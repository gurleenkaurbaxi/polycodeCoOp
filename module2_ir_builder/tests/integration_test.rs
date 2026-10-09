//! Integration tests with Module 1
//!
//! These tests require Module 1 to be running with:
//! `python ../module1_adapter/src/main.py --mode lsp --grpc-port 50051`
//!
//! Run with: INTEGRATION_TESTS=1 cargo test integration

use module2_ir_builder::graph::GraphBuilder;
use module2_ir_builder::api::GraphQuery;

/// Helper to build a simple test graph
fn build_test_graph() -> GraphBuilder {
    let mut builder = GraphBuilder::new();

    // Simulate processing a Python file
    builder.set_current_file("example.py".to_string(), "python".to_string());

    // Add some functions
    builder.process_function_declared(
        "authenticate".to_string(),
        2,
        10,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_declared(
        "validate_token".to_string(),
        1,
        20,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_declared(
        "issue_token".to_string(),
        1,
        30,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    // Add function calls to create the call graph
    builder.process_function_call(
        Some("authenticate".to_string()),
        "validate_token".to_string(),
        1,
        15,
    ).unwrap();

    builder.process_function_call(
        Some("authenticate".to_string()),
        "issue_token".to_string(),
        1,
        16,
    ).unwrap();

    // Resolve pending calls
    builder.resolve_pending_calls().unwrap();

    builder
}

#[test]
fn test_graph_queries_on_built_graph() {
    let builder = build_test_graph();
    let graph = builder.graph();
    let query = GraphQuery::new(graph);

    // Verify functions exist
    let functions = query.get_functions("example.py");
    assert_eq!(functions.len(), 3);
    assert!(functions.iter().any(|f| f.name == "authenticate"));
    assert!(functions.iter().any(|f| f.name == "validate_token"));
    assert!(functions.iter().any(|f| f.name == "issue_token"));
}

#[test]
fn test_find_callers_query() {
    let builder = build_test_graph();
    let graph = builder.graph();
    let query = GraphQuery::new(graph);

    // Who calls validate_token?
    let callers = query.find_callers("validate_token", "example.py");
    assert_eq!(callers.len(), 1);
    assert_eq!(callers[0].name, "authenticate");
}

#[test]
fn test_find_callees_query() {
    let builder = build_test_graph();
    let graph = builder.graph();
    let query = GraphQuery::new(graph);

    // What does authenticate call?
    let callees = query.find_callees("authenticate", "example.py");
    assert_eq!(callees.len(), 2);
    assert!(callees.iter().any(|f| f.name == "validate_token"));
    assert!(callees.iter().any(|f| f.name == "issue_token"));
}

#[test]
fn test_unused_functions_detection() {
    let builder = build_test_graph();
    let graph = builder.graph();
    let query = GraphQuery::new(graph);

    // Functions that are never called
    let unused = query.find_unused_functions("example.py");

    // Only "authenticate" is unused (nothing calls it)
    // validate_token and issue_token are both called by authenticate, so they're used
    assert_eq!(unused.len(), 1);
    assert!(unused.iter().any(|f| f.name == "authenticate"));
    assert!(!unused.iter().any(|f| f.name == "validate_token"));
    assert!(!unused.iter().any(|f| f.name == "issue_token"));
}

#[test]
fn test_graph_statistics() {
    let builder = build_test_graph();
    let graph = builder.graph();
    let query = GraphQuery::new(graph);

    let stats = query.get_stats();
    // 4 nodes: 1 Module + 3 Functions
    assert_eq!(stats.total_nodes, 4);
    // 2 edges: authenticate -> validate_token, authenticate -> issue_token
    assert_eq!(stats.total_edges, 2);
    assert_eq!(stats.total_files, 1);
}

#[test]
fn test_multi_file_graph() {
    let mut builder = GraphBuilder::new();

    // Process first file
    builder.set_current_file("auth.py".to_string(), "python".to_string());
    builder.process_function_declared(
        "login".to_string(),
        2,
        10,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_declared(
        "hash_password".to_string(),
        1,
        20,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_call(
        Some("login".to_string()),
        "hash_password".to_string(),
        1,
        15,
    ).unwrap();

    builder.resolve_pending_calls().unwrap();

    // Process second file
    builder.set_current_file("utils.py".to_string(), "python".to_string());
    builder.process_function_declared(
        "encode".to_string(),
        1,
        10,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    // Get statistics
    let graph = builder.graph();
    let query = GraphQuery::new(graph);
    let stats = query.get_stats();

    // 2 modules + 3 functions = 5 nodes
    assert_eq!(stats.total_nodes, 5);
    assert_eq!(stats.total_files, 2);

    // Verify each file's functions
    let query = GraphQuery::new(graph);
    let auth_funcs = query.get_functions("auth.py");
    let util_funcs = query.get_functions("utils.py");

    assert_eq!(auth_funcs.len(), 2);
    assert_eq!(util_funcs.len(), 1);
}

#[test]
fn test_incremental_update_scenario() {
    let mut builder = GraphBuilder::new();

    // Initial version
    builder.set_current_file("app.py".to_string(), "python".to_string());
    builder.process_function_declared(
        "old_function".to_string(),
        0,
        10,
        None,
        1700000000,
        vec![],          // decorators
    ).unwrap();

    let query1 = GraphQuery::new(builder.graph());
    let stats1 = query1.get_stats();
    assert_eq!(stats1.total_nodes, 2); // Module + function

    // File is modified (clear and rebuild)
    builder.clear_current_file().unwrap();
    let query2 = GraphQuery::new(builder.graph());
    let stats2 = query2.get_stats();
    assert_eq!(stats2.total_nodes, 0);

    // Re-parse the file with new content
    builder.set_current_file("app.py".to_string(), "python".to_string());
    builder.process_function_declared(
        "new_function".to_string(),
        1,
        10,
        None,
        1700000001,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_declared(
        "helper".to_string(),
        0,
        20,
        None,
        1700000001,
        vec![],          // decorators
    ).unwrap();

    builder.process_function_call(
        Some("new_function".to_string()),
        "helper".to_string(),
        0,
        15,
    ).unwrap();

    builder.resolve_pending_calls().unwrap();

    let query3 = GraphQuery::new(builder.graph());
    let stats3 = query3.get_stats();
    // 1 Module + 2 functions = 3 nodes
    assert_eq!(stats3.total_nodes, 3);
    // 1 edge: new_function -> helper
    assert_eq!(stats3.total_edges, 1);

    // Verify old function is gone
    let query = GraphQuery::new(builder.graph());
    let functions = query.get_functions("app.py");
    assert!(!functions.iter().any(|f| f.name == "old_function"));
    assert!(functions.iter().any(|f| f.name == "new_function"));
    assert!(functions.iter().any(|f| f.name == "helper"));
}

#[test]
fn test_all_event_types_accepted() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("comprehensive.py".to_string(), "python".to_string());

    // Test all 15 event types can be processed without error

    // 1. FunctionDeclared
    builder.process_function_declared(
        "main".to_string(), 0, 1, None, 1700000000,
        vec![],          // decorators
    ).unwrap();

    // 2. AsyncFunctionDeclared
    builder.process_async_function_declared(
        "async_main".to_string(), 0, 2, None, 1700000000,
        vec![],          // decorators
    ).unwrap();

    // 3. ClassDeclared
    builder.process_class_declared(
        "MyClass".to_string(), vec![], 3, 1700000000,
        vec![],          // decorators
    ).unwrap();

    // 4. FunctionCall
    builder.process_function_call(
        Some("main".to_string()), "helper".to_string(), 0, 4
    ).unwrap();

    // 5. ImportStatement
    builder.process_import(
        "os".to_string(), vec![], false, 5, 1700000000
    ).unwrap();

    // 6. VariableAssignment
    builder.process_variable_assignment(
        "config".to_string(), "global".to_string(), 6, 1700000000
    ).unwrap();

    // 7. ControlStructure
    builder.process_control_structure(
        0, Some("main".to_string()), 7, 1700000000
    ).unwrap();

    // 8. InterfaceDeclared
    builder.process_interface_declared(
        "IProtocol".to_string(), vec![], 8, 0, 1700000000
    ).unwrap();

    // 9. EnumDeclared
    builder.process_enum_declared(
        "Status".to_string(), 3, 9, 1700000000
    ).unwrap();

    // 10. ReturnStatement
    builder.process_return_statement(
        "main".to_string(), true, 10
    ).unwrap();

    // 11. ThrowStatement
    builder.process_throw_statement(
        Some("ValueError".to_string()), Some("main".to_string()), 11, true
    ).unwrap();

    // 12. CatchClause
    builder.process_catch_clause(
        vec!["ValueError".to_string()], Some("main".to_string()), 12, false
    ).unwrap();

    // 13. AwaitExpression
    builder.process_await_expression(
        "async_main".to_string(), Some("async_main".to_string()), 13
    ).unwrap();

    // 14. LambdaDeclared
    builder.process_lambda_declared(
        2, Some("main".to_string()), 14, 1700000000
    ).unwrap();

    // 15. MemberAccess
    builder.process_member_access(
        "obj".to_string(), "method".to_string(), Some("main".to_string()), 15, true
    ).unwrap();

    // Should have processed all events without panic
    let query = GraphQuery::new(builder.graph());
    let stats = query.get_stats();
    assert!(stats.total_nodes > 0);
}
