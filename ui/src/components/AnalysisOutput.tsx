import { useState } from "react";
import type { IRGraph, IRNode } from "../types";

const LANG_ICON: Record<string, string> = {
  python:"🐍", java:"☕", go:"🐹", rust:"🦀", ruby:"💎", c:"⚙",
  typescript:"🔷", javascript:"🟨", cpp:"⚙", cs:"🔵",
};

const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;

function StatCard({ icon, value, label, color, sub }: {
  icon: string; value: number | string; label: string; color: string; sub?: string;
}) {
  return (
    <div style={{
      flex: "1 1 130px",
      background: "rgba(14,22,33,0.7)",
      border: `1px solid ${color}30`,
      borderTop: `3px solid ${color}`,
      borderRadius: 10,
      padding: "14px 16px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>{icon}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: 800, color, fontFamily: "monospace", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: "0.65rem", fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "#617891" }}>{label}</div>
      {sub && <div style={{ fontSize: "0.62rem", color: "#617891", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function AnalysisOutput({ ir }: { ir: IRGraph }) {
  const [fnSearch, setFnSearch] = useState("");
  const [fnFilter, setFnFilter] = useState<"all" | "unused" | "used">("all");
  const [crossSearch, setCrossSearch] = useState("");

  const modules   = ir.nodes.filter(n => "Module"   in n.node_type);
  const classes   = ir.nodes.filter(n => "Class"    in n.node_type);
  const functions = ir.nodes.filter(n => "Function" in n.node_type);

  const callEdges   = ir.edges.filter(e => typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object));
  const calledIds   = new Set(callEdges.map(e => e.to));
  const unusedFns   = functions.filter(fn => !calledIds.has(fn.id));

  const nodeById = new Map(ir.nodes.map(n => [n.id, n]));
  const crossFileCalls = callEdges
    .map(e => ({ from: nodeById.get(e.from), to: nodeById.get(e.to) }))
    .filter(({ from, to }) => from && to && from.metadata.file_path !== to.metadata.file_path) as { from: IRNode; to: IRNode }[];
  const uniqueCross = crossFileCalls.filter((c, i, arr) =>
    arr.findIndex(x => x.from.id === c.from.id && x.to.id === c.to.id) === i
  );

  // ── filtered function list ─────────────────────────────────────────────────
  const filteredFns = functions.filter(fn => {
    const data = (fn.node_type as any).Function;
    const name = data?.name ?? "";
    const file = basename(fn.metadata.file_path);
    const matchSearch = !fnSearch || name.toLowerCase().includes(fnSearch.toLowerCase()) || file.toLowerCase().includes(fnSearch.toLowerCase());
    const isUnused = !calledIds.has(fn.id);
    const matchFilter = fnFilter === "all" || (fnFilter === "unused" && isUnused) || (fnFilter === "used" && !isUnused);
    return matchSearch && matchFilter;
  });

  const filteredCross = uniqueCross.filter(({ from, to }) => {
    if (!crossSearch) return true;
    const q = crossSearch.toLowerCase();
    const ff = (from.node_type as any).Function?.name ?? "";
    const tf = (to.node_type as any).Function?.name   ?? "";
    return ff.toLowerCase().includes(q) || tf.toLowerCase().includes(q) ||
      basename(from.metadata.file_path).toLowerCase().includes(q) ||
      basename(to.metadata.file_path).toLowerCase().includes(q);
  });

  // ── language breakdown ────────────────────────────────────────────────────
  const langCount = new Map<string, number>();
  for (const m of modules) {
    const lang = (m.node_type as any).Module?.language ?? "unknown";
    langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, paddingBottom: 32 }}>

      {/* ── Stat cards ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard icon="📂" value={modules.length}    label="Files"     color="#D5B893" sub={[...langCount.entries()].map(([l,c])=>`${LANG_ICON[l]??""} ${c} ${l}`).join("  ")} />
        <StatCard icon="⚙"  value={functions.length}  label="Functions" color="#c46a82" />
        <StatCard icon="🏛" value={classes.length}    label="Classes"   color="#7aaed4" />
        <StatCard icon="⚠"  value={unusedFns.length}  label="Unused fns" color={unusedFns.length > 0 ? "#e07070" : "#4ec94e"} sub={unusedFns.length > 0 ? "potential dead code" : "all functions are called"} />
        <StatCard icon="→"  value={callEdges.length}  label="Call edges" color="#e8c87a" sub={`${uniqueCross.length} cross-file`} />
        <StatCard icon="◈"  value={ir.nodes.length}   label="IR nodes"  color="#6abfb8" sub={`${ir.edges.length} edges`} />
      </div>

      {/* ── Language breakdown ───────────────────────────────────────────────── */}
      {langCount.size > 0 && (
        <div style={{ background: "rgba(14,22,33,0.6)", border: "1px solid rgba(97,120,145,0.15)", borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontSize: "0.62rem", letterSpacing: 2.5, textTransform: "uppercase", color: "#617891", marginBottom: 12 }}>Languages detected</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[...langCount.entries()].map(([lang, count]) => (
              <div key={lang} style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "6px 14px", borderRadius: 20,
                background: "rgba(97,120,145,0.08)",
                border: "1px solid rgba(97,120,145,0.2)",
              }}>
                <span style={{ fontSize: "1.1rem" }}>{LANG_ICON[lang] ?? "📄"}</span>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#cdd6e4" }}>{lang}</span>
                <span style={{ fontSize: "0.7rem", fontFamily: "monospace", color: "#617891" }}>{count} file{count !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Function table ───────────────────────────────────────────────────── */}
      <div style={{ background: "rgba(14,22,33,0.6)", border: "1px solid rgba(97,120,145,0.15)", borderRadius: 10, overflow: "hidden" }}>
        {/* table header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid rgba(97,120,145,0.15)", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: "0.65rem", letterSpacing: 2.5, textTransform: "uppercase", color: "#617891", fontWeight: 700 }}>
            Functions
            <span style={{ marginLeft: 8, fontSize: "0.7rem", fontFamily: "monospace", padding: "1px 7px", borderRadius: 10, background: "rgba(97,120,145,0.15)", color: "#cdd6e4" }}>
              {filteredFns.length}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* filter pills */}
            {(["all", "used", "unused"] as const).map(f => (
              <button key={f} onClick={() => setFnFilter(f)} style={{
                padding: "3px 12px", borderRadius: 14, border: "1px solid",
                fontSize: "0.62rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer",
                background: fnFilter === f ? (f === "unused" ? "rgba(196,106,130,0.2)" : "rgba(213,184,147,0.15)") : "transparent",
                borderColor: fnFilter === f ? (f === "unused" ? "#c46a82" : "#D5B893") : "rgba(97,120,145,0.25)",
                color: fnFilter === f ? (f === "unused" ? "#c46a82" : "#D5B893") : "#617891",
              }}>{f}</button>
            ))}
            <input
              value={fnSearch} onChange={e => setFnSearch(e.target.value)}
              placeholder="Search…"
              style={{ background: "rgba(97,120,145,0.08)", border: "1px solid rgba(97,120,145,0.2)", borderRadius: 6, padding: "4px 10px", color: "#cdd6e4", fontSize: "0.72rem", fontFamily: "ui-monospace,monospace", outline: "none", width: 130 }}
            />
          </div>
        </div>

        {/* column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 60px 60px 60px", padding: "6px 16px", borderBottom: "1px solid rgba(97,120,145,0.1)", fontSize: "0.58rem", letterSpacing: 1.5, textTransform: "uppercase", color: "#617891" }}>
          <span>Name</span><span>File</span><span style={{ textAlign: "center" }}>Params</span><span style={{ textAlign: "center" }}>Line</span><span style={{ textAlign: "center" }}>Status</span>
        </div>

        {/* rows */}
        <div style={{ maxHeight: 340, overflowY: "auto" }}>
          {filteredFns.length === 0
            ? <div style={{ padding: "20px 16px", color: "#617891", fontSize: "0.8rem", textAlign: "center" }}>No functions match</div>
            : filteredFns.map(fn => {
                const data    = (fn.node_type as any).Function;
                const isUsed  = calledIds.has(fn.id);
                const file    = basename(fn.metadata.file_path);
                return (
                  <div key={fn.id} style={{
                    display: "grid", gridTemplateColumns: "1fr 130px 60px 60px 60px",
                    padding: "8px 16px", alignItems: "center",
                    borderBottom: "1px solid rgba(97,120,145,0.07)",
                    transition: "background 0.15s",
                  }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(97,120,145,0.06)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ""}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: isUsed ? "#4ec94e" : "#c46a82", flexShrink: 0 }} />
                      <span style={{ fontFamily: "ui-monospace,monospace", fontSize: "0.82rem", color: "#e8dcc8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {data?.name ?? "?"}
                        {data?.is_async && <span style={{ marginLeft: 6, fontSize: "0.58rem", padding: "1px 5px", borderRadius: 3, background: "rgba(107,191,184,0.15)", border: "1px solid rgba(107,191,184,0.3)", color: "#6abfb8", fontStyle: "normal" }}>async</span>}
                      </span>
                    </span>
                    <span style={{ fontSize: "0.7rem", color: "#617891", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fn.metadata.file_path}>{file}</span>
                    <span style={{ textAlign: "center", fontSize: "0.72rem", color: "#617891", fontFamily: "monospace" }}>{data?.param_count ?? 0}</span>
                    <span style={{ textAlign: "center", fontSize: "0.72rem", color: "#617891", fontFamily: "monospace" }}>{fn.metadata.line_number}</span>
                    <span style={{ textAlign: "center" }}>
                      <span style={{
                        fontSize: "0.55rem", fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        background: isUsed ? "rgba(78,201,78,0.12)"    : "rgba(196,106,130,0.15)",
                        border:     isUsed ? "1px solid rgba(78,201,78,0.3)"  : "1px solid rgba(196,106,130,0.35)",
                        color:      isUsed ? "#4ec94e"  : "#c46a82",
                        letterSpacing: 1, textTransform: "uppercase",
                      }}>
                        {isUsed ? "used" : "unused"}
                      </span>
                    </span>
                  </div>
                );
              })
          }
        </div>
      </div>

      {/* ── Cross-file calls ─────────────────────────────────────────────────── */}
      <div style={{ background: "rgba(14,22,33,0.6)", border: "1px solid rgba(97,120,145,0.15)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid rgba(97,120,145,0.15)" }}>
          <div style={{ fontSize: "0.65rem", letterSpacing: 2.5, textTransform: "uppercase", color: "#617891", fontWeight: 700 }}>
            Cross-file Calls
            <span style={{ marginLeft: 8, fontSize: "0.7rem", fontFamily: "monospace", padding: "1px 7px", borderRadius: 10, background: "rgba(232,200,122,0.1)", border: "1px solid rgba(232,200,122,0.2)", color: "#e8c87a" }}>
              {filteredCross.length}
            </span>
          </div>
          {uniqueCross.length > 0 && (
            <input value={crossSearch} onChange={e => setCrossSearch(e.target.value)} placeholder="Filter…"
              style={{ background: "rgba(97,120,145,0.08)", border: "1px solid rgba(97,120,145,0.2)", borderRadius: 6, padding: "4px 10px", color: "#cdd6e4", fontSize: "0.72rem", fontFamily: "ui-monospace,monospace", outline: "none", width: 110 }} />
          )}
        </div>
        <div style={{ maxHeight: 240, overflowY: "auto" }}>
          {uniqueCross.length === 0
            ? <div style={{ padding: "16px 20px", color: "#4ec94e", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: 8 }}>
                <span>✓</span> No cross-file dependencies — all files are self-contained
              </div>
            : filteredCross.map(({ from, to }, i) => {
                const fromFn = (from.node_type as any).Function?.name ?? from.id.slice(0,8);
                const toFn   = (to.node_type as any).Function?.name   ?? to.id.slice(0,8);
                const fromFile = basename(from.metadata.file_path);
                const toFile   = basename(to.metadata.file_path);
                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
                    borderBottom: "1px solid rgba(97,120,145,0.07)",
                    fontSize: "0.78rem",
                  }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                      <span style={{ fontFamily: "ui-monospace,monospace", color: "#e8dcc8", fontWeight: 600 }}>{fromFn}</span>
                      <span style={{ fontSize: "0.64rem", color: "#617891" }}>{fromFile}</span>
                    </div>
                    <span style={{ color: "#e8c87a", fontSize: "1.1rem", flexShrink: 0 }}>→</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                      <span style={{ fontFamily: "ui-monospace,monospace", color: "#e8dcc8", fontWeight: 600 }}>{toFn}</span>
                      <span style={{ fontSize: "0.64rem", color: "#617891" }}>{toFile}</span>
                    </div>
                    <span style={{ fontSize: "0.6rem", color: "#617891", flexShrink: 0 }}>line {from.metadata.line_number}</span>
                  </div>
                );
              })
          }
        </div>
      </div>

    </div>
  );
}
