/**
 * Subscription terms consent — thin wrappers around the server RPCs (20261014130000_subscription_terms_consent.sql).
 * Every decision (who must accept, whether benefits/billing are on hold, which version is current) is made server-side;
 * this module only shapes data for the screens.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Athlete-level status (consent belongs to the athlete + terms version, not to a subscription). */
export type SubscriptionTermsStatus = "not_required" | "pending" | "accepted";

export type SubscriptionTermsDocument = {
  version: number;
  title: string;
  title_en: string | null;
  body_text: string;
  body_text_en: string | null;
  effective_at: string | null;
};

export type MySubscriptionTerms = {
  ok: true;
  status: SubscriptionTermsStatus;
  /** true only for "pending": the mandatory terms screen is shown until the athlete accepts. */
  blocking: boolean;
  accepted_version: number | null;
  accepted_at: string | null;
  /** Present only while "pending". */
  document: SubscriptionTermsDocument | null;
};

export type ManagerTermsStatusItem = {
  subscription_id: string;
  payee_is_manual: boolean;
  status: SubscriptionTermsStatus;
  accepted_version: number | null;
  accepted_at: string | null;
};

export type SubscriptionTermsSettings = {
  ok: true;
  enforced: boolean;
  document: SubscriptionTermsDocument | null;
  counts: Partial<Record<SubscriptionTermsStatus, number>>;
};

/** Document text in the UI language; English falls back to Hebrew (the canonical text) when no translation exists. */
export function termsTextFor(doc: SubscriptionTermsDocument, language: "en" | "he"): { title: string; body: string } {
  if (language === "en" && doc.body_text_en) return { title: doc.title_en || doc.title, body: doc.body_text_en };
  return { title: doc.title, body: doc.body_text };
}

export async function rpcGetMySubscriptionTerms(supabase: SupabaseClient): Promise<MySubscriptionTerms | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("get_my_subscription_terms");
  if (error) throw error;
  return data as MySubscriptionTerms | { ok: false; error: string };
}

export async function rpcAcceptSubscriptionTerms(
  supabase: SupabaseClient,
  version: number,
  userAgent: string | null
): Promise<{ ok: true; version: number } | { ok: false; error: string; current_version?: number }> {
  const { data, error } = await supabase.rpc("accept_subscription_terms", { p_version: version, p_user_agent: userAgent });
  if (error) return { ok: false, error: error.message };
  return data as { ok: true; version: number } | { ok: false; error: string; current_version?: number };
}

export async function rpcGetSubscriptionTermsStatus(
  supabase: SupabaseClient,
  subscriptionIds: string[]
): Promise<Record<string, ManagerTermsStatusItem>> {
  if (subscriptionIds.length === 0) return {};
  const { data, error } = await supabase.rpc("get_subscription_terms_status", { p_subscription_ids: subscriptionIds });
  if (error) throw error;
  const out: Record<string, ManagerTermsStatusItem> = {};
  if (data?.ok) for (const item of data.items as ManagerTermsStatusItem[]) out[item.subscription_id] = item;
  return out;
}

export async function rpcGetSubscriptionTermsSettings(
  supabase: SupabaseClient
): Promise<SubscriptionTermsSettings | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("get_subscription_terms_settings");
  if (error) throw error;
  return data as SubscriptionTermsSettings | { ok: false; error: string };
}

export async function rpcSetSubscriptionTermsEnforced(
  supabase: SupabaseClient,
  enabled: boolean
): Promise<{ ok: true; enforced: boolean } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("set_subscription_terms_enforced", { p_enabled: enabled });
  if (error) return { ok: false, error: error.message };
  return data as { ok: true; enforced: boolean } | { ok: false; error: string };
}

/** Manager-facing description of the payee's terms status, from persisted consent records only. */
export function managerTermsStatusText(
  item: ManagerTermsStatusItem,
  t: (key: string) => string,
  formatDate: (iso: string) => string
): string {
  switch (item.status) {
    case "pending":
      return t("subscriptions.terms.pending");
    case "accepted":
      return t("subscriptions.terms.accepted")
        .replace("{v}", String(item.accepted_version ?? ""))
        .replace("{date}", item.accepted_at ? formatDate(item.accepted_at.slice(0, 10)) : "");
    default:
      return item.payee_is_manual ? t("subscriptions.terms.manualNotRequired") : t("subscriptions.terms.notRequired");
  }
}

// ---------------------------------------------------------------------------
// Manager administration (Setup -> Legal -> Subscription terms). All server-side manager-only.
// ---------------------------------------------------------------------------

export type SubscriptionTermsProblem = "title_he_missing" | "title_en_missing" | "body_he_incomplete" | "body_en_incomplete";

export type SubscriptionTermsVersionRow = SubscriptionTermsDocument & {
  is_current: boolean;
  requires_reconsent: boolean;
  accepted_count: number;
};

export type SubscriptionTermsDraft = {
  title: string;
  title_en: string;
  body_text: string;
  body_text_en: string;
  based_on_version: number | null;
  updated_at: string;
  problems: SubscriptionTermsProblem[] | null;
};

export type SubscriptionTermsAdmin = {
  ok: true;
  enforced: boolean;
  required_version: number | null;
  /** Newest first. */
  versions: SubscriptionTermsVersionRow[];
  draft: SubscriptionTermsDraft | null;
  counts: Partial<Record<SubscriptionTermsStatus, number>>;
};

/** Mirrors the server's _subscription_terms_text_problems so the editor can show problems before saving. */
export const MIN_TERMS_BODY_LENGTH = 200;
export function subscriptionTermsTextProblems(d: { title: string; title_en: string; body_text: string; body_text_en: string }): SubscriptionTermsProblem[] {
  const out: SubscriptionTermsProblem[] = [];
  if (!d.title.trim()) out.push("title_he_missing");
  if (!d.title_en.trim()) out.push("title_en_missing");
  if (d.body_text.trim().length < MIN_TERMS_BODY_LENGTH) out.push("body_he_incomplete");
  if (d.body_text_en.trim().length < MIN_TERMS_BODY_LENGTH) out.push("body_en_incomplete");
  return out;
}

export function subscriptionTermsProblemKey(p: SubscriptionTermsProblem): string {
  return `subscriptionTermsAdmin.problem.${p}`;
}

export async function rpcGetSubscriptionTermsAdmin(supabase: SupabaseClient): Promise<SubscriptionTermsAdmin | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("get_subscription_terms_admin");
  if (error) throw error;
  return data as SubscriptionTermsAdmin | { ok: false; error: string };
}

type Outcome = { ok: true } & Record<string, unknown>;
type Failure = { ok: false; error: string } & Record<string, unknown>;

export async function rpcSaveSubscriptionTermsDraft(
  supabase: SupabaseClient,
  d: { title: string; title_en: string; body_text: string; body_text_en: string; based_on_version?: number | null }
): Promise<Outcome | Failure> {
  const { data, error } = await supabase.rpc("save_subscription_terms_draft", {
    p_title: d.title,
    p_title_en: d.title_en,
    p_body_text: d.body_text,
    p_body_text_en: d.body_text_en,
    p_based_on_version: d.based_on_version ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return data as Outcome | Failure;
}

export async function rpcCopySubscriptionTermsVersionToDraft(supabase: SupabaseClient, version: number): Promise<Outcome | Failure> {
  const { data, error } = await supabase.rpc("copy_subscription_terms_version_to_draft", { p_version: version });
  if (error) return { ok: false, error: error.message };
  return data as Outcome | Failure;
}

export async function rpcPublishSubscriptionTermsDraft(
  supabase: SupabaseClient,
  requiresReconsent: boolean,
  expectedUpdatedAt: string
): Promise<({ ok: true; version: number }) | (Failure & { problems?: SubscriptionTermsProblem[] })> {
  const { data, error } = await supabase.rpc("publish_subscription_terms_draft", {
    p_requires_reconsent: requiresReconsent,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: true; version: number } | (Failure & { problems?: SubscriptionTermsProblem[] });
}
