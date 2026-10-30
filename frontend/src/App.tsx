import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuditPanel } from "./components/AuditPanel";
import { CompareCards, type ComparePair } from "./components/CompareCards";
import { ContextPanel } from "./components/ContextPanel";
import { ControlBar } from "./components/ControlBar";
import { DamagePanel } from "./components/DamagePanel";
import { DecisionFeed } from "./components/DecisionFeed";
import { DecisionGraph } from "./components/DecisionGraph";
import { Toasts, type Toast } from "./components/Toasts";
import { api } from "./lib/api";
import { decisionsOf, evidenceOf, latestWithEvidence } from "./lib/derive";
import { connect, useStore, waitForFinish } from "./lib/store";
import type { AuditRow, LedgerPayment, OutboxEmail, ScenarioInfo, UiConfig } from "./lib/types";

export default function App() {
  const store = useStore();
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [scenarioId, setScenarioId] = useState("S2_injection");
  const [shield, setShield] = useState(true);
  const [mode, setMode] = useState<"scripted" | "live">("scripted");
  const [busy, setBusy] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | undefined>();
  const [selectedDecision, setSelectedDecision] = useState<string | undefined>();
  const [pair, setPair] = useState<ComparePair | null>(null);
  const [outbox, setOutbox] = useState<OutboxEmail[]>([]);
  const [ledger, setLedger] = useState<LedgerPayment[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 4000);
  }, []);

  const loadStatic = useCallback(() => {
    api.scenarios().then(setScenarios).catch(() => notify("Cannot reach the Sentinel API. Is the backend running?", "error"));
    api.uiConfig().then(setConfig).catch(() => undefined);
  }, [notify]);

  useEffect(() => {
    loadStatic();
    connect(
      (msg) => notify(msg, "error"),
      () => {
        notify("Reconnected.");
        loadStatic();
      },
    );
  }, [loadStatic, notify]);

  // Refresh damage + audit views whenever something executes or finishes.
  const tick = useMemo(
    () =>
      store.runOrder.length +
      Object.values(store.runs).reduce((n, r) => n + Object.keys(r.executed).length + r.decisionOrder.length + (r.summary ? 1 : 0) + Object.keys(r.approvals).length, 0),
    [store],
  );
  const refreshDamage = useCallback(() => {
    api.outbox().then(setOutbox).catch(() => undefined);
    api.ledger().then(setLedger).catch(() => undefined);
    api.audit().then((r) => setAuditRows(r.rows)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(refreshDamage, 150);
    return () => clearTimeout(t);
  }, [tick, refreshDamage]);

  const runId = selectedRun && store.runs[selectedRun] ? selectedRun : store.runOrder.at(-1);
  const run = runId ? store.runs[runId] : undefined;

  // Default selection: the newest decision with evidence (the "here is the sentence" moment), else the newest.
  const effectiveDecisionId = useMemo(() => {
    if (selectedDecision && run?.decisions[selectedDecision]) return selectedDecision;
    return latestWithEvidence(run)?.decision_id ?? (run ? decisionsOf(run).at(-1)?.decision_id : undefined);
  }, [selectedDecision, run]);
  const evidence = evidenceOf(effectiveDecisionId ? run?.decisions[effectiveDecisionId] : undefined);

  const start = async (sid: string, sh: boolean) => {
    const { run_id } = await api.startRun(sid, sh, mode);
    setSelectedRun(run_id);
    setSelectedDecision(undefined);
    return run_id;
  };

  const onRun = async () => {
    setBusy(true);
    try {
      setPair(null);
      await start(scenarioId, shield);
    } catch (e) {
      notify(`Run failed: ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const onBeforeAfter = async () => {
    setBusy(true);
    try {
      await api.reset();
      setPair({ scenarioId });
      const off = await start(scenarioId, false);
      setPair({ scenarioId, offRunId: off });
      await waitForFinish(off);
      const on = await start(scenarioId, true);
      setPair({ scenarioId, offRunId: off, onRunId: on });
      await waitForFinish(on);
    } catch (e) {
      notify(`Before/after failed: ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    try {
      await api.reset();
      setPair(null);
      setSelectedRun(undefined);
      setSelectedDecision(undefined);
      refreshDamage();
    } catch (e) {
      notify(`Reset failed: ${(e as Error).message}`, "error");
    }
  };

  const recentRuns = [...store.runOrder].reverse().slice(0, 8);

  return (
    <div className="flex min-h-full flex-col">
      <ControlBar
        scenarios={scenarios}
        scenarioId={scenarioId}
        setScenarioId={setScenarioId}
        shield={shield}
        setShield={setShield}
        mode={mode}
        setMode={setMode}
        busy={busy}
        connected={store.connected}
        config={config}
        onRun={onRun}
        onBeforeAfter={onBeforeAfter}
        onReset={onReset}
      />

      {pair && <CompareCards pair={pair} runs={store.runs} outbox={outbox} ledger={ledger} onClose={() => setPair(null)} />}

      {recentRuns.length > 0 && (
        <nav className="mx-5 mt-3 flex flex-wrap gap-2">
          {recentRuns.map((id) => {
            const r = store.runs[id];
            const active = id === runId;
            return (
              <button
                key={id}
                onClick={() => {
                  setSelectedRun(id);
                  setSelectedDecision(undefined);
                }}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1 text-xs font-semibold ${active ? "border-zinc-300 bg-zinc-800" : "border-line text-muted hover:text-zinc-200"}`}
              >
                <span>{r.scenario_id.split("_")[0] || "run"}</span>
                <span className={r.shield ? "text-allow" : "text-deny"}>{r.shield ? "ON" : "OFF"}</span>
                {!r.summary && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-approve" />}
                {r.summary?.attack_succeeded && <span className="text-deny">breached</span>}
              </button>
            );
          })}
        </nav>
      )}

      <main className="mx-5 mt-3 grid h-[max(420px,calc(100vh-430px))] grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
        <ContextPanel run={run} evidence={evidence} />
        <DecisionGraph run={run} selectedId={effectiveDecisionId} onSelect={setSelectedDecision} />
        <DecisionFeed run={run} selectedId={effectiveDecisionId} onSelect={setSelectedDecision} timeoutSeconds={config?.approval_timeout_seconds ?? 60} notify={(m) => notify(m, "error")} />
      </main>

      <footer className="mx-5 my-3 grid h-60 grid-cols-2 gap-3">
        <DamagePanel outbox={outbox} ledger={ledger} />
        <AuditPanel rows={auditRows} config={config} onChanged={refreshDamage} notify={notify} />
      </footer>

      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
