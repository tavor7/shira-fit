#!/usr/bin/env bash
# The first person in line is notified once per genuine opening. Replaces invoke_notify_waitlist_edge with a recorder, so it
# only needs a throwaway database. LOCAL stack only: commits fixtures and leaves the recorder removed afterwards.
# Usage: PSQL=... supabase/tests/208_waitlist_notify_on_opening_only_tests.sh
set -u
PSQL=${PSQL:?set PSQL}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@" </dev/null; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
as() { local uid=$1; shift
  echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}'; $*; commit;" \
    | $PSQL -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
new_user() { local role=$1 id; id=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t208-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role' where user_id='$id'" >/dev/null
  echo "$id"; }
new_session() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 2, make_time(6 + floor(random()*14)::int, floor(random()*60)::int, floor(random()*60)::int), '$COACH', $1, true) returning id"; }
fill_to() { local s=$1 n=$2 i=0; for U in "${FILLERS[@]}"; do [ "$i" -ge "$n" ] && break; su -c "insert into public.session_registrations (session_id, user_id, status) values ('$s','$U','active') on conflict (session_id,user_id) do update set status='active'" >/dev/null; i=$((i+1)); done; }
calls() { su -c "select count(*) from public.t208_calls where session_id='$1'"; }

ORIG=$(su -c "select pg_get_functiondef('public.invoke_notify_waitlist_edge(uuid)'::regprocedure)")
su -c "create table if not exists public.t208_calls (session_id uuid, at timestamptz default now());
  create or replace function public.invoke_notify_waitlist_edge(p_session_id uuid) returns void language sql security definer set search_path to 'public' as 'insert into public.t208_calls (session_id) values (p_session_id)';" >/dev/null
COACH=$(new_user coach); MGR=$(new_user manager); WAIT=$(new_user athlete)
FILLERS=(); for _ in 1 2 3 4 5 6 7 8; do FILLERS+=("$(new_user athlete)"); done

echo "--- one notification per opening"
S=$(new_session 7); fill_to "$S" 7
su -c "insert into public.waitlist_requests (session_id, user_id) values ('$S','$WAIT')" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "full to available notifies" 1 "$(calls "$S")"
as "${FILLERS[1]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "a further departure while still open does not repeat" 1 "$(calls "$S")"
as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[2]}')" >/dev/null
expect "nor does a staff removal while still open" 1 "$(calls "$S")"
expect "the waitlist row is untouched" 1 "$(su -c "select count(*) from public.waitlist_requests where session_id='$S'")"

echo "--- a new opening"
su -c "update public.session_registrations set status='active' where session_id='$S' and user_id in ('${FILLERS[0]}','${FILLERS[1]}','${FILLERS[2]}')" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','again')" >/dev/null
expect "full again, then available again, notifies again" 2 "$(calls "$S")"
as "${FILLERS[0]}" "select public.register_for_session('$S')" >/dev/null
as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[3]}')" >/dev/null
expect "a staff removal that reopens it notifies" 3 "$(calls "$S")"

echo "--- quick-add removal"
S=$(new_session 7); fill_to "$S" 6
M=$(su -c "insert into public.manual_participants (full_name, phone) values ('Quick', gen_random_uuid()::text) returning id")
su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S','$M')" >/dev/null
as "$MGR" "select public.remove_manual_participant_from_session('$S','$M')" >/dev/null
expect "removing a quick-add from a full session notifies" 1 "$(calls "$S")"
S=$(new_session 7); fill_to "$S" 5
M=$(su -c "insert into public.manual_participants (full_name, phone) values ('Quick2', gen_random_uuid()::text) returning id")
su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S','$M')" >/dev/null
as "$MGR" "select public.remove_manual_participant_from_session('$S','$M')" >/dev/null
expect "removing one from a session with space does not" 0 "$(calls "$S")"

echo "--- all capacities, as before"
S=$(new_session 1); fill_to "$S" 1
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "a personal session notifies when it opens" 1 "$(calls "$S")"
S=$(new_session 3); fill_to "$S" 3
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "a small group session notifies when it opens" 1 "$(calls "$S")"
S=$(new_session 7); fill_to "$S" 8
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "over capacity and still full does not" 0 "$(calls "$S")"

echo "--- concurrent departures (15 rounds)"
BAD=0
for round in $(seq 1 15); do
  S=$(new_session 7); fill_to "$S" 7
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[0]}'); select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[1]}'); select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  [ "$(calls "$S")" = 1 ] || BAD=$((BAD+1))
done
expect "rounds without exactly one notification" 0 "$BAD"

echo "--- a failure never blocks the departure"
S=$(new_session 7); fill_to "$S" 7
su -c "create or replace function public.invoke_notify_waitlist_edge(p_session_id uuid) returns void language plpgsql as 'begin raise exception ''boom''; end'" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "the cancellation still happened" cancelled "$(su -c "select status from public.session_registrations where session_id='$S' and user_id='${FILLERS[0]}'")"

expect "helper is not callable by clients" f "$(su -c "select has_function_privilege('authenticated','public._waitlist_departure_opened_spot(uuid)','execute') or has_function_privilege('anon','public._waitlist_departure_opened_spot(uuid)','execute')")"

echo "$ORIG" | $PSQL -q -v ON_ERROR_STOP=1 >/dev/null
su -c "drop table public.t208_calls" >/dev/null
echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
