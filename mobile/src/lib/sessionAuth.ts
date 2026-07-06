import type { Session } from "@supabase/supabase-js";
import { clearSupabaseAuthStorage, supabase } from "./supabase";

/** Refresh access token if within this window of expiry (seconds). */
const EXPIRY_SKEW_SEC = 60;

export function isAccessTokenExpired(session: Session | null | undefined): boolean {
  if (!session?.expires_at) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return session.expires_at <= nowSec + EXPIRY_SKEW_SEC;
}

export function isAuthFailureMessage(message: string | null | undefined): boolean {
  const msg = (message ?? "").toLowerCase();
  return (
    msg.includes("jwt expired") ||
    msg.includes("invalid jwt") ||
    msg.includes("not authenticated") ||
    msg.includes("session not found") ||
    (msg.includes("refresh token") && msg.includes("not found"))
  );
}

export function isInvalidRefreshTokenMessage(message: string | null | undefined): boolean {
  const msg = (message ?? "").toLowerCase();
  return msg.includes("refresh token") && msg.includes("not found");
}

export async function handleDeadSession(): Promise<void> {
  clearSupabaseAuthStorage();
  await supabase.auth.signOut({ scope: "local" });
}

let refreshInFlight: Promise<Session | null> | null = null;

/** Single shared refresh — used on cold start and when an API call gets 401. */
export async function refreshSupabaseSessionOnce(): Promise<Session | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        if (isInvalidRefreshTokenMessage(error.message)) {
          await handleDeadSession();
        }
        return null;
      }
      return data.session ?? null;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Cold start only: return a valid session, refreshing if the stored access token is expired.
 * Does not run on background → foreground resume.
 */
export async function ensureFreshSessionOnColdStart(
  session: Session | null
): Promise<Session | null> {
  if (!session) return null;
  if (!isAccessTokenExpired(session)) return session;
  return refreshSupabaseSessionOnce();
}
