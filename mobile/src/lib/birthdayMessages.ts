import { supabase } from "./supabase";
import {
  normalizeManagerMessageTheme,
  type ManagerMessageTheme,
} from "./managerMessageThemes";

export type BirthdayMessageSettings = {
  enabled: boolean;
  body: string;
  theme: ManagerMessageTheme;
  senderName: string;
  updatedAt: string | null;
  updatedByName: string | null;
};

export async function fetchBirthdayMessageSettings(): Promise<
  { ok: true; settings: BirthdayMessageSettings } | { ok: false; error: string }
> {
  const { data, error } = await supabase.rpc("get_manager_birthday_message_settings");
  if (error) return { ok: false, error: error.message };
  const row = data as {
    ok?: boolean;
    error?: string;
    enabled?: boolean;
    body?: string;
    theme?: string;
    sender_name?: string;
    updated_at?: string | null;
    updated_by_name?: string | null;
  } | null;
  if (!row?.ok) return { ok: false, error: row?.error ?? "unknown_error" };
  return {
    ok: true,
    settings: {
      enabled: !!row.enabled,
      body: row.body ?? "",
      theme: normalizeManagerMessageTheme(row.theme),
      senderName: row.sender_name?.trim() || "Shira",
      updatedAt: row.updated_at ?? null,
      updatedByName: row.updated_by_name?.trim() || null,
    },
  };
}

export async function saveBirthdayMessageSettings(
  enabled: boolean,
  body: string,
  theme: ManagerMessageTheme
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("set_manager_birthday_message_settings", {
    p_enabled: enabled,
    p_body: body,
    p_theme: theme,
  });
  if (error) return { ok: false, error: error.message };
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row?.ok) return { ok: false, error: row?.error ?? "unknown_error" };
  return { ok: true };
}

export const DEFAULT_BIRTHDAY_MESSAGE_EN = "Happy birthday, {name}! 🎂";
export const DEFAULT_BIRTHDAY_MESSAGE_HE = "יום הולדת שמח, {name}! 🎂";
