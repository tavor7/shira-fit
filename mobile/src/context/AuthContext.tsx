import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { syncPendingSignupConsent, syncPendingSignupLegalConsents } from "../lib/consent";
import { syncSignupProfileFromMetadata } from "../lib/signupOnboarding";
import { hasSignupSyncRun, profileHasSignupGaps, runSignupSyncOnce } from "../lib/signupSync";
import { decideAuthEventAction } from "../lib/authEvents";
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
  /**
   * Background signup-data sync for the signed-in user (lib/signupSync). Consent gates must not decide while
   * `settled` is false (a brand-new user's signup consents may still be on their way) and must re-check when
   * `generation` increases (the sync recorded something).
   */
  signupSync: { settled: boolean; generation: number };
};

const Ctx = createContext<AuthCtx | null>(null);

const BOOTSTRAP_ATTEMPTS = 3;

const signupSyncDeps = {
  syncProfile: syncSignupProfileFromMetadata,
  syncReceiptsConsent: syncPendingSignupConsent,
  syncLegalConsents: syncPendingSignupLegalConsents,
};

/**
 * Auth loading semantics (especially for web/PWA):
 * - Initial bootstrap still uses `loading` until we know session (+ profile) from `getSession`.
 * - Later `onAuthStateChange` updates only set `loading` when the **Supabase user id changes**
 *   (new sign-in or account switch). Same-user token refresh / profile reload does **not** toggle it.
 * Reason: `(app)/_layout` previously treated any `loading` as “replace the whole Stack with a spinner”.
 * Unmounting the Stack on refresh dropped client navigation state while `window.location` could still
 * show a deep route (e.g. manager session detail), so resume looked like a bogus redirect to home.
 *
 * Startup (Performance Phase 1 / step 2): `loading` ends as soon as the profile row is known. The signup syncs run
 * once per user per app session in the background (lib/signupSync) instead of on every profile load, and same-user
 * events (INITIAL_SESSION echo, tab/PWA resume, token refresh) no longer reload the whole profile chain (lib/authEvents).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [authUnavailableMessage, setAuthUnavailableMessage] = useState<string | null>(null);
  const [signupSync, setSignupSync] = useState({ settled: true, generation: 0 });
  const mountedRef = useRef(true);
  const profileLoadedAtRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The loaders below touch only refs and state setters, so they are stable for the provider's lifetime.
  /** One profile read. `keepOnError`: a failed background refresh must not drop a profile we already have. */
  const fetchProfile = useCallback(async (uid: string, opts?: { keepOnError?: boolean }): Promise<Profile | null> => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", uid)
      .single();
    if (!mountedRef.current) return null;
    if (!error && data) {
      setProfile(data as Profile);
      profileLoadedAtRef.current = Date.now();
      return data as Profile;
    }
    if (!opts?.keepOnError) setProfile(null);
    return null;
  }, []);

  /** Signup-data sync, at most once per user per app session; never blocks the UI. */
  const startSignupSync = useCallback((uid: string, profileBefore: Profile | null) => {
    // Already synced in this app session: change nothing (a visible consent gate must not blink).
    if (hasSignupSyncRun(uid)) return;
    setSignupSync((prev) => ({ ...prev, settled: false }));
    void runSignupSyncOnce(uid, signupSyncDeps).then(async (res) => {
      if (!mountedRef.current) return;
      // Re-read the profile only if the sync could have changed it: a filled gap, or a recorded receipts consent.
      const profileMayHaveChanged =
        (res.profileApplied && profileHasSignupGaps(profileBefore)) || res.receiptsConsentRecorded;
      if (profileMayHaveChanged && sessionRef.current?.user?.id === uid) await fetchProfile(uid, { keepOnError: true });
      if (!mountedRef.current) return;
      // Gates re-check only when a consent was actually recorded (profile-field changes reach them via the profile).
      const consentsChanged = res.receiptsConsentRecorded || res.legalConsentsRecorded > 0;
      setSignupSync((prev) => ({ settled: true, generation: prev.generation + (consentsChanged ? 1 : 0) }));
    });
  }, [fetchProfile]);

  /** Full load for a user: profile row (awaited), then the background signup sync. */
  const loadProfile = useCallback(
    async (uid: string) => {
      // Mark the sync as pending BEFORE the profile arrives: a load that doesn't block the UI (background auth event)
      // would otherwise render the new profile with `settled` still true for a moment, and a consent gate could flash
      // for a brand-new user whose signup consents are about to be recorded (reproduced under CPU load, 3 of 16 runs).
      if (!hasSignupSyncRun(uid)) setSignupSync((prev) => (prev.settled ? { ...prev, settled: false } : prev));
      const loaded = await fetchProfile(uid);
      if (mountedRef.current) startSignupSync(uid, loaded);
    },
    [fetchProfile, startSignupSync]
  );

  const refreshProfile = useCallback(async () => {
    const uid = sessionRef.current?.user?.id;
    if (uid) await loadProfile(uid);
  }, [loadProfile]);

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

        const action = decideAuthEventAction({
          event: event as string,
          prevUserId: previousUserId,
          nextUserId: s?.user?.id ?? null,
          prevAccessToken: sessionRef.current?.access_token ?? null,
          nextAccessToken: s?.access_token ?? null,
          msSinceProfileLoad: Date.now() - profileLoadedAtRef.current,
        });
        setAuthUnavailable(false);
        setAuthUnavailableMessage(null);

        if (action.kind === "signedOut") {
          sessionRef.current = s;
          setSession(s);
          setProfile(null);
          setLoading(false);
          return;
        }
        const uid = s!.user.id;
        if (action.kind === "sameUser") {
          // INITIAL_SESSION echo after bootstrap, tab/PWA resume (SIGNED_IN), token refresh: the profile is already
          // loaded. Keep the session object when nothing changed so the app does not re-render for it.
          if (action.updateSession) {
            sessionRef.current = s;
            setSession(s);
          }
          if (action.refreshProfile) void fetchProfile(uid, { keepOnError: true });
          return;
        }
        sessionRef.current = s;
        setSession(s);
        if (action.blockUi) setLoading(true);
        void loadProfile(uid).finally(() => {
          if (mountedRef.current && action.blockUi) setLoading(false);
        });
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
    // fetchProfile / loadProfile are stable (refs + setters only), so this still runs exactly once.
  }, [fetchProfile, loadProfile]);

  const retryAuthBootstrap = useCallback(async () => {
    await bootstrapRef.current();
  }, []);

  const signOut = useCallback(async () => {
    const uid = sessionRef.current?.user?.id;
    await clearAllUiDraftsForUser(uid);
    clearWebLastRoute(uid);
    await supabase.auth.signOut();
    if (mountedRef.current) {
      setProfile(null);
      setAuthUnavailable(false);
      setAuthUnavailableMessage(null);
    }
  }, []);

  // Stable value: consumers (effectively the whole app, via I18nProvider) re-render only when something changed.
  const value = useMemo<AuthCtx>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      authUnavailable,
      authUnavailableMessage,
      retryAuthBootstrap,
      refreshProfile,
      signOut,
      signupSync,
    }),
    [session, profile, loading, authUnavailable, authUnavailableMessage, retryAuthBootstrap, refreshProfile, signOut, signupSync]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
