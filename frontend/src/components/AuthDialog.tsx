import React, { useEffect, useState } from "react";
import { Coins, Eye, EyeOff, Loader2, X } from "lucide-react";
import { api, setToken } from "@/lib/api";
import type { User } from "@/types";
import { SIGNUP_CREDITS } from "@/types";

export type AuthReason = "run" | "tab" | "signin";

interface AuthDialogProps {
  reason: AuthReason;
  onAuthed: (user: User) => void;
  onClose: () => void;
}

const REASON_TEXT: Record<AuthReason, string> = {
  run: "Sign in to run your request - it starts automatically right after.",
  tab: "Sign in to see your datasets, leads and history.",
  signin: "Your runs, datasets and leads stay private to your account.",
};

export const AuthDialog: React.FC<AuthDialogProps> = ({ reason, onAuthed, onClose }) => {
  // First-time visitors usually hit a gated action, so start them on "create account".
  const [mode, setMode] = useState<"login" | "register">(reason === "signin" ? "login" : "register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The page behind the dialog stays still while it is open.
  useEffect(() => {
    const { style } = document.body;
    const previous = style.overflow;
    style.overflow = "hidden";
    return () => {
      style.overflow = previous;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login" ? { email, password } : { name, email, password };
      const res = await api<{ token: string; user: User }>(path, { method: "POST", json: body });
      setToken(res.token);
      onAuthed(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[70] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
      {/* Compact so even "create account" fits a laptop screen without scrolling; only a very short window
          (e.g. a phone held sideways) scrolls it, so the button always stays reachable. */}
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="auth-title"
        className="card relative w-full max-w-md p-6 sm:px-8 shadow-2xl max-h-full overflow-y-auto">
        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute right-3 top-3 p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
          <X className="w-5 h-5" />
        </button>
        <img src="/logo.png" alt="Magpie - You ask, it collects" className="h-10 w-auto mb-3" />
        <h2 id="auth-title" className="text-2xl font-black leading-tight text-slate-900">
          {mode === "login" ? "Welcome back" : "Create your free account"}
        </h2>
        <p className="text-sm text-slate-600 mt-1">{REASON_TEXT[reason]}</p>
        {mode === "register" && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
            <Coins className="w-4 h-4 shrink-0" aria-hidden="true" /> New accounts get {SIGNUP_CREDITS} free credits.
          </p>
        )}

        <div className="mt-4 space-y-3">
          {mode === "register" && (
            <div>
              <label htmlFor="auth-name" className="label">Your name</label>
              <input id="auth-name" className="input py-2" value={name} onChange={(e) => setName(e.target.value)}
                autoComplete="name" required maxLength={120} autoFocus />
            </div>
          )}
          <div>
            <label htmlFor="auth-email" className="label">E-mail</label>
            <input id="auth-email" type="email" className="input py-2" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required maxLength={254} autoFocus={mode === "login"} />
          </div>
          <div>
            <label htmlFor="auth-password" className="label">
              Password
              {mode === "register" && <span className="font-normal text-slate-500"> (at least 8 characters)</span>}
            </label>
            <div className="relative">
              <input id="auth-password" type={show ? "text" : "password"} className="input py-2 pr-12" value={password}
                onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 1}
                maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-500 hover:text-slate-800">
                {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2" role="alert">{error}</p>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full mt-4 py-2.5 text-base">
          {busy && <Loader2 className="w-5 h-5 animate-spin" />}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>

        <p className="text-sm text-slate-600 text-center mt-3">
          {mode === "login" ? "New to Magpie?" : "Already have an account?"}{" "}
          <button type="button" className="font-semibold text-blue-700 hover:underline"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}>
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
};
