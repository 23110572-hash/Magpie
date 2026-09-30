import React, { useEffect, useRef, useState } from "react";
import { Database, History as HistoryIcon, LogOut, Send, Settings, Terminal, Zap } from "lucide-react";
import type { Tab, User } from "@/types";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "home", label: "Home", icon: Terminal },
  { id: "datasets", label: "Datasets", icon: Database },
  { id: "leads", label: "Leads", icon: Send },
  { id: "history", label: "History", icon: HistoryIcon },
];

/** Brand mark pinned to the top-left corner, outside the navigation bar. */
export const BrandCorner: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button type="button" onClick={onClick} aria-label="Magpie home"
    className="fixed top-3 left-3 sm:top-4 sm:left-5 z-50 rounded-xl focus-visible:outline-2 focus-visible:outline-blue-600 print:hidden">
    <img src="/logo.png" alt="Magpie - You ask, it collects" className="h-11 sm:h-14 w-auto object-contain" />
  </button>
);

interface FloatingNavProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  runningCount: number;
  onRunningClick: () => void;
}

export const FloatingNav: React.FC<FloatingNavProps> = ({ activeTab, setActiveTab, runningCount, onRunningClick }) => (
  // Bottom bar on small screens (never collides with the corner logo), floating top bar on large screens.
  <header className="fixed z-40 left-1/2 -translate-x-1/2 w-[calc(100%-1.5rem)] max-w-[620px] bottom-3 lg:bottom-auto lg:top-5 print:hidden">
    <nav aria-label="Main navigation" className="glass-nav rounded-full px-2 py-2 flex items-center justify-between gap-1">
      <div className="flex items-center gap-1 flex-1 justify-around sm:justify-start">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button key={id} type="button" onClick={() => setActiveTab(id)} aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                active ? "bg-blue-600 text-white shadow-md shadow-blue-500/25" : "text-slate-700 hover:bg-slate-100"
              }`}>
              <Icon className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden text-xs">{label}</span>
            </button>
          );
        })}
      </div>
      {runningCount > 0 && (
        <button type="button" onClick={onRunningClick}
          className="flex items-center gap-1.5 px-3 py-1.5 mr-1 rounded-full text-sm font-semibold border bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 shrink-0"
          aria-label={`${runningCount} workflow${runningCount === 1 ? "" : "s"} running - show progress`}>
          <Zap className="w-4 h-4 text-amber-500 animate-pulse" aria-hidden="true" />
          <span>{runningCount}</span>
          <span className="hidden sm:inline">running</span>
        </button>
      )}
    </nav>
  </header>
);

interface UserMenuProps {
  user: User;
  onSettings: () => void;
  onSignOut: () => void;
}

/** Profile button pinned to the top-right corner, mirroring the logo. */
export const UserMenu: React.FC<UserMenuProps> = ({ user, onSettings, onSignOut }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const initials = user.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "U";
  return (
    <div ref={ref} className="fixed top-3 right-3 sm:top-5 sm:right-5 z-50 print:hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label="Account menu"
        className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-blue-600 text-white font-bold text-base shadow-lg shadow-blue-600/25 hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
        {initials}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-72 card p-2 shadow-2xl">
          <div className="px-3 py-2.5 border-b border-slate-100 mb-1">
            <div className="text-sm font-bold text-slate-900 truncate">{user.name}</div>
            <div className="text-xs text-slate-500 truncate">{user.email}</div>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onSettings(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Settings className="w-4 h-4" /> Settings
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onSignOut(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium text-rose-700 hover:bg-rose-50">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};
