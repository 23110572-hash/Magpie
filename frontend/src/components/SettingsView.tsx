import React, { useState } from "react";
import { CheckCircle2, Loader2, LogOut, Save, ShieldAlert, XCircle } from "lucide-react";
import { api, setToken } from "@/lib/api";
import type { SystemStatus, User } from "@/types";

interface SettingsViewProps {
  user: User;
  status: SystemStatus | null;
  onUserChange: (user: User) => void;
  onSignedOut: () => void;
  notify: (kind: "success" | "error" | "info", text: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");

export const SettingsView: React.FC<SettingsViewProps> = ({ user, status, onUserChange, onSignedOut, notify }) => {
  const [name, setName] = useState(user.name);
  const [savingName, setSavingName] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [deletePw, setDeletePw] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingName(true);
    try {
      onUserChange(await api<User>("/api/auth/me", { method: "PATCH", json: { name } }));
      notify("success", "Name updated");
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setSavingName(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPw(true);
    try {
      const res = await api<{ token: string; user: User }>("/api/auth/change-password", {
        method: "POST", json: { current_password: current, new_password: next },
      });
      setToken(res.token);
      setCurrent("");
      setNext("");
      notify("success", "Password changed. Other devices were signed out.");
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setSavingPw(false);
    }
  };

  const logoutAll = async () => {
    try {
      await api("/api/auth/logout-all", { method: "POST" });
    } catch {
      // signing out locally anyway
    }
    setToken("");
    onSignedOut();
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleting(true);
    try {
      await api("/api/auth/me", { method: "DELETE", json: { password: deletePw } });
      setToken("");
      onSignedOut();
    } catch (err) {
      notify("error", errorText(err));
      setDeleting(false);
    }
  };

  const keyRows: [string, string][] = [
    ["openrouter", "AI brain (OpenRouter)"], ["serper", "Google search & Maps (Serper)"], ["tavily", "Tavily search"],
    ["adzuna", "Adzuna jobs"], ["github", "GitHub (higher limits)"],
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Settings</h1>
        <p className="text-base text-slate-600 mt-1">Signed in as {user.email}</p>
      </div>

      <form onSubmit={saveName} className="card p-6">
        <h2 className="text-xl font-bold text-slate-900 mb-4">Profile</h2>
        <label htmlFor="set-name" className="label">Name (used when you send e-mails)</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input id="set-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          <button type="submit" disabled={savingName || !name.trim() || name === user.name} className="btn-primary shrink-0">
            {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      </form>

      <form onSubmit={changePassword} className="card p-6">
        <h2 className="text-xl font-bold text-slate-900 mb-4">Password</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="pw-current" className="label">Current password</label>
            <input id="pw-current" type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div>
            <label htmlFor="pw-new" className="label">New password (8+ characters)</label>
            <input id="pw-new" type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button type="submit" disabled={savingPw} className="btn-primary">{savingPw && <Loader2 className="w-4 h-4 animate-spin" />} Change password</button>
          <button type="button" onClick={logoutAll} className="btn-secondary"><LogOut className="w-4 h-4" /> Sign out everywhere</button>
        </div>
      </form>

      <section className="card p-6">
        <h2 className="text-xl font-bold text-slate-900 mb-4">System status</h2>
        {!status ? (
          <p className="text-base text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
        ) : (
          <div className="space-y-4">
            <p className="text-base text-slate-700">AI model: <strong>{status.llm.enabled ? status.llm.model : "not configured"}</strong></p>
            <ul className="grid sm:grid-cols-2 gap-2">
              {keyRows.map(([key, label]) => (
                <li key={key} className="flex items-center gap-2 text-base text-slate-700">
                  {status.keys[key] ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <XCircle className="w-5 h-5 text-slate-400" />}
                  {label}
                </li>
              ))}
            </ul>
            <p className="text-base text-slate-700">
              Outreach e-mail:{" "}
              <strong>{status.email.mode === "relay" ? "sent through the Vercel relay" : status.email.mode === "direct" ? "sent directly through Gmail" : "simulated (not configured)"}</strong>
              {status.email.from && <> from {status.email.from}</>}, replies go to {status.email.reply_to}.
            </p>
          </div>
        )}
      </section>

      <form onSubmit={deleteAccount} className="card p-6 border-rose-200">
        <h2 className="text-xl font-bold text-rose-700 mb-2 flex items-center gap-2"><ShieldAlert className="w-5 h-5" /> Delete account</h2>
        <p className="text-base text-slate-600 mb-4">Deletes your account and all your runs, datasets and leads. This can't be undone.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="del-pw" className="label">Password</label>
            <input id="del-pw" type="password" className="input" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} autoComplete="current-password" required />
          </div>
          <div>
            <label htmlFor="del-confirm" className="label">Type DELETE to confirm</label>
            <input id="del-confirm" className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        </div>
        <button type="submit" disabled={deleting || confirmText !== "DELETE" || !deletePw}
          className="btn-primary mt-4 bg-rose-600 hover:bg-rose-500 shadow-rose-600/20">
          {deleting && <Loader2 className="w-4 h-4 animate-spin" />} Delete my account
        </button>
      </form>
    </div>
  );
};
