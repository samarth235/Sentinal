// In-memory "damage" stores. Nothing here ever leaves the process.

export interface OutboxEmail {
  id: string;
  run_id: string;
  to: string;
  subject: string;
  body: string;
  sent_at: string;
}

export interface LedgerPayment {
  id: string;
  run_id: string;
  payee: string;
  amount_inr: number;
  note?: string;
  paid_at: string;
}

const outbox: OutboxEmail[] = [];
const ledger: LedgerPayment[] = [];

export function getOutbox(runId?: string): OutboxEmail[] {
  return runId ? outbox.filter((e) => e.run_id === runId) : [...outbox];
}

export function getLedger(runId?: string): LedgerPayment[] {
  return runId ? ledger.filter((p) => p.run_id === runId) : [...ledger];
}

export function pushEmail(email: OutboxEmail): void {
  outbox.push(email);
}

export function pushPayment(payment: LedgerPayment): void {
  ledger.push(payment);
}

export function reset(): void {
  outbox.length = 0;
  ledger.length = 0;
}
