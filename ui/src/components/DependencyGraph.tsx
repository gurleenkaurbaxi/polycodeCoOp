import { useRef, useState, useCallback, useEffect } from "react";
import CytoscapeComponent from "react-cytoscapejs";
import cytoscape from "cytoscape";
// @ts-ignore
import fcose from "cytoscape-fcose";
import type { IRGraph, IRNode } from "../types";

if (!(cytoscape as any)._fcoseRegistered) {
  cytoscape.use(fcose);
  (cytoscape as any)._fcoseRegistered = true;
}

const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;
const SOURCE_EXTS = /\.(py|java|go|rs|rb|c|h|ts|js|cpp|cs)$/i;

const LANG_META: Record<string, { icon: string; color: string }> = {
  python:     { icon: "🐍", color: "#3572A5" },
  java:       { icon: "☕", color: "#b07219" },
  go:         { icon: "🐹", color: "#00ADD8" },
  rust:       { icon: "🦀", color: "#dea584" },
  ruby:       { icon: "💎", color: "#701516" },
  c:          { icon: "⚙",  color: "#888" },
  typescript: { icon: "🔷", color: "#3178c6" },
  javascript: { icon: "🟨", color: "#c8b400" },
};

const FILE_PALETTE = [
  "#7aaed4","#6abfb8","#c9a260","#a87ad4","#d47a9e",
  "#7ad4a0","#d4a87a","#7ab8d4","#d47a7a","#aad47a",
];

const SCOPE_CAP = 35;
type ViewMode = "filemap" | "scope";

// ── per-file stats (plain function, not a hook) ───────────────────────────────
function deriveFileStats(ir: IRGraph) {
  const callEdges = ir.edges.filter(e =>
    typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object)
  );
  const calledIds = new Set(callEdges.map(e => e.to));
  const nodeById  = new Map(ir.nodes.map(n => [n.id, n]));
  const fnPerFile = new Map<string,number>();
  const unusedPF  = new Map<string,number>();
  const classPF   = new Map<string,number>();

  for (const n of ir.nodes) {
    const fp = n.metadata.file_path;
    if ("Function" in n.node_type) {
      fnPerFile.set(fp, (fnPerFile.get(fp) ?? 0) + 1);
      if (!calledIds.has(n.id)) unusedPF.set(fp, (unusedPF.get(fp) ?? 0) + 1);
    }
    if ("Class" in n.node_type) classPF.set(fp, (classPF.get(fp) ?? 0) + 1);
  }

  const connectedModIds = new Set<string>();
  for (const e of callEdges) {
    const f = nodeById.get(e.from); const t = nodeById.get(e.to);
    if (!f || !t || f.metadata.file_path === t.metadata.file_path) continue;
    for (const m of ir.nodes) {
      if (!("Module" in m.node_type)) continue;
      const fp = (m.node_type as any).Module?.file_path ?? "";
      if (fp === f.metadata.file_path || fp === t.metadata.file_path) connectedModIds.add(m.id);
    }
  }

  return ir.nodes
    .filter(n => "Module" in n.node_type && SOURCE_EXTS.test((n.node_type as any).Module?.file_path ?? ""))
    .map(n => {
      const fp   = (n.node_type as any).Module?.file_path ?? "";
      const lang = (n.node_type as any).Module?.language ?? "";
      return { id: n.id, path: fp, name: basename(fp), language: lang,
        fnCount: fnPerFile.get(fp) ?? 0, classCount: classPF.get(fp) ?? 0,
        unusedCount: unusedPF.get(fp) ?? 0, hasConnections: connectedModIds.has(n.id) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── file-map connection graph (only cross-file linked files) ──────────────────
function buildConnGraph(ir: IRGraph, stats: ReturnType<typeof deriveFileStats>) {
  const nodeById   = new Map(ir.nodes.map(n => [n.id, n]));
  const fileToMod  = new Map(stats.map(s => [s.path, s.id]));
  const callEdges  = ir.edges.filter(e =>
    typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object)
  );

  const nodes = stats.filter(s => s.hasConnections).map(s => ({
    data: { id: s.id, label: s.name, kind: "FileNode", unusedCount: s.unusedCount }
  }));

  const weights = new Map<string,number>();
  for (const e of callEdges) {
    const f = nodeById.get(e.from); const t = nodeById.get(e.to);
    if (!f || !t || f.metadata.file_path === t.metadata.file_path) continue;
    const sm = fileToMod.get(f.metadata.file_path); const tm = fileToMod.get(t.metadata.file_path);
    if (!sm || !tm) continue;
    const k = `${sm}→${tm}`; weights.set(k, (weights.get(k) ?? 0) + 1);
  }

  const edges: cytoscape.ElementDefinition[] = [];
  let i = 0;
  for (const [pair, w] of weights) {
    const [src, tgt] = pair.split("→");
    edges.push({ data: { id: `fe-${i++}`, source: src, target: tgt, kind: "FileEdge", label: String(w) } });
  }
  return [...nodes, ...edges];
}

// ── scope graph (one file + 1-hop neighbours) ─────────────────────────────────
function buildScopeGraph(ir: IRGraph, selectedPath: string, showAll: boolean) {
  const callEdges  = ir.edges.filter(e =>
    typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object)
  );
  const calledIds  = new Set(callEdges.map(e => e.to));
  const callerIds  = new Set(callEdges.map(e => e.from));
  const nodeById   = new Map(ir.nodes.map(n => [n.id, n]));

  const SKIP = new Set(["Module","Variable","Lambda","ControlFlow"]);
  const allHome = ir.nodes.filter(n =>
    n.metadata.file_path === selectedPath && !SKIP.has(Object.keys(n.node_type)[0])
  );

  // cross-file node ids
  const crossIds = new Set<string>();
  for (const e of callEdges) {
    const f = nodeById.get(e.from); const t = nodeById.get(e.to);
    if (!f || !t) continue;
    if (f.metadata.file_path === selectedPath && t.metadata.file_path !== selectedPath) crossIds.add(e.from);
    if (t.metadata.file_path === selectedPath && f.metadata.file_path !== selectedPath) crossIds.add(e.to);
  }

  const unusedIds = new Set(allHome.filter(n => !calledIds.has(n.id) && "Function" in n.node_type).map(n => n.id));
  const intraIds  = new Set(allHome.filter(n => calledIds.has(n.id) || callerIds.has(n.id)).map(n => n.id));

  const pri = (n: IRNode) => {
    const k = Object.keys(n.node_type)[0];
    if (["Class","Interface","Enum"].includes(k)) return 0;
    if (crossIds.has(n.id))  return 1;
    if (unusedIds.has(n.id)) return 2;
    if (intraIds.has(n.id))  return 3;
    return 4;
  };

  const sorted      = [...allHome].sort((a, b) => pri(a) - pri(b));
  const homeNodes   = showAll ? sorted : sorted.slice(0, SCOPE_CAP);
  const hiddenCount = showAll ? 0 : Math.max(0, sorted.length - SCOPE_CAP);
  const hiddenIsolated = showAll ? 0 : sorted.slice(SCOPE_CAP).filter(n => pri(n) === 4).length;
  const homeIds     = new Set(homeNodes.map(n => n.id));

  const outEdges = callEdges.filter(e => homeIds.has(e.from) && nodeById.get(e.to)?.metadata.file_path !== selectedPath);
  const inEdges  = callEdges.filter(e => nodeById.get(e.from)?.metadata.file_path !== selectedPath && homeIds.has(e.to));

  const extIds   = new Set([...outEdges.map(e => e.to), ...inEdges.map(e => e.from)]);
  const extNodes = [...extIds].map(id => nodeById.get(id))
    .filter((n): n is IRNode => !!n && !SKIP.has(Object.keys(n.node_type)[0]));
  const extFiles = [...new Set(extNodes.map(n => n.metadata.file_path))];
  const fileColor = new Map(extFiles.map((fp, i) => [fp, FILE_PALETTE[i % FILE_PALETTE.length]]));

  const els: cytoscape.ElementDefinition[] = [];

  // home container
  els.push({ data: { id: "home-container", label: basename(selectedPath), kind: "HomeContainer" } });

  // home nodes
  for (const n of homeNodes) {
    const k   = Object.keys(n.node_type)[0];
    const raw = (n.node_type as any)[k]?.name ?? "?";
    els.push({ data: { id: n.id, label: raw, kind: k, parent: "home-container", used: calledIds.has(n.id) ? "yes" : "no" } });
  }

  // external containers + nodes
  for (const fp of extFiles) {
    els.push({ data: { id: `ext-${fp}`, label: basename(fp), kind: "ExtContainer", fileColor: fileColor.get(fp) ?? "#617891" } });
  }
  for (const n of extNodes) {
    const k   = Object.keys(n.node_type)[0];
    if (["Variable","Lambda","ControlFlow","Module"].includes(k)) continue;
    const raw = (n.node_type as any)[k]?.name ?? "?";
    const fp  = n.metadata.file_path;
    els.push({ data: { id: n.id, label: raw, kind: `Ext_${k}`, parent: `ext-${fp}`, fileColor: fileColor.get(fp) ?? "#617891" } });
  }

  // edges — only between nodes actually drawn (Cytoscape throws on dangling ends)
  const drawnIds = new Set(els.map(el => el.data.id));
  const seen = new Set<string>();
  for (const e of [...outEdges, ...inEdges]) {
    const key = `${e.from}→${e.to}`;
    if (seen.has(key)) continue; seen.add(key);
    if (!drawnIds.has(e.from) || !drawnIds.has(e.to)) continue;
    els.push({ data: { id: `se-${key}`, source: e.from, target: e.to, kind: outEdges.includes(e) ? "OutCall" : "InCall" } });
  }

  return { elements: els, extFiles, fileColor, hiddenCount, hiddenIsolated, totalHome: allHome.length };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DependencyGraph({ ir }: { ir: IRGraph }) {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [view,         setView]         = useState<ViewMode>("filemap");
  const [search,       setSearch]       = useState("");
  const [selectedFile, setSelectedFile] = useState<ReturnType<typeof deriveFileStats>[number] | null>(null);
  const [scopePath,    setScopePath]    = useState("");
  const [showAll,      setShowAll]      = useState(false);

  const fileStats    = deriveFileStats(ir);
  const connElements = buildConnGraph(ir, fileStats);

  useEffect(() => { if (!scopePath && fileStats.length > 0) setScopePath(fileStats[0].path); }, [fileStats.length]);
  useEffect(() => { setShowAll(false); }, [scopePath]);

  const { elements: scopeEls, extFiles, fileColor, hiddenCount, hiddenIsolated, totalHome } =
    scopePath
      ? buildScopeGraph(ir, scopePath, showAll)
      : { elements: [], extFiles: [], fileColor: new Map(), hiddenCount: 0, hiddenIsolated: 0, totalHome: 0 };

  const callEdges   = ir.edges.filter(e => typeof e.edge_type === "object" && e.edge_type !== null && "Calls" in (e.edge_type as object));
  const calledIds   = new Set(callEdges.map(e => e.to));
  const filtered    = search ? fileStats.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.language.toLowerCase().includes(search.toLowerCase())) : fileStats;
  const totalUnused = fileStats.reduce((a, s) => a + s.unusedCount, 0);
  const scopeStat   = fileStats.find(s => s.path === scopePath);

  // ── layouts ──────────────────────────────────────────────────────────────────
  const connLayout = {
    name: "fcose", animate: true, animationDuration: 500, quality: "proof",
    randomize: true, nodeSeparation: 120, idealEdgeLength: () => 200,
    edgeElasticity: () => 0.4, nodeRepulsion: () => 8000,
    gravity: 0.25, gravityRange: 3, numIter: 2000, fit: true, padding: 60,
  };
  const scopeLayout = {
    name: "fcose", animate: true, animationDuration: 500, quality: "proof",
    randomize: true, nodeSeparation: 55, idealEdgeLength: () => 130,
    edgeElasticity: () => 0.45, nodeRepulsion: () => 10000,
    gravityCompound: 1.5, gravityRangeCompound: 1.5,
    gravity: 0.4, gravityRange: 3.5, numIter: 2500, fit: true, padding: 50,
  };

  // ── stylesheets ──────────────────────────────────────────────────────────────
  const connStyle = [
    { selector: "node[kind='FileNode']", style: { shape: "roundrectangle", label: "data(label)", "font-family": "ui-monospace,monospace", "font-size": "13px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#e8dcc8", "background-color": "#121e30", "border-width": 2, "border-color": "#D5B893", "border-opacity": 0.65, width: 160, height: 52, "text-wrap": "ellipsis", "text-max-width": "140px" } as any },
    { selector: "node[?unusedCount]", style: { "border-color": "#c46a82", "border-opacity": 0.9, "border-width": 2.5 } as any },
    { selector: "edge[kind='FileEdge']", style: { label: "data(label)", "font-size": "11px", "font-weight": "700", color: "#e8c87a", "text-background-color": "#080e18", "text-background-opacity": 0.92, "text-background-shape": "roundrectangle", "text-background-padding": "4px", "line-color": "#e8c87a", "target-arrow-color": "#e8c87a", "target-arrow-shape": "triangle", "arrow-scale": 1.5, "curve-style": "bezier", width: 2.5, opacity: 0.9 } as any },
    { selector: "node:selected", style: { "border-color": "#fff", "border-width": 3, "border-opacity": 1, "overlay-opacity": 0 } as any },
    { selector: ".dimmed", style: { opacity: 0.08 } as any },
    { selector: ".highlighted", style: { opacity: 1 } as any },
  ];

  const scopeStyle = [
    { selector: "node[kind='HomeContainer']", style: { shape: "roundrectangle", label: "data(label)", "font-size": "13px", "font-weight": "800", "text-valign": "top" as const, "text-margin-y": -6, color: "#D5B893", "text-background-color": "#050d18", "text-background-opacity": 0.95, "text-background-shape": "roundrectangle", "text-background-padding": "5px", "background-color": "#0a1830", "background-opacity": 0.7, "border-style": "solid", "border-color": "#D5B893", "border-width": 2, padding: "32px" } as any },
    { selector: "node[kind='ExtContainer']", style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "700", "text-valign": "top" as const, "text-margin-y": -6, color: "data(fileColor)", "text-background-color": "#050d18", "text-background-opacity": 0.95, "text-background-shape": "roundrectangle", "text-background-padding": "4px", "background-color": "#0a1020", "background-opacity": 0.6, "border-style": "dashed", "border-color": "data(fileColor)", "border-width": 1.5, "border-opacity": 0.6, padding: "28px" } as any },
    { selector: 'node[kind="Function"][used="yes"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#0f0a12", "background-color": "#c46a82", "border-width": 0, width: "label", height: "label", padding: "7px 12px" } as any },
    { selector: 'node[kind="Function"][used="no"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#cdd6e4", "background-color": "#2a1a22", "border-width": 1.5, "border-color": "#7a3050", "border-style": "dashed", width: "label", height: "label", padding: "7px 12px" } as any },
    { selector: 'node[kind="Class"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#0d1826", "background-color": "#7aaed4", "border-width": 0, width: "label", height: "label", padding: "7px 12px" } as any },
    { selector: 'node[kind="Interface"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#081616", "background-color": "#6abfb8", "border-width": 0, width: "label", height: "label", padding: "7px 12px" } as any },
    { selector: 'node[kind="Enum"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "11px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#140e00", "background-color": "#c9a260", "border-width": 0, width: "label", height: "label", padding: "7px 12px" } as any },
    { selector: 'node[kind="Ext_Function"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "10px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#080808", "background-color": "data(fileColor)", "border-width": 0, width: "label", height: "label", padding: "6px 10px", opacity: 0.85 } as any },
    { selector: 'node[kind="Ext_Class"]', style: { shape: "roundrectangle", label: "data(label)", "font-size": "10px", "font-weight": "600", "text-valign": "center" as const, "text-halign": "center" as const, color: "#080808", "background-color": "data(fileColor)", "border-width": 0, width: "label", height: "label", padding: "6px 10px", opacity: 0.7 } as any },
    { selector: "edge[kind='OutCall']", style: { "line-color": "#e8c87a", "target-arrow-color": "#e8c87a", "target-arrow-shape": "triangle", "arrow-scale": 1.4, "curve-style": "bezier", width: 2, opacity: 0.85 } as any },
    { selector: "edge[kind='InCall']",  style: { "line-color": "#7aaed4", "target-arrow-color": "#7aaed4", "target-arrow-shape": "triangle", "arrow-scale": 1.4, "curve-style": "bezier", width: 1.5, opacity: 0.65, "line-style": "dashed", "line-dash-pattern": [6, 4] } as any },
    { selector: "node:selected", style: { "border-width": 3, "border-color": "#fff", "border-opacity": 1, "overlay-opacity": 0 } as any },
    { selector: ".dimmed",       style: { opacity: 0.07 } as any },
    { selector: ".highlighted",  style: { opacity: 1 } as any },
  ];

  const CONTAINER_KINDS = new Set(["HomeContainer", "ExtContainer", "FileNode"]);

  const handleCy = useCallback((cy: cytoscape.Core) => {
    cyRef.current = cy;
    cy.on("tap", evt => { if (evt.target === cy) cy.elements().removeClass("dimmed highlighted"); });
    cy.on("mouseover", "node", evt => {
      const n = evt.target;
      const k = n.data("kind") ?? "";
      if (CONTAINER_KINDS.has(k)) return;

      // dim everything except containers (they stay fully visible as structural context)
      cy.elements().addClass("dimmed");
      cy.nodes().filter(nd => CONTAINER_KINDS.has(nd.data("kind") ?? "")).removeClass("dimmed");

      // highlight the hovered node, its edges, its neighbours, and its parent container
      n.removeClass("dimmed").addClass("highlighted");
      n.neighborhood().removeClass("dimmed").addClass("highlighted");

      // also un-dim the parent compound node so the box stays visible
      const parentId = n.data("parent");
      if (parentId) cy.getElementById(parentId).removeClass("dimmed").addClass("highlighted");
    });
    cy.on("mouseout", "node", () => cy.elements().removeClass("dimmed highlighted"));
  }, []);

  const zoomBtns = [
    { icon: "+", title: "Zoom in",       fn: () => { const cy = cyRef.current; if (cy) cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }); } },
    { icon: "−", title: "Zoom out",      fn: () => { const cy = cyRef.current; if (cy) cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }); } },
    { icon: "⊡", title: "Fit to screen", fn: () => cyRef.current?.fit(undefined, 40) },
    { icon: "⟳", title: "Re-layout",     fn: () => cyRef.current?.layout(view === "filemap" ? connLayout as any : scopeLayout as any).run() },
  ];

  const statItems = view === "filemap"
    ? [
        { label: "Files",     val: fileStats.length,                                color: "#D5B893" },
        { label: "Unused",    val: totalUnused,                                     color: totalUnused > 0 ? "#c46a82" : "#4ec94e" },
        { label: "File deps", val: fileStats.filter(s => s.hasConnections).length,  color: "#e8c87a" },
      ]
    : [
        { label: "Shown",  val: totalHome - hiddenCount,          color: "#D5B893" },
        { label: "Hidden", val: hiddenCount,                      color: hiddenCount > 0 ? "#617891" : "#4ec94e" },
        { label: "Unused", val: scopeStat?.unusedCount ?? 0,      color: (scopeStat?.unusedCount ?? 0) > 0 ? "#c46a82" : "#4ec94e" },
      ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0f18", overflow: "hidden" }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1px solid rgba(97,120,145,0.2)", background: "rgba(10,16,24,0.85)", flexShrink: 0, flexWrap: "wrap" }}>
        <div className="graph-view-toggle">
          <button className={`graph-view-btn ${view === "filemap" ? "active" : ""}`} onClick={() => setView("filemap")}>⬡ File Browser</button>
          <button className={`graph-view-btn ${view === "scope"   ? "active" : ""}`} onClick={() => setView("scope")  }>◎ File Scope</button>
        </div>

        <div style={{ width: 1, height: 22, background: "rgba(97,120,145,0.2)", flexShrink: 0 }} />

        {view === "filemap"
          ? <input className="graph-search" placeholder="Search files…" value={search} onChange={e => setSearch(e.target.value)} />
          : (
            <select value={scopePath} onChange={e => setScopePath(e.target.value)}
              style={{ background: "rgba(14,22,33,0.9)", border: "1px solid rgba(97,120,145,0.3)", borderRadius: 6, padding: "5px 10px", color: "#e8dcc8", fontSize: "0.78rem", fontFamily: "ui-monospace,monospace", outline: "none", cursor: "pointer", maxWidth: 280 }}>
              {fileStats.map(s => (
                <option key={s.id} value={s.path}>{s.unusedCount > 0 ? "⚠ " : ""}{s.name}  ({s.fnCount} fns{s.unusedCount > 0 ? `, ${s.unusedCount} unused` : ""})</option>
              ))}
            </select>
          )
        }

        <div style={{ display: "flex", gap: 16, marginLeft: "auto", flexWrap: "wrap" }}>
          {statItems.map(s => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <span style={{ fontSize: "1rem", fontWeight: 700, color: s.color, fontFamily: "monospace", lineHeight: 1.1 }}>{s.val}</span>
              <span style={{ fontSize: "0.55rem", color: "#617891", letterSpacing: 1, textTransform: "uppercase" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {view === "filemap" ? (

          /* FILE BROWSER ─────────────────────────────────────────────────── */
          <>
            {/* Left: file list */}
            <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid rgba(97,120,145,0.18)", overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ fontSize: "0.58rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", padding: "2px 6px 6px", borderBottom: "1px solid rgba(97,120,145,0.12)", marginBottom: 2 }}>
                {filtered.length} / {fileStats.length} files
              </div>
              {filtered.map(s => {
                const meta = LANG_META[s.language] ?? { icon: "📄", color: "#617891" };
                const isSel = selectedFile?.id === s.id;
                return (
                  <div key={s.id} onClick={() => setSelectedFile(isSel ? null : s)}
                    style={{ padding: "10px 12px", borderRadius: 8, border: isSel ? `1px solid ${meta.color}` : "1px solid rgba(97,120,145,0.13)", background: isSel ? `${meta.color}12` : "rgba(14,22,33,0.45)", cursor: "pointer", transition: "all 0.14s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: "1rem" }}>{meta.icon}</span>
                      <span style={{ fontFamily: "ui-monospace,monospace", fontSize: "0.8rem", fontWeight: 600, color: "#e8dcc8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.name}</span>
                      {s.hasConnections && <span style={{ fontSize: "0.52rem", padding: "1px 5px", borderRadius: 3, background: "rgba(232,200,122,0.12)", border: "1px solid rgba(232,200,122,0.3)", color: "#e8c87a", flexShrink: 0 }}>linked</span>}
                    </div>
                    <div style={{ display: "flex", gap: 8, fontSize: "0.63rem", color: "#617891" }}>
                      <span style={{ color: meta.color }}>{s.language}</span>
                      <span>·</span><span>{s.fnCount} fn{s.fnCount !== 1 ? "s" : ""}</span>
                      {s.classCount > 0 && <><span>·</span><span>{s.classCount} class{s.classCount !== 1 ? "es" : ""}</span></>}
                      {s.unusedCount > 0 && <span style={{ color: "#c46a82", marginLeft: "auto", fontWeight: 600 }}>⚠ {s.unusedCount} unused</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: file detail OR connection graph */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {selectedFile ? (
                <div style={{ height: "100%", overflowY: "auto", padding: "22px 26px" }}>
                  <button onClick={() => setSelectedFile(null)} style={{ background: "none", border: "1px solid rgba(97,120,145,0.25)", borderRadius: 6, color: "#617891", cursor: "pointer", padding: "4px 12px", fontSize: "0.68rem", marginBottom: 20 }}>← Back</button>
                  {(() => {
                    const meta    = LANG_META[selectedFile.language] ?? { icon: "📄", color: "#D5B893" };
                    const fileFns = ir.nodes.filter(n => "Function" in n.node_type && n.metadata.file_path === selectedFile.path);
                    return (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                          <span style={{ fontSize: "2.2rem" }}>{meta.icon}</span>
                          <div>
                            <div style={{ fontSize: "1.05rem", fontWeight: 700, fontFamily: "ui-monospace,monospace", color: "#e8dcc8" }}>{selectedFile.name}</div>
                            <div style={{ fontSize: "0.7rem", color: meta.color, marginTop: 3 }}>{selectedFile.language} · {selectedFile.fnCount} fns · {selectedFile.classCount} classes</div>
                          </div>
                          <button onClick={() => { setScopePath(selectedFile.path); setView("scope"); setSelectedFile(null); }}
                            style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 7, background: "rgba(213,184,147,0.1)", border: "1px solid rgba(213,184,147,0.3)", color: "#D5B893", cursor: "pointer", fontSize: "0.7rem", fontWeight: 600 }}>
                            ◎ Scope Graph →
                          </button>
                        </div>
                        <div style={{ fontSize: "0.63rem", color: "#617891", fontFamily: "monospace", padding: "5px 10px", background: "rgba(97,120,145,0.06)", borderRadius: 5, marginBottom: 14, wordBreak: "break-all" }}>{selectedFile.path}</div>
                        {selectedFile.unusedCount > 0 && <div style={{ padding: "8px 12px", background: "rgba(196,106,130,0.1)", border: "1px solid rgba(196,106,130,0.28)", borderRadius: 6, color: "#c46a82", fontSize: "0.74rem", marginBottom: 14 }}>⚠ {selectedFile.unusedCount} unused function{selectedFile.unusedCount !== 1 ? "s" : ""}</div>}
                        <div style={{ fontSize: "0.6rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", marginBottom: 8 }}>Functions ({fileFns.length})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {fileFns.map(fn => {
                            const d = (fn.node_type as any).Function;
                            const used = calledIds.has(fn.id);
                            return (
                              <div key={fn.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 7, background: "rgba(14,22,33,0.6)", border: `1px solid ${used ? "rgba(97,120,145,0.13)" : "rgba(196,106,130,0.22)"}` }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: used ? "#4ec94e" : "#c46a82", flexShrink: 0 }} />
                                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: "0.8rem", color: "#e8dcc8", flex: 1 }}>{d?.name ?? "?"}</span>
                                <span style={{ fontSize: "0.62rem", color: "#617891" }}>{d?.param_count ?? 0} params</span>
                                {d?.is_async && <span style={{ fontSize: "0.56rem", padding: "1px 5px", borderRadius: 3, background: "rgba(107,191,184,0.13)", border: "1px solid rgba(107,191,184,0.28)", color: "#6abfb8" }}>async</span>}
                                {!used && <span style={{ fontSize: "0.56rem", padding: "1px 5px", borderRadius: 3, background: "rgba(196,106,130,0.13)", border: "1px solid rgba(196,106,130,0.28)", color: "#c46a82" }}>unused</span>}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : fileStats.filter(s => s.hasConnections).length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, opacity: 0.45 }}>
                  <span style={{ fontSize: "3rem" }}>⬡</span>
                  <span style={{ color: "#617891", fontSize: "0.88rem", fontWeight: 600 }}>No cross-file dependencies</span>
                  <span style={{ color: "#617891", fontSize: "0.72rem" }}>Click a file on the left to explore its functions</span>
                </div>
              ) : (
                <>
                  <div style={{ position: "absolute", top: 10, left: 10, zIndex: 5, background: "rgba(8,14,24,0.88)", border: "1px solid rgba(97,120,145,0.2)", borderRadius: 7, padding: "7px 12px", fontSize: "0.62rem", color: "#617891", backdropFilter: "blur(6px)" }}>
                    <div style={{ color: "#e8c87a", fontWeight: 700, marginBottom: 2 }}>Cross-file connections only</div>
                    <div>Number on arrow = call count · pink border = has unused fns</div>
                  </div>
                  <div style={{ position: "absolute", top: 10, right: 10, zIndex: 5, display: "flex", gap: 4 }}>
                    {zoomBtns.map(b => <button key={b.icon} title={b.title} className="graph-zoom-btn" onClick={b.fn} style={{ fontSize: b.icon === "⊡" || b.icon === "⟳" ? 12 : 17, width: 30, height: 30 }}>{b.icon}</button>)}
                  </div>
                  <CytoscapeComponent key="conn" elements={connElements} layout={connLayout as any} stylesheet={connStyle as any} style={{ width: "100%", height: "100%" }} wheelSensitivity={0.3} minZoom={0.15} maxZoom={6} cy={handleCy} />
                </>
              )}
            </div>
          </>

        ) : (

          /* FILE SCOPE ───────────────────────────────────────────────────── */
          <>
            {/* Left sidebar legend */}
            <div style={{ width: 200, flexShrink: 0, borderRight: "1px solid rgba(97,120,145,0.15)", padding: "16px 14px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
              {scopeStat && (
                <div>
                  <div style={{ fontSize: "0.58rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", marginBottom: 6 }}>Viewing</div>
                  <div style={{ fontFamily: "ui-monospace,monospace", fontSize: "0.82rem", fontWeight: 700, color: "#D5B893", marginBottom: 3 }}>{LANG_META[scopeStat.language]?.icon ?? "📄"} {scopeStat.name}</div>
                  <div style={{ fontSize: "0.68rem", color: "#617891" }}>{scopeStat.fnCount} fns · {scopeStat.classCount} classes</div>
                  {scopeStat.unusedCount > 0 && <div style={{ marginTop: 5, fontSize: "0.68rem", color: "#c46a82", fontWeight: 600 }}>⚠ {scopeStat.unusedCount} unused</div>}
                </div>
              )}

              <div style={{ borderTop: "1px solid rgba(97,120,145,0.15)", paddingTop: 12 }}>
                <div style={{ fontSize: "0.58rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", marginBottom: 8 }}>Legend</div>
                {[
                  { el: <span style={{ width: 14, height: 14, borderRadius: 3, background: "#c46a82", display: "inline-block" }} />, label: "Function (called)" },
                  { el: <span style={{ width: 14, height: 14, borderRadius: 3, background: "#2a1a22", border: "1.5px dashed #7a3050", display: "inline-block" }} />, label: "Function (unused)" },
                  { el: <span style={{ width: 14, height: 14, borderRadius: 3, background: "#7aaed4", display: "inline-block" }} />, label: "Class / Interface" },
                  { el: <div style={{ width: 22, height: 2, background: "#e8c87a", display: "inline-block" }} />, label: "Calls out →" },
                  { el: <div style={{ width: 22, height: 0, borderTop: "2px dashed #7aaed4", display: "inline-block" }} />, label: "Called in ←" },
                ].map((l, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 22, flexShrink: 0, display: "flex", alignItems: "center" }}>{l.el}</div>
                    <span style={{ fontSize: "0.67rem", color: "#8a9aaa" }}>{l.label}</span>
                  </div>
                ))}
              </div>

              {extFiles.length > 0 && (
                <div style={{ borderTop: "1px solid rgba(97,120,145,0.15)", paddingTop: 12 }}>
                  <div style={{ fontSize: "0.58rem", letterSpacing: 2, textTransform: "uppercase", color: "#617891", marginBottom: 8 }}>External files</div>
                  {extFiles.map(fp => (
                    <div key={fp} onClick={() => setScopePath(fp)} title="Navigate to this file" style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, cursor: "pointer" }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: fileColor.get(fp) ?? "#617891", flexShrink: 0 }} />
                      <span style={{ fontSize: "0.7rem", color: fileColor.get(fp) ?? "#617891", fontFamily: "ui-monospace,monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(fp)}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: "0.58rem", color: "#617891", fontStyle: "italic", marginTop: 4 }}>Click to navigate →</div>
                </div>
              )}
            </div>

            {/* Graph canvas */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {hiddenCount > 0 && (
                <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 20, display: "flex", alignItems: "center", gap: 10, background: "rgba(8,14,24,0.95)", border: "1px solid rgba(232,200,122,0.35)", borderRadius: 8, padding: "7px 14px", backdropFilter: "blur(8px)", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: "0.8rem" }}>⚡</span>
                  <span style={{ fontSize: "0.72rem", color: "#e8dcc8" }}>
                    Showing <strong style={{ color: "#D5B893" }}>{totalHome - hiddenCount}</strong> of <strong style={{ color: "#D5B893" }}>{totalHome}</strong> nodes
                    <span style={{ color: "#617891", marginLeft: 6 }}>({hiddenIsolated} isolated hidden)</span>
                  </span>
                  <button onClick={() => setShowAll(v => !v)} style={{ padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontSize: "0.67rem", fontWeight: 700, background: showAll ? "rgba(196,106,130,0.18)" : "rgba(213,184,147,0.15)", border: showAll ? "1px solid #c46a82" : "1px solid rgba(213,184,147,0.4)", color: showAll ? "#c46a82" : "#D5B893" }}>
                    {showAll ? "← Smart view" : "Show all →"}
                  </button>
                </div>
              )}

              <div style={{ position: "absolute", bottom: 14, right: 14, zIndex: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {zoomBtns.map(b => <button key={b.icon} title={b.title} className="graph-zoom-btn" onClick={b.fn} style={{ fontSize: b.icon === "⊡" || b.icon === "⟳" ? 12 : 17 }}>{b.icon}</button>)}
              </div>

              {scopeEls.length > 1 ? (
                <CytoscapeComponent
                  key={`scope-${scopePath}-${showAll}`}
                  elements={scopeEls}
                  layout={scopeLayout as any}
                  stylesheet={scopeStyle as any}
                  style={{ width: "100%", height: "100%" }}
                  wheelSensitivity={0.3}
                  minZoom={0.1}
                  maxZoom={6}
                  cy={handleCy}
                />
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#617891", fontSize: "0.85rem", opacity: 0.5 }}>
                  No functions found — select a different file
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
