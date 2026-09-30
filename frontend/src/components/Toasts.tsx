import React from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info };
const STYLES = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
  info: "border-blue-200 bg-blue-50 text-blue-900",
};

export const Toasts: React.FC<{ toasts: Toast[]; onDismiss: (id: number) => void }> = ({ toasts, onDismiss }) => (
  <div className="fixed z-[80] right-3 bottom-24 lg:bottom-5 flex flex-col gap-2 w-[min(420px,calc(100%-1.5rem))] print:hidden"
    aria-live="assertive">
    {toasts.map((t) => {
      const Icon = ICONS[t.kind];
      return (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
          className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-lg ${STYLES[t.kind]}`}>
          <Icon className="w-5 h-5 shrink-0 mt-0.5" />
          <span className="flex-1">{t.text}</span>
          <button type="button" onClick={() => onDismiss(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      );
    })}
  </div>
);
