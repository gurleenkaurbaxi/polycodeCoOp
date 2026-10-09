use std::collections::{HashSet, VecDeque};

use module2_ir_builder::api::GraphQuery;

use crate::models::impact_report::ImpactReport;

// ── Core algorithm ────────────────────────────────────────────────────────────

/// Compute the impact of changing `target_function` in `file_path`.
///
/// Uses breadth-first traversal of reverse call edges so we naturally
/// get accurate depth levels. A `visited` set prevents infinite loops
/// on cyclic call graphs (A → B → A).
pub fn compute_impact(
    query: &GraphQuery,
    target_function: &str,
    file_path: &str,
) -> ImpactReport {
    let mut report = ImpactReport::empty(target_function, file_path);

    // BFS queue: (function_name, depth)
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    let mut visited: HashSet<String> = HashSet::new();

    // Seed: direct callers of the target (depth = 1)
    let direct_callers = query.find_callers(target_function, file_path);

    for caller in &direct_callers {
        if visited.insert(caller.name.clone()) {
            queue.push_back((caller.name.clone(), 1));
        }
    }

    // Record direct impacts
    report.direct_impacts = direct_callers;

    // BFS for transitive impacts
    while let Some((current_name, depth)) = queue.pop_front() {
        // Record depth for this symbol
        report
            .impact_depth_levels
            .insert(current_name.clone(), depth);

        // If depth > 1 it's transitive — fetch the FunctionInfo and record it
        if depth > 1 {
            let callers_of_current = query.find_callers(&current_name, file_path);
            // We need the FunctionInfo for `current_name` itself, not its callers.
            // We get it by asking for all functions and finding the match.
            let functions = query.get_functions(file_path);
            if let Some(info) = functions.into_iter().find(|f| f.name == current_name) {
                report.transitive_impacts.push(info);
            }

            // Enqueue callers of this function for further traversal
            for caller in callers_of_current {
                if visited.insert(caller.name.clone()) {
                    queue.push_back((caller.name.clone(), depth + 1));
                }
            }
        } else {
            // depth == 1: direct caller — enqueue ITS callers at depth 2
            let callers_of_direct = query.find_callers(&current_name, file_path);
            for caller in callers_of_direct {
                if visited.insert(caller.name.clone()) {
                    queue.push_back((caller.name.clone(), depth + 1));
                }
            }
        }

        // Also record depth-1 items in the depth map
        if depth == 1 {
            report
                .impact_depth_levels
                .insert(current_name.clone(), depth);
        }
    }

    report
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Linear chain:  grandparent → parent → target
    /// Changing `target` should impact `parent` (depth 1) and `grandparent` (depth 2).
    fn build_chain_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("chain.py".to_string(), "python".to_string());

        builder.process_function_declared("target".to_string(), 0, 1, None, ts, vec![]).unwrap();
        builder.process_function_declared("parent".to_string(), 0, 5, None, ts, vec![]).unwrap();
        builder.process_function_declared("grandparent".to_string(), 0, 10, None, ts, vec![]).unwrap();

        // parent calls target
        builder
            .process_function_call(Some("parent".to_string()), "target".to_string(), 0, 6)
            .unwrap();
        // grandparent calls parent
        builder
            .process_function_call(Some("grandparent".to_string()), "parent".to_string(), 0, 11)
            .unwrap();

        builder.resolve_pending_calls().unwrap();
        builder.into_graph()
    }

    /// Cyclic graph:  a → b → a  (both call each other)
    /// Changing `a` should impact `b` at depth 1 and NOT loop forever.
    fn build_cyclic_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("cyclic.py".to_string(), "python".to_string());

        builder.process_function_declared("a".to_string(), 0, 1, None, ts, vec![]).unwrap();
        builder.process_function_declared("b".to_string(), 0, 5, None, ts, vec![]).unwrap();

        builder
            .process_function_call(Some("a".to_string()), "b".to_string(), 0, 2)
            .unwrap();
        builder
            .process_function_call(Some("b".to_string()), "a".to_string(), 0, 6)
            .unwrap();

        builder.resolve_pending_calls().unwrap();
        builder.into_graph()
    }

    /// Island function: nobody calls `alone`.
    fn build_island_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();

        builder.set_current_file("island.py".to_string(), "python".to_string());
        builder.process_function_declared("alone".to_string(), 0, 1, None, 0, vec![]).unwrap();

        builder.into_graph()
    }

    #[test]
    fn test_direct_impact_is_parent() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let report = compute_impact(&query, "target", "chain.py");

        assert_eq!(report.direct_impacts.len(), 1);
        assert_eq!(report.direct_impacts[0].name, "parent");
    }

    #[test]
    fn test_transitive_impact_is_grandparent() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let report = compute_impact(&query, "target", "chain.py");

        assert_eq!(report.transitive_impacts.len(), 1);
        assert_eq!(report.transitive_impacts[0].name, "grandparent");
    }

    #[test]
    fn test_depth_levels_are_correct() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let report = compute_impact(&query, "target", "chain.py");

        assert_eq!(*report.impact_depth_levels.get("parent").unwrap(), 1);
        assert_eq!(*report.impact_depth_levels.get("grandparent").unwrap(), 2);
    }

    #[test]
    fn test_total_impact_count() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let report = compute_impact(&query, "target", "chain.py");

        assert_eq!(report.total_impact_count(), 2);
    }

    #[test]
    fn test_cyclic_graph_does_not_loop() {
        let graph = build_cyclic_graph();
        let query = GraphQuery::new(&graph);
        // This must terminate — if cycle detection is broken it hangs forever
        let report = compute_impact(&query, "a", "cyclic.py");
        // `b` calls `a`, so `b` is a direct impact
        assert_eq!(report.direct_impacts.len(), 1);
        assert_eq!(report.direct_impacts[0].name, "b");
        // No infinite loop — total impact is bounded
        assert!(report.total_impact_count() <= 2);
    }

    #[test]
    fn test_island_function_has_no_impact() {
        let graph = build_island_graph();
        let query = GraphQuery::new(&graph);
        let report = compute_impact(&query, "alone", "island.py");

        assert!(report.has_no_impact());
        assert_eq!(report.total_impact_count(), 0);
    }
}