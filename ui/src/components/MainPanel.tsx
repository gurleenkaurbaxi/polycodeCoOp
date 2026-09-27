import { useState } from "react";
import "../App.css";
import AnalysisOutput from "./AnalysisOutput";
import DependencyGraph from "./DependencyGraph";
import FixSuggester from "./FixSuggester";
import type { AnalysisResult } from "../types";

interface Props {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
}

const TABS = [
  { id: "overview", label: "Overview",       icon: "◈" },
  { id: "graph",    label: "Dependency Graph", icon: "⬡" },
  { id: "fixes",    label: "AI Fixes",        icon: "✦" },
] as const;

type TabId = typeof TABS[number]["id"];

export default function MainPanel({ result, loading, error }: Props) {
  const [tab, setTab] = useState<TabId>("overview");

  if (loading) {
    return (
      <main className="main-content main-content--center">
        <div className="loading-state">
          <div className="loading-spinner" />
          <p className="loading-text">Analysing repository…</p>
          <p className="loading-sub">Parsing files, building IR graph, generating AI suggestions</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="main-content main-content--center">
        <div className="error-state">
          <div className="error-icon">⚠</div>
          <p className="error-title">Analysis failed</p>
          <p className="error-msg">{error}</p>
        </div>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="main-content main-content--center">
        <div className="empty-state">
          <div className="empty-icon">⬡</div>
          <p className="empty-title">No analysis yet</p>
          <p className="empty-sub">Upload a file or paste a GitHub repo URL in the sidebar</p>
        </div>
      </main>
    );
  }

  const fnCount  = result.ir.nodes.filter(n => "Function" in n.node_type).length;
  const modCount = result.ir.nodes.filter(n => "Module"   in n.node_type).length;
  const callEdges = result.ir.edges.filter(e =>
    typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object)
  );
  const calledIds = new Set(callEdges.map(e => e.to));
  const unusedCount = result.ir.nodes
    .filter(n => "Function" in n.node_type && !calledIds.has(n.id)).length;

  const tabBadge: Record<TabId, string | null> = {
    overview: String(modCount),
    graph:    String(result.ir.nodes.length),
    fixes:    result.suggestions.length > 0 ? String(result.suggestions.length) : null,
  };

  return (
    <main className="main-content main-content--tabs">

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <div className="tab-bar">
        <div className="tab-bar-inner">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? "tab-btn--active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="tab-icon">{t.icon}</span>
              {t.label}
              {tabBadge[t.id] && (
                <span className={`tab-badge ${t.id === "fixes" && unusedCount > 0 ? "tab-badge--warn" : ""}`}>
                  {tabBadge[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* quick stats strip */}
        <div className="tab-stats">
          <span className="tab-stat"><span style={{ color: "#D5B893" }}>⬚</span> {modCount} files</span>
          <span className="tab-stat"><span style={{ color: "#c46a82" }}>◉</span> {fnCount} fns</span>
          <span className="tab-stat"><span style={{ color: "#e8c87a" }}>→</span> {callEdges.length} calls</span>
          {unusedCount > 0 && (
            <span className="tab-stat tab-stat--warn">⚠ {unusedCount} unused</span>
          )}
        </div>
      </div>

      {/* ── Tab panels ─────────────────────────────────────────────────────── */}
      <div className="tab-panels">
        {tab === "overview" && (
          <div className="tab-panel">
            <AnalysisOutput ir={result.ir} />
          </div>
        )}
        {tab === "graph" && (
          <div className="tab-panel tab-panel--graph">
            <DependencyGraph ir={result.ir} />
          </div>
        )}
        {tab === "fixes" && (
          <div className="tab-panel">
            <FixSuggester suggestions={result.suggestions} stats={result.stats} />
          </div>
        )}
      </div>
    </main>
  );
}
