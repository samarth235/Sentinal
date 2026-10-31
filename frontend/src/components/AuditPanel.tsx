import { Link2, PencilLine, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { EmptyState } from "./ui";
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

  const doRestore = async () => {
    setBusy(true);
    try {
      const { restored } = await api.restoreTamper();
      setTampered(null);
      setVerify(await api.verify());
      onChanged();
      notify(restored.length ? `Restored row${restored.length > 1 ? "s" : ""} #${restored.join(", #")}.` : "Nothing to restore.");
    } catch (e) {
      notify(`Restore failed: ${(e as Error).message}`);
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
      <div className="panel-head">
        <span className="flex items-center gap-2">
          <span className="panel-title">Audit chain</span>
          {config?.audit_store && <span className="text-xs text-fg-subtle">{config.audit_store}</span>}
        </span>
        <span className="flex items-center gap-2">
          {verify &&
            (verify.valid ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-allow">
                <ShieldCheck size={13} /> Intact, {verify.rows} rows
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-deny">
                <ShieldAlert size={13} /> Broken at row #{verify.broken_at}
              </span>
            ))}
          {config?.tamper_demo && (tampered !== null || broken !== null) && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={doRestore}>
              <RotateCcw size={13} /> Undo tamper
            </button>
          )}
          {config?.tamper_demo && (
            <button className="btn btn-sm btn-ghost text-deny hover:text-deny" disabled={busy || rows.length === 0} onClick={doTamper}>
              <PencilLine size={13} /> Tamper
            </button>
          )}
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={doVerify}>
            Verify
          </button>
        </span>
      </div>
      <div ref={listRef} className="relative flex-1 overflow-y-auto py-1 font-mono text-[11.5px]">
        {shown.length === 0 && <EmptyState Icon={Link2} title="No audit rows yet" />}
        {shown.map((r) => {
          const isBroken = r.seq === broken;
          const isTampered = r.seq === tampered;
          return (
            <div
              key={r.seq}
              data-seq={r.seq}
              className={`flex items-center gap-4 px-4 py-1 ${isBroken ? "bg-deny-bg text-deny" : isTampered ? "bg-warn-bg" : "hover:bg-subtle"}`}
            >
              <span className={`w-10 tabular-nums ${isBroken ? "" : "text-fg-subtle"}`}>#{r.seq}</span>
              <span className={`w-32 truncate ${isBroken ? "" : "text-fg"}`}>{r.event_type}</span>
              <span className={isBroken ? "" : "text-fg-muted"} title={r.hash}>
                {short(r.hash)}
              </span>
              <span className="hidden text-fg-subtle 2xl:inline" title={r.prev_hash}>
                prev {short(r.prev_hash)}
              </span>
              {isTampered && <span className="ml-auto font-sans text-[11px] font-medium text-warn">Edited</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
