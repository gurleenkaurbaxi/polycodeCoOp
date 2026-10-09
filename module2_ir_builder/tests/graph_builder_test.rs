use module2_ir_builder::graph::GraphBuilder;
use module2_ir_builder::api::GraphQuery;

#[test]
fn test_basic_function_declaration() {
    let mut builder = GraphBuilder::new();

    // Set up file context
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Declare a function
    let func_id = builder
        .process_function_declared(
            "main".to_string(),
            2,                // param_count
            10,               // line_number
            None,             // parent_scope
            1700000000,       // timestamp
            vec![],          // decorators
        )
        .expect("Failed to process function declaration");

    // Verify the node was created
    let graph = builder.graph();
    let node = graph.get_node(&func_id).expect("Node not found");

    assert_eq!(node.display_name(), "main");
    assert_eq!(node.metadata.line_number, 10);
    assert_eq!(node.metadata.file_path, "test.py");

    // Verify graph stats (includes the auto-created Module node + the function node)
    let stats = graph.stats();
    assert_eq!(stats.node_count, 2); // Module node + Function node
    assert_eq!(stats.edge_count, 0);
}

#[test]
fn test_function_call_relationship() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Declare two functions
    builder
        .process_function_declared(
            "caller".to_string(),
            0,
            10,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare caller");

    builder
        .process_function_declared(
            "callee".to_string(),
            1,
            20,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare callee");

    // Record a function call
    builder
        .process_function_call(
            Some("caller".to_string()),
            "callee".to_string(),
            1,
            15,
        )
        .expect("Failed to process function call");

    // Resolve pending calls
    builder.resolve_pending_calls().expect("Failed to resolve calls");

    // Verify the edge was created
    let graph = builder.graph();
    let stats = graph.stats();
    assert_eq!(stats.node_count, 3); // Module node + 2 function nodes
    assert_eq!(stats.edge_count, 1);

    // Query: who calls "callee"?
    let query = GraphQuery::new(graph);
    let callers = query.find_callers("callee", "test.py");
    assert_eq!(callers.len(), 1);
    assert_eq!(callers[0].name, "caller");
}

#[test]
fn test_class_inheritance() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Declare base class
    builder
        .process_class_declared(
            "BaseClass".to_string(),
            vec![],
            10,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare base class");

    // Declare derived class
    builder
        .process_class_declared(
            "DerivedClass".to_string(),
            vec!["BaseClass".to_string()],
            20,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare derived class");

    // Verify inheritance relationship
    let graph = builder.graph();
    let stats = graph.stats();
    assert_eq!(stats.node_count, 3); // Module node + 2 class nodes
    assert_eq!(stats.edge_count, 1);

    // Query: what classes inherit from BaseClass?
    let query = GraphQuery::new(graph);
    let subclasses = query.find_subclasses("BaseClass", "test.py");
    assert_eq!(subclasses.len(), 1);
    assert_eq!(subclasses[0].name, "DerivedClass");
}

#[test]
fn test_import_dependencies() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("main.py".to_string(), "python".to_string());

    // Process an import
    builder
        .process_import(
            "os".to_string(),
            vec![],
            false,
            5,
            1700000000,
        )
        .expect("Failed to process import");

    // Verify import was recorded
    let graph = builder.graph();
    let query = GraphQuery::new(graph);
    let deps = query.find_dependencies("main.py");

    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].module_path, "os");
}

#[test]
fn test_unused_function_detection() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Declare a function that's never called
    builder
        .process_function_declared(
            "unused_helper".to_string(),
            0,
            10,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare unused function");

    // Declare a function that is called
    builder
        .process_function_declared(
            "main".to_string(),
            0,
            20,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare main");

    builder
        .process_function_declared(
            "helper".to_string(),
            0,
            30,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare helper");

    // Main calls helper
    builder
        .process_function_call(
            Some("main".to_string()),
            "helper".to_string(),
            0,
            25,
        )
        .expect("Failed to process call");

    builder.resolve_pending_calls().expect("Failed to resolve calls");

    // Query: find unused functions
    let graph = builder.graph();
    let query = GraphQuery::new(graph);
    let unused = query.find_unused_functions("test.py");

    // Only "unused_helper" is unused: "helper" is called by "main", and
    // "main" is an entry point, so it is never reported as dead code
    assert_eq!(unused.len(), 1);
    assert!(unused.iter().any(|f| f.name == "unused_helper"));
    assert!(!unused.iter().any(|f| f.name == "main"));
}

#[test]
fn test_incremental_update() {
    let mut builder = GraphBuilder::new();
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Build initial graph
    builder
        .process_function_declared(
            "old_function".to_string(),
            0,
            10,
            None,
            1700000000,
            vec![],          // decorators
        )
        .expect("Failed to declare function");

    let stats1 = builder.graph().stats();
    assert_eq!(stats1.node_count, 2); // Module + old_function

    // Simulate file change: clear and rebuild
    builder.clear_current_file().expect("Failed to clear file");

    let stats2 = builder.graph().stats();
    assert_eq!(stats2.node_count, 0);

    // Set file context again (creates Module node)
    builder.set_current_file("test.py".to_string(), "python".to_string());

    // Add new content
    builder
        .process_function_declared(
            "new_function".to_string(),
            0,
            10,
            None,
            1700000001,
            vec![],          // decorators
        )
        .expect("Failed to declare new function");

    let stats3 = builder.graph().stats();
    assert_eq!(stats3.node_count, 2); // Module + new_function

    // Verify old function is gone, new function exists
    let graph = builder.graph();
    let query = GraphQuery::new(graph);
    let functions = query.get_functions("test.py");
    assert_eq!(functions.len(), 1);
    assert_eq!(functions[0].name, "new_function");
}
