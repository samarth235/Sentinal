import { nanoid } from "nanoid";
import { ContextLedger } from "./gateway/contextLedger.js";
import { buildToolCall, handleToolCall, type GatewayResult } from "./gateway/gateway.js";
import { bus, providers as defaultProviders, type Providers } from "./integrations/index.js";
import { initPolicy, type Policy } from "./policy/loader.js";

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

export type GuardedTools<T> = { [K in keyof T]: (args: Record<string, unknown>) => Promise<string> } & {
  /** Record what the user asked for (needed for provenance). */
  recordUser(text: string): void;
  /** Record untrusted content the agent read through some other channel. */
  recordUntrusted(text: string, label?: string): void;
  ledger: ContextLedger;
  last?: GatewayResult;
};

/**
 * Framework-agnostic wrapper:
 *
 *   const sentinel = createSentinel({ policyPath, providers });
 *   const guardedTools = sentinel.wrap(myTools, { profile: "research_assistant", shield: true });
 *   await guardedTools.send_email({ to, subject, body }); // routed through handleToolCall
 *
 * Tool names must exist in the policy and registry. Execution uses Sentinel's mock tools in this
 * demo build; TODO(person-b): accept caller-supplied implementations for real integrations.
 */
export function createSentinel(opts: SentinelOptions) {
  const policy: Policy = initPolicy(opts.policyPath);
  const providers: Providers = { ...defaultProviders, ...opts.providers };

  return {
    policy,
    bus,
    wrap<T extends Record<string, unknown>>(tools: T, wrapOpts: WrapOptions): GuardedTools<T> {
      const runId = wrapOpts.runId ?? `sdk_${nanoid(8)}`;
      const ledger = wrapOpts.ledger ?? new ContextLedger(runId, (e) => void bus.publishSafe(e));
      const ctx = { run_id: runId, session_id: runId, profile: wrapOpts.profile, shield: wrapOpts.shield ?? true, ledger, policy, providers, bus };
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
