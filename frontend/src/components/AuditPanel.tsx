import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AuditRow, UiConfig, VerifyResult } from "../lib/types";

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export function AuditPanel({ rows, config, onChanged, notify }: { rows: AuditRow[]; config: UiConfig | null; onChanged: () => void; notify: (m: string) => void }) {
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [tampered, setTampered] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const doVerify = async () => {
    setBusy(true);
    try {
      setVerify(await api.verify());
    } catch (e) {
      notify(`Verify failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const doTamper = async () => {
    setBusy(true);
    try {
      const { tampered_seq } = await api.tamper();
      setTampered(tampered_seq);
      setVerify(null);
      onChanged();
      notify(`Row #${tampered_seq} edited directly in the store (verdict flipped). Press Verify.`);
    } catch (e) {
      notify(`Tamper failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const broken = verify && !verify.valid ? verify.broken_at : null;
  const listRef = useRef<HTMLDivElement | null>(null);
  // Show the broken row even when it is older than the visible window.
  const tail = rows.slice(-60);
  const shown = (broken !== null && !tail.some((r) => r.seq === broken) ? [...rows.filter((r) => r.seq === broken), ...tail] : tail).reverse();

  useEffect(() => {
    if (broken === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seq="${broken}"]`);
    const list = listRef.current;
    if (el && list) list.scrollTo({ top: el.offsetTop - list.offsetTop - list.clientHeight / 2, behavior: "smooth" });
  }, [broken]);

  return (
    <section className="panel">
      <div className="panel-title">
        <span>Audit chain {config?.audit_store && <span className="normal-case tracking-normal text-zinc-500">· {config.audit_store}</span>}</span>
        <span className="flex items-center gap-2 normal-case tracking-normal">
          {verify &&
            (verify.valid ? (
              <span className="rounded-md bg-allow/15 px-2 py-1 text-xs font-bold text-allow">✓ Chain intact ({verify.rows} rows)</span>
            ) : (
              <span className="rounded-md bg-deny/20 px-2 py-1 text-xs font-bold text-deny">✕ Tampered at row #{verify.broken_at}</span>
            ))}
          <button className="btn btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={doVerify}>
            Verify
          </button>
          {config?.tamper_demo && (
            <button className="btn px-2.5 py-1 text-xs border border-deny/60 text-deny hover:bg-deny/10" disabled={busy || rows.length === 0} onClick={doTamper}>
              Tamper
            </button>
          )}
        </span>
      </div>
      <div ref={listRef} className="relative flex-1 overflow-y-auto px-4 pb-3 font-mono text-[11.5px]">
        {shown.length === 0 && <p className="pt-6 text-center font-sans text-sm text-muted">No audit rows yet.</p>}
        {shown.map((r, i) => {
          const isBroken = r.seq === broken;
          const isTampered = r.seq === tampered;
          return (
            <div key={r.seq} data-seq={r.seq} className="relative pl-5">
              {i < shown.length - 1 && <span className={`absolute left-[7px] top-4 h-full w-px ${isBroken ? "bg-deny" : "bg-zinc-700"}`} />}
              <span className={`absolute left-[3px] top-[7px] h-2.5 w-2.5 rounded-full ${isBroken ? "bg-deny" : "bg-zinc-500"}`} />
              <div className={`flex items-center gap-3 rounded px-1.5 py-1 ${isBroken ? "bg-red-950/60 text-red-200" : isTampered ? "bg-amber-950/30" : ""}`}>
                <span className="w-9 text-zinc-500">#{r.seq}</span>
                <span className="w-32 truncate text-zinc-200">{r.event_type}</span>
                <span className="text-zinc-400" title={r.hash}>
                  {short(r.hash)}
                </span>
                <span className="hidden text-zinc-600 2xl:inline" title={r.prev_hash}>
                  ← {short(r.prev_hash)}
                </span>
                {isTampered && <span className="ml-auto font-sans text-[10px] font-bold text-approve">EDITED</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
