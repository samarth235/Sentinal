/**
 * @sentinel-gateway/sdk — route every tool call your agent makes through a Sentinel gateway.
 *
 *   const sentinel = new SentinelClient({ baseUrl: process.env.SENTINEL_URL!, apiKey: process.env.SENTINEL_AGENT_KEY! });
 *   const session = await sentinel.startSession({ profile: "research_assistant", userPrompt });
 *   const tools = session.wrap({ browse_url: fetchPage, send_email: sendEmail });
 *   const text = await tools.send_email({ to, subject, body }); // runs only if Sentinel allows it
 *
 * Sentinel never sees your credentials or runs your tools: it decides, your process executes,
 * and the result is reported back so content the agent reads is tracked as untrusted.
 * Zero dependencies (uses global fetch, Node 20+ / Deno / Bun / browsers).
 */

export type DecisionStatus = "allowed" | "denied" | "pending" | "rejected" | "timed_out";

export interface Decision {
  decision_id: string;
  status: DecisionStatus;
  /** Run the tool only when this is true. */
  authorized: boolean;
  verdict: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  rule_id: string;
  outcome: string | null;
  impact: "low" | "medium" | "high" | "critical";
  reasons: { code: string; message: string }[];
  /** Human-readable explanation when the call was not authorised (safe to hand back to the model). */
  message: string | null;
  session_tainted: boolean;
  latency_ms: number;
  policy_version: string | null;
}

export class SentinelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SentinelError";
  }
}

/** Thrown by wrapped tools when `onBlocked: "throw"` and Sentinel does not authorise the call. */
export class ToolBlockedError extends Error {
  constructor(readonly decision: Decision) {
    super(decision.message ?? `Blocked by Sentinel (${decision.rule_id})`);
    this.name = "ToolBlockedError";
  }
}

export interface ClientOptions {
  /** e.g. https://sentinel.example.com */
  baseUrl: string;
  /** An AGENT_API_KEYS entry on the gateway. */
  apiKey?: string;
  /** Per-request timeout for non-approval requests (ms). Default 15000. */
  timeoutMs?: number;
  /** How long to wait for a human approval before giving up (ms). Default 10 minutes. */
  approvalWaitMs?: number;
  fetch?: typeof fetch;
}

/** A tool implementation. Return a string, or { text, records } for database-style tools. */
export type ToolFn = (args: Record<string, any>) => unknown | Promise<unknown>;
export type ToolResult = { text: string; records?: Record<string, unknown>[]; label?: string };

export interface WrapOptions {
  /** "message" (default): a blocked tool returns Sentinel's explanation as the tool result, so the model can recover. "throw": throw ToolBlockedError. */
  onBlocked?: "message" | "throw";
  /** Called after every decision (logging, UI). */
  onDecision?: (tool: string, decision: Decision) => void;
  /** Label for a tool's output in evidence (e.g. the URL). Defaults to args.url when present. */
  labelFor?: (tool: string, args: Record<string, any>) => string | undefined;
}

export type Guarded<T extends Record<string, ToolFn>> = { [K in keyof T]: (args: Parameters<T[K]>[0]) => Promise<string> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SentinelClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    if (!opts.baseUrl) throw new Error("SentinelClient: baseUrl is required");
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.opts.timeoutMs ?? 15_000): Promise<{ status: number; data: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new SentinelError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
      return { status: res.status, data };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new SentinelError(`Sentinel did not answer within ${timeoutMs}ms`, 504);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  get approvalWaitMs(): number {
    return this.opts.approvalWaitMs ?? 10 * 60_000;
  }

  /** Open a session for one agent task. Pass the user's request so Sentinel knows what was actually asked. */
  async startSession(input: { profile: string; userPrompt?: string; title?: string }): Promise<SentinelSession> {
    const { data } = await this.request<{ session_id: string; policy_version: string }>("POST", "/api/v1/sessions", {
      profile: input.profile,
      user_prompt: input.userPrompt,
      title: input.title,
    });
    return new SentinelSession(this, data.session_id, data.policy_version);
  }

  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/api/health");
      return true;
    } catch {
      return false;
    }
  }
}

export class SentinelSession {
  constructor(
    private readonly client: SentinelClient,
    readonly id: string,
    readonly policyVersion: string,
  ) {}

  private path(p = "") {
    return `/api/v1/sessions/${encodeURIComponent(this.id)}${p}`;
  }

  /** Something the user said (follow-up instructions). */
  recordUser(text: string) {
    return this.client.request("POST", this.path("/context"), { source: "user", text });
  }

  /** Content the agent read from outside (a page, email, file) that did not come through a wrapped tool. */
  recordUntrusted(text: string, label?: string) {
    return this.client.request("POST", this.path("/context"), { source: "untrusted", text, label });
  }

  /** Internal data the agent saw (database rows), so sensitive values are tracked on the way out. */
  recordInternal(text: string, records?: Record<string, unknown>[], tool?: string) {
    return this.client.request("POST", this.path("/context"), { source: "internal", text, records, tool });
  }

  /**
   * Ask Sentinel whether a call may run. Resolves once there is a final answer
   * (including after a human approves or rejects on Telegram / the dashboard).
   */
  async check(tool: string, args: Record<string, unknown>, callId?: string): Promise<Decision> {
    const first = await this.client.request<Decision>("POST", this.path("/tool-calls"), { tool, args, call_id: callId, wait: false });
    let decision = first.data;
    const deadline = Date.now() + this.client.approvalWaitMs;
    let delay = 1000;
    while (decision.status === "pending") {
      if (Date.now() > deadline) throw new SentinelError("gave up waiting for a human approval", 408);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 5000);
      decision = (await this.client.request<Decision>("GET", `/api/v1/decisions/${encodeURIComponent(decision.decision_id)}`)).data;
    }
    return decision;
  }

  /** Report what an authorised tool returned (untrusted output taints the session; internal rows are tracked). */
  reportResult(decisionId: string, result: ToolResult) {
    return this.client.request("POST", this.path(`/tool-calls/${encodeURIComponent(decisionId)}/result`), result);
  }

  /** Check, run, report — the whole loop for one call. */
  async run(tool: string, args: Record<string, any>, impl: ToolFn, opts: WrapOptions = {}): Promise<string> {
    const decision = await this.check(tool, args);
    opts.onDecision?.(tool, decision);
    if (!decision.authorized) {
      if (opts.onBlocked === "throw") throw new ToolBlockedError(decision);
      return decision.message ?? `BLOCKED_BY_SENTINEL (${decision.rule_id})`;
    }
    const raw = await impl(args);
    const result: ToolResult =
      typeof raw === "string"
        ? { text: raw }
        : raw && typeof raw === "object" && typeof (raw as ToolResult).text === "string"
          ? (raw as ToolResult)
          : { text: JSON.stringify(raw ?? null) };
    const label = result.label ?? opts.labelFor?.(tool, args) ?? (typeof args.url === "string" ? args.url : undefined);
    await this.reportResult(decision.decision_id, { ...result, label });
    return result.text;
  }

  /** Wrap a set of tool functions. Each wrapped function checks with Sentinel first. */
  wrap<T extends Record<string, ToolFn>>(tools: T, opts: WrapOptions = {}): Guarded<T> {
    const out = {} as Record<string, (args: Record<string, any>) => Promise<string>>;
    for (const [name, impl] of Object.entries(tools)) out[name] = (args) => this.run(name, args ?? {}, impl, opts);
    return out as Guarded<T>;
  }

  /** Close the session (marks it finished in the dashboard and audit log). */
  end() {
    return this.client.request("POST", this.path("/end"), {});
  }
}
