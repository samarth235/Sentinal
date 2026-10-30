import { EventEmitter } from "node:events";
import type { BusEvent } from "../types.js";
import type { AuditSink } from "./audit.js";

type Listener<T extends BusEvent["type"]> = (event: Extract<BusEvent, { type: T }>) => void;

/**
 * Typed event bus. Every event is appended to the AuditSink and then emitted to listeners,
 * both under its own type and under "event" (Person B bridges "event" to Socket.io).
 */
export class SentinelBus {
  private readonly emitter = new EventEmitter();
  private auditSink: () => AuditSink | undefined = () => undefined;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  useAudit(getSink: () => AuditSink): void {
    this.auditSink = getSink;
  }

  /** Audit, then emit. Throws if the audit append fails (listeners are still notified). */
  async publish(event: BusEvent): Promise<void> {
    try {
      await this.auditSink()?.append(event);
    } finally {
      this.emitLocal(event);
    }
  }

  /** Publish where an audit failure must not stop the caller; the failure is logged. */
  async publishSafe(event: BusEvent): Promise<void> {
    try {
      await this.publish(event);
    } catch (err) {
      console.error(`[sentinel] audit append failed for ${event.type}:`, (err as Error).message);
    }
  }

  /** Emit without auditing — used only when auditing itself has failed. */
  emitLocal(event: BusEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit("event", event);
  }

  on<T extends BusEvent["type"]>(type: T, listener: Listener<T>): () => void;
  on(type: "event", listener: (event: BusEvent) => void): () => void;
  on(type: string, listener: (event: any) => void): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }
}

export const bus = new SentinelBus();
