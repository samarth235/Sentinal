import { useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";
import type { BusEvent, ContextSegment, Decision, RunSummary, ToolCall } from "./types";

export interface RunState {
  run_id: string;
  scenario_id: string;
  shield: boolean;
  mode: "live" | "scripted" | "sdk";
  /** For agent sessions (mode "sdk"): the session title and profile. */
  title?: string;
  profile?: string;
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
  // System events (overrides, notices) are not runs.
  if (e.run_id === "system" || e.type === "policy.override" || e.type === "system.notice") return s;
  const run = { ...ensureRun(s, e.run_id) };
  switch (e.type) {
    case "run.started":
      Object.assign(run, { scenario_id: e.scenario_id, shield: e.shield, mode: e.mode, title: e.title, profile: e.profile });
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
      // Server time of the decision, so the countdown survives a page refresh (snapshot replay).
      run.pending = { ...run.pending, [e.decision.decision_id]: Date.parse(e.decision.decided_at) || Date.now() };
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
type Notice = { level: "info" | "warn" | "error"; text: string };
const noticeListeners = new Set<(n: Notice) => void>();

/** Server notices (Telegram delivery failures, audit alerts, policy changes). */
export function onNotice(fn: (n: Notice) => void): () => void {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
}

/** Reconnect with the current token (after the user signs in). */
export function reconnect() {
  if (!socket) return;
  socket.auth = { token: getToken() };
  socket.disconnect().connect();
}

export function connect(onDisconnect: (msg: string) => void, onReconnect: () => void, onUnauthorized: () => void = () => {}) {
  if (socket) return;
  socket = io(API_URL, { transports: ["websocket", "polling"], reconnection: true, auth: { token: getToken() } });
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
  socket.on("connect_error", (err) => {
    if (state.connected || !wasConnected) set({ ...state, connected: false });
    if (err?.message === "unauthorized") onUnauthorized();
  });
  // Snapshot = replay of the last 500 events, so a refreshed page recovers its state.
  socket.on("sentinel:snapshot", (events: BusEvent[]) => {
    let s: State = { connected: true, runs: {}, runOrder: [] };
    for (const e of events) s = reduce(s, e);
    set(s);
  });
  socket.on("sentinel:event", (e: BusEvent) => {
    if (e.type === "system.notice") noticeListeners.forEach((fn) => fn({ level: e.level, text: e.text }));
    if (e.type === "policy.override") {
      const what = e.action === "granted" ? `${e.profile} may use ${e.tool} until ${new Date(e.expires_at ?? "").toLocaleTimeString()}` : e.action === "cleared" ? "all overrides cleared" : `${e.profile} → ${e.tool} expired`;
      noticeListeners.forEach((fn) => fn({ level: "warn", text: `Policy override: ${what} (${e.by})` }));
    }
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
