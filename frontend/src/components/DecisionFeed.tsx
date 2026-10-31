import { Braces, Check, Clock, History, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "./ui";
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
  return <span className={`font-mono text-xs font-medium tabular-nums ${left <= 10 ? "text-deny" : "text-warn"}`}>{left}s left</span>;
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
      className={`cursor-pointer rounded-md border bg-surface p-3.5 transition-colors ${selected ? "border-fg-subtle ring-1 ring-fg-subtle" : "border-line hover:border-line-strong"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[13.5px] font-medium text-fg">{d.call.tool}</div>
          <div className="mt-1 space-y-0.5 font-mono text-[11.5px] text-fg-muted">
            {Object.entries(d.call.args).map(([k, v]) => (
              <div key={k} className="truncate">
                <span className="text-fg-subtle">{k}=</span>
                {formatArg(v, 70)}
              </div>
            ))}
          </div>
        </div>
        <VerdictBadge decision={d} />
      </div>

      <ul className="mt-3 space-y-2">
        {d.reasons.map((r, i) => (
          <li key={i} className="text-[13px] leading-snug text-fg">
            {r.message}
            {r.evidence?.filter((e) => !e.segment_id.startsWith("arg:")).slice(0, 1).map((e, j) => (
              <div key={j} className="mt-1.5 border-l-2 border-deny-solid bg-deny-bg px-2.5 py-1.5 font-mono text-[11.5px] text-deny">
                {e.excerpt}
              </div>
            ))}
          </li>
        ))}
        {d.rule_id === "SHIELD_OFF" && <li className="text-[13px] text-fg-muted">Shield off. The call ran without any policy check.</li>}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5 text-xs text-fg-subtle">
        <span className="rounded bg-subtle px-1.5 py-0.5 font-mono font-medium text-fg-muted">{d.rule_id}</span>
        <span className="tabular-nums">{d.latency_ms} ms</span>
        {d.guard.provider !== "not-consulted" && d.guard.provider !== "shield-off" && (
          <span>
            guard: {d.guard.available ? `${d.guard.label} ${d.guard.score.toFixed(2)}` : "unavailable"}
          </span>
        )}
        {d.session_tainted && <span className="text-deny">Session tainted</span>}
        <span className="ml-auto">
          <OutcomePill outcome={d.outcome} />
        </span>
      </div>

      {pendingSince !== undefined && !approval && (
        <div className="mt-3 flex items-center gap-2.5 rounded-md border border-warn-line bg-warn-bg px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
          <Clock size={14} className="text-warn" />
          <span className="text-[13px] font-medium text-warn">Needs approval</span>
          <Countdown since={pendingSince} seconds={timeoutSeconds} />
          <button className="btn btn-sm btn-outline ml-auto" disabled={sending} onClick={() => answer(false)}>
            Reject
          </button>
          <button className="btn btn-sm btn-primary" disabled={sending} onClick={() => answer(true)}>
            <Check size={13} /> Approve
          </button>
        </div>
      )}
      {approval && (
        <div className="mt-2 text-xs text-fg-muted">
          {approval.result === "approved" ? `Approved by ${approval.approver ?? "?"}` : approval.result === "rejected" ? `Rejected by ${approval.approver ?? "?"}` : "No answer in time, blocked (fail closed)"}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1 text-xs" onClick={(e) => e.stopPropagation()}>
        {d.shield && (
          <button className="btn btn-ghost btn-sm -ml-2.5" onClick={doReplay}>
            <History size={13} /> Replay on current policy
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => setDetails(!details)}>
          <Braces size={13} /> {details ? "Hide details" : "Details"}
        </button>
        {replay && (
          <span className="ml-auto flex items-center gap-2 text-fg-subtle">
            Replay <VerdictBadge decision={replay} /> <span className="font-mono">{replay.rule_id}</span>
          </span>
        )}
      </div>
      {details && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] text-fg-muted" onClick={(e) => e.stopPropagation()}>
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
      <div className="panel-head">
        <span className="panel-title">Decisions</span>
        {run && <span className="text-xs text-fg-subtle tabular-nums">{decisions.length} call{decisions.length === 1 ? "" : "s"}</span>}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto bg-canvas p-3">
        {decisions.length === 0 && <EmptyState Icon={ListChecks} title="No tool calls yet" hint="Each call the agent makes is judged here." />}
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
