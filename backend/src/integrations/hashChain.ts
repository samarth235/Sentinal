import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { BusEvent } from "../types.js";
import type { AuditSink } from "./audit.js";
import { canonicalJson } from "./canonicalJson.js";
import { maskDeep } from "./masking.js";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditRow {
  seq: number;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: string; // ISO, computed in Node so the hash input is known
  prev_hash: string;
  hash: string;
}

export type VerifyResult =
  | { valid: true; rows: number }
  | { valid: false; rows: number; broken_at: number; expected: string; found: string };

export function computeHash(prevHash: string, seq: number, eventType: string, payload: unknown, createdAtIso: string): string {
  return createHash("sha256")
    .update(`${prevHash}|${seq}|${eventType}|${canonicalJson(payload)}|${createdAtIso}`)
    .digest("hex");
}

/** Storage behind the chain. append() receives a builder that turns the current tail into the next row. */
export interface ChainStore {
  readonly kind: "postgres" | "memory";
  append(build: (tail: { seq: number; hash: string } | null) => AuditRow): Promise<AuditRow>;
  list(runId?: string): Promise<AuditRow[]>;
  /** Demo only: rewrite one decision row's payload without fixing hashes. */
  tamper(): Promise<number | null>;
  /** Demo only: overwrite one row's payload in place (used by tamper and its undo). */
  setPayload(seq: number, payload: unknown): Promise<void>;
}

/**
 * Hash-chained audit sink. Appends are serialised through one in-process queue (the store
 * also locks, so concurrent processes cannot fork the chain). Payloads are masked before
 * storage. append() rejects on storage failure; the gateway then denies the action.
 */
export class HashChainAuditSink implements AuditSink {
  private queue: Promise<unknown> = Promise.resolve();
  /** seq -> payload before the tamper demo edited it, so a rehearsal can be undone. */
  private readonly originals = new Map<number, unknown>();

  constructor(readonly store: ChainStore) {}

  append(event: BusEvent): Promise<void> {
    const payload = maskDeep(JSON.parse(JSON.stringify(event)));
    const job = this.queue.then(() =>
      this.store.append((tail) => {
        const seq = (tail?.seq ?? 0) + 1;
        const prev_hash = tail?.hash ?? GENESIS_HASH;
        const created_at = new Date().toISOString();
        const hash = computeHash(prev_hash, seq, event.type, payload, created_at);
        return { seq, run_id: event.run_id, event_type: event.type, payload, created_at, prev_hash, hash };
      }),
    );
    // Keep the queue alive after a failure; the caller still sees the rejection.
    this.queue = job.catch(() => undefined);
    return job.then(() => undefined);
  }

  list(runId?: string): Promise<AuditRow[]> {
    return this.store.list(runId);
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(await this.store.list());
  }

  async tamper(): Promise<number | null> {
    const target = pickTamperTarget(await this.store.list());
    if (!target) return null;
    if (!this.originals.has(target.seq)) this.originals.set(target.seq, target.payload);
    await this.store.setPayload(target.seq, flipVerdict(target.payload));
    return target.seq;
  }

  /** Undo every tamper made by this process. Returns the restored seqs. */
  async restore(): Promise<number[]> {
    const seqs = [...this.originals.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      await this.store.setPayload(seq, this.originals.get(seq));
      this.originals.delete(seq);
    }
    return seqs;
  }

  get tamperedSeqs(): number[] {
    return [...this.originals.keys()];
  }
}

export function verifyChain(rows: AuditRow[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const expected = computeHash(prev, row.seq, row.event_type, row.payload, row.created_at);
    if (row.prev_hash !== prev || row.hash !== expected) {
      return { valid: false, rows: rows.length, broken_at: row.seq, expected, found: row.hash };
    }
    prev = row.hash;
  }
  return { valid: true, rows: rows.length };
}

/**
 * Local fallback (no DATABASE_URL): chain kept in memory, mirrored to a JSONL file when a path is given.
 * On first use the file is read back so the chain survives restarts. A file that does not verify is
 * moved aside (never silently extended) and a fresh chain starts.
 */
export class MemoryChainStore implements ChainStore {
  readonly kind = "memory" as const;
  readonly rows: AuditRow[] = [];
  private loaded: Promise<void> | null = null;

  constructor(private readonly filePath: string | null = null) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.filePath) return;
      let text: string;
      try {
        text = await fs.readFile(this.filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      let rows: AuditRow[] = [];
      let parsed = true;
      try {
        rows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditRow);
      } catch {
        parsed = false;
      }
      if (parsed && verifyChain(rows).valid) {
        this.rows.push(...rows);
        return;
      }
      const aside = `${this.filePath}.invalid-${Date.now()}`;
      await fs.rename(this.filePath, aside);
      console.warn(`[sentinel] ${this.filePath} did not verify; moved to ${aside} and started a new chain`);
    })();
    return this.loaded;
  }

  async append(build: (tail: { seq: number; hash: string } | null) => AuditRow): Promise<AuditRow> {
    await this.load();
    const last = this.rows.at(-1);
    const row = build(last ? { seq: last.seq, hash: last.hash } : null);
    if (this.filePath) await fs.appendFile(this.filePath, JSON.stringify(row) + "\n", "utf8");
    this.rows.push(row);
    return row;
  }

  async list(runId?: string): Promise<AuditRow[]> {
    await this.load();
    const rows = runId ? this.rows.filter((r) => r.run_id === runId) : this.rows;
    return rows.map((r) => ({ ...r }));
  }

  async tamper(): Promise<number | null> {
    await this.load();
    const row = pickTamperTarget(this.rows);
    if (!row) return null;
    row.payload = flipVerdict(row.payload);
    return row.seq;
  }

  /** Only the in-memory copy changes; the JSONL mirror keeps the original row. */
  async setPayload(seq: number, payload: unknown): Promise<void> {
    await this.load();
    const row = this.rows.find((r) => r.seq === seq);
    if (row) row.payload = payload;
  }
}

/** Prefer the latest DENY decision (flipping it to ALLOW is the most dramatic edit). */
export function pickTamperTarget<T extends { event_type: string; payload: unknown }>(rows: T[]): T | undefined {
  const decisions = rows.filter((r) => r.event_type === "decision.made");
  const verdict = (r: T) => (r.payload as { decision?: { verdict?: string } })?.decision?.verdict;
  return [...decisions].reverse().find((r) => verdict(r) === "DENY") ?? decisions.at(-1);
}

export function flipVerdict(payload: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy?.decision) copy.decision.verdict = copy.decision.verdict === "ALLOW" ? "DENY" : "ALLOW";
  return copy;
}
