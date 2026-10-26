#!/usr/bin/env bash
# Regression test for 20261023130000_guard_subscription_hard_delete.sql.
#
# Real `authenticator` connections. Fixture: manager M, athlete A with a real subscription (via create_subscription,
# so subscriptions / subscription_versions / subscription_version_allowances / subscription_billing_periods /
# subscription_charges are all populated exactly as production would produce them).
#   G  a direct hard DELETE (as manager, who passes RLS) is refused on every guarded table: subscriptions,
#      subscription_versions, subscription_freezes, subscription_billing_periods, subscription_charges,
#      subscription_impact_events
#   U  subscription_version_allowances is deliberately NOT guarded (edit_subscription_version depends on
#      deleting and reinserting it) -- a direct delete there still works
#   U2 (20261026160000 fix) subscription_registration_coverage and subscription_impact_event_registrations
#      are ALSO not guarded -- they are coverage/audit metadata with no money column, always designed (original
#      schema) to cascade away with their registration; the guard on them broke session deletion
#      (subscription_record_immutable) for any session with a subscription-covered participant. See
#      191_session_delete_subscription_coverage_cascade_tests.sh for the end-to-end session-delete regression.
#   P  the real, intended way to remove a subscription (delete_subscription, a tombstone) is completely
#      unaffected by this migration and still works
#   Z  existing subscription RPCs (freeze/stop/edit) are still fully functional (spot check: freeze_subscription
#      still applies normally; this migration touches no RPC body, only adds DELETE triggers on the tables)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/182_subscription_hard_delete_guard_tests.sh   (SCRATCH/LOCAL ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
refused() { case "$2" in *subscription_record_immutable*) ok "$1 (refused)";; *) fail "$1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
allowed() { case "$2" in *subscription_record_immutable*|*ERROR*) fail "$1: $(echo "$2" | head -1 | cut -c1-160)";; *) ok "$1";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f182-$n-m@t.local', '041$n'), ('$A'::uuid, 'f182-$n-a@t.local', '042$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A');
  update public.profiles set role='manager' where user_id='$M'" >/dev/null

echo "== setup: a real subscription with an immediate charge"
R=$(api "$M" "select public.create_subscription('$A', false, 350, current_date, null, null, '[]'::jsonb)::text;")
case "$R" in *'"ok" : true'*) ok "setup: create_subscription succeeded";; *) fail "setup create_subscription: $R"; echo "182 ABORTED: fixture failed"; exit 1;; esac
SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false order by created_at desc limit 1")
VER=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB' limit 1")
BP=$(su -c "select id from public.subscription_billing_periods where subscription_id = '$SUB' limit 1")
CHG=$(su -c "select id from public.subscription_charges where subscription_id = '$SUB' limit 1")
[ -n "$BP" ] && [ -n "$CHG" ] && ok "setup: an immediate billing period and charge were generated" || fail "setup: expected an immediate billing period/charge, got BP='$BP' CHG='$CHG'"

echo "== G: direct hard DELETE refused on every guarded table"
refused "G subscriptions"                            "$(api "$M" "delete from public.subscriptions where id = '$SUB'; select 1;")"
refused "G subscription_versions"                     "$(api "$M" "delete from public.subscription_versions where id = '$VER'; select 1;")"
[ -n "$BP" ]  && refused "G subscription_billing_periods" "$(api "$M" "delete from public.subscription_billing_periods where id = '$BP'; select 1;")"
[ -n "$CHG" ] && refused "G subscription_charges"         "$(api "$M" "delete from public.subscription_charges where id = '$CHG'; select 1;")"

FRZ=$(su -c "insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until) values ('$SUB', current_date + 30, current_date + 36) returning id" | head -1)
refused "G subscription_freezes" "$(api "$M" "delete from public.subscription_freezes where id = '$FRZ'; select 1;")"

REGX=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ((select id from public.training_sessions limit 1), '$A', 'active') returning id" 2>&1 | head -1)
if [ -z "$REGX" ] || [[ "$REGX" != *-*-*-*-* ]]; then
  # no training_sessions row exists yet in this fresh database; create a throwaway one
  CX=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('$CX','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f182-$n-cx@t.local', jsonb_build_object('full_name','cx','phone','043$n','gender','female','address','A','zip_code','1'), now(), now()); update public.profiles set role='coach', approval_status='approved' where user_id='$CX'" >/dev/null
  SX=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 20, '06:00', '$CX', 6, true) returning id" | head -1)
  REGX=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$SX', '$A', 'active') returning id" | head -1)
fi
EVT=$(su -c "insert into public.subscription_impact_events (subscription_id, action_type, action_source_id, effective_date, confirmed) values ('$SUB', 'freeze', gen_random_uuid(), current_date, true) returning id" | head -1)
refused "G subscription_impact_events" "$(api "$M" "delete from public.subscription_impact_events where id = '$EVT'; select 1;")"

echo "== U2: subscription_registration_coverage and subscription_impact_event_registrations stay deletable (20261026160000 fix -- no money column, always cascade-on-registration-delete by original schema design)"
COV=$(su -c "insert into public.subscription_registration_coverage (subscription_id, version_id, registration_id, session_date, week_start, tier, covered, non_coverage_reason, decided_by) values ('$SUB', '$VER', '$REGX', current_date, current_date, 'personal', false, 'frozen', 'reconcile') returning id" 2>&1 | head -1)
case "$COV" in *-*-*-*-*) allowed "U2 direct delete of a subscription_registration_coverage row" "$(api "$M" "delete from public.subscription_registration_coverage where id = '$COV'; select 1;")";; *) fail "U2 coverage fixture insert failed: $COV";; esac

EVTREG=$(su -c "insert into public.subscription_impact_event_registrations (event_id, registration_id, previous_covered, new_covered) values ('$EVT', '$REGX', true, false) returning id" 2>&1 | head -1)
case "$EVTREG" in *-*-*-*-*) allowed "U2 direct delete of a subscription_impact_event_registrations row" "$(api "$M" "delete from public.subscription_impact_event_registrations where id = '$EVTREG'; select 1;")";; *) fail "U2 impact_event_registrations fixture insert failed: $EVTREG";; esac

echo "== U: subscription_version_allowances stays deletable (edit_subscription_version depends on this)"
su -c "insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values ('$VER', 'pair', 2) on conflict do nothing" >/dev/null
allowed "U direct delete of a subscription_version_allowances row" "$(api "$M" "delete from public.subscription_version_allowances where version_id = '$VER' and tier = 'pair'; select 1;")"

echo "== P: the real deletion path (delete_subscription, a tombstone) is unaffected"
R=$(api "$M" "select public.delete_subscription('$SUB')::text;")
case "$R" in *'"ok" : true'*) ok "P delete_subscription still works";; *) fail "P delete_subscription: $R";; esac
DELETED_AT=$(su -c "select (deleted_at is not null)::text from public.subscriptions where id = '$SUB'")
[ "$DELETED_AT" = "true" ] && ok "P subscription row is tombstoned, not removed" || fail "P deleted_at was not set"
[ -n "$CHG" ] && { N=$(su -c "select count(*) from public.subscription_charges where id = '$CHG'"); [ "$N" = "1" ] && ok "P the charge still exists after tombstoning" || fail "P the charge disappeared"; }

echo "== Z: existing subscription RPCs remain functional (spot check: a fresh subscription can still be frozen)"
R=$(api "$M" "select public.create_subscription('$A', false, 350, current_date + 60, null, null, '[]'::jsonb)::text;")
case "$R" in *'"ok" : true'*) ok "Z a fresh subscription can still be created";; *) fail "Z create_subscription: $R";; esac
SUB2=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false and deleted_at is null order by created_at desc limit 1")
R=$(api "$M" "select public.freeze_subscription('$SUB2', current_date + 65, current_date + 70, true)::text;")
case "$R" in *'"ok" : true'*) ok "Z freeze_subscription still applies normally";; *) fail "Z freeze_subscription: $R";; esac

echo
echo "182 subscription hard-delete guard: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
