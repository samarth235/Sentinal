import type { ArgProvenance, ContextSegment, Evidence } from "../types.js";
import type { ContextLedger } from "./contextLedger.js";
import { excerpt, findSpans, kindForArg, normalizeValue } from "./normalize.js";

export function toEvidence(segment: ContextSegment, start: number, end: number): Evidence {
  return {
    segment_id: segment.segment_id,
    source: segment.source,
    trust: segment.trust,
    start,
    end,
    excerpt: excerpt(segment.text, start, end),
  };
}

/**
 * Where did this argument value come from? Deterministic string matching (§8.3):
 * - found in a user segment            -> USER_SOURCED (user intent wins)
 * - found only in untrusted segments   -> UNTRUSTED_SOURCED
 * - found nowhere                      -> UNKNOWN (the model made it up)
 * System prompts and internal data are not searched.
 */
export function argProvenance(arg: string, value: unknown, ledger: ContextLedger): ArgProvenance {
  const kind = kindForArg(arg);
  const needle = normalizeValue(kind, value);
  const display = typeof value === "string" ? value : JSON.stringify(value);
  const evidence: Evidence[] = [];

  if (needle) {
    for (const seg of ledger.segments) {
      const searchable = (seg.source === "user" && seg.trust === "TRUSTED") || seg.trust === "UNTRUSTED";
      if (!searchable) continue;
      for (const span of findSpans(kind, needle, seg.text)) evidence.push(toEvidence(seg, span.start, span.end));
    }
  }

  const inUser = evidence.some((e) => e.source === "user");
  const inUntrusted = evidence.some((e) => e.trust === "UNTRUSTED");
  const cls = inUser ? "USER_SOURCED" : inUntrusted ? "UNTRUSTED_SOURCED" : "UNKNOWN";
  return { arg, value: display, class: cls, evidence };
}

export function computeProvenance(
  provenanceArgs: string[],
  args: Record<string, unknown>,
  ledger: ContextLedger,
): ArgProvenance[] {
  return provenanceArgs.filter((a) => args[a] !== undefined).map((a) => argProvenance(a, args[a], ledger));
}

/** Describe where in a page an evidence span sits, for plain-English reasons. */
export function describeLocation(text: string, start: number): string {
  const commentOpen = text.lastIndexOf("<!--", start);
  if (commentOpen !== -1 && text.lastIndexOf("-->", start) < commentOpen) return "an HTML comment";

  const before = text.slice(0, start);
  const tags = [...before.matchAll(/<([a-z]+)\b[^>]*style\s*=\s*"([^"]*)"[^>]*>/gi)];
  const last = tags.at(-1);
  if (last && last.index !== undefined) {
    const closed = before.slice(last.index).includes(`</${last[1]}`);
    const hiddenStyle = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*[01](px)?\b|color\s*:\s*#fff(fff)?\b|opacity\s*:\s*0(\.0+)?\b/i;
    if (!closed && hiddenStyle.test(last[2])) return "hidden text";
  }
  return "the page text";
}
