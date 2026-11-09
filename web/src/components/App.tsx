"use client";

import { useCallback, useEffect, useState } from "react";
import { loadSession, saveSession } from "@/lib/api";
import type { Session } from "@/lib/types";
import { Dashboard } from "./Dashboard";
import { LoginForm } from "./LoginForm";

/** Session gate. Storage is only read in an effect, so prerendering stays static. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSession(loadSession());
      setReady(true);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const login = useCallback((s: Session) => {
    saveSession(s);
    setSession(s);
  }, []);
  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  if (!ready) return <div className="boot" aria-busy="true" />;
  return session ? <Dashboard session={session} onLogout={logout} /> : <LoginForm onLogin={login} />;
}
