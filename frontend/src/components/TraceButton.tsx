import { Search } from "lucide-react";
import { useState } from "react";
import { Popover } from "radix-ui";
import { api } from "../lib/api";
import type { ForensicsHit } from "../lib/types";

const tone = (verdict: string) => (verdict === "DENY" ? "text-deny" : verdict === "ALLOW" ? "text-allow" : "text-warn");

/** Forensics: "every action influenced by this page / email" as a query, not an investigation. */
export function TraceButton({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ForensicsHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setHits(await api.forensics(q.trim()));
    } catch (e) {
      setError((e as Error).message);
      setHits(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="btn btn-ghost btn-sm" aria-label="Trace a source">
          <Search size={14} /> Trace
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-[min(440px,calc(100vw-32px))] rounded-md border border-line bg-surface p-3 text-fg shadow-lg">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim().length >= 3) void search();
            }}
          >
            <label htmlFor="trace-q" className="text-xs font-medium text-fg-muted">
              Every action influenced by a source — paste a URL, sender or phrase from the suspicious content
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="trace-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="news.example.test/ai-trends-2026"
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 font-mono text-xs outline-none focus:border-line-strong"
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || q.trim().length < 3}>
                Trace
              </button>
            </div>
          </form>
          {error && <p className="mt-3 text-xs text-deny">{error}</p>}
          {hits && (
            <div className="mt-3 max-h-80 space-y-3 overflow-auto">
              {hits.length === 0 && <p className="text-xs text-fg-subtle">No untrusted content matches.</p>}
              {hits.map((h) => (
                <div key={h.source.segment_id} className="rounded-md border border-line p-2">
                  <button className="text-left text-xs font-medium hover:underline" onClick={() => onOpenRun(h.source.run_id)}>
                    {h.source.label ?? h.source.tool ?? "untrusted content"} <span className="font-mono text-fg-subtle">{h.source.run_id}</span>
                  </button>
                  <p className="mt-1 line-clamp-2 font-mono text-[11px] text-fg-muted">{h.source.excerpt}</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {h.decisions.length === 0 && <li className="text-[11px] text-fg-subtle">No actions after it.</li>}
                    {h.decisions.map((d) => (
                      <li key={d.decision_id} className="flex gap-2 text-[11px]">
                        <span className={`w-28 font-medium ${tone(d.verdict)}`}>{d.verdict}</span>
                        <span className="font-mono">{d.tool}</span>
                        <span className="text-fg-subtle">{d.outcome ?? "pending"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
