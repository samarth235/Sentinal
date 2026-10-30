import { useEffect, useRef, useState } from "react";
import { segmentSource } from "../lib/derive";
import type { RunState } from "../lib/store";
import type { ContextSegment, Evidence } from "../lib/types";

const TRUST_STYLE = {
  TRUSTED: { box: "border-line bg-panel-2", tag: "text-zinc-300 bg-zinc-700/50", name: "trusted" },
  UNTRUSTED: { box: "border-deny/70 bg-red-950/20 ring-1 ring-deny/20", tag: "text-red-200 bg-deny/30", name: "untrusted" },
  INTERNAL_DATA: { box: "border-approve/50 bg-amber-950/15", tag: "text-amber-200 bg-approve/25", name: "internal data" },
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
    <div className={`rounded-lg border p-3 ${style.box}`}>
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${style.tag}`}>{style.name}</span>
        <span className="truncate font-mono text-xs text-zinc-400">{label}</span>
        {evidence.length > 0 && <span className="ml-auto shrink-0 text-[11px] font-bold text-deny">● evidence</span>}
      </button>
      {open && (
        <pre className={`mt-2 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed ${seg.source === "user" ? "text-base font-sans text-zinc-100" : "text-zinc-300"} max-h-72 overflow-y-auto`}>
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
  // Scroll only the panel and the segment box to the highlight — never the page itself.
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
      <div className="panel-title">
        Context the agent read
        <span className="flex gap-2 normal-case tracking-normal">
          <span className="text-deny">■ untrusted</span>
          <span className="text-approve">■ internal</span>
        </span>
      </div>
      <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 pb-4">
        {!run && <Empty />}
        {run?.segments.map((seg) => (
          <Segment key={seg.segment_id} run={run} seg={seg} evidence={evidence.filter((e) => e.segment_id === seg.segment_id)} scrollRef={scrollRef} />
        ))}
      </div>
    </section>
  );
}

function Empty() {
  return <p className="pt-8 text-center text-sm text-muted">Pick a scenario and press Run.</p>;
}
