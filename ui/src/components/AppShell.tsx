import { useState } from "react";
import MainPanel from "./MainPanel";
import CodeInputPanel from "./CodeInputPanel";
import LandingPage from "./LandingPage";
// import ChatBox from "./ChatBox";  // chat panel disabled below
import type { AnalysisResult } from "../types";

export default function AppShell() {
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!started) return <LandingPage onEnter={() => setStarted(true)} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <CodeInputPanel
            onResult={setResult}
            onLoading={setLoading}
            onError={setError}
          />
        </div>
        {/*<div className="sidebar-bottom">
          <ChatBox result={result} />
        </div>*/}

      </aside>
      <MainPanel result={result} loading={loading} error={error} />
    </div>
  );
}