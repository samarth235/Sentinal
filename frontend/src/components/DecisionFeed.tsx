import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { decisionsOf } from "../lib/derive";
import { formatArg } from "../lib/mask";
import type { RunState } from "../lib/store";
import type { Decision } from "../lib/types";
import { OutcomePill, VerdictBadge } from "./verdict";

function Countdown({ since, seconds }: { since: number; seconds: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil(seconds - (now - since) / 1000));
  return <span className={`font-mono font-bold ${left <= 10 ? "text-deny" : "text-approve"}`}>{left}s</span>;
}

function Card({
  d,
  run,
  selected,
  onSelect,
  timeoutSeconds,
  notify,
}: {
  d: Decision;
  run: RunState;
  selected: boolean;
  onSelect: () => void;
  timeoutSeconds: number;
  notify: (msg: string) => void;
}) {
  const [replay, setReplay] = useState<Decision | null>(null);
  const [details, setDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const pendingSince = run.pending[d.decision_id];
  const approval = run.approvals[d.decision_id];

  const answer = async (approve: boolean) => {
    setSending(true);
    try {
      await api.approve(d.decision_id, approve);
    } catch (e) {
      notify(`Approval failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const doReplay = async () => {
    try {
      setReplay(await api.replay(d.decision_id));
    } catch (e) {
      notify(`Replay failed: ${(e as Error).message}`);
    }
  };

  return (
    <article
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border bg-panel-2 p-3.5 transition ${selected ? "border-zinc-400" : "border-line hover:border-zinc-600"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[15px] font-semibold text-zinc-100">{d.call.tool}</div>
          <div className="mt-0.5 space-y-0.5 font-mono text-[11.5px] text-zinc-400">
            {Object.entries(d.call.args).map(([k, v]) => (
              <div key={k} className="truncate">
                <span className="text-muted">{k}=</span>
                {formatArg(v, 70)}
              </div>
            ))}
          </div>
        </div>
        <VerdictBadge decision={d} />
      </div>

      <ul className="mt-2.5 space-y-1.5">
        {d.reasons.map((r, i) => (
          <li key={i} className="text-[13.5px] leading-snug text-zinc-200">
            {r.message}
            {r.evidence?.filter((e) => !e.segment_id.startsWith("arg:")).slice(0, 1).map((e, j) => (
              <div key={j} className="mt-1.5 rounded-md border border-deny/50 bg-red-950/30 px-2 py-1 font-mono text-[11.5px] text-red-200">
                “{e.excerpt}”
              </div>
            ))}
          </li>
        ))}
        {d.rule_id === "SHIELD_OFF" && <li className="text-[13.5px] text-zinc-400">Shield off — the call ran without any policy check.</li>}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono font-bold text-zinc-200">{d.rule_id}</span>
        <span>{d.latency_ms} ms</span>
        {d.guard.provider !== "not-consulted" && d.guard.provider !== "shield-off" && (
          <span>
            guard: {d.guard.available ? `${d.guard.label} ${d.guard.score.toFixed(2)}` : "unavailable"}
          </span>
        )}
        {d.session_tainted && <span className="text-red-300">session tainted</span>}
        <span className="ml-auto">
          <OutcomePill outcome={d.outcome} />
        </span>
      </div>

      {pendingSince !== undefined && !approval && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-approve/50 bg-amber-950/20 p-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-sm font-semibold text-approve">Needs a human</span>
          <Countdown since={pendingSince} seconds={timeoutSeconds} />
          <button className="btn ml-auto bg-allow px-3 py-1.5 text-black hover:bg-green-400" disabled={sending} onClick={() => answer(true)}>
            ✓ Approve
          </button>
          <button className="btn bg-deny px-3 py-1.5 text-white hover:bg-red-400" disabled={sending} onClick={() => answer(false)}>
            ✕ Reject
          </button>
        </div>
      )}
      {approval && (
        <div className="mt-2 text-xs text-muted">
          {approval.result === "approved" ? `Approved by ${approval.approver ?? "?"}` : approval.result === "rejected" ? `Rejected by ${approval.approver ?? "?"}` : "No answer in time — blocked (fail closed)"}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
        {d.shield && (
          <button className="font-semibold text-zinc-300 underline-offset-2 hover:underline" onClick={doReplay}>
            Replay against current policy
          </button>
        )}
        <button className="text-muted hover:text-zinc-300" onClick={() => setDetails(!details)}>
          {details ? "Hide" : "Details"}
        </button>
        {replay && (
          <span className="ml-auto flex items-center gap-2">
            replay → <VerdictBadge decision={replay} size="sm" /> <span className="font-mono">{replay.rule_id}</span>
          </span>
        )}
      </div>
      {details && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-black/50 p-2 font-mono text-[11px] text-zinc-400" onClick={(e) => e.stopPropagation()}>
          {JSON.stringify({ provenance: d.provenance, guard: d.guard, impact: d.impact, decision_id: d.decision_id }, null, 2)}
        </pre>
      )}
    </article>
  );
}

export function DecisionFeed({
  run,
  selectedId,
  onSelect,
  timeoutSeconds,
  notify,
}: {
  run?: RunState;
  selectedId?: string;
  onSelect: (id: string) => void;
  timeoutSeconds: number;
  notify: (msg: string) => void;
}) {
  const decisions = run ? [...decisionsOf(run)].reverse() : [];
  return (
    <section className="panel">
      <div className="panel-title">
        Decisions
        {run && <span className="normal-case tracking-normal">{decisions.length} call{decisions.length === 1 ? "" : "s"}</span>}
      </div>
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 pb-4">
        {decisions.length === 0 && <p className="pt-8 text-center text-sm text-muted">No tool calls yet.</p>}
        {run &&
          decisions.map((d) => (
            <Card
              key={d.decision_id}
              d={d}
              run={run}
              selected={d.decision_id === selectedId}
              onSelect={() => onSelect(d.decision_id)}
              timeoutSeconds={timeoutSeconds}
              notify={notify}
            />
          ))}
      </div>
    </section>
  );
}
