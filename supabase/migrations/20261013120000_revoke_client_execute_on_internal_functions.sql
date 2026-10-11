-- Security (SEC-2): revoke client EXECUTE on internal SECURITY DEFINER functions outside the subscription engine, and
-- require staff for log_document_event.
--
-- Same defect class as SEC-1 (20261013100000) and 20261005160000: these functions are SECURITY DEFINER (owner postgres,
-- search_path pinned) and perform NO caller authorization -- authorization lives in the manager/staff entry points that
-- call them, in the pg_cron jobs and in the edge functions (service_role). Supabase's default privileges nevertheless left
-- EXECUTE granted to PUBLIC, anon and authenticated, so anyone holding the public anon key could call them through the
-- REST API (/rpc/...). Audited from the production catalog (read-only) and reproduced on an isolated copy, impact by group:
--   documents / receipts / payments: delete any account payment or wipe recorded session payments
--       (_revert_document_payment), create an official tax receipt from any payment row (_create_document_from_payment_row),
--       burn legal receipt numbers (_allocate_document_number), overwrite a receipt's PDF and signature fields
--       (finalize_document_pdf), falsify delivery records (record_document_email_sent), rewrite customer billing details
--       (_upsert_customer_from_payee), forge document audit events (_log_document_event);
--   personal data and legal consent: read any user's email (_auth_user_email / _resolve_customer_email), read consent and
--       WhatsApp-eligibility and disabled status of any user, record legal (electronic-receipts) consent for any user
--       (_insert_electronic_receipts_consent_audit), re-run signup profile/consent syncs for any user;
--   messaging, edge triggers, jobs, maintenance: queue WhatsApp messages to any user with any payload
--       (enqueue_whatsapp_notification), send a paid "registration open" WhatsApp blast to every athlete for any week
--       (enqueue_weekly_registration_open_whatsapp), fire the notification / waitlist / weekly-open edge functions, re-create
--       cron schedules, run the session-opening and duplicate-session cleanup (which deletes sessions) jobs, add skip dates to
--       any recurring series, forge activity-log events (which the manager "revert" feature acts on);
--   internal read helpers with no client caller in the app's whole history.
--
-- Callers (audited against the production catalog): only SECURITY DEFINER functions owned by postgres (entry points, the
-- auth.users signup triggers, the activity / waitlist triggers), pg_cron jobs running as postgres, and edge functions using
-- the service-role key (finalize_document_pdf, record_document_email_sent, has_current_marketing_consent,
-- open_next_week_sessions_if_due_core). No RLS policy (including storage), view, invoker-rights function, auth hook or
-- non-postgres definer references them, and neither the current app (main, Phase 5) nor any earlier app version calls them.
-- service_role and the owner keep EXECUTE.
--
-- Deliberately NOT revoked (documented in the SEC-2 audit): is_manager / is_coach / is_coach_or_manager / is_super_user and
-- is_registration_hidden* (used by RLS and storage policies, which run as the caller); public-by-design readers
-- (get_public_business_info, get_registration_opening_schedule, get_current_electronic_receipts_consent_version); price
-- lookups the app calls; active_registration_count(s) (called directly by earlier app versions); wrappers that are guarded
-- downstream (manager_weekly_stats, staff_update_profile_text).

-- Documents / receipts / payments
revoke execute on function public._allocate_document_number() from public, anon, authenticated;
revoke execute on function public._revert_document_payment(public.document_source_type,uuid) from public, anon, authenticated;
revoke execute on function public.finalize_document_pdf(uuid,text,text,text,boolean) from public, anon, authenticated;
revoke execute on function public.record_document_email_sent(uuid,text,text) from public, anon, authenticated;
revoke execute on function public._upsert_customer_from_payee(text,text,text,uuid,uuid,text,text) from public, anon, authenticated;
revoke execute on function public._upsert_customer_from_payee(text,text,text,uuid,uuid) from public, anon, authenticated;
revoke execute on function public._create_document_from_payment_row(text) from public, anon, authenticated;
revoke execute on function public._log_document_event(uuid,public.document_event_action,jsonb) from public, anon, authenticated;

-- Personal data and legal consent
revoke execute on function public._auth_user_email(uuid) from public, anon, authenticated;
revoke execute on function public._resolve_customer_email(uuid,text) from public, anon, authenticated;
revoke execute on function public.has_current_marketing_consent(uuid) from public, anon, authenticated;
revoke execute on function public._whatsapp_user_can_receive(uuid) from public, anon, authenticated;
revoke execute on function public._whatsapp_user_can_see_settings(uuid) from public, anon, authenticated;
revoke execute on function public._whatsapp_user_in_test_list(uuid) from public, anon, authenticated;
revoke execute on function public._apply_signup_profile_from_metadata(uuid) from public, anon, authenticated;
revoke execute on function public._try_sync_signup_consent_for_user(uuid) from public, anon, authenticated;
revoke execute on function public._try_sync_signup_legal_consents_for_user(uuid) from public, anon, authenticated;
revoke execute on function public._insert_electronic_receipts_consent_audit(uuid,integer,text) from public, anon, authenticated;
revoke execute on function public.athlete_disabled_on_date(uuid,date) from public, anon, authenticated;
revoke execute on function public.manual_participant_disabled_on_date(uuid,date) from public, anon, authenticated;

-- Messaging, edge-function triggers, scheduled jobs and admin maintenance
revoke execute on function public.enqueue_whatsapp_notification(uuid,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.enqueue_weekly_registration_open_whatsapp(date,date) from public, anon, authenticated;
revoke execute on function public.enqueue_due_session_reminder_whatsapp() from public, anon, authenticated;
revoke execute on function public.maybe_enqueue_whatsapp_waitlist(uuid) from public, anon, authenticated;
revoke execute on function public.invoke_dispatch_notifications_edge() from public, anon, authenticated;
revoke execute on function public.invoke_notify_waitlist_edge(uuid) from public, anon, authenticated;
revoke execute on function public.invoke_open_weekly_registrations_edge() from public, anon, authenticated;
revoke execute on function public.open_next_week_sessions_if_due_core() from public, anon, authenticated;
revoke execute on function public.reschedule_open_weekly_registrations_cron() from public, anon, authenticated;
revoke execute on function public.schedule_birthday_message_cron() from public, anon, authenticated;
revoke execute on function public.schedule_whatsapp_notification_crons() from public, anon, authenticated;
revoke execute on function public._reconcile_slot_duplicate_sessions() from public, anon, authenticated;
revoke execute on function public._series_add_skip_date(uuid,date) from public, anon, authenticated;
revoke execute on function public._insert_activity_event(uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public._birthday_message_sender_id() from public, anon, authenticated;
revoke execute on function public._whatsapp_rollout_mode() from public, anon, authenticated;

-- Internal read helpers (no client caller, ever)
revoke execute on function public._manager_stats_period_bounds(date,text) from public, anon, authenticated;
revoke execute on function public._session_roster_size(uuid) from public, anon, authenticated;
revoke execute on function public._session_is_slot_roster_ghost(uuid) from public, anon, authenticated;
revoke execute on function public._is_capacity_mismatch_ignored(uuid) from public, anon, authenticated;

-- log_document_event is the client entry point for document audit events ("document_viewed" from the staff documents and
-- participant-history screens, both coach/manager routes). It only required a signed-in user, so any athlete could append
-- audit events to any document. Require staff, like documents' own RLS (is_coach_or_manager). Body otherwise unchanged.
create or replace function public.log_document_event(p_document_id uuid, p_action public.document_event_action, p_metadata jsonb default '{}'::jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  perform public._log_document_event(p_document_id, p_action, p_metadata);
  return json_build_object('ok', true);
end; $function$;

-- Self-check: every internal closed to clients, server-side callers intact, client entry points still open.
do $$
declare
  v_fn text;
  v_role text;
begin
  foreach v_fn in array array[
    'public._allocate_document_number()',
    'public._apply_signup_profile_from_metadata(uuid)',
    'public._auth_user_email(uuid)',
    'public._birthday_message_sender_id()',
    'public._create_document_from_payment_row(text)',
    'public._insert_activity_event(uuid,text,text,text,jsonb)',
    'public._insert_electronic_receipts_consent_audit(uuid,integer,text)',
    'public._is_capacity_mismatch_ignored(uuid)',
    'public._log_document_event(uuid,public.document_event_action,jsonb)',
    'public._manager_stats_period_bounds(date,text)',
    'public._reconcile_slot_duplicate_sessions()',
    'public._resolve_customer_email(uuid,text)',
    'public._revert_document_payment(public.document_source_type,uuid)',
    'public._series_add_skip_date(uuid,date)',
    'public._session_is_slot_roster_ghost(uuid)',
    'public._session_roster_size(uuid)',
    'public._try_sync_signup_consent_for_user(uuid)',
    'public._try_sync_signup_legal_consents_for_user(uuid)',
    'public._upsert_customer_from_payee(text,text,text,uuid,uuid,text,text)',
    'public._upsert_customer_from_payee(text,text,text,uuid,uuid)',
    'public._whatsapp_rollout_mode()',
    'public._whatsapp_user_can_receive(uuid)',
    'public._whatsapp_user_can_see_settings(uuid)',
    'public._whatsapp_user_in_test_list(uuid)',
    'public.athlete_disabled_on_date(uuid,date)',
    'public.enqueue_due_session_reminder_whatsapp()',
    'public.enqueue_weekly_registration_open_whatsapp(date,date)',
    'public.enqueue_whatsapp_notification(uuid,text,text,jsonb)',
    'public.finalize_document_pdf(uuid,text,text,text,boolean)',
    'public.has_current_marketing_consent(uuid)',
    'public.invoke_dispatch_notifications_edge()',
    'public.invoke_notify_waitlist_edge(uuid)',
    'public.invoke_open_weekly_registrations_edge()',
    'public.manual_participant_disabled_on_date(uuid,date)',
    'public.maybe_enqueue_whatsapp_waitlist(uuid)',
    'public.open_next_week_sessions_if_due_core()',
    'public.record_document_email_sent(uuid,text,text)',
    'public.reschedule_open_weekly_registrations_cron()',
    'public.schedule_birthday_message_cron()',
    'public.schedule_whatsapp_notification_crons()'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') then
        raise exception 'self-check: % is still executable by %', v_fn, v_role;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE')
       or not has_function_privilege('postgres', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: % lost its server-side callers', v_fn;
    end if;
  end loop;

  foreach v_fn in array array[
    'public.is_manager(uuid)', 'public.is_coach_or_manager(uuid)', 'public.is_registration_hidden(uuid, uuid)',
    'public.get_public_business_info()', 'public.get_registration_opening_schedule()',
    'public.get_current_electronic_receipts_consent_version()', 'public.active_registration_counts(uuid[])',
    'public.log_document_event(uuid, public.document_event_action, jsonb)', 'public.record_user_consent(public.legal_consent_type, public.consent_status, integer, text, text)',
    'public.sync_signup_profile_from_metadata()', 'public.sync_signup_legal_consents()', 'public.sync_signup_electronic_receipts_consent()',
    'public.open_next_week_sessions_if_due()', 'public.create_documents_from_payments(jsonb)', 'public.cancel_document(uuid, text, boolean)'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'self-check: expected entry point % does not exist', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: client entry point % lost EXECUTE for authenticated', v_fn;
    end if;
  end loop;
end $$;
