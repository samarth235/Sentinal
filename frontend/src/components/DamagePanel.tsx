import { Mail, Wallet } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "./ui";
import { formatArg, maskText } from "../lib/mask";
import type { LedgerPayment, OutboxEmail } from "../lib/types";

const TRUSTED_DOMAIN = "company.test";

export function DamagePanel({ outbox, ledger }: { outbox: OutboxEmail[]; ledger: LedgerPayment[] }) {
  const [tab, setTab] = useState<"outbox" | "ledger">("outbox");
  const bad = outbox.filter((e) => !e.to.toLowerCase().endsWith(`@${TRUSTED_DOMAIN}`)).length + ledger.length;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="flex items-center gap-2">
          <span className="panel-title">Side effects</span>
          {bad > 0 && <span className="rounded border border-deny-line bg-deny-bg px-1.5 text-[11px] font-medium leading-5 text-deny">{bad} harmful</span>}
        </span>
        <span className="flex h-7 rounded-md border border-line bg-subtle p-0.5">
          {(["outbox", "ledger"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-[5px] px-2.5 text-xs ${tab === t ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}>
              {t === "outbox" ? "Outbox" : "Ledger"} <span className="text-fg-subtle tabular-nums">{t === "outbox" ? outbox.length : ledger.length}</span>
            </button>
          ))}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "outbox" ? (
          outbox.length === 0 ? (
            <EmptyState Icon={Mail} title="Outbox empty" hint="No emails sent." />
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-surface text-xs text-fg-subtle">
                <tr>
                  <th className="border-b border-line py-2 pl-4 pr-3 font-medium">To</th>
                  <th className="border-b border-line py-2 pr-3 font-medium">Subject</th>
                  <th className="border-b border-line py-2 pr-4 font-medium">Body</th>
                </tr>
              </thead>
              <tbody>
                {[...outbox].reverse().map((e) => {
                  const attacker = !e.to.toLowerCase().endsWith(`@${TRUSTED_DOMAIN}`);
                  return (
                    <tr key={e.id} className={`border-b border-line ${attacker ? "bg-deny-bg" : ""}`}>
                      <td className={`py-2 pl-4 pr-3 font-mono ${attacker ? "font-medium text-deny" : ""}`}>{e.to}</td>
                      <td className="py-2 pr-3">{e.subject}</td>
                      <td className="py-2 pr-4 font-mono text-[11.5px] text-fg-muted">{formatArg(maskText(e.body), 90)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : ledger.length === 0 ? (
          <EmptyState Icon={Wallet} title="Ledger empty" hint="No money moved." />
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-surface text-xs text-fg-subtle">
              <tr>
                <th className="border-b border-line py-2 pl-4 pr-3 font-medium">Payee</th>
                <th className="border-b border-line py-2 pr-3 font-medium">Amount</th>
                <th className="border-b border-line py-2 pr-4 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {[...ledger].reverse().map((p) => (
                <tr key={p.id} className="border-b border-line bg-deny-bg">
                  <td className="py-2 pl-4 pr-3 font-mono font-medium text-deny">{p.payee}</td>
                  <td className="py-2 pr-3 font-medium tabular-nums">₹{p.amount_inr.toLocaleString("en-IN")}</td>
                  <td className="py-2 pr-4 text-fg-muted">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
