import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthPage } from "@/components/AuthPage";
import { Workspace } from "@/Workspace";
import { UNAUTHORIZED_EVENT, api, getToken, setToken } from "@/lib/api";
import type { User } from "@/types";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  // With no saved session there is nothing to check.
  const [checking, setChecking] = useState(() => !!getToken());

  useEffect(() => {
    if (!getToken()) return;
    let alive = true;
    api<User>("/api/auth/me")
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { if (alive) setToken(""); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signOut = useCallback(() => {
    setToken("");
    setUser(null);
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-base gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading Magpie…
      </div>
    );
  }
  if (!user) return <AuthPage onAuthed={setUser} />;
  return <Workspace key={user.id} user={user} onUserChange={setUser} onSignOut={signOut} />;
}

export default App;
