#!/usr/bin/env bash
# Regression test for 20261013100000_revoke_client_execute_on_subscription_internals.sql (SEC-1).
#
#   P  catalog: none of the 20 internals is executable by PUBLIC / anon / authenticated; postgres (owner, pg_cron) and
#      service_role (edge function) keep the billing job; every public entry point keeps EXECUTE for authenticated
#   D  denial over a real `authenticator` connection (safeupdate loaded, role + JWT claims, one transaction per call, exactly
#      like PostgREST): every callable internal is rejected with "permission denied" for anon AND for an authenticated
#      MANAGER, and the rejected calls write nothing
#   W  every legitimate workflow that relies on the internals (as definer) still works through the same API path:
#      create (engine + payee trigger), athlete register (reserve + registration trigger), cancel (cancellation trigger),
#      manager add manual participant (reserve + manual-participant trigger), edit / freeze / stop preview + confirm
#      (compute_impact, reconcile, engine), reactivate, delete (finance aggregator), the read RPCs, manager_weekly_stats
#      (finance aggregators; both overloads when present), the billing job as postgres (pg_cron) and as service_role
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/161_subscription_internals_execute_privileges_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users, sessions and subscriptions. Never run it against production.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
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
rpc() { api "$1" "select ($2)::text;" | grep '^{' | head -1; }
okjson() { case "$2" in *'"ok" : true'*|*'"ok": true'*) ok "$1";; *) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; esac; }

INTERNALS=(
  'public.subscription_generate_or_correct_billing_period(uuid, uuid, date, date, uuid, public.subscription_charge_type)'
  'public.generate_due_subscription_charges()'
  'public.invoke_generate_subscription_charges_edge()'
  'public.subscription_compute_impact(uuid, public.subscription_impact_action_type, date, date, date, date, numeric, date, boolean, jsonb)'
  'public.subscription_reconcile_week(uuid, date, public.subscription_tier)'
  'public.subscription_reserve_or_reject(uuid, boolean, uuid, boolean)'
  'public.subscription_billing_period_amount(uuid, date, date)'
  'public.subscription_billing_period_segments(uuid, date, date)'
  'public.subscription_effective_context(uuid, boolean, date, public.subscription_tier)'
  'public.subscription_effective_next_billing_date(uuid)'
  'public.subscription_effective_plan_end_date(uuid)'
  'public.subscription_effective_weekly_limit(uuid, boolean, public.subscription_tier, date)'
  'public.subscription_total_frozen_days(uuid, date)'
  'public.subscription_version_display_status(uuid, date)'
  'public._period_merged_athlete_finance(date, date)'
  'public._manager_weekly_stats_families_json(date, date)'
  'public._subscription_reconcile_after_cancellation_change()'
  'public._subscription_reconcile_after_manual_participant_change()'
  'public._subscription_reconcile_after_registration_change()'
  'public._validate_subscription_payee()'
)

echo "== P: catalog privileges"
for fn in "${INTERNALS[@]}"; do
  expect "P ${fn%%(*} closed to PUBLIC/anon/authenticated" "false false false" \
    "$(su -c "select has_function_privilege('public', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('anon', '$fn'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('authenticated', '$fn'::regprocedure, 'EXECUTE')")"
done
expect "P billing job keeps postgres (pg_cron) and service_role (edge function)" "true true" \
  "$(su -c "select has_function_privilege('postgres', 'public.generate_due_subscription_charges()'::regprocedure, 'EXECUTE') || ' ' || has_function_privilege('service_role', 'public.generate_due_subscription_charges()'::regprocedure, 'EXECUTE')")"
for fn in 'public.create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb)' 'public.edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean)' \
          'public.freeze_subscription(uuid, date, date, boolean)' 'public.stop_subscription(uuid, date, boolean)' 'public.reactivate_subscription(uuid, date, date)' \
          'public.delete_subscription(uuid)' 'public.get_my_subscription()' 'public.get_subscription_detail(uuid)' 'public.list_active_subscriptions()' \
          'public.list_subscription_history()' 'public.manager_weekly_stats(date, text)' 'public.register_for_session(uuid, boolean)' 'public.cancel_registration(uuid, text)' \
          'public.add_manual_participant_to_session(uuid, uuid, boolean, boolean)'; do
  expect "P entry point ${fn%%(*} still open to authenticated" "t" "$(su -c "select has_function_privilege('authenticated', '$fn'::regprocedure, 'EXECUTE')")"
done

# ---- fixtures: manager, coach, athlete, manual participant, a next-week session
n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()"); A2=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f161-$n-m@t.local', '056$n'), ('$C'::uuid, 'f161-$n-c@t.local', '057$n'),
               ('$A'::uuid, 'f161-$n-a@t.local', '058$n'), ('$A2'::uuid, 'f161-$n-b@t.local', '059$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A','$A2');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$C'" >/dev/null
MP=$(su -c "insert into public.manual_participants (full_name, phone) values ('mp161 $n', '050$n') returning id" | head -1)
SESS=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date - extract(dow from current_date)::int + 8, '10:00', '$C', 6, true) returning id" | head -1)
START=$(su -c "select current_date - 20")

echo "== W: legitimate workflows through the API path"
R=$(rpc "$M" "public.create_subscription('$A', false, 300, '$START', null, extract(day from date '$START')::smallint, (select jsonb_agg(jsonb_build_object('tier', t, 'weekly_limit', 2)) from unnest(enum_range(null::public.subscription_tier)) t))")
okjson "W manager create_subscription (engine + payee trigger as definer)" "$R"; SUB=$(jf "$R" subscription_id)
expect "W create billed the first period" "1" "$(su -c "select count(*) from public.subscription_charges where subscription_id='$SUB'")"
R=$(api "$A" "select public.register_for_session('$SESS')::text;" | grep '^{'); okjson "W athlete register_for_session (reserve_or_reject)" "$R"
expect "W registration got a coverage decision (registration trigger + reconcile)" "1" "$(su -c "select count(*) from public.subscription_registration_coverage c join public.session_registrations r on r.id = c.registration_id where r.session_id='$SESS' and r.user_id='$A'")"
R=$(api "$A" "select public.cancel_registration('$SESS', 'test')::text;" | grep '^{'); okjson "W athlete cancel_registration (cancellation trigger)" "$R"
R=$(rpc "$M" "public.add_manual_participant_to_session('$SESS', '$MP', false, false)"); okjson "W manager add_manual_participant_to_session (reserve + manual trigger)" "$R"
for op in "public.edit_subscription_version('$SUB', current_date, 320, null, false, null, false)" \
          "public.freeze_subscription('$SUB', current_date + 30, current_date + 33, false)" \
          "public.stop_subscription('$SUB', current_date + 60, false)"; do
  R=$(rpc "$M" "$op"); okjson "W manager ${op%%(*} (compute_impact, reconcile, engine as definer)" "$R"
done
R=$(rpc "$M" "public.get_subscription_detail('$SUB')"); okjson "W manager get_subscription_detail (effective_* helpers)" "$R"
R=$(api "$M" "select public.list_active_subscriptions()::text;"); case "$R" in *"permission denied"*|*ERROR*) fail "W list_active_subscriptions: $R";; *) ok "W manager list_active_subscriptions";; esac
R=$(api "$M" "select public.list_subscription_history()::text;"); case "$R" in *"permission denied"*|*ERROR*) fail "W list_subscription_history: $R";; *) ok "W manager list_subscription_history";; esac
R=$(api "$A" "select public.get_my_subscription()::text;"); case "$R" in *"permission denied"*|*ERROR*) fail "W get_my_subscription: $R";; *) ok "W athlete get_my_subscription";; esac
R=$(rpc "$M" "public.manager_weekly_stats(current_date, 'week')"); okjson "W manager_weekly_stats(date,text) (finance aggregators)" "$R"
if [ "$(su -c "select to_regprocedure('public.manager_weekly_stats(date)') is not null")" = "t" ]; then
  R=$(rpc "$M" "public.manager_weekly_stats(p_week_start => current_date)"); okjson "W manager_weekly_stats(date) wrapper" "$R"; fi
R=$(rpc "$M" "public.stop_subscription('$SUB', current_date + 60, true)"); okjson "W manager stop confirmed" "$R"
R=$(rpc "$M" "public.reactivate_subscription('$SUB', current_date + 61, null)"); okjson "W manager reactivate_subscription (engine as definer)" "$R"
SUB2=$(jf "$R" subscription_id)
R=$(rpc "$M" "public.delete_subscription('$SUB2')"); okjson "W manager delete_subscription (effective_context + finance aggregator)" "$R"
okjson "W billing job as postgres (the pg_cron identity)" "$(su -c "select public.generate_due_subscription_charges()::text")"
okjson "W billing job as service_role (the edge function)" "$(api_as service_role "" "select public.generate_due_subscription_charges()::text;" | grep '^{')"

echo "== D: direct calls are refused for anon and for a manager"
VER=$(su -c "select id from public.subscription_versions where subscription_id='$SUB' order by version_no desc limit 1")
L0=$(su -c "select count(*) || ':' || coalesce(sum(amount_ils), 0) from public.subscription_charges")
C0=$(su -c "select count(*) || ':' || md5(coalesce(string_agg(id::text || covered::text, ',' order by id), '')) from public.subscription_registration_coverage")
for call in \
  "public.subscription_generate_or_correct_billing_period('$SUB', '$VER', date '2031-01-10', date '2031-02-10', null, null)" \
  "public.generate_due_subscription_charges()" \
  "public.invoke_generate_subscription_charges_edge()" \
  "public.subscription_compute_impact('$SUB', 'stop', null, null, current_date)" \
  "public.subscription_reconcile_week('$SUB', current_date, 'group')" \
  "public.subscription_reserve_or_reject('$A', false, gen_random_uuid(), false)" \
  "public.subscription_billing_period_amount('$SUB', current_date, current_date + 30)" \
  "public.subscription_billing_period_segments('$SUB', current_date, current_date + 30)" \
  "public.subscription_effective_context('$A', false, current_date, 'group')" \
  "public.subscription_effective_next_billing_date('$SUB')" \
  "public.subscription_effective_plan_end_date('$SUB')" \
  "public.subscription_effective_weekly_limit('$A', false, 'group', current_date)" \
  "public.subscription_total_frozen_days('$SUB', null)" \
  "public.subscription_version_display_status('$VER', current_date)" \
  "public._period_merged_athlete_finance(current_date - 365, current_date)" \
  "public._manager_weekly_stats_families_json(current_date - 7, current_date)"; do
  for who in anon "authenticated:$M"; do r=${who%%:*}; u=""; [ "$r" = authenticated ] && u=${who#*:}
    out=$(api_as "$r" "$u" "select ($call)::text;")
    case "$out" in *"permission denied"*) ok "D ${call%%(*} denied to ${r/authenticated/manager}";; *) fail "D ${call%%(*} as $r: $(echo "$out" | head -1 | cut -c1-140)";; esac
  done
done
expect "D refused calls wrote no charges" "$L0" "$(su -c "select count(*) || ':' || coalesce(sum(amount_ils), 0) from public.subscription_charges")"
expect "D refused calls changed no coverage" "$C0" "$(su -c "select count(*) || ':' || md5(coalesce(string_agg(id::text || covered::text, ',' order by id), '')) from public.subscription_registration_coverage")"

echo
echo "161 subscription internals EXECUTE privileges: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
