#!/usr/bin/env bash
# Regression test for 20261013120000_revoke_client_execute_on_internal_functions.sql (SEC-2).
#
#   P  catalog: the 40 internals are closed to PUBLIC / anon / authenticated and keep postgres + service_role; the client
#      entry points and the RLS / storage helper functions stay open
#   D  denial over a real `authenticator` connection (safeupdate loaded, role + JWT claims, one transaction per call, like
#      PostgREST): every internal is rejected with "permission denied" for anon, an athlete AND a manager, and nothing in the
#      affected tables (payments, documents, customers, consents, notifications, activity log, sessions, series, cron) changes
#   L  log_document_event: staff (manager, coach) succeed, an athlete is refused
#   W  every legitimate path that relies on the internals still works through the same API path: receipt create (number
#      allocation, customer upsert, email resolution) and cancel with payment revert; the edge-function calls as service_role
#      (finalize_document_pdf, record_document_email_sent, has_current_marketing_consent, open_next_week_sessions_if_due_core);
#      signup as supabase_auth_admin (auth.users triggers); the signup sync RPCs; WhatsApp feature state; register / cancel
#      (activity + waitlist triggers); weekly stats; and every pg_cron job command as postgres
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_ADMIN="docker exec -i <db> psql -U supabase_admin" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/162_internal_functions_execute_privileges_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users, documents and payments. Never run it against production.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
PSQL_ADMIN=${PSQL_ADMIN:?set PSQL_ADMIN}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
noerr() { case "$2" in *"permission denied"*|*ERROR*) fail "$1: $(echo "$2" | grep -m1 -E 'ERROR|denied' | cut -c1-160)";; *) ok "$1";; esac; }
okjson() { case "$2" in *'"ok" : true'*|*'"ok": true'*|*'"ok":true'*) ok "$1";; *) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; esac; }

INTERNALS=(
  'public._allocate_document_number()' 'public._revert_document_payment(public.document_source_type, uuid)'
  'public.finalize_document_pdf(uuid, text, text, text, boolean)' 'public.record_document_email_sent(uuid, text, text)'
  'public._upsert_customer_from_payee(text, text, text, uuid, uuid, text, text)' 'public._upsert_customer_from_payee(text, text, text, uuid, uuid)'
  'public._create_document_from_payment_row(text)' 'public._log_document_event(uuid, public.document_event_action, jsonb)'
  'public._auth_user_email(uuid)' 'public._resolve_customer_email(uuid, text)' 'public.has_current_marketing_consent(uuid)'
  'public._whatsapp_user_can_receive(uuid)' 'public._whatsapp_user_can_see_settings(uuid)' 'public._whatsapp_user_in_test_list(uuid)'
  'public._apply_signup_profile_from_metadata(uuid)' 'public._try_sync_signup_consent_for_user(uuid)'
  'public._try_sync_signup_legal_consents_for_user(uuid)' 'public._insert_electronic_receipts_consent_audit(uuid, integer, text)'
  'public.athlete_disabled_on_date(uuid, date)' 'public.manual_participant_disabled_on_date(uuid, date)'
  'public.enqueue_whatsapp_notification(uuid, text, text, jsonb)' 'public.enqueue_weekly_registration_open_whatsapp(date, date)'
  'public.enqueue_due_session_reminder_whatsapp()' 'public.maybe_enqueue_whatsapp_waitlist(uuid)'
  'public.invoke_dispatch_notifications_edge()' 'public.invoke_notify_waitlist_edge(uuid)' 'public.invoke_open_weekly_registrations_edge()'
  'public.open_next_week_sessions_if_due_core()' 'public.reschedule_open_weekly_registrations_cron()' 'public.schedule_birthday_message_cron()'
  'public.schedule_whatsapp_notification_crons()' 'public._reconcile_slot_duplicate_sessions()' 'public._series_add_skip_date(uuid, date)'
  'public._insert_activity_event(uuid, text, text, text, jsonb)' 'public._birthday_message_sender_id()' 'public._whatsapp_rollout_mode()'
  'public._manager_stats_period_bounds(date, text)' 'public._session_roster_size(uuid)' 'public._session_is_slot_roster_ghost(uuid)'
  'public._is_capacity_mismatch_ignored(uuid)'
)

echo "== P: catalog"
expect "P 40 internals listed" "40" "${#INTERNALS[@]}"
for fn in "${INTERNALS[@]}"; do
  expect "P ${fn%%(*}" "false false false true true" "$(su -c "select has_function_privilege('public', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('anon', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('authenticated', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('service_role', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('postgres', '$fn'::regprocedure, 'EXECUTE')")"
done
for fn in 'public.is_manager(uuid)' 'public.is_coach_or_manager(uuid)' 'public.is_registration_hidden(uuid, uuid)' 'public.get_public_business_info()' \
          'public.get_registration_opening_schedule()' 'public.active_registration_counts(uuid[])' 'public.log_document_event(uuid, public.document_event_action, jsonb)' \
          'public.create_document(numeric, public.document_service_type, text, text, text, public.document_payment_method, text, text, uuid, uuid, public.document_source_type, uuid, text)' \
          'public.cancel_document(uuid, text, boolean)' 'public.sync_signup_profile_from_metadata()' 'public.open_next_week_sessions_if_due()'; do
  expect "P client entry / policy helper ${fn%%(*} open to authenticated" "t" "$(su -c "select has_function_privilege('authenticated', '$fn'::regprocedure, 'EXECUTE')")"
done

# ---- fixtures
n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at, email_confirmed_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now(), now()
  from (values ('$M'::uuid, 'f162-$n-m@t.local', '061$n'), ('$C'::uuid, 'f162-$n-c@t.local', '062$n'), ('$A'::uuid, 'f162-$n-a@t.local', '063$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
SESS=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date - extract(dow from current_date)::int + 9, '11:00', '$C', 1, true) returning id" | head -1)
SERIES=$(su -c "select id from public.session_series limit 1")
FP_SQL="select md5(concat_ws('#',
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.athlete_account_payments x),
  (select md5(coalesce(string_agg(id::text || amount_paid::text || coalesce(payment_method, ''), '|' order by id), '')) from public.session_registrations),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.documents x),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.document_events x),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.customers x),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.receipt_settings x),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.user_consents x),
  (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.notification_deliveries x),
  (select count(*)::text from public.user_activity_events),
  (select md5(coalesce(string_agg(id::text, '|' order by id), '')) from public.training_sessions),
  (select md5(coalesce(string_agg(id::text || coalesce(skip_dates::text, ''), '|' order by id), '')) from public.session_series),
  (select md5(coalesce(string_agg(jobname || schedule || active::text, '|' order by jobname), '')) from cron.job),
  (select md5(coalesce(string_agg(user_id::text || coalesce(address, '') || coalesce(electronic_receipts_consent_version::text, ''), '|' order by user_id), '')) from public.profiles)))"

echo "== D: direct calls refused for anon, an athlete and a manager; nothing written"
FP0=$(su -c "$FP_SQL")
CALLS=(
  "public._allocate_document_number()" "public._revert_document_payment('account_payment', gen_random_uuid())"
  "public.finalize_document_pdf(gen_random_uuid(), 'x', null, null, true)" "public.record_document_email_sent(gen_random_uuid(), 'a@b.c', 'sent')"
  "public._upsert_customer_from_payee('x', null, null, '$A', null, null, null)" "public._upsert_customer_from_payee('x'::text, null::text, null::text, '$A'::uuid, null::uuid)"
  "public._create_document_from_payment_row('x')" "public._log_document_event(gen_random_uuid(), 'document_viewed', '{}')"
  "public._auth_user_email('$A')" "public._resolve_customer_email('$A', null)" "public.has_current_marketing_consent('$A')"
  "public._whatsapp_user_can_receive('$A')" "public._whatsapp_user_can_see_settings('$A')" "public._whatsapp_user_in_test_list('$A')"
  "public._apply_signup_profile_from_metadata('$A')" "public._try_sync_signup_consent_for_user('$A')" "public._try_sync_signup_legal_consents_for_user('$A')"
  "public._insert_electronic_receipts_consent_audit('$A', 99, 'x')" "public.athlete_disabled_on_date('$A', current_date)"
  "public.manual_participant_disabled_on_date(gen_random_uuid(), current_date)" "public.enqueue_whatsapp_notification('$A', 'x', 'k$n', '{}')"
  "public.enqueue_weekly_registration_open_whatsapp(date '2031-01-05', date '2031-01-11')" "public.enqueue_due_session_reminder_whatsapp()"
  "public.maybe_enqueue_whatsapp_waitlist('$SESS')" "public.invoke_dispatch_notifications_edge()" "public.invoke_notify_waitlist_edge('$SESS')"
  "public.invoke_open_weekly_registrations_edge()" "public.open_next_week_sessions_if_due_core()" "public.reschedule_open_weekly_registrations_cron()"
  "public.schedule_birthday_message_cron()" "public.schedule_whatsapp_notification_crons()" "public._reconcile_slot_duplicate_sessions()"
  "public._series_add_skip_date(coalesce(nullif('$SERIES','')::uuid, gen_random_uuid()), date '2031-01-01')"
  "public._insert_activity_event('$A', 'x', 'y', 'z', '{}')" "public._birthday_message_sender_id()" "public._whatsapp_rollout_mode()"
  "public._manager_stats_period_bounds(current_date, 'week')" "public._session_roster_size('$SESS')" "public._session_is_slot_roster_ghost('$SESS')"
  "public._is_capacity_mismatch_ignored('$SESS')"
)
expect "D 40 calls listed" "40" "${#CALLS[@]}"
for call in "${CALLS[@]}"; do
  for who in "anon:" "authenticated:$A" "authenticated:$M"; do r=${who%%:*}; u=${who#*:}
    out=$(api_as "$r" "$u" "select ($call)::text;")
    label=$r; [ "$u" = "$A" ] && label=athlete; [ "$u" = "$M" ] && label=manager
    case "$out" in *"permission denied"*) ok "D ${call%%(*} denied to $label";;
      *"is not unique"*) [[ "$call" == *"::uuid, null::uuid)" ]] && ok "D ${call%%(*} 5-arg overload unreachable (ambiguous) for $label" || fail "D ${call%%(*} ambiguous";; *) fail "D ${call%%(*} as $label: $(echo "$out" | head -1 | cut -c1-120)";; esac
  done
done
expect "D refused calls changed nothing (payments, documents, customers, consents, notifications, activity, sessions, series, cron, profiles)" "$FP0" "$(su -c "$FP_SQL")"

echo "== W: legitimate paths"
R=$(api "$M" "select public.create_document(120, 'other', 'Customer 162', null, null, 'cash', 'svc', null, '$A', null, 'manual', null, null)::text;")
okjson "W manager create_document (number allocation, customer upsert, email resolution)" "$R"; DOC=$(jf "$(echo "$R" | grep '^{')" document_id)
PAY=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 80, 'cash', current_date, '$M') returning id" | head -1)
R=$(api "$M" "select public.create_document(80, 'other', 'Customer 162', null, null, 'cash', 'svc', null, '$A', null, 'account_payment', '$PAY', 'cash')::text;")
okjson "W manager create_document from an account payment" "$R"; DOC2=$(jf "$(echo "$R" | grep '^{')" document_id)
R=$(api "$M" "select public.cancel_document('$DOC2', 'test 162', true)::text;"); okjson "W manager cancel_document with payment revert (_revert_document_payment as definer)" "$R"
# Updated 2026-10-21 (20261023150000_account_payment_reversal_status.sql): _revert_document_payment's
# account_payment branch now marks the row reversed_at/reversed_by instead of deleting it (row preserved,
# auditable, excluded from collected totals) -- it is no longer expected to disappear.
expect "W the linked payment was reverted by the manager flow (preserved, marked reversed)" "1:true" "$(su -c "select count(*)::text || ':' || (bool_or(reversed_at is not null))::text from public.athlete_account_payments where id='$PAY'")"
R=$(api "$M" "select public.log_document_event('$DOC', 'document_viewed', '{}')::text;"); okjson "L manager log_document_event" "$R"
R=$(api "$C" "select public.log_document_event('$DOC', 'document_viewed', '{}')::text;"); okjson "L coach log_document_event" "$R"
E0=$(su -c "select count(*) from public.document_events where document_id='$DOC'")
R=$(api "$A" "select public.log_document_event('$DOC', 'document_viewed', '{}')::text;")
case "$R" in *forbidden*) ok "L athlete log_document_event refused (forbidden)";; *) fail "L athlete log_document_event: $R";; esac
expect "L athlete call wrote no event" "$E0" "$(su -c "select count(*) from public.document_events where document_id='$DOC'")"
noerr "W edge (service_role) finalize_document_pdf" "$(api_as service_role "" "select public.finalize_document_pdf('$DOC', 'documents/t162.pdf', null, null, true)::text;")"
noerr "W edge (service_role) record_document_email_sent" "$(api_as service_role "" "select public.record_document_email_sent('$DOC', 'a@t.local', 'sent')::text;")"
noerr "W edge (service_role) has_current_marketing_consent" "$(api_as service_role "" "select public.has_current_marketing_consent('$A')::text;")"
noerr "W edge (service_role) open_next_week_sessions_if_due_core" "$(api_as service_role "" "select public.open_next_week_sessions_if_due_core()::text;")"
NU=$(su -c "select gen_random_uuid()")
out=$($PSQL_ADMIN -qAt -v ON_ERROR_STOP=1 -c "set role supabase_auth_admin; insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$NU', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f162-$n-new@t.local',
  jsonb_build_object('full_name','New 162','phone','064$n','gender','female','address','Street 1','zip_code','12345','health_declaration_confirmed', true), now(), now());" 2>&1)
noerr "W signup as supabase_auth_admin (handle_new_user + signup-consent triggers)" "$out"
expect "W signup created the profile with metadata" "Street 1" "$(su -c "select address from public.profiles where user_id='$NU'")"
for f in sync_signup_profile_from_metadata sync_signup_legal_consents sync_signup_electronic_receipts_consent get_whatsapp_feature_state open_next_week_sessions_if_due; do
  noerr "W athlete $f" "$(api "$A" "select public.$f()::text;")"
done
noerr "W athlete register_for_session (activity trigger)" "$(api "$A" "select public.register_for_session('$SESS')::text;")"
noerr "W athlete cancel_registration (activity + waitlist triggers)" "$(api "$A" "select public.cancel_registration('$SESS', 'test')::text;")"
noerr "W manager_weekly_stats (_manager_stats_period_bounds)" "$(api "$M" "select public.manager_weekly_stats(current_date, 'week')::text;")"
noerr "W manager_capacity_mismatch (_is_capacity_mismatch_ignored)" "$(api "$M" "select count(*) from public.manager_capacity_mismatch(current_date, 'week', false);")"
for cmd in $(su -c "select replace(command, ' ', '~') from cron.job order by jobname"); do c=${cmd//\~/ }
  noerr "W cron as postgres: $c" "$(su -c "$c" 2>&1)"
done

echo
echo "162 internal functions EXECUTE privileges: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
