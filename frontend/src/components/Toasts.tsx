export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`cursor-pointer rounded-lg border px-4 py-3 text-sm font-medium shadow-2xl ${
            t.tone === "error" ? "border-deny/70 bg-red-950 text-red-100" : "border-line bg-panel-2 text-zinc-100"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
