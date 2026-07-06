import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { clearAllUiDraftsForUser } from "../lib/uiDraftStorage";
import { clearWebLastRoute } from "../lib/webLastRoute";
import {
  ensureFreshSessionOnColdStart,
  handleDeadSession,
  isInvalidRefreshTokenMessage,
  refreshSupabaseSessionOnce,
} from "../lib/sessionAuth";
import type { Profile } from "../types/database";

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  /** True when initial session fetch failed after retries (not the same as signed out). */
  authUnavailable: boolean;
  authUnavailableMessage: string | null;
  retryAuthBootstrap: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

const BOOTSTRAP_ATTEMPTS = 3;

/**
 * Auth loading semantics (especially for web/PWA):
 * - Initial bootstrap still uses `loading` until we know session (+ profile) from `getSession`.
 * - Later `onAuthStateChange` updates only set `loading` when the **Supabase user id changes**
 *   (new sign-in or account switch). Same-user token refresh / profile reload does **not** toggle it.
 * Reason: `(app)/_layout` previously treated any `loading` as “replace the whole Stack with a spinner”.
 * Unmounting the Stack on refresh dropped client navigation state while `window.location` could still
 * show a deep route (e.g. manager session detail), so resume looked like a bogus redirect to home.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [authUnavailableMessage, setAuthUnavailableMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function loadProfile(uid: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", uid)
      .single();
    if (!mountedRef.current) return;
    if (!error && data) setProfile(data as Profile);
    else setProfile(null);
  }

  const refreshProfile = useCallback(async () => {
    const uid = sessionRef.current?.user?.id;
    if (uid) await loadProfile(uid);
  }, []);

  const bootstrapRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    let cancelled = false;
    async function runBootstrapWithRetry() {
      setAuthUnavailable(false);
      setAuthUnavailableMessage(null);
      setLoading(true);

      let lastMessage = "";

      for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
        const { data: { session: s }, error } = await supabase.auth.getSession();
        if (!mountedRef.current) return;

        if (!error) {
          let activeSession = await ensureFreshSessionOnColdStart(s);
          if (!mountedRef.current) return;
          if (s && !activeSession) {
            await handleDeadSession();
            setSession(null);
            setProfile(null);
            setLoading(false);
            return;
          }
          setSession(activeSession);
          if (activeSession?.user?.id) {
            await loadProfile(activeSession.user.id);
            if (!mountedRef.current) return;
          } else {
            setProfile(null);
          }
          setLoading(false);
          return;
        }

        lastMessage = error.message || "Unknown error";
        if (isInvalidRefreshTokenMessage(lastMessage)) {
          await handleDeadSession();
          setSession(null);
          setProfile(null);
          setLoading(false);
          return;
        }

        if (attempt < BOOTSTRAP_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          if (!mountedRef.current) return;
        }
      }

      setSession(null);
      setProfile(null);
      setAuthUnavailable(true);
      setAuthUnavailableMessage(lastMessage);
      setLoading(false);
    }

    bootstrapRef.current = runBootstrapWithRetry;

    let subUnsub: (() => void) | null = null;

    void (async () => {
      await runBootstrapWithRetry();
      if (!mountedRef.current || cancelled) return;

      const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
        const previousUserId = sessionRef.current?.user?.id ?? null;

        if ((event as unknown as string) === "TOKEN_REFRESH_FAILED") {
          void (async () => {
            const refreshed = await refreshSupabaseSessionOnce();
            if (!mountedRef.current) return;
            if (refreshed) {
              setSession(refreshed);
              setAuthUnavailable(false);
              setAuthUnavailableMessage(null);
              if (refreshed.user?.id) {
                await loadProfile(refreshed.user.id);
              } else {
                setProfile(null);
              }
              return;
            }
            await handleDeadSession();
            setSession(null);
            setProfile(null);
            setLoading(false);
          })();
          return;
        }

        const ev = event as string;
        /** Background-only events: never use them to drive global `loading` (would remount the app Stack). */
        const skipFullScreenLoading =
          ev === "INITIAL_SESSION" || ev === "TOKEN_REFRESHED" || ev === "USER_UPDATED";

        setSession(s);
        setAuthUnavailable(false);
        setAuthUnavailableMessage(null);
        if (s?.user?.id) {
          const userChanged = previousUserId !== s.user.id;
          const shouldBlockUi = !skipFullScreenLoading && userChanged;
          if (shouldBlockUi) {
            setLoading(true);
          }
          void loadProfile(s.user.id).finally(() => {
            if (mountedRef.current && shouldBlockUi) setLoading(false);
          });
        } else {
          setProfile(null);
          setLoading(false);
        }
      });
      if (cancelled) {
        sub.subscription.unsubscribe();
        return;
      }
      subUnsub = () => sub.subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      subUnsub?.();
    };
  }, []);

  const retryAuthBootstrap = useCallback(async () => {
    await bootstrapRef.current();
  }, []);

  const signOut = async () => {
    const uid = sessionRef.current?.user?.id;
    await clearAllUiDraftsForUser(uid);
    clearWebLastRoute(uid);
    await supabase.auth.signOut();
    if (mountedRef.current) {
      setProfile(null);
      setAuthUnavailable(false);
      setAuthUnavailableMessage(null);
    }
  };

  return (
    <Ctx.Provider
      value={{
        session,
        user: session?.user ?? null,
        profile,
        loading,
        authUnavailable,
        authUnavailableMessage,
        retryAuthBootstrap,
        refreshProfile,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
