import type { LucideIcon } from "lucide-react";

export function EmptyState({ Icon, title, hint }: { Icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center gap-1.5 text-center font-sans">
      <Icon size={18} className="text-fg-subtle" strokeWidth={1.75} />
      <p className="text-[13px] font-medium text-fg-muted">{title}</p>
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
}

export function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-sm ${color}`} />
      {label}
    </span>
  );
}
