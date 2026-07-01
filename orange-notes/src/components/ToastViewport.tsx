import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { useToastStore, type Toast } from "@/store/useToastStore";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), toast.duration - 400);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => dismiss(toast.id), 200);
  };

  const Icon =
    toast.variant === "success"
      ? CheckCircle2
      : toast.variant === "destructive"
        ? AlertCircle
        : Info;

  return (
    <div
      onClick={handleDismiss}
      className={cn(
        "pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm",
        "min-w-[260px] max-w-[420px] cursor-pointer select-none",
        "transition-all duration-200 ease-out",
        exiting ? "opacity-0 translate-x-4 scale-95" : "opacity-100 translate-x-0 scale-100",
        toast.variant === "destructive" &&
          "bg-destructive/95 text-destructive-foreground border-destructive/50 shadow-destructive/20",
        toast.variant === "success" &&
          "bg-emerald-600/95 text-white border-emerald-500/50 shadow-emerald-500/20",
        toast.variant === "default" &&
          "bg-popover/95 text-popover-foreground border-border/60 shadow-foreground/10 hover:bg-popover"
      )}
    >
      <Icon
        className={cn(
          "h-4.5 w-4.5 mt-0.5 shrink-0",
          toast.variant === "destructive" && "text-white/90",
          toast.variant === "success" && "text-white/90",
          toast.variant === "default" && "text-muted-foreground"
        )}
        strokeWidth={2}
      />
      <span className="flex-1 text-sm leading-snug">{toast.message}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleDismiss();
        }}
        className="shrink-0 p-0.5 rounded-md opacity-50 hover:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
