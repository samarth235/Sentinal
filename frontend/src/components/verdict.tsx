import { Ban, Check, CircleDashed, Clock, type LucideIcon } from "lucide-react";
import type { Decision, Outcome } from "../lib/types";

export type VerdictKey = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "SHIELD_OFF";

export const verdictKey = (d: Decision): VerdictKey => (d.rule_id === "SHIELD_OFF" ? "SHIELD_OFF" : d.verdict);

/** `color` is a CSS color (Radix variable) for places Tailwind classes cannot reach, like the graph. */
export const VERDICT_STYLE: Record<VerdictKey, { label: string; Icon: LucideIcon; cls: string; color: string; tint: string }> = {
  ALLOW: { label: "Allow", Icon: Check, cls: "text-allow bg-allow-bg border-allow-line", color: "var(--grass-9)", tint: "var(--grass-2)" },
  DENY: { label: "Deny", Icon: Ban, cls: "text-deny bg-deny-bg border-deny-line", color: "var(--red-9)", tint: "var(--red-2)" },
  REQUIRE_APPROVAL: { label: "Approval", Icon: Clock, cls: "text-warn bg-warn-bg border-warn-line", color: "var(--amber-9)", tint: "var(--amber-2)" },
  SHIELD_OFF: { label: "Unchecked", Icon: CircleDashed, cls: "text-fg-muted bg-subtle border-line", color: "var(--slate-9)", tint: "var(--slate-2)" },
};

export type Tone = "good" | "bad" | "warn" | "neutral";

export const TONE_COLOR: Record<Tone, string> = { good: "var(--grass-9)", bad: "var(--red-9)", warn: "var(--amber-9)", neutral: "var(--slate-9)" };

export const OUTCOME_LABEL: Record<Outcome, { label: string; tone: Tone }> = {
  EXECUTED: { label: "Executed", tone: "good" },
  BLOCKED: { label: "Blocked", tone: "bad" },
  APPROVED_EXECUTED: { label: "Approved, executed", tone: "good" },
  REJECTED: { label: "Rejected by human", tone: "bad" },
  TIMED_OUT: { label: "Timed out, blocked", tone: "bad" },
  UNPROTECTED_EXECUTED: { label: "Ran with no checks", tone: "neutral" },
};

export function VerdictBadge({ decision }: { decision: Decision }) {
  const s = VERDICT_STYLE[verdictKey(decision)];
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-xs font-medium ${s.cls}`}>
      <s.Icon size={13} strokeWidth={2.25} aria-hidden />
      {s.label}
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome?: Outcome }) {
  if (!outcome) return <span className="text-xs text-fg-subtle">Evaluating…</span>;
  const o = OUTCOME_LABEL[outcome];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[o.tone] }} />
      {o.label}
    </span>
  );
}
