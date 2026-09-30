import React, { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { api, setToken } from "@/lib/api";
import type { User } from "@/types";

interface AuthPageProps {
  onAuthed: (user: User) => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthed }) => {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/40 to-indigo-50/40 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <img src="/logo.png" alt="Magpie - You ask, it collects" className="h-16 w-auto mx-auto mb-6" />
        <form onSubmit={submit} className="card p-7 sm:p-8 shadow-xl" aria-labelledby="auth-title">
          <h1 id="auth-title" className="text-2xl font-black text-slate-900">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="text-sm text-slate-600 mt-1 mb-6">
            {mode === "login"
              ? "Sign in to see your datasets, history and leads."
              : "Free account. Your runs, datasets and leads stay private to you."}
          </p>

          {mode === "register" && (
            <div className="mb-4">
              <label htmlFor="auth-name" className="label">Your name</label>
              <input id="auth-name" className="input" value={name} onChange={(e) => setName(e.target.value)}
                autoComplete="name" required maxLength={120} />
            </div>
          )}
          <div className="mb-4">
            <label htmlFor="auth-email" className="label">E-mail</label>
            <input id="auth-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required maxLength={254} />
          </div>
          <div className="mb-2">
            <label htmlFor="auth-password" className="label">Password</label>
            <div className="relative">
              <input id="auth-password" type={show ? "text" : "password"} className="input pr-12" value={password}
                onChange={(e) => setPassword(e.target.value)} required minLength={mode === "register" ? 8 : 1}
                maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} />
              <button type="button" onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-500 hover:text-slate-800"
                aria-label={show ? "Hide password" : "Show password"}>
                {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
            {mode === "register" && <p className="text-xs text-slate-500 mt-1.5">At least 8 characters.</p>}
          </div>

          {error && (
            <p className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full mt-6 py-3 text-base">
            {busy && <Loader2 className="w-5 h-5 animate-spin" />}
            {mode === "login" ? "Sign in" : "Create account"}
          </button>

          <p className="text-sm text-slate-600 text-center mt-5">
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
    </div>
  );
};
