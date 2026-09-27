//! api_server — HTTP bridge between the React UI and the analysis pipeline.
//!
//! Endpoints
//!   POST /api/analyze/repo   { url, max_fixes? } → AnalysisResponse
//!   POST /api/analyze/files  multipart(files)    → AnalysisResponse
//!
//! Requires Module 1 (Python gRPC server) to be running.
//! Default: http://127.0.0.1:50051  Override: M1_SERVER env var.
//!
//! Set GROQ_API_KEY to enable AI fix suggestions.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    extract::{Multipart, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::detect_language;
use module2_ir_builder::grpc_client::IREventClient;
use module3_analysis::AnalysisEngine;

// ── App state ─────────────────────────────────────────────────────────────────

struct AppState {
    grpc_server: String,
    groq_key: Option<String>,
}

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Suggestion {
    pub id: usize,
    pub file: String,
    pub line: i32,
    pub function: String,
    pub suggestion: String,
}

#[derive(Serialize)]
pub struct AnalysisStats {
    pub source: String,
    pub files_parsed: usize,
    pub total_findings: usize,
    pub cap: usize,
}

#[derive(Serialize)]
pub struct AnalysisResponse {
    pub ir: Value,
    pub suggestions: Vec<Suggestion>,
    pub stats: AnalysisStats,
}

// ── Request types ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RepoRequest {
    url: String,
    #[serde(default = "default_max_fixes")]
    max_fixes: usize,
}

fn default_max_fixes() -> usize {
    10
}

// ── Error handling ────────────────────────────────────────────────────────────

struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

type HandlerResult<T> = std::result::Result<T, AppError>;

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let grpc_server = std::env::var("M1_SERVER")
        .unwrap_or_else(|_| "http://127.0.0.1:50051".to_string());

    let groq_key = std::env::var("GROQ_API_KEY").ok();

    if groq_key.is_none() {
        tracing::warn!("GROQ_API_KEY not set — AI suggestions will show a placeholder message");
    }

    info!("Module 1 gRPC server: {}", grpc_server);

    let state = Arc::new(AppState { grpc_server, groq_key });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/analyze/repo", post(analyze_repo))
        .route("/api/analyze/files", post(analyze_files))
        .layer(cors)
        .with_state(state);

    let addr = "0.0.0.0:3000";
    info!("API server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn analyze_repo(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RepoRequest>,
) -> HandlerResult<Json<AnalysisResponse>> {
    let tmp = tempfile::tempdir().context("Failed to create temp dir")?;

    info!("Cloning {}", req.url);
    clone_repo(&req.url, tmp.path())?;

    let files = find_source_files(tmp.path());
    info!("Found {} source files", files.len());

    let response = run_pipeline(&state, files, &req.url, req.max_fixes).await?;
    Ok(Json(response))
}

async fn analyze_files(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> HandlerResult<Json<AnalysisResponse>> {
    let tmp = tempfile::tempdir().context("Failed to create temp dir")?;
    let mut saved: Vec<PathBuf> = Vec::new();
    let mut names: Vec<String> = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .context("Failed to read multipart field")?
    {
        let filename = field
            .file_name()
            .unwrap_or("uploaded_file")
            .to_string();
        let data = field
            .bytes()
            .await
            .context("Failed to read field bytes")?;

        let dest = tmp.path().join(&filename);
        std::fs::write(&dest, &data)
            .with_context(|| format!("Failed to write {}", dest.display()))?;

        names.push(filename);
        saved.push(dest);
    }

    let source = if names.len() == 1 {
        names[0].clone()
    } else {
        format!("{} files uploaded", names.len())
    };

    let max_fixes = default_max_fixes();
    let response = run_pipeline(&state, saved, &source, max_fixes).await?;
    Ok(Json(response))
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

async fn run_pipeline(
    state: &AppState,
    files: Vec<PathBuf>,
    source: &str,
    max_fixes: usize,
) -> Result<AnalysisResponse> {
    if files.is_empty() {
        return Ok(AnalysisResponse {
            ir: serde_json::json!({ "nodes": [], "edges": [] }),
            suggestions: Vec::new(),
            stats: AnalysisStats {
                source: source.to_string(),
                files_parsed: 0,
                total_findings: 0,
                cap: max_fixes,
            },
        });
    }

    // Connect to Module 1 gRPC
    let mut ir_client = IREventClient::connect(state.grpc_server.clone())
        .await
        .context("Cannot connect to Module 1 — is it running? (python test_integration_v3.py)")?;

    // Parse each file via Module 1
    let mut processed: Vec<String> = Vec::new();
    for path in &files {
        let path_str = path.to_string_lossy().to_string();
        let lang = match detect_language(&path_str) {
            Ok(l) => l.as_str().to_string(),
            Err(_) => continue,
        };
        if ir_client.monitor_file(path_str.clone(), lang).await.is_ok() {
            processed.push(path_str);
        }
    }

    let files_parsed = processed.len();

    // Build graph (Module 2)
    let graph = ir_client.into_graph();
    let query = GraphQuery::new(&graph);

    // Export IR as JSON value for the UI
    let ir_str = query.export_to_json()?;
    let ir: Value = serde_json::from_str(&ir_str)?;

    // Detect dead code across all files (Module 3)
    let mut engine = AnalysisEngine::new();
    let mut all_findings: Vec<(String, String, i32, i32, bool)> = Vec::new();
    for file_path in &processed {
        let result = engine.dead_code(&query, file_path);
        for fi in &result.payload.functions {
            all_findings.push((
                fi.name.clone(),
                fi.file_path.clone(),
                fi.line_number,
                fi.param_count,
                fi.is_async,
            ));
        }
    }
    all_findings.sort_by(|a, b| (&a.1, a.2).cmp(&(&b.1, b.2)));

    let total_findings = all_findings.len();
    let capped: Vec<_> = all_findings.iter().take(max_fixes).collect();

    // Generate AI suggestions (Module 4 / Groq)
    let mut suggestions: Vec<Suggestion> = Vec::new();
    match &state.groq_key {
        Some(key) => {
            let groq = GroqClient::new(key.clone())?;
            for (i, (name, file_path, line_number, param_count, is_async)) in
                capped.iter().enumerate()
            {
                let (snippet_start, snippet) =
                    match read_snippet(file_path, *line_number, 50) {
                        Ok(pair) => pair,
                        Err(_) => continue,
                    };

                let prompt = build_prompt(
                    name,
                    file_path,
                    *line_number,
                    *param_count,
                    *is_async,
                    snippet_start,
                    &snippet,
                );

                let suggestion_text = groq
                    .suggest_fix(prompt)
                    .await
                    .unwrap_or_else(|e| format!("[Groq error: {}]", e));

                suggestions.push(Suggestion {
                    id: i + 1,
                    file: file_path.clone(),
                    line: *line_number,
                    function: name.clone(),
                    suggestion: suggestion_text,
                });
            }
        }
        None => {
            for (i, (name, file_path, line_number, _, _)) in capped.iter().enumerate() {
                suggestions.push(Suggestion {
                    id: i + 1,
                    file: file_path.clone(),
                    line: *line_number,
                    function: name.clone(),
                    suggestion:
                        "Set GROQ_API_KEY when starting the server to enable AI suggestions."
                            .to_string(),
                });
            }
        }
    }

    Ok(AnalysisResponse {
        ir,
        suggestions,
        stats: AnalysisStats {
            source: source.to_string(),
            files_parsed,
            total_findings,
            cap: max_fixes,
        },
    })
}

// ── Groq client ───────────────────────────────────────────────────────────────

struct GroqClient {
    api_key: String,
    http: reqwest::Client,
}

impl GroqClient {
    fn new(api_key: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("Failed to build HTTP client")?;
        Ok(Self { api_key, http })
    }

    async fn suggest_fix(&self, prompt: String) -> Result<String> {
        #[derive(Serialize)]
        struct Msg {
            role: &'static str,
            content: String,
        }
        #[derive(Serialize)]
        struct Req {
            model: &'static str,
            max_tokens: u32,
            messages: Vec<Msg>,
        }
        #[derive(Deserialize)]
        struct Resp {
            choices: Vec<Choice>,
        }
        #[derive(Deserialize)]
        struct Choice {
            message: Msg2,
        }
        #[derive(Deserialize)]
        struct Msg2 {
            content: String,
        }

        let body = Req {
            model: "qwen/qwen3.8-27b",
            max_tokens: 1024,
            messages: vec![Msg { role: "user", content: prompt }],
        };

        let resp = self
            .http
            .post("https://api.groq.com/openai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .context("HTTP request to Groq failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Groq returned {}: {}", status, body);
        }

        let parsed: Resp = resp.json().await.context("Failed to parse Groq response")?;
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| anyhow::anyhow!("Groq returned no choices"))
    }
}

// ── Snippet + prompt helpers ──────────────────────────────────────────────────

fn read_snippet(file_path: &str, line_number: i32, window: usize) -> Result<(usize, String)> {
    let content = std::fs::read_to_string(file_path)
        .with_context(|| format!("Cannot read {}", file_path))?;
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let center = (line_number as usize).saturating_sub(1);
    let half = window / 2;
    let start = center.saturating_sub(half);
    let end = (center + half + 1).min(total);
    Ok((start + 1, lines[start..end].join("\n")))
}

fn build_prompt(
    name: &str,
    file_path: &str,
    line_number: i32,
    param_count: i32,
    is_async: bool,
    snippet_start: usize,
    snippet: &str,
) -> String {
    let async_tag = if is_async { "async " } else { "" };
    let snippet_end = snippet_start + snippet.lines().count().saturating_sub(1);
    format!(
        "You are a code quality assistant. Static analysis flagged the following \
function as DEAD CODE (never called).\n\n\
File: {file_path}\n\
Function: `{async_tag}{name}` ({param_count} parameter(s))\n\
Declared at: line {line_number}\n\n\
Source context (lines {snippet_start}–{snippet_end}):\n\
```\n{snippet}\n```\n\n\
Provide a concise, actionable suggestion (3–5 sentences). Consider:\n\
1. Delete it entirely?\n\
2. Move to a shared module or make public?\n\
3. Needs a call-site?\n\
4. Refactoring opportunities?\n\
Do NOT rewrite the entire file.",
    )
}

// ── Repo helpers (mirrored from module3/module4) ──────────────────────────────

fn clone_repo(url: &str, dest: &Path) -> Result<()> {
    let status = std::process::Command::new("git")
        .args(["clone", "--depth", "1", url])
        .arg(dest)
        .status()
        .context("Failed to spawn `git clone`")?;
    if !status.success() {
        anyhow::bail!("`git clone {}` failed (exit {:?})", url, status.code());
    }
    Ok(())
}

fn find_source_files(dir: &Path) -> Vec<PathBuf> {
    const SKIP_DIRS: &[&str] = &[".git", "target", "node_modules", "vendor"];
    const EXTS: &[&str] = &["py", "java", "go", "c", "h", "rb", "rs"];

    let mut result = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];

    while let Some((cur, depth)) = stack.pop() {
        if depth > 20 {
            continue;
        }
        for entry in std::fs::read_dir(&cur).into_iter().flatten().flatten() {
            let path = entry.path();
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !SKIP_DIRS.contains(&name) {
                    stack.push((path, depth + 1));
                }
            } else {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if EXTS.contains(&ext.as_str()) {
                    result.push(path);
                }
            }
        }
    }
    result.sort();
    result
}
