import fs from "node:fs/promises";
import type { BusEvent } from "../types.js";

export interface AuditSink {
  append(event: BusEvent): Promise<void>;
}

export interface AuditRecord {
  seq: number;
  at: string;
  event: BusEvent;
}

/**
 * Stub sink: in-memory array, plus one JSON line per event to a file when a path is given.
 * Person B replaces this with a hash-chained Postgres sink.
 */
export class JsonlAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  constructor(private readonly filePath: string | null) {}

  async append(event: BusEvent): Promise<void> {
    const record: AuditRecord = { seq: this.records.length + 1, at: new Date().toISOString(), event };
    if (this.filePath) await fs.appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
    this.records.push(record);
  }
}
