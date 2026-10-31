import { nanoid } from "nanoid";
import { ContextLedger } from "./gateway/contextLedger.js";
import { buildToolCall, handleToolCall, mockExecutor, type GatewayResult, type ToolExecutor } from "./gateway/gateway.js";
import { bus, providers as defaultProviders, type Providers } from "./integrations/index.js";
import { initPolicy, type Policy } from "./policy/loader.js";
import type { ToolResult } from "./tools/mockTools.js";

export interface SentinelOptions {
  policyPath: string;
  providers?: Partial<Providers>;
}

export interface WrapOptions {
  profile: string;
  shield?: boolean;
  /** Share a ledger across wrapped tool sets / turns. Defaults to a fresh one. */
  ledger?: ContextLedger;
  runId?: string;
}

/** A real tool: gets the arguments, returns text (or { text, records } for database-style tools). */
export type ToolImpl = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type GuardedTools<T> = { [K in keyof T]: (args: Record<string, unknown>) => Promise<string> } & {
  /** Record what the user asked for (needed for provenance). */
  recordUser(text: string): void;
  /** Record untrusted content the agent read through some other channel. */
  recordUntrusted(text: string, label?: string): void;
  ledger: ContextLedger;
  last?: GatewayResult;
};

function toResult(out: unknown): ToolResult {
  if (typeof out === "string") return { text: out };
  if (out && typeof out === "object" && typeof (out as ToolResult).text === "string") return out as ToolResult;
  return { text: JSON.stringify(out ?? null) };
}

/**
 * In-process, framework-agnostic wrapper (for Node agents that embed Sentinel):
 *
 *   const sentinel = createSentinel({ policyPath, providers });
 *   const tools = sentinel.wrap({ send_email: realSendEmail, browse_url: realFetch }, { profile: "research_assistant" });
 *   tools.recordUser(prompt);
 *   await tools.send_email({ to, subject, body }); // decided by Sentinel, then runs realSendEmail
 *
 * Pass a function to run your real tool. Passing null uses Sentinel's built-in mock tool (demo).
 * Remote agents (other processes or languages) use the HTTP gateway and the sdk/ package instead.
 */
export function createSentinel(opts: SentinelOptions) {
  const policy: Policy = initPolicy(opts.policyPath);
  const providers: Providers = { ...defaultProviders, ...opts.providers };

  return {
    policy,
    bus,
    wrap<T extends Record<string, ToolImpl | null | undefined>>(tools: T, wrapOpts: WrapOptions): GuardedTools<T> {
      const runId = wrapOpts.runId ?? `sdk_${nanoid(8)}`;
      const ledger = wrapOpts.ledger ?? new ContextLedger(runId, (e) => void bus.publishSafe(e));
      const real = new Map(Object.entries(tools).filter((e): e is [string, ToolImpl] => typeof e[1] === "function"));
      // Tools passed as null fall back to Sentinel's mock implementation (demo).
      const executor: ToolExecutor = async (call) => {
        const impl = real.get(call.tool);
        return impl ? toResult(await impl(call.args)) : mockExecutor(call);
      };
      const ctx = { run_id: runId, session_id: runId, profile: wrapOpts.profile, shield: wrapOpts.shield ?? true, ledger, policy, providers, bus, executor };
      const guarded = {
        ledger,
        recordUser: (text: string) => void ledger.addUser(text),
        recordUntrusted: (text: string, label?: string) => void ledger.addToolResult("external", "UNTRUSTED", text, { label }),
      } as GuardedTools<T>;
      for (const name of Object.keys(tools)) {
        (guarded as Record<string, unknown>)[name] = async (args: Record<string, unknown>) => {
          const res = await handleToolCall(buildToolCall(ctx, name, args), ctx);
          guarded.last = res;
          return res.result;
        };
      }
      return guarded;
    },
  };
}
