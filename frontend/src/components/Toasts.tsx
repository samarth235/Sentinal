import { toast, Toaster } from "sonner";

export type ToastTone = "info" | "error";

export function notifyToast(text: string, tone: ToastTone = "info") {
  if (tone === "error") toast.error(text, { duration: 6000 });
  else toast(text, { duration: 4000 });
}

export function Toasts({ dark }: { dark: boolean }) {
  return (
    <Toaster
      position="bottom-right"
      theme={dark ? "dark" : "light"}
      toastOptions={{ style: { fontFamily: "var(--font-sans)", fontSize: 13, borderRadius: 8 } }}
    />
  );
}
