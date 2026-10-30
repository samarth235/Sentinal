import { useState } from "react";
import { formatArg, maskText } from "../lib/mask";
import type { LedgerPayment, OutboxEmail } from "../lib/types";

const TRUSTED_DOMAIN = "company.test";

export function DamagePanel({ outbox, ledger }: { outbox: OutboxEmail[]; ledger: LedgerPayment[] }) {
  const [tab, setTab] = useState<"outbox" | "ledger">("outbox");
  const bad = outbox.filter((e) => !e.to.toLowerCase().endsWith(`@${TRUSTED_DOMAIN}`)).length + ledger.length;
  return (
    <section className="panel">
      <div className="panel-title">
        <span className="flex items-center gap-2">
          Damage
          {bad > 0 && <span className="rounded bg-deny px-1.5 py-0.5 text-[10px] font-bold text-white normal-case tracking-normal">{bad} harmful</span>}
        </span>
        <span className="flex gap-1 normal-case tracking-normal">
          {(["outbox", "ledger"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded px-2 py-0.5 text-xs font-semibold ${tab === t ? "bg-zinc-200 text-black" : "text-muted hover:text-zinc-200"}`}>
              {t === "outbox" ? `Outbox (${outbox.length})` : `Ledger (${ledger.length})`}
            </button>
          ))}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-3">
        {tab === "outbox" ? (
          outbox.length === 0 ? (
            <p className="pt-6 text-center text-sm text-muted">Outbox empty — no emails sent.</p>
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] uppercase text-muted">
                <tr>
                  <th className="py-1 pr-2 font-semibold">To</th>
                  <th className="py-1 pr-2 font-semibold">Subject</th>
                  <th className="py-1 font-semibold">Body</th>
                </tr>
              </thead>
              <tbody>
                {[...outbox].reverse().map((e) => {
                  const attacker = !e.to.toLowerCase().endsWith(`@${TRUSTED_DOMAIN}`);
                  return (
                    <tr key={e.id} className={`border-t border-line ${attacker ? "bg-red-950/40 text-red-100" : ""}`}>
                      <td className={`py-1.5 pr-2 font-mono font-semibold ${attacker ? "text-deny" : ""}`}>{e.to}</td>
                      <td className="py-1.5 pr-2">{e.subject}</td>
                      <td className="py-1.5 font-mono text-[11.5px] text-zinc-400">{formatArg(maskText(e.body), 90)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : ledger.length === 0 ? (
          <p className="pt-6 text-center text-sm text-muted">Ledger empty — no money moved.</p>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] uppercase text-muted">
              <tr>
                <th className="py-1 pr-2 font-semibold">Payee</th>
                <th className="py-1 pr-2 font-semibold">Amount</th>
                <th className="py-1 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody>
              {[...ledger].reverse().map((p) => (
                <tr key={p.id} className="border-t border-line bg-red-950/40 text-red-100">
                  <td className="py-1.5 pr-2 font-mono font-semibold text-deny">{p.payee}</td>
                  <td className="py-1.5 pr-2 font-semibold">₹{p.amount_inr.toLocaleString("en-IN")}</td>
                  <td className="py-1.5 text-zinc-400">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
