import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getToken, setToken } from "../lib/api";

/** Full-page sign-in for deployments that require an operator token. */
export function TokenGate({ onSignedIn, rejected }: { onSignedIn: () => void; rejected: boolean }) {
  const [value, setValue] = useState(getToken);
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value.trim());
          onSignedIn();
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} />
          <span className="text-[17px] font-semibold">Sentinel</span>
        </div>
        <p className="mt-3 text-[13px] text-fg-muted">This deployment is protected. Enter your operator token (an <span className="font-mono">API_TOKEN</span> value) to view decisions and approve actions.</p>
        {rejected && <p className="mt-3 rounded-md bg-deny-bg px-3 py-2 text-[13px] text-deny">That token was not accepted.</p>}
        <label htmlFor="gate-token" className="mt-4 block text-xs font-medium text-fg-muted">
          Operator token
        </label>
        <input
          id="gate-token"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1.5 h-9 w-full rounded-md border border-line bg-canvas px-2.5 font-mono text-sm outline-none focus:border-line-strong"
        />
        <button type="submit" className="btn btn-primary mt-4 w-full justify-center" disabled={!value.trim()}>
          <KeyRound size={14} /> Sign in
        </button>
        <p className="mt-3 text-xs text-fg-subtle">The token is kept in this browser only.</p>
      </form>
    </div>
  );
}
