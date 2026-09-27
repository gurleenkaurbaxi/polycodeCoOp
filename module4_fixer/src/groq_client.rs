use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// ── Request ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: &'static str,
    max_tokens: u32,
    messages: Vec<Message>,
}

// ── Response ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: AssistantMessage,
}

#[derive(Deserialize)]
struct AssistantMessage {
    content: String,
}

// ── Public client ─────────────────────────────────────────────────────────────

pub struct GroqClient {
    api_key: String,
    http: reqwest::Client,
}

impl GroqClient {
    pub fn new(api_key: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("Failed to build HTTP client")?;
        Ok(Self { api_key, http })
    }

    pub async fn suggest_fix(&self, prompt: String) -> Result<String> {
        const API_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
        const MODEL: &str = "qwen/qwen3.8-27b";

        let body = ChatRequest {
            model: MODEL,
            max_tokens: 1024,
            messages: vec![Message { role: "user", content: prompt }],
        };

        let resp = self
            .http
            .post(API_URL)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .context("HTTP request to Groq API failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Groq API returned {}: {}", status, body);
        }

        let parsed: ChatResponse =
            resp.json().await.context("Failed to deserialize Groq API response")?;

        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| anyhow::anyhow!("Groq API response contained no choices"))
    }
}
