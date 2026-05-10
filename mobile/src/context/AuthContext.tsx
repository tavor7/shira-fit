import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { clearSupabaseAuthStorage, supabase } from "../lib/supabase";
import { clearAllUiDraftsForUser } from "../lib/uiDraftStorage";
import { clearWebLastRoute } from "../lib/webLastRoute";
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
          setSession(s);
          if (s?.user?.id) {
            await loadProfile(s.user.id);
            if (!mountedRef.current) return;
          } else {
            setProfile(null);
          }
          setLoading(false);
          return;
        }

        lastMessage = error.message || "Unknown error";
        const msg = lastMessage.toLowerCase();
        if (msg.includes("refresh token") && msg.includes("not found")) {
          clearSupabaseAuthStorage();
          void supabase.auth.signOut({ scope: "local" });
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
        if ((event as unknown as string) === "TOKEN_REFRESH_FAILED") {
          void (async () => {
            const { data: refData, error: refErr } = await supabase.auth.refreshSession();
            if (!mountedRef.current) return;
            if (!refErr && refData.session) {
              setSession(refData.session);
              setAuthUnavailable(false);
              setAuthUnavailableMessage(null);
              if (refData.session.user?.id) {
                // Do not toggle global loading: (app)/_layout would unmount the entire Stack and hurt URL/restoration on web.
                await loadProfile(refData.session.user.id);
              } else {
                setProfile(null);
              }
              return;
            }
            clearSupabaseAuthStorage();
            void supabase.auth.signOut({ scope: "local" });
            setSession(null);
            setProfile(null);
            setLoading(false);
          })();
          return;
        }

        const ev = event as string;
        /** These events refresh the session/profile in the background; blocking the UI remounts expo-router stacks. */
        const skipFullScreenLoading =
          ev === "INITIAL_SESSION" || ev === "TOKEN_REFRESHED" || ev === "USER_UPDATED";

        setSession(s);
        setAuthUnavailable(false);
        setAuthUnavailableMessage(null);
        if (s?.user?.id) {
          if (!skipFullScreenLoading) {
            setLoading(true);
          }
          void loadProfile(s.user.id).finally(() => {
            if (mountedRef.current && !skipFullScreenLoading) setLoading(false);
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
