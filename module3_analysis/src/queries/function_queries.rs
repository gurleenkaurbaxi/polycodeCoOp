use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::api::queries::{DependencyInfo, FunctionInfo};

/// All functions defined in the given file.
pub fn get_functions(query: &GraphQuery, file_path: &str) -> Vec<FunctionInfo> {
    query.get_functions(file_path)
}

/// All functions that directly call `function_name` inside `file_path`.
pub fn get_callers(
    query: &GraphQuery,
    function_name: &str,
    file_path: &str,
) -> Vec<FunctionInfo> {
    query.find_callers(function_name, file_path)
}

/// All functions that `function_name` calls inside `file_path`.
pub fn get_callees(
    query: &GraphQuery,
    function_name: &str,
    file_path: &str,
) -> Vec<FunctionInfo> {
    query.find_callees(function_name, file_path)
}

/// Functions in `file_path` that are never called by anything.
pub fn get_unused_functions(query: &GraphQuery, file_path: &str) -> Vec<FunctionInfo> {
    query.find_unused_functions(file_path)
}

/// All modules imported by `file_path`.
pub fn get_dependencies(query: &GraphQuery, file_path: &str) -> Vec<DependencyInfo> {
    query.find_dependencies(file_path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Build a small graph:
    ///   file: test.py
    ///   functions: `caller` and `callee`
    ///   edge: caller → callee
    fn build_test_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("test.py".to_string(), "python".to_string());

        builder
            .process_function_declared("callee".to_string(), 0, 1, None, ts, vec![])
            .expect("declare callee");

        builder
            .process_function_declared("caller".to_string(), 0, 5, None, ts, vec![])
            .expect("declare caller");

        builder
            .process_function_call(
                Some("caller".to_string()),
                "callee".to_string(),
                0,
                6,
            )
            .expect("function call");

        builder.resolve_pending_calls().expect("resolve calls");

        builder.into_graph()
    }

    #[test]
    fn test_get_functions_returns_all_declared() {
        let graph = build_test_graph();
        let query = GraphQuery::new(&graph);
        let functions = get_functions(&query, "test.py");
        assert_eq!(functions.len(), 2);
        println!("{:#?}", functions);
    }

    #[test]
    fn test_get_callers_of_callee() {
        let graph = build_test_graph();
        let query = GraphQuery::new(&graph);
        let callers = get_callers(&query, "callee", "test.py");
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].name, "caller");
        println!("{:#?}", callers);
    }

    #[test]
    fn test_get_callees_of_caller() {
        let graph = build_test_graph();
        let query = GraphQuery::new(&graph);
        let callees = get_callees(&query, "caller", "test.py");
        assert_eq!(callees.len(), 1);
        assert_eq!(callees[0].name, "callee");
        println!("{:#?}", callees);
    }

    #[test]
    fn test_get_unused_functions() {
        let graph = build_test_graph();
        let query = GraphQuery::new(&graph);
        // `callee` is called by `caller` → only `caller` has no incoming Calls edge
        let unused = get_unused_functions(&query, "test.py");
        assert_eq!(unused.len(), 1);
        assert_eq!(unused[0].name, "caller");
        println!("{:#?}", unused);
    }
}