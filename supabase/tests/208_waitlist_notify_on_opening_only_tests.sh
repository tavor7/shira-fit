#!/usr/bin/env bash
# The head of the waitlist is told once per opening, and the next person is told if the head leaves while a place is free.
# Replaces invoke_notify_waitlist_edge with a recorder, so it needs a throwaway database. Needs 20261103101000.
# LOCAL stack only: commits fixtures, and restores the function afterwards.
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
bare_session() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 2, make_time(6 + floor(random()*14)::int, floor(random()*60)::int, random()*59.999), '$COACH', $1, true) returning id"; }
new_session() { local s; s=$(bare_session "$1"); su -c "insert into public.waitlist_requests (session_id, user_id) values ('$s','$WAIT')" >/dev/null; echo "$s"; }
fill_to() { local s=$1 n=$2 i=0; for U in "${FILLERS[@]}"; do [ "$i" -ge "$n" ] && break; su -c "insert into public.session_registrations (session_id, user_id, status) values ('$s','$U','active') on conflict (session_id,user_id) do update set status='active'" >/dev/null; i=$((i+1)); done; }
calls() { su -c "select count(*) from public.t208_calls where session_id='$1'"; }
told() { su -c "select count(*) from public.t208_calls where session_id='$1' and recipient='$2'"; }
line() { local s=$1 u=$2 mins=$3; su -c "insert into public.waitlist_requests (session_id, user_id, requested_at) values ('$s','$u', now() - interval '$mins minutes')" >/dev/null; }
leave() { su -c "delete from public.waitlist_requests where session_id='$1' and user_id='$2'" >/dev/null; }

ORIG=$(su -c "select pg_get_functiondef('public.invoke_notify_waitlist_edge(uuid)'::regprocedure)")
su -c "create table if not exists public.t208_calls (session_id uuid, recipient uuid, at timestamptz default now());
  create or replace function public.invoke_notify_waitlist_edge(p_session_id uuid) returns void language sql security definer set search_path to 'public'
  as 'insert into public.t208_calls (session_id, recipient) select p_session_id, public._waitlist_first_eligible_user(p_session_id)';" >/dev/null
COACH=$(new_user coach); MGR=$(new_user manager); WAIT=$(new_user athlete); A=$(new_user athlete); B=$(new_user athlete); D=$(new_user athlete)
FILLERS=(); for _ in 1 2 3 4 5 6 7 8; do FILLERS+=("$(new_user athlete)"); done

echo "--- one notification per opening"
S=$(new_session 7); fill_to "$S" 7
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

echo "--- continuity: the head leaves while a place is free"
S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20; line "$S" "$D" 10
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "the head is told" 1 "$(told "$S" "$A")"
leave "$S" "$B"
expect "someone further back leaving tells nobody" 1 "$(calls "$S")"
leave "$S" "$A"
expect "the head leaving tells the next person" 1 "$(told "$S" "$D")"
expect "exactly two notifications so far" 2 "$(calls "$S")"
line "$S" "$A" 5
leave "$S" "$D"
expect "someone already told about this opening is not told again" 2 "$(calls "$S")"
expect "registration rows are untouched by any of this" 6 "$(su -c "select count(*) from public.session_registrations where session_id='$S' and status='active'")"

echo "--- continuity: withdrawing through the app"
S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
as "$A" "delete from public.waitlist_requests where session_id='$S' and user_id='$A'" >/dev/null
expect "the athlete's own withdrawal tells the next person" 1 "$(told "$S" "$B")"

echo "--- continuity: the head registers"
S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
as "$A" "select public.register_for_session('$S')" >/dev/null
expect "the session is full again, so nobody else is told" 0 "$(told "$S" "$B")"
S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
as "${FILLERS[1]}" "select public.cancel_registration('$S','t')" >/dev/null
as "$A" "select public.register_for_session('$S')" >/dev/null
expect "a place is still free, so the next person is told" 1 "$(told "$S" "$B")"

echo "--- continuity: when nobody should be told"
for CASE in refilled hidden closed started; do
  S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20
  as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
  case $CASE in
    refilled) su -c "update public.session_registrations set status='active' where session_id='$S' and user_id='${FILLERS[0]}'" >/dev/null;;
    hidden) su -c "update public.training_sessions set is_hidden=true where id='$S'" >/dev/null;;
    closed) su -c "update public.training_sessions set is_open_for_registration=false where id='$S'" >/dev/null;;
    started) su -c "update public.training_sessions set session_date=current_date - 1 where id='$S'" >/dev/null;;
  esac
  leave "$S" "$A"
  expect "$CASE session: the next person is not told" 0 "$(told "$S" "$B")"
done
S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20; line "$S" "$D" 10
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
su -c "update public.profiles set disabled_at=now() where user_id='$B'" >/dev/null
leave "$S" "$A"
expect "a disabled person is passed over" 1 "$(told "$S" "$D")"
su -c "update public.profiles set disabled_at=null where user_id='$B'" >/dev/null
S=$(bare_session 7); fill_to "$S" 5; line "$S" "$A" 30; line "$S" "$B" 20
leave "$S" "$A"
expect "no opening was ever recorded, so leaving tells nobody" 0 "$(calls "$S")"

echo "--- concurrent departures (10 rounds)"
BAD=0
for round in $(seq 1 10); do
  S=$(new_session 7); fill_to "$S" 7
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[0]}'); select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[1]}'); select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  [ "$(calls "$S")" = 1 ] || BAD=$((BAD+1))
done
expect "rounds without exactly one notification" 0 "$BAD"

echo "--- concurrent leavers (10 rounds)"
BAD=0
for round in $(seq 1 10); do
  S=$(bare_session 7); fill_to "$S" 7; line "$S" "$A" 30; line "$S" "$B" 20; line "$S" "$D" 10
  as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
  as "$A" "delete from public.waitlist_requests where session_id='$S' and user_id='$A'; select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "$B" "delete from public.waitlist_requests where session_id='$S' and user_id='$B'; select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  [ "$(told "$S" "$D")" = 1 ] || BAD=$((BAD+1))
done
expect "rounds where the last person was not told exactly once" 0 "$BAD"

echo "--- a failure never blocks the change that caused it"
S=$(new_session 7); fill_to "$S" 7
su -c "create or replace function public.invoke_notify_waitlist_edge(p_session_id uuid) returns void language plpgsql as 'begin raise exception ''boom''; end'" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "the cancellation still happened" cancelled "$(su -c "select status from public.session_registrations where session_id='$S' and user_id='${FILLERS[0]}'")"
leave "$S" "$WAIT"
expect "leaving the line still happened" 0 "$(su -c "select count(*) from public.waitlist_requests where session_id='$S'")"

echo "--- permissions"
for FN in "_waitlist_lock_session(uuid)" "_waitlist_recipient_already_told(uuid,uuid)" "_waitlist_notify_head(uuid,uuid)" "_waitlist_note_departure(uuid)"; do
  expect "$FN not callable by clients" f "$(su -c "select has_function_privilege('authenticated','public.$FN','execute') or has_function_privilege('anon','public.$FN','execute')")"
done
expect "opening rows are not readable by clients" 1 "$(as "$A" "select count(*) from public.session_waitlist_openings" | grep -c "permission denied")"

echo "$ORIG" | $PSQL -q -v ON_ERROR_STOP=1 >/dev/null
su -c "drop table public.t208_calls" >/dev/null
echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
