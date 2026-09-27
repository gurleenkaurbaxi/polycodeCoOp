import { useState } from "react";
import type { Suggestion, AnalysisStats } from "../types";

const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export default function FixSuggester({ suggestions, stats }: { suggestions: Suggestion[]; stats: AnalysisStats }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied,   setCopied]   = useState<number | null>(null);
  const [search,   setSearch]   = useState("");

  const filtered = suggestions.filter(s =>
    !search ||
    s.function.toLowerCase().includes(search.toLowerCase()) ||
    basename(s.file).toLowerCase().includes(search.toLowerCase())
  );

  const handleCopy = (s: Suggestion, e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(s.suggestion);
    setCopied(s.id);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 32 }}>

      {/* ── Header banner ─────────────────────────────────────────────────── */}
      <div style={{
        background: "linear-gradient(135deg, rgba(99,32,36,0.18), rgba(14,22,33,0.8))",
        border: "1px solid rgba(196,106,130,0.25)",
        borderLeft: "3px solid #c46a82",
        borderRadius: 10,
        padding: "16px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: "1.3rem" }}>✦</span>
            <span style={{ fontSize: "0.9rem", fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: "#D5B893" }}>AI Fix Suggestions</span>
            <span style={{ fontSize: "0.6rem", padding: "2px 8px", borderRadius: 10, background: "rgba(196,106,130,0.2)", border: "1px solid rgba(196,106,130,0.35)", color: "#c46a82", fontWeight: 700 }}>
              Powered by Groq
            </span>
          </div>
          <div style={{ fontSize: "0.72rem", color: "#617891" }}>
            Analysed <strong style={{ color: "#cdd6e4" }}>{stats.files_parsed}</strong> files ·
            Found <strong style={{ color: "#c46a82" }}>{stats.total_findings}</strong> dead code locations ·
            Source: <strong style={{ color: "#cdd6e4", fontFamily: "monospace" }}>{stats.source.replace(/https?:\/\/(github|gitlab)\.com\//, "")}</strong>
          </div>
        </div>

        {/* summary pills */}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(196,106,130,0.1)", border: "1px solid rgba(196,106,130,0.2)", textAlign: "center" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "#c46a82", fontFamily: "monospace" }}>{suggestions.length}</div>
            <div style={{ fontSize: "0.58rem", color: "#617891", textTransform: "uppercase", letterSpacing: 1 }}>fixes</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(232,200,122,0.08)", border: "1px solid rgba(232,200,122,0.18)", textAlign: "center" }}>
            <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "#e8c87a", fontFamily: "monospace" }}>
              {new Set(suggestions.map(s => basename(s.file))).size}
            </div>
            <div style={{ fontSize: "0.58rem", color: "#617891", textTransform: "uppercase", letterSpacing: 1 }}>files</div>
          </div>
        </div>
      </div>

      {/* ── Search + count ────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by function or file…"
            style={{ flex: 1, maxWidth: 320, background: "rgba(97,120,145,0.08)", border: "1px solid rgba(97,120,145,0.2)", borderRadius: 7, padding: "7px 12px", color: "#cdd6e4", fontSize: "0.78rem", fontFamily: "ui-monospace,monospace", outline: "none" }}
          />
          <span style={{ fontSize: "0.68rem", color: "#617891" }}>
            {filtered.length} of {suggestions.length} showing — click a card to expand
          </span>
        </div>
      )}

      {/* ── Cards ─────────────────────────────────────────────────────────── */}
      {suggestions.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#4ec94e", fontSize: "0.9rem", border: "1px solid rgba(78,201,78,0.2)", borderRadius: 10, background: "rgba(78,201,78,0.05)" }}>
          ✓ No dead code found — the codebase looks clean!
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((s, idx) => {
            const isOpen = expanded === s.id;
            const isCopied = copied === s.id;
            const file = basename(s.file);
            return (
              <div key={s.id} onClick={() => setExpanded(isOpen ? null : s.id)}
                style={{
                  border: `1px solid ${isOpen ? "rgba(196,106,130,0.45)" : "rgba(97,120,145,0.15)"}`,
                  borderLeft: `3px solid ${isOpen ? "#c46a82" : "rgba(196,106,130,0.4)"}`,
                  borderRadius: 9,
                  background: isOpen ? "rgba(196,106,130,0.06)" : "rgba(14,22,33,0.5)",
                  cursor: "pointer",
                  transition: "all 0.18s",
                  overflow: "hidden",
                }}
                onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.borderColor = "rgba(97,120,145,0.35)"; }}
                onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.borderColor = "rgba(97,120,145,0.15)"; }}
              >
                {/* card header */}
                <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", gap: 12 }}>

                  {/* index */}
                  <span style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(196,106,130,0.15)", border: "1px solid rgba(196,106,130,0.3)", color: "#c46a82", fontSize: "0.7rem", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {idx + 1}
                  </span>

                  {/* badge */}
                  <span style={{ fontSize: "0.56rem", fontWeight: 700, letterSpacing: 1.5, padding: "3px 8px", borderRadius: 4, background: "rgba(99,32,36,0.35)", border: "1px solid rgba(196,106,130,0.4)", color: "#ff9999", flexShrink: 0 }}>
                    DEAD CODE
                  </span>

                  {/* function name */}
                  <span style={{ fontFamily: "ui-monospace,'Cascadia Code',monospace", fontSize: "0.88rem", fontWeight: 700, color: "#e8dcc8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.function}
                    <span style={{ marginLeft: 8, fontSize: "0.65rem", color: "#617891", fontWeight: 400 }}>line {s.line}</span>
                  </span>

                  {/* file */}
                  <span style={{ fontSize: "0.7rem", color: "#617891", fontFamily: "monospace", flexShrink: 0, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.file}>
                    {file}
                  </span>

                  {/* copy button */}
                  <button onClick={e => handleCopy(s, e)}
                    title="Copy suggestion"
                    style={{ padding: "4px 10px", borderRadius: 5, background: isCopied ? "rgba(78,201,78,0.15)" : "rgba(97,120,145,0.1)", border: `1px solid ${isCopied ? "rgba(78,201,78,0.35)" : "rgba(97,120,145,0.25)"}`, color: isCopied ? "#4ec94e" : "#617891", fontSize: "0.65rem", cursor: "pointer", transition: "all 0.2s", flexShrink: 0, fontWeight: 600 }}>
                    {isCopied ? "✓ Copied" : "Copy"}
                  </button>

                  {/* chevron */}
                  <span style={{ color: "#617891", fontSize: "0.7rem", flexShrink: 0, transform: isOpen ? "rotate(180deg)" : "", transition: "transform 0.2s" }}>▼</span>
                </div>

                {/* expanded body */}
                {isOpen && (
                  <div style={{ padding: "0 16px 16px", borderTop: "1px solid rgba(97,120,145,0.15)", marginTop: 0 }}>

                    {/* filepath */}
                    <div style={{ padding: "10px 0 14px", fontSize: "0.68rem", color: "#617891", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#e8c87a" }}>📁</span>
                      <span style={{ wordBreak: "break-all" }}>{s.file}</span>
                      <span style={{ marginLeft: "auto", background: "rgba(232,200,122,0.1)", border: "1px solid rgba(232,200,122,0.2)", borderRadius: 4, padding: "1px 7px", color: "#e8c87a", flexShrink: 0 }}>line {s.line}</span>
                    </div>

                    {/* AI suggestion */}
                    <div style={{
                      background: "rgba(8,14,24,0.7)",
                      border: "1px solid rgba(97,120,145,0.2)",
                      borderRadius: 8,
                      padding: "14px 16px",
                    }}>
                      <div style={{ fontSize: "0.58rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ color: "#D5B893" }}>✦</span> AI Recommendation
                      </div>
                      <p style={{ fontSize: "0.82rem", color: "#a8bfd4", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" }}>
                        {s.suggestion}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
