pub mod analysis;
pub mod cache;
pub mod models;
pub mod queries;

use module2_ir_builder::api::GraphQuery;

use crate::analysis::call_graph::{build_call_graph, CallGraph};
use crate::analysis::dead_code::detect_dead_code;
use crate::analysis::dependency_graph::{build_dependency_graph, DependencyGraph};
use crate::analysis::impact_analysis::compute_impact;
// use crate::cache::analysis_cache::{AnalysisCache, FileAnalysisKey, ImpactKey};
use crate::models::analysis_result::AnalysisResult;
use crate::models::impact_report::ImpactReport;

// ── Re-exports for consumers ──────────────────────────────────────────────────

pub use analysis::call_graph::CallGraph as M3CallGraph;
pub use analysis::dependency_graph::DependencyGraph as M3DependencyGraph;
pub use cache::analysis_cache::{AnalysisCache, FileAnalysisKey, ImpactKey};
pub use cache::analysis_cache::AnalysisCache as M3Cache;
pub use models::analysis_result::{AnalysisResult as M3AnalysisResult, AnalysisType};
pub use models::impact_report::ImpactReport as M3ImpactReport;

// ── Main engine ───────────────────────────────────────────────────────────────

/// The top-level entry point for all Module 3 analysis.
///
/// Holds a cache and exposes four analysis operations.
/// Every operation checks the cache first and only computes if there is a miss.
///
/// # Usage
/// ```
/// use module2_ir_builder::{GraphBuilder, IRGraph};
/// use module2_ir_builder::api::GraphQuery;
/// use module3_analysis::AnalysisEngine;
///
/// let graph: IRGraph = /* built by Module 2 */ IRGraph::new();
/// let query = GraphQuery::new(&graph);
/// let mut engine = AnalysisEngine::new();
///
/// let dead = engine.dead_code(&query, "app.py");
/// let impact = engine.impact(&query, "app.py", "process_order");
/// ```
pub struct AnalysisEngine {
    pub cache: AnalysisCache,
}

impl AnalysisEngine {
    /// Create a new engine with an empty cache.
    pub fn new() -> Self {
        Self {
            cache: AnalysisCache::new(),
        }
    }

    /// Detect functions that are never called in `file_path`.
    /// Returns cached result on repeat calls with the same file.
    pub fn dead_code(&mut self, query: &GraphQuery, file_path: &str) -> AnalysisResult {
        let key = FileAnalysisKey::new("dead_code", file_path);

        if let Some(cached) = self.cache.get_file_result(&key) {
            return cached.clone();
        }

        let result = detect_dead_code(query, file_path);
        self.cache.insert_file_result(key, result.clone());
        result
    }

    /// Build the call graph for all functions in `file_path`.
    /// Returns cached result on repeat calls with the same file.
    pub fn call_graph(&mut self, query: &GraphQuery, file_path: &str) -> CallGraph {
        let key = FileAnalysisKey::new("call_graph", file_path);

        if let Some(cached) = self.cache.get_file_result(&key) {
            // Re-derive CallGraph from the cached AnalysisResult payload
            return CallGraph {
                file_path: file_path.to_string(),
                nodes: cached.payload.functions.clone(),
                adjacency: std::collections::HashMap::new(),
                edges: Vec::new(),
            };
        }

        let cg = build_call_graph(query, file_path);

        // Store a summary result in the file store for cache-hit detection
        let summary = AnalysisResult::new(
            AnalysisType::CallGraph,
            crate::models::analysis_result::AnalysisPayload {
                functions: cg.nodes.clone(),
                classes: Vec::new(),
                dependencies: Vec::new(),
            },
        );
        self.cache.insert_file_result(key, summary);
        cg
    }

    /// Map all import dependencies for `file_path`.
    /// Returns cached result on repeat calls with the same file.
    pub fn dependencies(&mut self, query: &GraphQuery, file_path: &str) -> DependencyGraph {
        let key = FileAnalysisKey::new("dependency", file_path);

        if let Some(cached) = self.cache.get_file_result(&key) {
            return DependencyGraph {
                file_path: file_path.to_string(),
                imports: cached
                    .payload
                    .dependencies
                    .iter()
                    .map(|d| (d.module_path.clone(), d.clone()))
                    .collect(),
            };
        }

        let dg = build_dependency_graph(query, file_path);

        let summary = AnalysisResult::new(
            AnalysisType::Dependency,
            crate::models::analysis_result::AnalysisPayload {
                functions: Vec::new(),
                classes: Vec::new(),
                dependencies: dg.imports.values().cloned().collect(),
            },
        );
        self.cache.insert_file_result(key, summary);
        dg
    }

    /// Compute the ripple impact of changing `function_name` in `file_path`.
    /// Each (file, function) pair is cached independently.
    pub fn impact(
        &mut self,
        query: &GraphQuery,
        file_path: &str,
        function_name: &str,
    ) -> ImpactReport {
        let key = ImpactKey::new(file_path, function_name);

        if let Some(cached) = self.cache.get_impact(&key) {
            return cached.clone();
        }

        let report = compute_impact(query, function_name, file_path);
        self.cache.insert_impact(key, report.clone());
        report
    }

    /// Notify the engine that `file_path` has been re-parsed by Module 2.
    /// Invalidates all cached results for that file so the next call recomputes.
    pub fn on_file_updated(&mut self, file_path: &str) {
        self.cache.invalidate_file(file_path);
    }
}

impl Default for AnalysisEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Integration tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::api::GraphQuery;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Full graph:
    ///   auth.py imports `hashlib`
    ///   functions: `hash_password`, `login` (calls hash_password), `orphan`
    fn build_full_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("auth.py".to_string(), "python".to_string());

        builder
            .process_import("hashlib".to_string(), vec!["sha256".to_string()], false, 1, ts)
            .unwrap();

        builder
            .process_function_declared("hash_password".to_string(), 1, 3, None, ts, vec![])
            .unwrap();
        builder
            .process_function_declared("login".to_string(), 2, 8, None, ts, vec![])
            .unwrap();
        builder
            .process_function_declared("orphan".to_string(), 0, 15, None, ts, vec![])
            .unwrap();

        builder
            .process_function_call(Some("login".to_string()), "hash_password".to_string(), 1, 10)
            .unwrap();

        builder.resolve_pending_calls().unwrap();
        builder.into_graph()
    }

    #[test]
    fn test_engine_dead_code() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        let result = engine.dead_code(&query, "auth.py");
        let names: Vec<&str> = result.payload.functions.iter().map(|f| f.name.as_str()).collect();

        // `hash_password` is called by `login` — not dead
        assert!(!names.contains(&"hash_password"));
        // `login` and `orphan` have no callers — dead
        assert!(names.contains(&"login"));
        assert!(names.contains(&"orphan"));
    }

    #[test]
    fn test_engine_call_graph() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        let cg = engine.call_graph(&query, "auth.py");
        assert_eq!(cg.nodes.len(), 3);
        let login_callees = cg.adjacency.get("login").unwrap();
        assert!(login_callees.contains(&"hash_password".to_string()));
    }

    #[test]
    fn test_engine_dependencies() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        let dg = engine.dependencies(&query, "auth.py");
        assert!(dg.imports.contains_key("hashlib"));
    }

    #[test]
    fn test_engine_impact() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        let report = engine.impact(&query, "auth.py", "hash_password");
        assert_eq!(report.direct_impacts.len(), 1);
        assert_eq!(report.direct_impacts[0].name, "login");
    }

    #[test]
    fn test_cache_hit_on_second_call() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        engine.dead_code(&query, "auth.py");
        engine.dead_code(&query, "auth.py"); // should hit cache

        assert_eq!(engine.cache.file_result_count(), 1);
    }

    #[test]
    fn test_on_file_updated_clears_cache() {
        let graph = build_full_graph();
        let query = GraphQuery::new(&graph);
        let mut engine = AnalysisEngine::new();

        engine.dead_code(&query, "auth.py");
        assert_eq!(engine.cache.file_result_count(), 1);

        engine.on_file_updated("auth.py");
        assert_eq!(engine.cache.file_result_count(), 0);
    }
}