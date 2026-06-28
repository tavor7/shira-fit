import { supabase } from "./supabase";
import { escapeIlike } from "./staffAthleteSearch";
import {
  normalizeManagerMessageTheme,
  type ManagerMessageTheme,
} from "./managerMessageThemes";

export type { ManagerMessageTheme };

export type MessageRecipient = {
  user_id: string;
  full_name: string;
  username: string;
  role: string;
};

export type PendingManagerMessage = {
  id: string;
  body: string;
  created_at: string;
  sender_name: string;
  message_theme: ManagerMessageTheme;
};

export type SentManagerMessage = {
  id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  recipient_id: string;
  recipient_name: string;
  recipient_role: string;
  message_theme: ManagerMessageTheme;
};

function parseRpcObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

export async function searchMessageRecipients(termRaw: string, limit = 30): Promise<MessageRecipient[]> {
  const term = termRaw.trim();
  const safe = escapeIlike(term);

  const me = (await supabase.auth.getUser()).data.user?.id ?? null;

  let query = supabase
    .from("profiles")
    .select("user_id, full_name, username, role")
    .in("role", ["athlete", "coach", "manager"])
    .order("full_name", { ascending: true })
    .limit(limit);

  if (me) query = query.neq("user_id", me);

  if (term.length > 0) {
    query = query.or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return (data as MessageRecipient[]).map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name ?? "—",
    username: r.username ?? "",
    role: r.role ?? "athlete",
  }));
}

export async function sendManagerDirectMessage(
  recipientId: string,
  body: string,
  messageTheme: ManagerMessageTheme = "love"
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("send_manager_direct_message", {
    p_recipient_id: recipientId,
    p_body: body.trim(),
    p_theme: messageTheme,
  });
  if (error) return { ok: false, error: error.message };
  const o = parseRpcObject(data);
  if (!o || o.ok !== true) return { ok: false, error: String(o?.error ?? "unknown") };
  return { ok: true, id: String(o.id ?? "") };
}

export async function fetchPendingManagerDirectMessage(): Promise<PendingManagerMessage | null> {
  const { data, error } = await supabase.rpc("get_pending_manager_direct_message");
  if (error) return null;
  const o = parseRpcObject(data);
  if (!o || o.ok !== true) return null;
  const msg = o.message;
  if (msg == null || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const id = String(m.id ?? "");
  if (!id) return null;
  return {
    id,
    body: String(m.body ?? ""),
    created_at: String(m.created_at ?? ""),
    sender_name: String(m.sender_name ?? ""),
    message_theme: normalizeManagerMessageTheme(m.message_theme),
  };
}

export async function markManagerDirectMessageRead(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("mark_manager_direct_message_read", {
    p_message_id: messageId,
  });
  if (error) return false;
  const o = parseRpcObject(data);
  return o?.ok === true;
}

export async function cancelManagerDirectMessage(
  messageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("cancel_manager_direct_message", {
    p_message_id: messageId,
  });
  if (error) return { ok: false, error: error.message };
  const o = parseRpcObject(data);
  if (!o || o.ok !== true) return { ok: false, error: String(o?.error ?? "unknown") };
  return { ok: true };
}

export async function fetchSentManagerDirectMessages(limit = 40): Promise<SentManagerMessage[]> {
  const { data, error } = await supabase
    .from("manager_direct_messages")
    .select("id, body, created_at, read_at, recipient_id, message_theme")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data?.length) return [];

  const recipientIds = [...new Set((data as { recipient_id: string }[]).map((r) => r.recipient_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, full_name, role")
    .in("user_id", recipientIds);

  const byId = new Map(
    ((profiles ?? []) as { user_id: string; full_name: string; role: string }[]).map((p) => [p.user_id, p])
  );

  return (data as { id: string; body: string; created_at: string; read_at: string | null; recipient_id: string; message_theme?: string }[]).map(
    (row) => {
      const rec = byId.get(row.recipient_id);
      return {
        id: row.id,
        body: row.body,
        created_at: row.created_at,
        read_at: row.read_at,
        recipient_id: row.recipient_id,
        recipient_name: rec?.full_name ?? "—",
        recipient_role: rec?.role ?? "",
        message_theme: normalizeManagerMessageTheme(row.message_theme),
      };
    }
  );
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}
