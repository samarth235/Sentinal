import type { GuardSignal, ToolCall } from "../types.js";

export interface GuardProvider {
  classify(input: { call: ToolCall; untrustedText: string }): Promise<GuardSignal>;
}

const INJECTION_PATTERNS = [
  /ignore\s+(all|previous|prior|the above)\s+(instructions|prompts)/i,
  /you\s+are\s+now\b/i,
  /system\s+override/i,
  /do\s+not\s+(tell|mention|inform)\s+(this\s+\w+\s+to\s+)?the\s+user/i,
  /do\s+not\s+mention\s+this/i,
];

/** Stub guard: phrase regexes. Person B swaps in a Groq classifier behind the same interface. */
export class HeuristicGuard implements GuardProvider {
  async classify({ untrustedText }: { call: ToolCall; untrustedText: string }): Promise<GuardSignal> {
    const hit = INJECTION_PATTERNS.some((re) => re.test(untrustedText));
    return { available: true, label: hit ? "injection" : "benign", score: hit ? 0.9 : 0.1, provider: "heuristic-stub" };
  }
}

export const GUARD_TIMEOUT_MS = 3000;

export function unavailableSignal(provider: string): GuardSignal {
  return { available: false, label: "unknown", score: 0, provider };
}

/** Signal used when the session is untainted and the guard is deliberately not consulted. */
export const NOT_CONSULTED: GuardSignal = { available: true, label: "unknown", score: 0, provider: "not-consulted" };

/** Call the guard with a hard timeout. Any error or timeout => unavailable (the engine fails closed on that). */
export async function safeClassify(
  guard: GuardProvider,
  input: { call: ToolCall; untrustedText: string },
  timeoutMs = GUARD_TIMEOUT_MS,
): Promise<GuardSignal> {
  const name = guard.constructor?.name ?? "guard";
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<GuardSignal>((resolve) => {
      timer = setTimeout(() => resolve(unavailableSignal(name)), timeoutMs);
    });
    const signal = await Promise.race([guard.classify(input), timeout]);
    const valid =
      signal &&
      typeof signal.available === "boolean" &&
      ["injection", "benign", "unknown"].includes(signal.label) &&
      typeof signal.score === "number" &&
      signal.score >= 0 &&
      signal.score <= 1;
    return valid ? signal : unavailableSignal(name);
  } catch {
    return unavailableSignal(name);
  } finally {
    clearTimeout(timer);
  }
}
