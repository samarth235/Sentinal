import type { AuditRow, Decision, LedgerPayment, OutboxEmail, RunSummary, ScenarioInfo, UiConfig, VerifyResult } from "./types";

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:4000";

const TOKEN_KEY = "sentinel-api-token";

/** Operator token for state-changing routes (only needed when the backend sets API_TOKEN). */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: the token simply is not remembered.
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  scenarios: () => req<ScenarioInfo[]>("/api/scenarios"),
  uiConfig: () => req<UiConfig>("/api/ui-config"),
  startRun: (scenario_id: string, shield: boolean, mode: "live" | "scripted") =>
    req<{ run_id: string }>("/api/runs", { method: "POST", body: JSON.stringify({ scenario_id, shield, mode }) }),
  run: (id: string) => req<RunSummary>(`/api/runs/${id}`),
  approve: (decisionId: string, approve: boolean) =>
    req<{ ok: true }>(`/api/approvals/${decisionId}`, { method: "POST", body: JSON.stringify({ approve }) }),
  outbox: () => req<OutboxEmail[]>("/api/outbox"),
  ledger: () => req<LedgerPayment[]>("/api/ledger"),
  reset: () => req<{ ok: true }>("/api/reset", { method: "POST" }),
  replay: (decisionId: string) => req<Decision>(`/api/replay/${decisionId}`, { method: "POST" }),
  audit: () => req<{ store: string; rows: AuditRow[] }>("/api/audit"),
  verify: () => req<VerifyResult>("/api/audit/verify"),
  tamper: () => req<{ tampered_seq: number }>("/api/audit/tamper-demo", { method: "POST" }),
  restoreTamper: () => req<{ restored: number[] }>("/api/audit/tamper-demo/restore", { method: "POST" }),
};
