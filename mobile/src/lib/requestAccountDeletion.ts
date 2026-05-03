import { supabaseUrl } from "./supabase";

export type DeleteAccountCode =
  | "coach_has_sessions"
  | "cannot_delete_manager"
  | "unauthorized"
  | "profile_not_found";

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; error: string; code?: DeleteAccountCode | string };

export async function requestAccountDeletion(accessToken: string): Promise<DeleteAccountResult> {
  const base = supabaseUrl.replace(/\/$/, "");
  if (!base) {
    return { ok: false, error: "Missing Supabase URL" };
  }
  const res = await fetch(`${base}/functions/v1/delete-account`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  let body: { ok?: boolean; error?: string; code?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: "Invalid response" };
  }
  if (res.ok && body.ok) return { ok: true };
  return {
    ok: false,
    error: body.error ?? res.statusText ?? "Request failed",
    code: body.code,
  };
}
