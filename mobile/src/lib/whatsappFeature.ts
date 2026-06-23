import { supabase } from "./supabase";

export type WhatsAppRolloutMode = "off" | "testing" | "live";

export type WhatsAppFeatureState = {
  ok: boolean;
  rollout_mode?: WhatsAppRolloutMode;
  can_see_settings?: boolean;
  can_receive?: boolean;
  whatsapp_enabled?: boolean;
  whatsapp_phone_e164?: string | null;
  error?: string;
};

export type WhatsAppTestUser = {
  user_id: string;
  full_name: string;
  phone: string;
  role: string;
};

export type WhatsAppRolloutConfig = {
  ok: boolean;
  mode?: WhatsAppRolloutMode;
  test_users?: WhatsAppTestUser[];
  error?: string;
};

export type WhatsAppTestCandidate = {
  user_id: string;
  full_name: string;
  phone: string;
  role: string;
  username: string;
};

type RpcPayload = { ok?: boolean; error?: string };

function parseRpcJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as T;
  return null;
}

function parseTestUsers(raw: unknown): WhatsAppTestUser[] {
  if (Array.isArray(raw)) return raw as WhatsAppTestUser[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as WhatsAppTestUser[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function fetchWhatsAppFeatureState(): Promise<WhatsAppFeatureState> {
  const { data, error } = await supabase.rpc("get_whatsapp_feature_state");
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<WhatsAppFeatureState>(data);
  return row ?? { ok: false, error: "invalid_response" };
}

export async function setWhatsAppNotificationsEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc("set_whatsapp_notifications_enabled", { p_enabled: enabled });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<RpcPayload>(data);
  return { ok: row?.ok === true, error: row?.error };
}

export async function fetchWhatsAppRolloutConfig(): Promise<WhatsAppRolloutConfig> {
  const { data, error } = await supabase.rpc("get_whatsapp_rollout_config");
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<WhatsAppRolloutConfig & { test_users?: unknown }>(data);
  if (!row) return { ok: false, error: "invalid_response" };
  return {
    ok: row.ok === true,
    mode: row.mode,
    test_users: parseTestUsers(row.test_users),
    error: row.error,
  };
}

export async function setWhatsAppRolloutMode(mode: WhatsAppRolloutMode): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc("set_whatsapp_rollout_mode", { p_mode: mode });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<RpcPayload>(data);
  return { ok: row?.ok === true, error: row?.error };
}

export async function setWhatsAppTestUsers(userIds: string[]): Promise<{ ok: boolean; error?: string; count?: number }> {
  const { data, error } = await supabase.rpc("set_whatsapp_test_users", {
    p_user_ids: userIds,
  });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<RpcPayload & { count?: number }>(data);
  return { ok: row?.ok === true, error: row?.error, count: row?.count };
}

export async function saveWhatsAppRolloutConfig(
  mode: WhatsAppRolloutMode,
  userIds: string[]
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const { data, error } = await supabase.rpc("save_whatsapp_rollout_config", {
    p_mode: mode,
    p_user_ids: userIds,
  });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<RpcPayload & { count?: number; mode?: WhatsAppRolloutMode }>(data);
  return { ok: row?.ok === true, error: row?.error, count: row?.count };
}

export type WhatsAppTestTemplate =
  | "hello_world"
  | "waitlist_spot"
  | "session_reminder_24h"
  | "session_reminder_3h"
  | "weekly_registration_open";

export async function searchWhatsAppTestCandidates(
  term: string,
  limit = 40
): Promise<WhatsAppTestCandidate[]> {
  const { data, error } = await supabase.rpc("search_whatsapp_test_user_candidates", {
    p_term: term,
    p_limit: limit,
  });
  if (error) return [];
  return (data ?? []) as WhatsAppTestCandidate[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWhatsAppDeliveryStatus(
  deliveryId: string
): Promise<{ ok: boolean; status?: string; error?: string; skip_reason?: string }> {
  const { data, error } = await supabase.rpc("get_whatsapp_delivery_status", {
    p_delivery_id: deliveryId,
  });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<{
    ok?: boolean;
    status?: string;
    error?: string;
    error_message?: string;
    skip_reason?: string;
  }>(data);
  if (!row?.ok) return { ok: false, error: row?.error ?? "invalid_response" };
  return {
    ok: true,
    status: row.status,
    error: row.error_message ?? undefined,
    skip_reason: row.skip_reason ?? undefined,
  };
}

export async function sendWhatsAppManagerTestMessage(
  userId: string,
  template: WhatsAppTestTemplate
): Promise<{ ok: boolean; error?: string; user_name?: string; phone?: string; status?: string }> {
  const { data, error } = await supabase.rpc("send_whatsapp_manager_test_message", {
    p_user_id: userId,
    p_template: template,
  });
  if (error) return { ok: false, error: error.message };
  const row = parseRpcJson<{
    ok?: boolean;
    queued?: boolean;
    delivery_id?: string;
    error?: string;
    user_name?: string;
    phone?: string;
    status?: string;
  }>(data);
  if (!row?.ok) {
    return {
      ok: false,
      error: row?.error,
      user_name: row?.user_name,
      phone: row?.phone,
      status: row?.status,
    };
  }

  const deliveryId = row.delivery_id;
  if (!deliveryId) {
    return { ok: true, user_name: row.user_name, phone: row.phone, status: row.status };
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(500);
    const statusRes = await fetchWhatsAppDeliveryStatus(deliveryId);
    if (!statusRes.ok) continue;
    if (statusRes.status === "sent") {
      return {
        ok: true,
        user_name: row.user_name,
        phone: row.phone,
        status: "sent",
      };
    }
    if (statusRes.status === "failed" || statusRes.status === "skipped") {
      return {
        ok: false,
        error: statusRes.error ?? statusRes.skip_reason ?? "delivery_failed",
        user_name: row.user_name,
        phone: row.phone,
        status: statusRes.status,
      };
    }
  }

  return {
    ok: false,
    error: "delivery_timeout",
    user_name: row.user_name,
    phone: row.phone,
    status: "pending",
  };
}
