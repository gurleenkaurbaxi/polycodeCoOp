use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::api::queries::FunctionInfo;

use crate::models::analysis_result::{AnalysisPayload, AnalysisResult, AnalysisType};

/// Detect functions in `file_path` that are never called by anything.
/// Returns a structured AnalysisResult containing the unused functions.
pub fn detect_dead_code(query: &GraphQuery, file_path: &str) -> AnalysisResult {
    let unused = query.find_unused_functions(file_path);

    let payload = AnalysisPayload {
        functions: unused,
        classes: Vec::new(),
        dependencies: Vec::new(),
    };

    AnalysisResult::new(AnalysisType::DeadCode, payload)
}

/// Raw version — returns just the list of unused FunctionInfo.
/// Useful when the caller only needs the data, not the full AnalysisResult wrapper.
pub fn find_unused_functions(query: &GraphQuery, file_path: &str) -> Vec<FunctionInfo> {
    query.find_unused_functions(file_path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    fn build_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("app.py".to_string(), "python".to_string());

        // `used` is called by `entry` — so `used` has an incoming Calls edge
        builder.process_function_declared("used".to_string(), 0, 1, None, ts, vec![]).unwrap();
        builder.process_function_declared("entry".to_string(), 0, 5, None, ts, vec![]).unwrap();
        // `orphan` is declared but never called
        builder.process_function_declared("orphan".to_string(), 0, 10, None, ts, vec![]).unwrap();

        builder.process_function_call(Some("entry".to_string()), "used".to_string(), 0, 6).unwrap();
        builder.resolve_pending_calls().unwrap();

        builder.into_graph()
    }

    #[test]
    fn test_detect_dead_code_returns_correct_type() {
        let graph = build_graph();
        let query = GraphQuery::new(&graph);
        let result = detect_dead_code(&query, "app.py");
        assert_eq!(result.analysis_type, AnalysisType::DeadCode);
    }

    #[test]
    fn test_orphan_and_entry_are_unused() {
        let graph = build_graph();
        let query = GraphQuery::new(&graph);
        // `used` is called by `entry` — it has an incoming Calls edge, so it is NOT unused
        // `entry` and `orphan` have no callers — they ARE unused
        let unused = find_unused_functions(&query, "app.py");
        let names: Vec<&str> = unused.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(unused.len(), 2);
        assert!(names.contains(&"entry"));
        assert!(names.contains(&"orphan"));
    }

    #[test]
    fn test_used_function_is_not_in_dead_code() {
        let graph = build_graph();
        let query = GraphQuery::new(&graph);
        let unused = find_unused_functions(&query, "app.py");
        assert!(!unused.iter().any(|f| f.name == "used"));
    }

    #[test]
    fn test_summary_stats_match_payload() {
        let graph = build_graph();
        let query = GraphQuery::new(&graph);
        let result = detect_dead_code(&query, "app.py");
        assert_eq!(result.summary_stats.total_items, result.payload.functions.len());
    }
}