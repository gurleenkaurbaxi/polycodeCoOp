use std::collections::HashMap;

use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::api::queries::DependencyInfo;
use serde::{Deserialize, Serialize};

use crate::models::analysis_result::{AnalysisPayload, AnalysisResult, AnalysisType};

// ── Data structures ───────────────────────────────────────────────────────────

/// The dependency graph for a single file.
/// Maps `file_path → list of modules it imports`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub file_path: String,
    /// module_path → DependencyInfo (import details)
    pub imports: HashMap<String, DependencyInfo>,
}

// ── Core logic ────────────────────────────────────────────────────────────────

/// Build a DependencyGraph showing what `file_path` imports.
pub fn build_dependency_graph(query: &GraphQuery, file_path: &str) -> DependencyGraph {
    let deps = query.find_dependencies(file_path);

    let imports: HashMap<String, DependencyInfo> = deps
        .into_iter()
        .map(|d| (d.module_path.clone(), d))
        .collect();

    DependencyGraph {
        file_path: file_path.to_string(),
        imports,
    }
}

/// Convenience wrapper returning a full AnalysisResult.
pub fn analyse_dependencies(query: &GraphQuery, file_path: &str) -> AnalysisResult {
    let dep_graph = build_dependency_graph(query, file_path);

    let payload = AnalysisPayload {
        functions: Vec::new(),
        classes: Vec::new(),
        dependencies: dep_graph.imports.into_values().collect(),
    };

    AnalysisResult::new(AnalysisType::Dependency, payload)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Graph: auth.py imports `os` and `hashlib`
    fn build_import_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("auth.py".to_string(), "python".to_string());

        builder
            .process_import("os".to_string(), vec!["path".to_string()], false, 1, ts)
            .unwrap();

        builder
            .process_import("hashlib".to_string(), vec!["sha256".to_string()], false, 2, ts)
            .unwrap();

        builder.into_graph()
    }

    #[test]
    fn test_dependency_graph_finds_both_imports() {
        let graph = build_import_graph();
        let query = GraphQuery::new(&graph);
        let dep_graph = build_dependency_graph(&query, "auth.py");
        assert_eq!(dep_graph.imports.len(), 2);
        assert!(dep_graph.imports.contains_key("os"));
        assert!(dep_graph.imports.contains_key("hashlib"));
    }

    #[test]
    fn test_dependency_graph_import_details() {
        let graph = build_import_graph();
        let query = GraphQuery::new(&graph);
        let dep_graph = build_dependency_graph(&query, "auth.py");
        let os_dep = dep_graph.imports.get("os").expect("os must exist");
        assert!(!os_dep.is_wildcard);
        assert!(os_dep.imported_names.contains(&"path".to_string()));
    }

    #[test]
    fn test_analyse_dependencies_result_type() {
        let graph = build_import_graph();
        let query = GraphQuery::new(&graph);
        let result = analyse_dependencies(&query, "auth.py");
        assert_eq!(result.analysis_type, AnalysisType::Dependency);
        assert_eq!(result.summary_stats.total_items, 2);
    }

    #[test]
    fn test_file_with_no_imports_returns_empty() {
        let mut builder = GraphBuilder::new();
        builder.set_current_file("bare.py".to_string(), "python".to_string());
        builder.process_function_declared("run".to_string(), 0, 1, None, 0, vec![]).unwrap();
        let graph = builder.into_graph();

        let query = GraphQuery::new(&graph);
        let dep_graph = build_dependency_graph(&query, "bare.py");
        assert!(dep_graph.imports.is_empty());
    }
}