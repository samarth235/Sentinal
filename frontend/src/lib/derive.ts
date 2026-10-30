import type { ContextSegment, Decision, Evidence } from "./types";
import type { RunState } from "./store";

const EXECUTED = new Set(["EXECUTED", "APPROVED_EXECUTED", "UNPROTECTED_EXECUTED"]);

export function decisionsOf(run: RunState): Decision[] {
  return run.decisionOrder.map((id) => run.decisions[id]).filter(Boolean);
}

/**
 * Where a tool_result segment came from: the k-th result of tool T matches the k-th executed
 * call of tool T. Gives "news.example.test/ai-trends-2026" for browse_url pages.
 */
export function segmentSource(run: RunState, seg: ContextSegment): string {
  if (seg.source !== "tool_result" || !seg.tool) return seg.source;
  const sameTool = run.segments.filter((s) => s.source === "tool_result" && s.tool === seg.tool);
  const k = sameTool.findIndex((s) => s.segment_id === seg.segment_id);
  const executed = decisionsOf(run).filter((d) => d.call.tool === seg.tool && d.outcome && EXECUTED.has(d.outcome));
  const url = executed[k]?.call.args.url;
  return typeof url === "string" ? `${seg.tool} · ${url.replace(/^https?:\/\//, "")}` : seg.tool;
}

/** Evidence that points into ledger segments (R4/R5 reasons, else untrusted provenance hits). */
export function evidenceOf(d: Decision | undefined): Evidence[] {
  if (!d) return [];
  const fromReasons = d.reasons.flatMap((r) => r.evidence ?? []);
  const fromProvenance = d.provenance.filter((p) => p.class === "UNTRUSTED_SOURCED").flatMap((p) => p.evidence);
  const all = fromReasons.length ? fromReasons : fromProvenance;
  return all.filter((e) => !e.segment_id.startsWith("arg:"));
}

/** Latest decision in a run that carries highlightable evidence. */
export function latestWithEvidence(run: RunState | undefined): Decision | undefined {
  if (!run) return undefined;
  return [...decisionsOf(run)].reverse().find((d) => evidenceOf(d).length > 0);
}
