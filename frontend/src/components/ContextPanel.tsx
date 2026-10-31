import { ChevronRight, FileText, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState, Legend } from "./ui";
import { segmentSource } from "../lib/derive";
import type { RunState } from "../lib/store";
import type { ContextSegment, Evidence } from "../lib/types";

const TRUST_STYLE = {
  TRUSTED: { rail: "bg-line-strong", tag: "text-fg-muted bg-subtle border-line", name: "Trusted" },
  UNTRUSTED: { rail: "bg-deny-solid", tag: "text-deny bg-deny-bg border-deny-line", name: "Untrusted" },
  INTERNAL_DATA: { rail: "bg-warn-solid", tag: "text-warn bg-warn-bg border-warn-line", name: "Internal data" },
} as const;

function Highlighted({ text, ranges, firstRef }: { text: string; ranges: Evidence[]; firstRef: React.RefObject<HTMLElement | null> }) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((r, i) => {
    if (r.start < cursor) return;
    parts.push(text.slice(cursor, r.start));
    parts.push(
      <mark key={i} ref={i === 0 ? (firstRef as React.RefObject<HTMLElement>) : undefined} className="mark-evidence">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    cursor = r.end;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function Segment({ run, seg, evidence, scrollRef }: { run: RunState; seg: ContextSegment; evidence: Evidence[]; scrollRef: React.RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(seg.source !== "system");
  const style = TRUST_STYLE[seg.trust];
  const label = seg.source === "user" ? "user prompt" : seg.source === "system" ? "system prompt" : segmentSource(run, seg);
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-surface">
      <span className={`absolute inset-y-0 left-0 w-0.5 ${style.rail}`} />
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-subtle" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`} />
        <span className={`shrink-0 rounded border px-1.5 text-[11px] font-medium leading-5 ${style.tag}`}>{style.name}</span>
        <span className="truncate font-mono text-xs text-fg-muted">{label}</span>
        {evidence.length > 0 && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-deny">
            <TriangleAlert size={12} /> Evidence
          </span>
        )}
      </button>
      {open && (
        <pre className={`max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 leading-relaxed ${seg.source === "user" ? "font-sans text-[13.5px] text-fg" : "font-mono text-xs text-fg-muted"}`}>
          <Highlighted text={seg.text} ranges={evidence} firstRef={scrollRef} />
        </pre>
      )}
    </div>
  );
}

export function ContextPanel({ run, evidence }: { run?: RunState; evidence: Evidence[] }) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const key = evidence.map((e) => `${e.segment_id}:${e.start}`).join("|");
  // Scroll only the panel and the segment box to the highlight, never the page itself.
  useEffect(() => {
    const mark = scrollRef.current;
    const list = listRef.current;
    if (!mark || !list) return;
    const pre = mark.closest("pre");
    if (pre) pre.scrollTo({ top: mark.offsetTop - pre.offsetTop - pre.clientHeight / 3, behavior: "smooth" });
    const box = (pre ?? mark).getBoundingClientRect();
    const view = list.getBoundingClientRect();
    list.scrollTo({ top: list.scrollTop + box.top - view.top - 8, behavior: "smooth" });
  }, [key]);

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Context the agent read</span>
        <span className="flex gap-3 text-xs text-fg-subtle">
          <Legend color="bg-deny-solid" label="Untrusted" />
          <Legend color="bg-warn-solid" label="Internal" />
        </span>
      </div>
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto bg-canvas p-3">
        {!run && <Empty />}
        {run?.segments.map((seg) => (
          <Segment key={seg.segment_id} run={run} seg={seg} evidence={evidence.filter((e) => e.segment_id === seg.segment_id)} scrollRef={scrollRef} />
        ))}
      </div>
    </section>
  );
}

function Empty() {
  return <EmptyState Icon={FileText} title="No context yet" hint="Pick a scenario and press Run." />;
}
