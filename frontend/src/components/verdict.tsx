import type { Decision, Outcome } from "../lib/types";

export type VerdictKey = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "SHIELD_OFF";

export const verdictKey = (d: Decision): VerdictKey => (d.rule_id === "SHIELD_OFF" ? "SHIELD_OFF" : d.verdict);

export const VERDICT_STYLE: Record<VerdictKey, { label: string; icon: string; text: string; bg: string; border: string; hex: string }> = {
  ALLOW: { label: "ALLOW", icon: "✓", text: "text-allow", bg: "bg-allow/15", border: "border-allow/60", hex: "#22c55e" },
  DENY: { label: "DENY", icon: "✕", text: "text-deny", bg: "bg-deny/15", border: "border-deny/70", hex: "#ef4444" },
  REQUIRE_APPROVAL: { label: "APPROVAL", icon: "⏳", text: "text-approve", bg: "bg-approve/15", border: "border-approve/60", hex: "#f59e0b" },
  SHIELD_OFF: { label: "UNCHECKED", icon: "○", text: "text-zinc-300", bg: "bg-off/20", border: "border-off/60", hex: "#6b7280" },
};

export const OUTCOME_LABEL: Record<Outcome, { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  EXECUTED: { label: "Executed", tone: "good" },
  BLOCKED: { label: "Blocked", tone: "bad" },
  APPROVED_EXECUTED: { label: "Approved · executed", tone: "good" },
  REJECTED: { label: "Rejected by human", tone: "bad" },
  TIMED_OUT: { label: "Timed out · blocked", tone: "bad" },
  UNPROTECTED_EXECUTED: { label: "Ran with no checks", tone: "neutral" },
};

export function VerdictBadge({ decision, size = "lg" }: { decision: Decision; size?: "lg" | "sm" }) {
  const s = VERDICT_STYLE[verdictKey(decision)];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border font-extrabold tracking-wide ${s.text} ${s.bg} ${s.border} ${
        size === "lg" ? "px-3 py-1.5 text-xl" : "px-2 py-0.5 text-xs"
      }`}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome?: Outcome }) {
  if (!outcome) return <span className="text-xs text-muted">evaluating…</span>;
  const o = OUTCOME_LABEL[outcome];
  const tone = { good: "text-allow border-allow/40", bad: "text-deny border-deny/50", warn: "text-approve border-approve/50", neutral: "text-zinc-300 border-off/60" }[o.tone];
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>{o.label}</span>;
}
