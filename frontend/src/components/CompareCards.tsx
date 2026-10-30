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
    return { tone: "neutral", headline: "Task completed — no checks", detail: emails.length ? `Email sent to ${emails.map((e) => e.to).join(", ")} without confirmation` : "Every call ran unprotected" };
  }
  const approved = decisions.find((d) => d.outcome === "APPROVED_EXECUTED");
  if (approved) return { tone: "good", headline: "Legitimate task allowed", detail: `${approved.call.tool} ran after human approval` };
  const blocked = decisions.find((d) => d.outcome === "REJECTED" || d.outcome === "TIMED_OUT");
  if (blocked) return { tone: "neutral", headline: "Held for approval", detail: blocked.outcome === "TIMED_OUT" ? "No answer in time — blocked (fail closed)" : "Rejected by a human" };
  return { tone: "good", headline: "Completed", detail: "No unsafe action" };
}

const TONE = {
  bad: "border-deny bg-red-950/40 text-deny",
  good: "border-allow bg-green-950/30 text-allow",
  neutral: "border-off bg-zinc-900 text-zinc-200",
  pending: "border-approve/60 bg-amber-950/20 text-approve",
};

function Card({ label, v }: { label: string; v: Verdict }) {
  return (
    <div className={`flex-1 rounded-xl border-2 px-5 py-3.5 ${TONE[v.tone]}`}>
      <div className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-3">
        <span className="text-2xl font-black">
          {v.tone === "bad" ? "✕ " : v.tone === "good" ? "✓ " : ""}
          {v.headline}
        </span>
      </div>
      <div className="mt-0.5 text-[15px] font-medium text-zinc-200">{v.detail}</div>
    </div>
  );
}

export function CompareCards({ pair, runs, outbox, ledger, onClose }: { pair: ComparePair; runs: Record<string, RunState>; outbox: OutboxEmail[]; ledger: LedgerPayment[]; onClose: () => void }) {
  return (
    <div className="relative mx-5 mt-3 flex gap-3">
      <Card label={`Shield OFF · ${pair.scenarioId}`} v={describe(pair.offRunId ? runs[pair.offRunId] : undefined, outbox, ledger)} />
      <div className="grid place-items-center text-2xl text-muted">→</div>
      <Card label={`Shield ON · ${pair.scenarioId}`} v={describe(pair.onRunId ? runs[pair.onRunId] : undefined, outbox, ledger)} />
      <button onClick={onClose} className="absolute -top-2 -right-2 grid h-6 w-6 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700" aria-label="Close comparison">
        ✕
      </button>
    </div>
  );
}
