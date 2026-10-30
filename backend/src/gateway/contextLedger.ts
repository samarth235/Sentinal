import { nanoid } from "nanoid";
import type { BusEvent, ContextSegment, Trust } from "../types.js";

export interface InternalValue {
  segment_id: string;
  field: string;
  value: string;
}

/**
 * Per-run record of everything the agent has seen, in order, with a trust level.
 * This is what provenance and taint are computed from.
 */
export class ContextLedger {
  readonly segments: ContextSegment[] = [];
  /** Values returned by INTERNAL_DATA tools (query_db), keyed by field. */
  readonly internalValues: InternalValue[] = [];
  /** Human label per segment, e.g. the URL a page came from. */
  readonly labels = new Map<string, string>();

  constructor(
    readonly runId: string,
    private readonly emit: (event: BusEvent) => void = () => {},
  ) {}

  private add(seg: Omit<ContextSegment, "segment_id" | "added_at">, label?: string): ContextSegment {
    const segment: ContextSegment = { segment_id: `seg_${nanoid(8)}`, added_at: new Date().toISOString(), ...seg };
    this.segments.push(segment);
    if (label) this.labels.set(segment.segment_id, label);
    this.emit({ type: "context.added", run_id: this.runId, segment });
    return segment;
  }

  addSystem(text: string): ContextSegment {
    return this.add({ source: "system", trust: "TRUSTED", text });
  }

  addUser(text: string): ContextSegment {
    return this.add({ source: "user", trust: "TRUSTED", text });
  }

  addToolResult(
    tool: string,
    trust: Trust,
    text: string,
    opts: { label?: string; records?: Record<string, unknown>[] } = {},
  ): ContextSegment {
    const segment = this.add({ source: "tool_result", tool, trust, text }, opts.label);
    if (trust === "INTERNAL_DATA" && opts.records) {
      for (const row of opts.records) {
        for (const [field, value] of Object.entries(row)) {
          if (value !== null && value !== undefined && String(value).length > 0) {
            this.internalValues.push({ segment_id: segment.segment_id, field, value: String(value) });
          }
        }
      }
    }
    return segment;
  }

  isTainted(): boolean {
    return this.segments.some((s) => s.trust === "UNTRUSTED");
  }

  untrustedText(): string {
    return this.segments
      .filter((s) => s.trust === "UNTRUSTED")
      .map((s) => s.text)
      .join("\n\n");
  }

  /** A copy holding only the first n segments — what the agent had seen at that point (for replay). */
  snapshot(n = this.segments.length): ContextLedger {
    const copy = new ContextLedger(this.runId);
    copy.segments.push(...this.segments.slice(0, n));
    const kept = new Set(copy.segments.map((s) => s.segment_id));
    copy.internalValues.push(...this.internalValues.filter((v) => kept.has(v.segment_id)));
    for (const [id, label] of this.labels) if (kept.has(id)) copy.labels.set(id, label);
    return copy;
  }

  get(segmentId: string): ContextSegment | undefined {
    return this.segments.find((s) => s.segment_id === segmentId);
  }
}
