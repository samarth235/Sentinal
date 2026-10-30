import type { ScenarioInfo, UiConfig } from "../lib/types";

interface Props {
  scenarios: ScenarioInfo[];
  scenarioId: string;
  setScenarioId: (id: string) => void;
  shield: boolean;
  setShield: (v: boolean) => void;
  mode: "scripted" | "live";
  setMode: (m: "scripted" | "live") => void;
  busy: boolean;
  connected: boolean;
  config: UiConfig | null;
  onRun: () => void;
  onBeforeAfter: () => void;
  onReset: () => void;
}

function Toggle<T extends string | boolean>({ value, options, onChange }: { value: T; options: { v: T; label: string; active: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onChange(o.v)}
          className={`rounded-md px-3 py-1.5 text-sm font-bold transition ${value === o.v ? o.active : "text-muted hover:text-zinc-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ControlBar(p: Props) {
  const current = p.scenarios.find((s) => s.id === p.scenarioId);
  return (
    <header className="border-b border-line bg-panel/80 px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-lg font-black">S</div>
          <span className="text-xl font-extrabold tracking-[0.18em]">SENTINEL</span>
        </div>

        <select
          value={p.scenarioId}
          onChange={(e) => p.setScenarioId(e.target.value)}
          className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-semibold"
        >
          {p.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id.split("_")[0]} — {s.title}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2 text-sm text-muted">
          Shield
          <Toggle
            value={p.shield}
            onChange={p.setShield}
            options={[
              { v: true, label: "ON", active: "bg-allow text-black" },
              { v: false, label: "OFF", active: "bg-deny text-white" },
            ]}
          />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          Mode
          <Toggle
            value={p.mode}
            onChange={p.setMode}
            options={[
              { v: "scripted", label: "scripted", active: "bg-zinc-200 text-black" },
              { v: "live", label: "live", active: "bg-zinc-200 text-black" },
            ]}
          />
        </div>

        <div className="flex items-center gap-2">
          <button className="btn btn-primary" disabled={p.busy || !p.connected} onClick={p.onRun}>
            ▶ Run
          </button>
          <button className="btn btn-ghost" disabled={p.busy || !p.connected} onClick={p.onBeforeAfter}>
            ⇄ Run before/after
          </button>
          <button className="btn btn-ghost" disabled={p.busy} onClick={p.onReset}>
            ↺ Reset
          </button>
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          {p.config && (
            <span className="hidden xl:inline">
              guard: {p.config.guard_provider === "GroqGuard" ? "Groq" : "heuristic"} · audit: {p.config.audit_store ?? "none"} · approvals:{" "}
              {p.config.telegram ? "Telegram + dashboard" : "dashboard"}
            </span>
          )}
          <span className={`flex items-center gap-1.5 font-semibold ${p.connected ? "text-allow" : "text-deny"}`}>
            <span className={`h-2 w-2 rounded-full ${p.connected ? "bg-allow" : "bg-deny animate-pulse"}`} />
            {p.connected ? "live" : "offline"}
          </span>
        </div>
      </div>
      {current && (
        <p className="mt-2 truncate text-sm text-zinc-400">
          <span className="text-muted">User asks ({current.profile}):</span> “{current.user_prompt}”
        </p>
      )}
    </header>
  );
}
