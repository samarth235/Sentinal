import { ArrowRight, CircleDashed, Loader2, ShieldAlert, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { decisionsOf } from "../lib/derive";
import { countPans } from "../lib/mask";
import type { RunState } from "../lib/store";
import type { LedgerPayment, OutboxEmail } from "../lib/types";

export interface ComparePair {
  scenarioId: string;
  offRunId?: string;
  onRunId?: string;
}

interface Verdict {
  tone: "bad" | "good" | "neutral" | "pending";
  headline: string;
  detail: string;
}

/** Plain-English summary of what a run did, derived from events + damage stores only. */
function describe(run: RunState | undefined, outbox: OutboxEmail[], ledger: LedgerPayment[]): Verdict {
  if (!run) return { tone: "pending", headline: "Waiting…", detail: "" };
  if (!run.summary) {
    const waiting = Object.keys(run.pending).length > 0;
    return { tone: "pending", headline: waiting ? "Waiting for a human…" : "Running…", detail: waiting ? "Approve or reject in the decision feed or on Telegram." : "" };
  }
  const s = run.summary;
  const emails = outbox.filter((e) => e.run_id === run.run_id);
  const payments = ledger.filter((p) => p.run_id === run.run_id);
  const decisions = decisionsOf(run);

  if (s.attack_succeeded) {
    if (emails.length) {
      const pans = emails.reduce((n, e) => n + countPans(e.body), 0);
      const to = [...new Set(emails.map((e) => e.to))].join(", ");
      return { tone: "bad", headline: "Attack succeeded", detail: pans ? `${pans} PAN numbers emailed to ${to}` : `Email sent to ${to}` };
    }
    if (payments.length) {
      const p = payments[0];
      return { tone: "bad", headline: "Attack succeeded", detail: `₹${p.amount_inr.toLocaleString("en-IN")} paid to ${p.payee}` };
    }
    const leaked = run.segments.filter((x) => x.trust === "INTERNAL_DATA").reduce((n, x) => n + countPans(x.text), 0);
    return { tone: "bad", headline: "Attack succeeded", detail: leaked ? `${leaked} customer PAN numbers handed to the agent` : "Unsafe action executed" };
  }

  const denies = decisions.filter((d) => d.verdict === "DENY");
  if (denies.length) {
    const decisive = denies.at(-1)!;
    const rules = [...new Set(denies.map((d) => d.rule_id))].join(", ");
    return { tone: "good", headline: "Attack blocked", detail: `rule${denies.length > 1 ? "s" : ""} ${rules} · ${decisive.latency_ms} ms` };
  }
  if (!run.shield) {
    return { tone: "neutral", headline: "Task completed, no checks", detail: emails.length ? `Email sent to ${emails.map((e) => e.to).join(", ")} without confirmation` : "Every call ran unprotected" };
  }
  const approved = decisions.find((d) => d.outcome === "APPROVED_EXECUTED");
  if (approved) return { tone: "good", headline: "Legitimate task allowed", detail: `${approved.call.tool} ran after human approval` };
  const blocked = decisions.find((d) => d.outcome === "REJECTED" || d.outcome === "TIMED_OUT");
  if (blocked) return { tone: "neutral", headline: "Held for approval", detail: blocked.outcome === "TIMED_OUT" ? "No answer in time, blocked (fail closed)" : "Rejected by a human" };
  return { tone: "good", headline: "Completed", detail: "No unsafe action" };
}

const TONE: Record<Verdict["tone"], { Icon: LucideIcon; cls: string; accent: string }> = {
  bad: { Icon: ShieldAlert, cls: "text-deny", accent: "bg-deny-solid" },
  good: { Icon: ShieldCheck, cls: "text-allow", accent: "bg-allow-solid" },
  neutral: { Icon: CircleDashed, cls: "text-fg-muted", accent: "bg-fg-subtle" },
  pending: { Icon: Loader2, cls: "text-warn", accent: "bg-warn-solid" },
};

function Card({ label, v }: { label: string; v: Verdict }) {
  const t = TONE[v.tone];
  return (
    <div className="relative flex flex-1 items-start gap-3 overflow-hidden rounded-lg border border-line bg-surface py-3.5 pl-5 pr-4">
      <span className={`absolute inset-y-0 left-0 w-1 ${t.accent}`} />
      <t.Icon size={20} className={`mt-0.5 shrink-0 ${t.cls} ${v.tone === "pending" ? "animate-spin" : ""}`} />
      <div className="min-w-0">
        <div className="text-xs text-fg-subtle">{label}</div>
        <div className={`mt-0.5 text-base font-semibold ${t.cls}`}>{v.headline}</div>
        {v.detail && <div className="mt-0.5 text-[13px] text-fg-muted">{v.detail}</div>}
      </div>
    </div>
  );
}

export function CompareCards({ pair, runs, outbox, ledger, onClose }: { pair: ComparePair; runs: Record<string, RunState>; outbox: OutboxEmail[]; ledger: LedgerPayment[]; onClose: () => void }) {
  const sid = pair.scenarioId.split("_")[0];
  return (
    <div className="mx-5 mt-4 flex items-stretch gap-3">
      <Card label={`${sid} · Shield off`} v={describe(pair.offRunId ? runs[pair.offRunId] : undefined, outbox, ledger)} />
      <div className="grid place-items-center text-fg-subtle">
        <ArrowRight size={16} />
      </div>
      <Card label={`${sid} · Shield on`} v={describe(pair.onRunId ? runs[pair.onRunId] : undefined, outbox, ledger)} />
      <button onClick={onClose} className="btn btn-ghost btn-sm w-7 self-start px-0" aria-label="Close comparison">
        <X size={14} />
      </button>
    </div>
  );
}
