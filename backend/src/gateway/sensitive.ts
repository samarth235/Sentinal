import type { Evidence } from "../types.js";
import type { Policy } from "../policy/loader.js";
import type { ContextLedger } from "./contextLedger.js";
import { excerpt } from "./normalize.js";

export interface SensitiveMatch {
  kind: string; // pattern name ("pan", "phone") or internal field name
  value: string;
  evidence: Evidence;
}

/**
 * Sensitive data in an outgoing argument (§8.4): any policy pattern match, or any value that
 * came back from an INTERNAL_DATA tool under a field listed in sensitive.fields.
 *
 * TODO(person-b): the match is inside a tool ARGUMENT, not a ledger segment, so segment_id is
 * "arg:<name>" and offsets index into the argument value. When the value is traceable to a
 * query_db result, a second evidence entry points at that ledger segment.
 */
export function containsSensitive(argName: string, text: string, ledger: ContextLedger, policy: Policy): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];
  const argEvidence = (start: number, end: number): Evidence => ({
    segment_id: `arg:${argName}`,
    source: "tool_result",
    trust: "INTERNAL_DATA",
    start,
    end,
    excerpt: excerpt(text, start, end),
  });

  for (const [kind, pattern] of Object.entries(policy.sensitive.patterns)) {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![A-Za-z0-9])`, "g"))) {
      matches.push({ kind, value: m[0], evidence: argEvidence(m.index, m.index + m[0].length) });
    }
  }

  const sensitiveFields = new Set(policy.sensitive.fields);
  for (const iv of ledger.internalValues) {
    if (!sensitiveFields.has(iv.field)) continue;
    let i = text.indexOf(iv.value);
    while (i !== -1) {
      const already = matches.some((m) => m.evidence.start === i && m.value === iv.value);
      if (!already) matches.push({ kind: iv.field, value: iv.value, evidence: argEvidence(i, i + iv.value.length) });
      const seg = ledger.get(iv.segment_id);
      const segAt = seg ? seg.text.indexOf(iv.value) : -1;
      if (seg && segAt !== -1 && !matches.some((m) => m.evidence.segment_id === seg.segment_id && m.value === iv.value)) {
        matches.push({
          kind: iv.field,
          value: iv.value,
          evidence: {
            segment_id: seg.segment_id,
            source: seg.source,
            trust: seg.trust,
            start: segAt,
            end: segAt + iv.value.length,
            excerpt: excerpt(seg.text, segAt, segAt + iv.value.length),
          },
        });
      }
      i = text.indexOf(iv.value, i + 1);
    }
  }
  return matches;
}
