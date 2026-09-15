-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 1b).
-- Additive schema only: bilingual legal-document columns, a manager-controlled rollout
-- toggle, and operational/marketing classification on the two send paths that can carry
-- promotional content. No existing rows are touched, no destructive changes.

-- legal_documents: full body text lives in the app's static legal pages; body_text /
-- body_text_en here hold the SHORT acknowledgment/consent statement shown in the
-- in-app gate (same pattern already used for electronic_receipts). English columns are
-- nullable so the existing electronic_receipts row (Hebrew-only) is unaffected.
alter table public.legal_documents
  add column if not exists title_en text,
  add column if not exists body_text_en text;

-- Manager-controlled rollout switch. Defaults to false: publishing terms_of_service /
-- privacy_policy legal_documents rows does NOT, by itself, gate anyone. A manager must
-- explicitly flip this on after reviewing the documents and testing the flow.
alter table public.app_settings
  add column if not exists legal_consent_gate_enabled boolean not null default false;

-- Manager direct messages (in-app inbox) and WhatsApp notification_deliveries can both
-- carry promotional content depending on what a manager types. Classify explicitly;
-- existing rows and all system-generated sends (reminders, waitlist, birthday, etc.)
-- default to 'operational' so nothing already flowing is reinterpreted as marketing.
alter table public.manager_direct_messages
  add column if not exists category public.communication_category not null default 'operational';

alter table public.notification_deliveries
  add column if not exists category public.communication_category not null default 'operational';

comment on column public.manager_direct_messages.category is
  'operational: required to run the studio (no marketing consent needed). marketing: promotional/commercial — only sent to recipients with accepted marketing_communications consent.';
comment on column public.notification_deliveries.category is
  'Same classification as manager_direct_messages.category, applied to WhatsApp sends.';

-- Helper: does this user currently have an accepted, current-version marketing consent?
create or replace function public.has_current_marketing_consent(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_consents uc
    where uc.user_id = p_user_id
      and uc.consent_type = 'marketing_communications'
      and uc.status = 'accepted'
      and uc.consent_version = (
        select coalesce(max(ld.version), 0)
        from public.legal_documents ld
        where ld.consent_type = 'marketing_communications' and ld.is_current
      )
  );
$$;

-- service_role only: called directly by the dispatch-notifications Edge Function. Other
-- SECURITY DEFINER RPCs in this codebase (get_marketing_consent_status,
-- send_manager_direct_message, send_custom_push_notification) call this internally too,
-- but a Postgres function calling another function runs with the OUTER function's
-- privileges, not the original caller's grants — so `authenticated` does not need direct
-- execute here, and granting it would let any signed-in user query any other user's
-- marketing-consent status by user_id, which is not something they need direct access to.
grant execute on function public.has_current_marketing_consent(uuid) to service_role;
