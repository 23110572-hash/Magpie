import { useCallback, useEffect, useState } from "react";
import { AuthDialog, type AuthReason } from "@/components/AuthDialog";
import { Workspace } from "@/Workspace";
import { UNAUTHORIZED_EVENT, api, getToken, setToken } from "@/lib/api";
import type { PendingAction, User } from "@/types";

/** Visitors land on Home as guests; signing in is only asked for when they try to run or open their data. */
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(() => !!getToken());
  const [authReason, setAuthReason] = useState<AuthReason | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // Restore a saved session.
  useEffect(() => {
    if (!getToken()) return;
    let alive = true;
    api<User>("/api/auth/me")
      .then((u) => {
        if (!alive) return;
        setUser(u);
        setAuthReason(null);
      })
      .catch(() => {
        if (alive) setToken("");
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Session expired or revoked while using the app: drop back to guest mode.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const requireAuth = useCallback((action: PendingAction) => {
    setPending(action.run || action.tab ? action : null);
    setAuthReason(action.run ? "run" : action.tab ? "tab" : "signin");
  }, []);

  const onAuthed = useCallback((u: User) => {
    setUser(u);
    setChecking(false);
    setAuthReason(null);
  }, []);

  const closeAuth = useCallback(() => {
    setAuthReason(null);
    setPending(null);
  }, []);

  const consumePending = useCallback(() => setPending(null), []);

  const signOut = useCallback(() => {
    setToken("");
    setUser(null);
    setPending(null);
  }, []);

  return (
    <>
      {/* Remount on sign-in / sign-out so no data leaks between accounts. */}
      <Workspace
        key={user?.id ?? "guest"}
        user={user}
        authLoading={checking}
        onRequireAuth={requireAuth}
        pending={user ? pending : null}
        onPendingConsumed={consumePending}
        onUserChange={setUser}
        onSignOut={signOut}
      />
      {authReason && <AuthDialog reason={authReason} onAuthed={onAuthed} onClose={closeAuth} />}
    </>
  );
}

export default App;
