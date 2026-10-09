use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::api::queries::ClassInfo;

/// All classes defined in the given file.
pub fn get_classes(query: &GraphQuery, file_path: &str) -> Vec<ClassInfo> {
    query.get_classes(file_path)
}

/// All classes that directly inherit from `class_name` in `file_path`.
pub fn get_subclasses(
    query: &GraphQuery,
    class_name: &str,
    file_path: &str,
) -> Vec<ClassInfo> {
    query.find_subclasses(class_name, file_path)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Build a graph with:
    ///   file: shapes.py
    ///   classes: `Shape` (base) and `Circle` (inherits Shape)
    fn build_class_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("shapes.py".to_string(), "python".to_string());

        builder
            .process_class_declared("Shape".to_string(), vec![], 1, ts, vec![])
            .expect("declare Shape");

        builder
            .process_class_declared("Circle".to_string(), vec!["Shape".to_string()], 10, ts, vec![])
            .expect("declare Circle");

        builder.into_graph()
    }

    #[test]
    fn test_get_classes_returns_all_declared() {
        let graph = build_class_graph();
        let query = GraphQuery::new(&graph);
        let classes = get_classes(&query, "shapes.py");
        assert_eq!(classes.len(), 2);
        println!("{:#?}", classes);
    }

    #[test]
    fn test_get_subclasses_of_shape() {
        let graph = build_class_graph();
        let query = GraphQuery::new(&graph);
        let subclasses = get_subclasses(&query, "Shape", "shapes.py");
        assert_eq!(subclasses.len(), 1);
        assert_eq!(subclasses[0].name, "Circle");
        println!("{:#?}", subclasses);
    }

    #[test]
    fn test_leaf_class_has_no_subclasses() {
        let graph = build_class_graph();
        let query = GraphQuery::new(&graph);
        let subclasses = get_subclasses(&query, "Circle", "shapes.py");
        assert!(subclasses.is_empty());
        println!("Circle subclasses (expect empty): {:#?}", subclasses);
    }
}