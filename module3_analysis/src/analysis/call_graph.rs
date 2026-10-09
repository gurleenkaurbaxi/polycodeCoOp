use std::collections::HashMap;

use module2_ir_builder::api::GraphQuery;
use module2_ir_builder::api::queries::FunctionInfo;
use serde::{Deserialize, Serialize};

use crate::models::analysis_result::{AnalysisPayload, AnalysisResult, AnalysisType};

// ── Data structures ───────────────────────────────────────────────────────────

/// A directed edge in the call graph: `caller` calls `callee`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub caller: String,
    pub callee: String,
}

/// The full call graph for a file.
/// `nodes` = every function; `edges` = every caller→callee relationship.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallGraph {
    pub file_path: String,
    pub nodes: Vec<FunctionInfo>,
    /// adjacency: function name → list of functions it calls
    pub adjacency: HashMap<String, Vec<String>>,
    pub edges: Vec<CallEdge>,
}

// ── Core logic ────────────────────────────────────────────────────────────────

/// Build a CallGraph for all functions in `file_path`.
pub fn build_call_graph(query: &GraphQuery, file_path: &str) -> CallGraph {
    let functions = query.get_functions(file_path);
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    let mut edges: Vec<CallEdge> = Vec::new();

    for func in &functions {
        // Skip if name is empty — guard against malformed nodes
        if func.name.is_empty() {
            continue;
        }
        let callees = query.find_callees(&func.name, file_path);
        let callee_names: Vec<String> = callees.iter().map(|c| c.name.clone()).collect();

        for callee_name in &callee_names {
            edges.push(CallEdge {
                caller: func.name.clone(),
                callee: callee_name.clone(),
            });
        }

        adjacency.insert(func.name.clone(), callee_names);
    }

    CallGraph {
        file_path: file_path.to_string(),
        nodes: functions,
        adjacency,
        edges,
    }
}

/// Convenience wrapper that returns a full AnalysisResult.
pub fn analyse_call_graph(query: &GraphQuery, file_path: &str) -> AnalysisResult {
    let call_graph = build_call_graph(query, file_path);

    let payload = AnalysisPayload {
        functions: call_graph.nodes,
        classes: Vec::new(),
        dependencies: Vec::new(),
    };

    AnalysisResult::new(AnalysisType::CallGraph, payload)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use module2_ir_builder::{GraphBuilder, IRGraph};

    /// Graph:  entry → process → helper
    fn build_chain_graph() -> IRGraph {
        let mut builder = GraphBuilder::new();
        let ts = 0i64;

        builder.set_current_file("main.py".to_string(), "python".to_string());

        builder.process_function_declared("helper".to_string(), 0, 1, None, ts, vec![]).unwrap();
        builder.process_function_declared("process".to_string(), 0, 5, None, ts, vec![]).unwrap();
        builder.process_function_declared("entry".to_string(), 0, 10, None, ts, vec![]).unwrap();

        builder.process_function_call(Some("process".to_string()), "helper".to_string(), 0, 6).unwrap();
        builder.process_function_call(Some("entry".to_string()), "process".to_string(), 0, 11).unwrap();
        builder.resolve_pending_calls().unwrap();

        builder.into_graph()
    }

    #[test]
    fn test_call_graph_node_count() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let cg = build_call_graph(&query, "main.py");
        assert_eq!(cg.nodes.len(), 3);
    }

    #[test]
    fn test_call_graph_edge_count() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let cg = build_call_graph(&query, "main.py");
        // entry→process and process→helper
        assert_eq!(cg.edges.len(), 2);
    }

    #[test]
    fn test_adjacency_entry_calls_process() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let cg = build_call_graph(&query, "main.py");
        let callees = cg.adjacency.get("entry").expect("entry must exist");
        assert!(callees.contains(&"process".to_string()));
    }

    #[test]
    fn test_adjacency_helper_calls_nobody() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let cg = build_call_graph(&query, "main.py");
        let callees = cg.adjacency.get("helper").expect("helper must exist");
        assert!(callees.is_empty());
    }

    #[test]
    fn test_analyse_call_graph_result_type() {
        let graph = build_chain_graph();
        let query = GraphQuery::new(&graph);
        let result = analyse_call_graph(&query, "main.py");
        assert_eq!(result.analysis_type, AnalysisType::CallGraph);
        assert_eq!(result.summary_stats.total_items, 3);
    }
}