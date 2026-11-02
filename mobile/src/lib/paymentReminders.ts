import { supabase } from "./supabase";

export type ReminderStatus = "pending" | "read" | "cancelled" | "settled" | "account_changed";

export type ReminderHistoryRow = {
  id: string;
  recipient_id: string;
  recipient_name: string;
  sender_name: string;
  amount: number;
  shown_amount: number | null;
  status: ReminderStatus;
  sent_at: string;
  read_at: string | null;
  closed_at: string | null;
};

export type ReminderAccountMember = {
  kind: "app" | "manual";
  id: string;
  name: string;
  own_balance: number | null;
  ineligible_reason: string | null;
};

export type ReminderAccountStatus = {
  account_key: string;
  is_family: boolean;
  family_name: string | null;
  /** Null when this manager may not see it. Never treat that as zero. */
  balance: number | null;
  has_hidden: boolean;
  members: ReminderAccountMember[];
  history: ReminderHistoryRow[];
};

export type AccountBalanceRow = { balance: number | null; is_family: boolean; has_pending: boolean };
export type AccountBalanceMap = Record<string, AccountBalanceRow>;

export type SendReminderResult =
  | { ok: true; amount: number }
  | { ok: false; error: string; currentAmount?: number };

export function balanceKey(kind: "app" | "manual", id: string): string {
  return `${kind}:${id}`;
}

function parseRow(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

function numberOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export function parseAccountStatus(o: Record<string, unknown>): ReminderAccountStatus {
  return {
    account_key: String(o.account_key ?? ""),
    is_family: o.is_family === true,
    family_name: o.family_name == null ? null : String(o.family_name),
    balance: numberOrNull(o.balance),
    has_hidden: o.has_hidden === true,
    members: ((o.members as Record<string, unknown>[]) ?? []).map((m) => ({
      kind: m.kind === "manual" ? "manual" : "app",
      id: String(m.id ?? ""),
      name: String(m.name ?? ""),
      own_balance: numberOrNull(m.own_balance),
      ineligible_reason: m.ineligible_reason == null ? null : String(m.ineligible_reason),
    })),
    history: ((o.history as Record<string, unknown>[]) ?? []).map((h) => ({
      id: String(h.id ?? ""),
      recipient_id: String(h.recipient_id ?? ""),
      recipient_name: String(h.recipient_name ?? ""),
      sender_name: String(h.sender_name ?? ""),
      amount: Number(h.amount ?? 0),
      shown_amount: numberOrNull(h.shown_amount),
      status: h.status as ReminderStatus,
      sent_at: String(h.sent_at ?? ""),
      read_at: h.read_at == null ? null : String(h.read_at),
      closed_at: h.closed_at == null ? null : String(h.closed_at),
    })),
  };
}

/** Null when the lookup failed: a failed lookup is unknown, not a zero balance. */
export async function fetchAccountBalances(): Promise<AccountBalanceMap | null> {
  const { data, error } = await supabase.rpc("manager_account_balances");
  if (error) return null;
  const o = parseRow(data);
  if (!o || o.ok !== true) return null;
  const out: AccountBalanceMap = {};
  for (const r of (o.rows as Record<string, unknown>[]) ?? []) {
    out[balanceKey(r.kind === "manual" ? "manual" : "app", String(r.id))] = {
      balance: numberOrNull(r.balance),
      is_family: r.is_family === true,
      has_pending: r.has_pending === true,
    };
  }
  return out;
}

export async function fetchReminderStatus(payeeId: string, payeeIsManual: boolean): Promise<ReminderAccountStatus | null> {
  const { data, error } = await supabase.rpc("manager_payment_reminder_status", {
    p_payee_id: payeeId,
    p_payee_is_manual: payeeIsManual,
  });
  if (error) return null;
  const o = parseRow(data);
  if (!o || o.ok !== true) return null;
  return parseAccountStatus(o);
}

export async function sendPaymentReminder(recipientId: string, seenAmount: number): Promise<SendReminderResult> {
  const { data, error } = await supabase.rpc("send_payment_reminder", {
    p_recipient_id: recipientId,
    p_expected_amount: seenAmount,
  });
  if (error) return { ok: false, error: error.message };
  const o = parseRow(data);
  if (!o) return { ok: false, error: "unknown" };
  if (o.ok === true) return { ok: true, amount: Number(o.amount ?? seenAmount) };
  return { ok: false, error: String(o.error ?? "unknown"), currentAmount: numberOrNull(o.current_amount) ?? undefined };
}

export async function cancelPaymentReminder(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("cancel_payment_reminder", { p_message_id: messageId });
  if (error) return false;
  return parseRow(data)?.ok === true;
}

export type ReminderCardNotice =
  | "hidden"
  | "noLogin"
  | "notEligible"
  | "familyEven"
  | "credit"
  | "nothingOwed"
  | null;

export type ReminderCardState = {
  balanceTone: "owe" | "credit" | "even" | "unknown";
  pending: ReminderHistoryRow | null;
  eligibleRecipients: ReminderAccountMember[];
  notice: ReminderCardNotice;
  canSend: boolean;
  showAction: boolean;
};

/** What the card shows. The server re-decides all of this when sending; this only avoids offering what it would refuse. */
export function reminderCardState(status: ReminderAccountStatus, recipientId: string | null): ReminderCardState {
  const { balance } = status;
  const pending = status.history.find((h) => h.status === "pending") ?? null;
  const eligibleRecipients = status.members.filter((m) => m.ineligible_reason == null);
  const balanceTone = balance == null ? "unknown" : balance > 0 ? "owe" : balance < 0 ? "credit" : "even";

  let notice: ReminderCardNotice = null;
  if (status.has_hidden) notice = "hidden";
  else if (eligibleRecipients.length === 0) {
    notice = status.members.every((m) => m.ineligible_reason === "no_login") ? "noLogin" : "notEligible";
  } else if (balanceTone === "credit") notice = "credit";
  else if (balanceTone === "even") {
    notice = status.is_family && status.members.some((m) => (m.own_balance ?? 0) > 0) ? "familyEven" : "nothingOwed";
  }

  const showAction = notice === null && balanceTone === "owe";
  const recipientOk = !!recipientId && eligibleRecipients.some((m) => m.id === recipientId);
  return {
    balanceTone,
    pending,
    eligibleRecipients,
    notice,
    showAction,
    canSend: showAction && recipientOk && !pending,
  };
}

/** Which family member is chosen first: the person being viewed if they can receive it, otherwise the first who can. */
export function defaultReminderRecipient(status: ReminderAccountStatus, viewedId: string): string | null {
  const eligible = status.members.filter((m) => m.ineligible_reason == null);
  return (eligible.find((m) => m.id === viewedId) ?? eligible[0])?.id ?? null;
}
