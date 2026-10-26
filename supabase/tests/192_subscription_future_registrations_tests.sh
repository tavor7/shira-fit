#!/usr/bin/env bash
# Regression suite for 20261026180000 (stop/delete subscription future-registrations resolution).
#
# When a manager stops or deletes a subscription, any registration for a session scheduled on/after
# the termination date must be resolved: either 'remove' (take the athlete off the session) or
# 'charge_regular_price' (keep the registration, stop treating it as subscription-covered, let the
# existing per-session billing path charge it normally once attended -- no immediate charge).
#
# Drives the REAL stop_subscription_with_future_registrations / delete_subscription_with_future_
# registrations RPCs -- new, separately-named entry points added alongside the original
# stop_subscription(uuid,date,boolean) / delete_subscription(uuid), which this migration leaves
# completely untouched (no DROP FUNCTION, no overload ambiguity, no risk to any existing caller still
# using the old names) -- over an `authenticator` connection as `authenticated` with JWT claims,
# exactly like PostgREST -- same harness as 159/182/190/191.
#
# Scenarios
#   A  stop with ZERO future registrations behaves exactly as before (no preview forced, applies
#      immediately, no future_registration_action needed)
#   B  stop with a future registration previews it, blocks confirm without an action, then 'remove'
#      cancels the registration and removes its coverage row -- the session/registration themselves
#      are never deleted, only cancelled
#   C  stop with a future registration, 'charge_regular_price' choice: coverage flips to
#      covered=false/non_coverage_reason=subscription_ended, the registration stays 'active', and
#      NO charge is created immediately (ledger fingerprint unchanged by the resolution step itself)
#   D  a PAST (session_date before the stop date) registration is never touched by either choice --
#      its coverage row, attended flag and any charge stay byte-identical
#   E  delete_subscription: same preview/confirm/choice behavior as stop, cutoff = today
#   F  idempotency: retrying the exact same confirmed stop (same action) converges to already_applied
#      and resolves nothing a second time; a DIFFERENT action for the same stop_date is a distinct
#      operation (not swallowed as a retry)
#   G  manual participants: 'remove' deletes the session_manual_participants row (and its coverage
#      row cascades); 'charge_regular_price' flips coverage the same way as for app athletes
#   H  concurrency-safety spot check: resolving future registrations after a registration was already
#      cancelled by someone else skips it cleanly (no error, no double action)
#   I  a session scheduled EARLIER TODAY that has already ended is never touched, even on stop/delete
#      with cutoff = today -- session_date >= cutoff alone would wrongly include it; the
#      _session_has_ended guard excludes it
#   J  preview/confirm staleness: a registration added for a future session AFTER the manager's
#      preview is never silently swept into a confirm based on that stale preview -- confirming
#      without expected ids, or with the pre-change expected ids, is refused; only a fresh preview +
#      the current full expected-id set succeeds
#   K  authorization (20261026200000): anon is refused at the Postgres grant layer for both new RPCs
#      (permission denied, never reaches the function body); an authenticated non-manager still
#      reaches the body and is refused by its own is_manager check, same as every other subscription
#      RPC -- nothing is applied by any of the refused calls
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/192_subscription_future_registrations_tests.sh
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
ledger_fp() { su -c "select count(*) || ':' || coalesce(sum(amount_ils),0) from public.subscription_charges where subscription_id='$1'"; }

TODAY=$(su -c "select public._studio_today_date()")
d() { su -c "select (date '$TODAY' + $1)::date"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()"); CO=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f192-$n-m@t.local', '071$n'), ('$A'::uuid, 'f192-$n-a@t.local', '072$n'), ('$CO'::uuid, 'f192-$n-c@t.local', '073$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A','$CO');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$CO'" >/dev/null

mksub() { # price, returns SUB/VER via globals, and a FRESH athlete A each time (create_subscription
          # refuses a second active subscription for the same athlete)
  local an; an=$(date +%s%N | tail -c 9)
  A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f192-$an-a@t.local', jsonb_build_object('full_name','a192','phone','075$an','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  R=$(api "$M" "select public.create_subscription('$A', false, $1, '$TODAY', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
  case "$R" in *'"ok" : true'*) :;; *) fail "mksub: $R"; echo "192 ABORTED"; exit 1;; esac
  SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false and deleted_at is null order by created_at desc limit 1")
  VER=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB' and effective_to is null limit 1")
}
mksession() { # session_date [start_time] [duration_minutes], returns SX
  SX=$(su -c "insert into public.training_sessions (session_date, start_time, duration_minutes, coach_id, max_participants, is_open_for_registration) values ('$1', '${2:-08:00}', ${3:-60}, '$CO', 6, true) returning id" | head -1)
}
regcov() { # session_id, session_date, covered(true/false) -> REG, COV
  REG=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$1', '$A', 'active') returning id" | head -1)
  COV=$(su -c "insert into public.subscription_registration_coverage (subscription_id, version_id, registration_id, session_date, week_start, tier, covered, decided_by) values ('$SUB', '$VER', '$REG', '$2', ('$2'::date) - extract(dow from '$2'::date)::int, 'group', $3, 'registration') returning id" | head -1)
}

echo "== A: stop with ZERO future registrations behaves exactly as before"
mksub 300
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 10)', true, null)::text;")
expect "A stop applied with no future_registration_action needed" "applied" "$(jf "$R" action)"
expect "A future_registrations_resolved is 0" "0" "$(jf "$R" future_registrations_resolved)"

echo "== B: stop with a future registration -- preview, block, then 'remove'"
mksub 300
mksession "$(d 20)"; regcov "$SX" "$(d 20)" true
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', false, null)::text;")
expect "B preview action" "preview" "$(jf "$R" action)"
expect "B preview future_registrations_count" "1" "$(jf "$R" future_registrations_count)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, null)::text;")
expect "B confirm without an action is refused" "future_registration_action_required" "$(jf "$R" error)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove', ARRAY['$REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "B confirm with 'remove' applies" "applied" "$(jf "$R" action)"
expect "B one registration resolved" "1" "$(jf "$R" future_registrations_resolved)"
expect "B registration is cancelled, not deleted" "cancelled" "$(su -c "select status from public.session_registrations where id='$REG'")"
expect "B session itself still exists" "1" "$(su -c "select count(*) from public.training_sessions where id='$SX'")"
expect "B coverage row is gone" "0" "$(su -c "select count(*) from public.subscription_registration_coverage where id='$COV'")"

echo "== C: stop with a future registration -- 'charge_regular_price' creates no immediate charge"
# Control: an otherwise-identical subscription, stopped the same way, but with NO future
# registration. Its ledger after stopping is purely the stop's own normal mid-period proration
# (reversal + replacement charge) -- the baseline to compare against, not zero/unchanged (stopping a
# subscription mid-cycle always prorates the current period; that's pre-existing, unrelated behavior).
mksub 300
CONTROL_SUB=$SUB
api "$M" "select public.stop_subscription_with_future_registrations('$CONTROL_SUB', '$(d 15)', true, null)::text;" >/dev/null
CONTROL_FP=$(ledger_fp "$CONTROL_SUB")

mksub 300
mksession "$(d 22)"; regcov "$SX" "$(d 22)" true
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'charge_regular_price', ARRAY['$REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "C confirm with 'charge_regular_price' applies" "applied" "$(jf "$R" action)"
expect "C one registration resolved" "1" "$(jf "$R" future_registrations_resolved)"
expect "C registration stays active" "active" "$(su -c "select status from public.session_registrations where id='$REG'")"
expect "C coverage flipped to not covered" "f" "$(su -c "select covered from public.subscription_registration_coverage where id='$COV'")"
expect "C non_coverage_reason is subscription_ended" "subscription_ended" "$(su -c "select non_coverage_reason from public.subscription_registration_coverage where id='$COV'")"
expect "C ledger matches the control (identical to a plain stop with no future registration -- resolving the future registration added zero charges)" "$CONTROL_FP" "$(ledger_fp "$SUB")"

echo "== D: a PAST registration before the stop date is never touched by either choice"
mksub 300
PASTDATE=$(d 2)
mksession "$PASTDATE"; regcov "$SX" "$PASTDATE" true
su -c "update public.session_registrations set status='active', attended=true where id='$REG'" >/dev/null
BEFORE_COV=$(su -c "select covered, non_coverage_reason from public.subscription_registration_coverage where id='$COV'")
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 10)', true, 'remove')::text;")
expect "D stop applied" "applied" "$(jf "$R" action)"
expect "D the past registration's coverage row is untouched" "$BEFORE_COV" "$(su -c "select covered, non_coverage_reason from public.subscription_registration_coverage where id='$COV'")"
expect "D the past registration's attended flag is untouched" "t" "$(su -c "select attended from public.session_registrations where id='$REG'")"

echo "== E: delete_subscription has the same preview/confirm/choice behavior (cutoff = today)"
mksub 300
# Late in the day so it reliably has NOT ended yet regardless of what time this suite happens to run at.
mksession "$TODAY" "23:50" 5; regcov "$SX" "$TODAY" true
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB', null, false)::text;")
expect "E delete preview" "preview" "$(jf "$R" action)"
expect "E delete preview future_registrations_count" "1" "$(jf "$R" future_registrations_count)"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB', null, true)::text;")
expect "E delete confirm without an action is refused" "future_registration_action_required" "$(jf "$R" error)"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB', 'remove', true, ARRAY['$REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "E delete confirm with 'remove' applies" "tombstoned" "$(jf "$R" action)"
expect "E delete resolved one registration" "1" "$(jf "$R" future_registrations_resolved)"
expect "E registration cancelled, not deleted" "cancelled" "$(su -c "select status from public.session_registrations where id='$REG'")"
DELETED_AT=$(su -c "select (deleted_at is not null)::text from public.subscriptions where id='$SUB'")
expect "E subscription is tombstoned" "true" "$DELETED_AT"

echo "== F: idempotency -- same action retried converges; a different action is a distinct operation"
mksub 300
mksession "$(d 24)"; regcov "$SX" "$(d 24)" true
N0=$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB'")
R1=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'charge_regular_price', ARRAY['$REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "F first confirm applies" "applied" "$(jf "$R1" action)"
# Retry: the resolved row is no longer covered=true, so there's nothing left for the staleness check
# to require expected ids for -- the plain 4-arg idempotent-retry call is exactly what a client that
# simply resubmits the same request would send.
R2=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'charge_regular_price')::text;")
expect "F identical retry is already_applied" "already_applied" "$(jf "$R2" action)"
mksession "$(d 21)"; regcov "$SX" "$(d 21)" true
R3=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove', ARRAY['$REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "F a DIFFERENT action for the same stop is a distinct operation (applied, not already_applied)" "applied" "$(jf "$R3" action)"
expect "F the second registration was resolved by the distinct operation" "1" "$(jf "$R3" future_registrations_resolved)"

echo "== G: manual participants resolve the same way as app athletes"
mksub 300
mksession "$(d 26)"
MPID=$(su -c "insert into public.manual_participants (full_name, phone) values ('mp192 $n', '074$n') returning id" | head -1)
SMP=$(su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$SX', '$MPID') returning id" | head -1)
MCOV=$(su -c "insert into public.subscription_registration_coverage (subscription_id, version_id, manual_participant_id, session_date, week_start, tier, covered, decided_by) values ('$SUB', '$VER', '$SMP', '$(d 20)', ('$(d 20)'::date) - extract(dow from '$(d 20)'::date)::int, 'group', true, 'registration') returning id" | head -1)
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove', ARRAY[]::uuid[], ARRAY['$SMP']::uuid[])::text;")
expect "G manual participant 'remove' applied" "applied" "$(jf "$R" action)"
expect "G session_manual_participants row deleted" "0" "$(su -c "select count(*) from public.session_manual_participants where id='$SMP'")"
expect "G its coverage row cascaded away" "0" "$(su -c "select count(*) from public.subscription_registration_coverage where id='$MCOV'")"

echo "== H: a registration cancelled by someone else between preview and confirm is skipped cleanly"
mksub 300
mksession "$(d 28)"; regcov "$SX" "$(d 28)" true
su -c "update public.session_registrations set status='cancelled' where id='$REG'" >/dev/null
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove')::text;")
expect "H stop still applies" "applied" "$(jf "$R" action)"
expect "H nothing was resolved (registration already inactive)" "0" "$(jf "$R" future_registrations_resolved)"

echo "== I: a session scheduled earlier TODAY that already ended is never touched"
mksub 300
mksession "$TODAY" "00:05" 1
regcov "$SX" "$TODAY" true
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$TODAY', true, 'remove')::text;")
expect "I stop applied" "applied" "$(jf "$R" action)"
expect "I nothing resolved for the already-ended same-day session" "0" "$(jf "$R" future_registrations_resolved)"
expect "I the already-ended registration stays active (untouched)" "active" "$(su -c "select status from public.session_registrations where id='$REG'")"
expect "I its coverage row is untouched (still covered=true)" "t" "$(su -c "select covered from public.subscription_registration_coverage where id='$COV'")"

mksub 300
mksession "$TODAY" "00:10" 1
regcov "$SX" "$TODAY" true
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB', 'remove', true)::text;")
expect "I (delete) tombstoned" "tombstoned" "$(jf "$R" action)"
expect "I (delete) nothing resolved for the already-ended same-day session" "0" "$(jf "$R" future_registrations_resolved)"
expect "I (delete) the already-ended registration stays active (untouched)" "active" "$(su -c "select status from public.session_registrations where id='$REG'")"
expect "I (delete) its coverage row is untouched (still covered=true)" "t" "$(su -c "select covered from public.subscription_registration_coverage where id='$COV'")"

echo "== J: preview/confirm staleness -- a registration added after preview is never silently resolved"
mksub 300
mksession "$(d 30)"; regcov "$SX" "$(d 30)" true
FIRST_REG=$REG
PREVIEW=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', false, null)::text;")
expect "J preview shows exactly the one known registration" "1" "$(jf "$PREVIEW" future_registrations_count)"

# A NEW future registration appears after the manager's preview (e.g. the athlete self-registers).
mksession "$(d 31)"; regcov "$SX" "$(d 31)" true
SECOND_REG=$REG

R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove')::text;")
expect "J confirming with no expected ids at all is refused" "future_registrations_expectation_required" "$(jf "$R" error)"

R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove', ARRAY['$FIRST_REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "J confirming with the STALE (pre-second-registration) expected ids is refused, not silently expanded" "future_registrations_changed" "$(jf "$R" error)"
expect "J nothing was applied by the refused confirm (subscription not yet stopped)" "" "$(su -c "select stopped_effective_date from public.subscription_versions where id='$VER'")"
expect "J the first (previously-previewed) registration was untouched by the refused confirm" "active" "$(su -c "select status from public.session_registrations where id='$FIRST_REG'")"
expect "J the second (unexpected) registration was untouched by the refused confirm" "active" "$(su -c "select status from public.session_registrations where id='$SECOND_REG'")"

# Manager re-previews, sees both, and confirms with the FULL current set -- now it succeeds.
PREVIEW2=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', false, null)::text;")
expect "J re-preview now shows both registrations" "2" "$(jf "$PREVIEW2" future_registrations_count)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 15)', true, 'remove', ARRAY['$FIRST_REG','$SECOND_REG']::uuid[], ARRAY[]::uuid[])::text;")
expect "J confirming with the FULL current expected ids applies" "applied" "$(jf "$R" action)"
expect "J both registrations resolved" "2" "$(jf "$R" future_registrations_resolved)"
expect "J first registration cancelled" "cancelled" "$(su -c "select status from public.session_registrations where id='$FIRST_REG'")"
expect "J second registration cancelled too" "cancelled" "$(su -c "select status from public.session_registrations where id='$SECOND_REG'")"

echo "== K: authorization -- anon cannot reach either new RPC; authenticated non-manager is refused by the function itself"
mksub 300
anon_out=$(api_as "anon" "" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 10)', true, 'remove')::text;")
case "$anon_out" in *"permission denied"*) ok "K anon is refused at the grant layer (stop)";; *) fail "K anon stop was not refused: $(echo "$anon_out" | head -1 | cut -c1-160)";; esac
anon_out=$(api_as "anon" "" "select public.delete_subscription_with_future_registrations('$SUB', 'remove', true)::text;")
case "$anon_out" in *"permission denied"*) ok "K anon is refused at the grant layer (delete)";; *) fail "K anon delete was not refused: $(echo "$anon_out" | head -1 | cut -c1-160)";; esac
# A non-manager authenticated user (the fixture athlete) still reaches the function body -- it's the
# function's own is_manager check, not a grant, that refuses them. This is the pre-existing,
# unrelated-to-this-migration authorization model every subscription RPC already uses.
athlete_out=$(api_as "authenticated" "$A" "select public.stop_subscription_with_future_registrations('$SUB', '$(d 10)', true, 'remove')::text;")
expect "K authenticated non-manager is refused by is_manager (not the grant layer)" "forbidden" "$(jf "$athlete_out" error)"
expect "K nothing was applied by any of the refused calls (subscription still has no stopped_effective_date)" "" "$(su -c "select stopped_effective_date from public.subscription_versions where id='$VER'")"

echo
echo "192 subscription future registrations: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
