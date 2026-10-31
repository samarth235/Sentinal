import { ArrowLeftRight, Check, ChevronDown, KeyRound, Moon, Play, RotateCcw, ShieldCheck, Sun } from "lucide-react";
import { useState } from "react";
import { Popover, Select, Switch, ToggleGroup } from "radix-ui";
import { getToken, setToken } from "../lib/api";
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
  dark: boolean;
  toggleDark: () => void;
  onRun: () => void;
  onBeforeAfter: () => void;
  onReset: () => void;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden items-center gap-1.5 lg:inline-flex">
      <span className="text-fg-subtle">{label}</span>
      <span className="text-fg-muted">{value}</span>
    </span>
  );
}

function ScenarioSelect({ scenarios, value, onChange }: { scenarios: ScenarioInfo[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        aria-label="Scenario"
        className="btn btn-outline w-80 justify-between font-normal data-[placeholder]:text-fg-subtle"
      >
        <Select.Value placeholder="Choose a scenario" />
        <Select.Icon>
          <ChevronDown size={14} className="text-fg-subtle" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4} className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface p-1 text-fg shadow-lg">
          <Select.Viewport>
            {scenarios.map((s) => (
              <Select.Item
                key={s.id}
                value={s.id}
                className="relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 pr-7 text-[13px] outline-none data-[highlighted]:bg-subtle"
              >
                <span className="w-6 font-mono text-xs text-fg-subtle">{s.id.split("_")[0]}</span>
                <Select.ItemText>{s.title}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-2">
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/** Operator token for backends started with API_TOKEN; stored in this browser only. */
function TokenButton() {
  const [value, setValue] = useState(getToken);
  const [saved, setSaved] = useState(Boolean(getToken()));
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={`btn btn-sm ${saved ? "btn-ghost" : "btn-outline text-warn"}`} aria-label="API token">
          <KeyRound size={14} /> {saved ? "Token set" : "Set token"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-72 rounded-md border border-line bg-surface p-3 text-fg shadow-lg">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToken(value.trim());
              setSaved(Boolean(value.trim()));
            }}
          >
            <label className="text-xs font-medium text-fg-muted" htmlFor="api-token">
              This backend requires an API token to run, approve or reset.
            </label>
            <input
              id="api-token"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-2 h-8 w-full rounded-md border border-line bg-canvas px-2 font-mono text-xs outline-none focus:border-line-strong"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Popover.Close asChild>
                <button type="submit" className="btn btn-sm btn-primary">
                  Save
                </button>
              </Popover.Close>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ControlBar(p: Props) {
  // Production mode: the server rejects shield-off runs and resets, so the controls are not offered.
  const demo = p.config?.mode !== "production";
  const current = p.scenarios.find((s) => s.id === p.scenarioId);
  return (
    <header className="border-b border-line bg-surface">
      <div className="flex h-12 items-center gap-4 border-b border-line px-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} strokeWidth={2} />
          <span className="text-[15px] font-semibold">Sentinel</span>
          <span className="hidden text-[13px] text-fg-subtle sm:inline">Tool-call policy gateway</span>
        </div>
        <div className="ml-auto flex items-center gap-5 text-xs">
          {p.config && (
            <>
              <Meta label="Guard" value={p.config.guard_provider === "GroqGuard" ? "Groq" : "Heuristic"} />
              <Meta label="Audit" value={p.config.audit_store ?? "none"} />
              <Meta label="Approvals" value={p.config.telegram ? "Telegram, dashboard" : "Dashboard"} />
            </>
          )}
          {p.config?.auth_required && <TokenButton />}
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            <span className={`h-2 w-2 rounded-full ${p.connected ? "bg-allow-solid" : "bg-deny-solid"}`} />
            {p.connected ? "Connected" : "Offline"}
          </span>
          <button className="btn btn-ghost btn-sm w-7 px-0" onClick={p.toggleDark} aria-label="Toggle theme">
            {p.dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-3">
        <ScenarioSelect scenarios={p.scenarios} value={p.scenarioId} onChange={p.setScenarioId} />

        {!demo && (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
            <ShieldCheck size={14} className="text-allow" /> Shield on <span className="text-fg-subtle">(production mode)</span>
          </span>
        )}
        {demo && <label className="flex items-center gap-2 text-[13px] text-fg-muted">
          <Switch.Root
            checked={p.shield}
            onCheckedChange={p.setShield}
            className="relative h-5 w-9 shrink-0 rounded-full bg-active outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong data-[state=checked]:bg-allow-solid"
          >
            <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
          </Switch.Root>
          Shield <span className="w-6 font-medium text-fg">{p.shield ? "on" : "off"}</span>
        </label>}

        <div className="flex items-center gap-2 text-[13px] text-fg-muted">
          Mode
          <ToggleGroup.Root
            type="single"
            value={p.mode}
            onValueChange={(v) => v && p.setMode(v as "scripted" | "live")}
            className="inline-flex h-8 rounded-md border border-line bg-subtle p-0.5"
          >
            {(["scripted", "live"] as const).map((m) => (
              <ToggleGroup.Item
                key={m}
                value={m}
                className="rounded-[5px] px-3 text-[13px] capitalize text-fg-muted outline-none data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-sm"
              >
                {m}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {demo && (
            <>
              <button className="btn btn-ghost" disabled={p.busy} onClick={p.onReset}>
                <RotateCcw size={14} /> Reset
              </button>
              <button className="btn btn-outline" disabled={p.busy || !p.connected} onClick={p.onBeforeAfter}>
                <ArrowLeftRight size={14} /> Compare off / on
              </button>
            </>
          )}
          <button className="btn btn-primary" disabled={p.busy || !p.connected} onClick={p.onRun}>
            <Play size={14} /> Run
          </button>
        </div>
      </div>

      {current && (
        <p className="truncate border-t border-line bg-canvas px-5 py-2 text-[13px] text-fg-muted">
          <span className="text-fg-subtle">User prompt · {current.profile}</span>
          <span className="mx-2 text-line-strong">|</span>
          {current.user_prompt}
        </p>
      )}
    </header>
  );
}
