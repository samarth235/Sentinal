import { ContextLedger } from "./gateway/contextLedger.js";
import type { AuditRow } from "./integrations/hashChain.js";
import type { BusEvent, ContextSegment, Decision } from "./types.js";

/**
 * Everything here is derived from the hash-chained audit log, so it survives restarts and
 * works across instances. In-memory run state is only a cache for the live dashboard.
 */

const eventOf = (row: AuditRow) => row.payload as BusEvent;

/** Latest version of each decision (decision.made is emitted twice: decided, then with outcome). */
export function decisionsFromAudit(rows: AuditRow[], opts: { runId?: string; limit?: number } = {}): Decision[] {
  const latest = new Map<string, Decision>();
  for (const row of rows) {
    if (row.event_type !== "decision.made") continue;
    if (opts.runId && row.run_id !== opts.runId) continue;
    const d = (eventOf(row) as Extract<BusEvent, { type: "decision.made" }>).decision;
    if (d?.decision_id) {
      latest.delete(d.decision_id); // keep insertion order = last update
      latest.set(d.decision_id, d);
    }
  }
  const all = [...latest.values()].sort((a, b) => a.decided_at.localeCompare(b.decided_at));
  return opts.limit ? all.slice(-opts.limit) : all;
}

/** Approvals that were requested but never resolved (e.g. the process died while waiting). */
export function unresolvedApprovals(rows: AuditRow[]): { run_id: string; decision_id: string }[] {
  const open = new Map<string, string>();
  for (const row of rows) {
    const e = eventOf(row);
    if (e.type === "approval.requested") open.set(e.decision.decision_id, e.run_id);
    if (e.type === "approval.resolved") open.delete(e.decision_id);
  }
  return [...open].map(([decision_id, run_id]) => ({ decision_id, run_id }));
}

/** Rebuild what the agent had seen before a decision, from context.added rows (for replay after restart). */
export function ledgerFromAudit(rows: AuditRow[], decisionId: string): { decision: Decision; ledger: ContextLedger } | undefined {
  const first = rows.find((r) => r.event_type === "decision.made" && (eventOf(r) as { decision?: Decision }).decision?.decision_id === decisionId);
  if (!first) return undefined;
  const decision = (eventOf(first) as Extract<BusEvent, { type: "decision.made" }>).decision;
  const ledger = new ContextLedger(first.run_id);
  for (const row of rows) {
    if (row.seq >= first.seq) break;
    if (row.run_id !== first.run_id || row.event_type !== "context.added") continue;
    const seg = (eventOf(row) as Extract<BusEvent, { type: "context.added" }>).segment;
    ledger.segments.push(seg);
    if (seg.label) ledger.labels.set(seg.segment_id, seg.label);
  }
  return { decision, ledger };
}

export interface ForensicsHit {
  source: { run_id: string; segment_id: string; label?: string; tool?: string; added_at: string; excerpt: string };
  decisions: (Pick<Decision, "decision_id" | "verdict" | "rule_id" | "outcome" | "decided_at" | "impact"> & { tool: string })[];
}

/**
 * "Show me every action influenced by this email / page": find untrusted context matching the
 * query (by label, e.g. a URL, or by text), then every decision made in that run after it was read.
 */
export function forensics(rows: AuditRow[], query: string, limit = 50): ForensicsHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: ForensicsHit[] = [];
  const decisions = decisionsFromAudit(rows);
  for (const row of rows) {
    if (row.event_type !== "context.added") continue;
    const seg = (eventOf(row) as Extract<BusEvent, { type: "context.added" }>).segment as ContextSegment;
    if (seg.trust !== "UNTRUSTED") continue;
    const text = seg.text.toLowerCase();
    const at = text.indexOf(q);
    const labelHit = (seg.label ?? "").toLowerCase().includes(q);
    if (at === -1 && !labelHit) continue;
    const start = Math.max(0, at === -1 ? 0 : at - 60);
    const influenced = decisions
      .filter((d) => d.call.run_id === row.run_id && d.decided_at >= seg.added_at)
      .map((d) => ({ decision_id: d.decision_id, verdict: d.verdict, rule_id: d.rule_id, outcome: d.outcome, decided_at: d.decided_at, impact: d.impact, tool: d.call.tool }));
    hits.push({
      source: { run_id: row.run_id, segment_id: seg.segment_id, label: seg.label, tool: seg.tool, added_at: seg.added_at, excerpt: seg.text.slice(start, start + 160).replace(/\s+/g, " ") },
      decisions: influenced,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Latency percentiles and verdict counts over a set of decisions. */
export function metricsFor(decisions: Decision[]) {
  const shielded = decisions.filter((d) => d.shield);
  const lat = shielded.map((d) => d.latency_ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
  const count = <K extends string>(key: (d: Decision) => K | undefined) =>
    shielded.reduce<Record<string, number>>((acc, d) => {
      const k = key(d) ?? "pending";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const consulted = shielded.filter((d) => d.guard.provider !== "not-consulted");
  return {
    decisions: shielded.length,
    by_verdict: count((d) => d.verdict),
    by_outcome: count((d) => d.outcome),
    by_rule: count((d) => d.rule_id),
    latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: lat.at(-1) ?? null },
    guard: {
      consulted: consulted.length,
      unavailable: consulted.filter((d) => !d.guard.available).length,
      flagged: consulted.filter((d) => d.guard.label === "injection").length,
    },
  };
}
