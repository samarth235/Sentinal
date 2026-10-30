import { useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL } from "./api";
import type { BusEvent, ContextSegment, Decision, RunSummary, ToolCall } from "./types";

export interface RunState {
  run_id: string;
  scenario_id: string;
  shield: boolean;
  mode: "live" | "scripted";
  segments: ContextSegment[];
  calls: ToolCall[];
  decisions: Record<string, Decision>;
  decisionOrder: string[];
  /** decision_id -> ms timestamp when approval was requested, while pending. */
  pending: Record<string, number>;
  approvals: Record<string, { result: "approved" | "rejected" | "timeout"; approver?: string }>;
  executed: Record<string, string>;
  messages: string[];
  summary?: RunSummary;
}

export interface State {
  connected: boolean;
  runs: Record<string, RunState>;
  runOrder: string[];
}

let state: State = { connected: false, runs: {}, runOrder: [] };
const listeners = new Set<() => void>();
const finishWaiters = new Map<string, (s: RunSummary) => void>();

function set(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

function ensureRun(s: State, runId: string): RunState {
  return (
    s.runs[runId] ?? {
      run_id: runId,
      scenario_id: "",
      shield: true,
      mode: "scripted",
      segments: [],
      calls: [],
      decisions: {},
      decisionOrder: [],
      pending: {},
      approvals: {},
      executed: {},
      messages: [],
    }
  );
}

/** Pure reducer: all UI state is derived from BusEvents. */
export function reduce(s: State, e: BusEvent): State {
  const run = { ...ensureRun(s, e.run_id) };
  switch (e.type) {
    case "run.started":
      Object.assign(run, { scenario_id: e.scenario_id, shield: e.shield, mode: e.mode });
      break;
    case "context.added":
      if (!run.segments.some((x) => x.segment_id === e.segment.segment_id)) run.segments = [...run.segments, e.segment];
      break;
    case "tool.requested":
      run.calls = [...run.calls, e.call];
      break;
    case "decision.made":
      run.decisions = { ...run.decisions, [e.decision.decision_id]: e.decision };
      if (!run.decisionOrder.includes(e.decision.decision_id)) run.decisionOrder = [...run.decisionOrder, e.decision.decision_id];
      break;
    case "approval.requested":
      run.pending = { ...run.pending, [e.decision.decision_id]: Date.now() };
      break;
    case "approval.resolved": {
      const { [e.decision_id]: _done, ...rest } = run.pending;
      run.pending = rest;
      run.approvals = { ...run.approvals, [e.decision_id]: { result: e.result, approver: e.approver } };
      break;
    }
    case "tool.executed":
      run.executed = { ...run.executed, [e.decision_id]: e.result_preview };
      break;
    case "agent.message":
      run.messages = [...run.messages, e.text];
      break;
    case "run.finished":
      run.summary = e.summary;
      break;
  }
  const runOrder = s.runOrder.includes(e.run_id) ? s.runOrder : [...s.runOrder, e.run_id];
  return { ...s, runs: { ...s.runs, [e.run_id]: run }, runOrder };
}

let socket: Socket | null = null;

export function connect(onDisconnect: (msg: string) => void, onReconnect: () => void) {
  if (socket) return;
  socket = io(API_URL, { transports: ["websocket", "polling"], reconnection: true });
  let wasConnected = false;
  socket.on("connect", () => {
    if (wasConnected) onReconnect();
    wasConnected = true;
    set({ ...state, connected: true });
  });
  socket.on("disconnect", () => {
    set({ ...state, connected: false });
    onDisconnect("Lost connection to Sentinel — reconnecting…");
  });
  socket.on("connect_error", () => {
    if (state.connected || !wasConnected) set({ ...state, connected: false });
  });
  // Snapshot = replay of the last 500 events, so a refreshed page recovers its state.
  socket.on("sentinel:snapshot", (events: BusEvent[]) => {
    let s: State = { connected: true, runs: {}, runOrder: [] };
    for (const e of events) s = reduce(s, e);
    set(s);
  });
  socket.on("sentinel:event", (e: BusEvent) => {
    set(reduce(state, e));
    if (e.type === "run.finished") {
      finishWaiters.get(e.run_id)?.(e.summary);
      finishWaiters.delete(e.run_id);
    }
  });
}

export function waitForFinish(runId: string): Promise<RunSummary> {
  const done = state.runs[runId]?.summary;
  if (done) return Promise.resolve(done);
  return new Promise((resolve) => finishWaiters.set(runId, resolve));
}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
