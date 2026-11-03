#!/usr/bin/env bash
# Manager "spot available" reliability: a second genuine opening from a re-activated registration still notifies, and two
# concurrent self-cancellations from a full session notify exactly once. Real connections as `authenticated`, so the
# actor gate and READ COMMITTED behaviour are the production ones.
# Usage: PSQL=... supabase/tests/205_manager_notification_reliability_tests.sh   (LOCAL stack only, commits fixtures)
set -u
PSQL=${PSQL:?set PSQL}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
as() { local uid=$1; shift
  echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}'; $*; commit;" \
    | $PSQL -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
new_user() { local role=$1 id; id=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t205-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role' where user_id='$id'" >/dev/null
  echo "$id"; }
new_session() { local cap=$1
  su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
         values (current_date + 5, make_time(6 + floor(random()*14)::int, floor(random()*60)::int, floor(random()*60)::int), '$COACH', $cap, true) returning id"; }
fill() { su -c "insert into public.session_registrations (session_id, user_id, status) values ('$1','$2','active')" >/dev/null; }
spot_events() { su -c "select count(*) from public.manager_operational_notifications where session_id='$1' and event_kind='group_spot_available'"; }

COACH=$(new_user coach)
A=$(new_user athlete); B=$(new_user athlete)
OTHERS=(); for _ in 1 2 3 4 5; do OTHERS+=("$(new_user athlete)"); done

echo "--- a later genuine opening from a re-activated registration"
S=$(new_session 7)
for U in "$A" "$B" "${OTHERS[@]}"; do fill "$S" "$U"; done
as "$A" "select public.cancel_registration('$S','t205')" >/dev/null
expect "first departure from a full session notifies" 1 "$(spot_events "$S")"
as "$A" "select public.register_for_session('$S')" >/dev/null
expect "the same row was re-activated" "$(su -c "select count(*) from public.session_registrations where session_id='$S' and user_id='$A'")" 1
as "$A" "select public.cancel_registration('$S','t205 again')" >/dev/null
expect "second departure by the same athlete notifies again" 2 "$(spot_events "$S")"

echo "--- staying below capacity is not a new opening"
as "$B" "select public.cancel_registration('$S','t205')" >/dev/null
expect "departure from a session that already had space does not notify" 2 "$(spot_events "$S")"

echo "--- concurrent self-cancellations from a full session (20 rounds)"
DOUBLE=0; MISSED=0
for round in $(seq 1 20); do
  S=$(new_session 7)
  for U in "$A" "$B" "${OTHERS[@]}"; do fill "$S" "$U"; done
  as "$A" "select public.cancel_registration('$S','race'); select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "$B" "select public.cancel_registration('$S','race'); select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  N=$(spot_events "$S")
  [ "$N" -gt 1 ] && DOUBLE=$((DOUBLE+1))
  [ "$N" -lt 1 ] && MISSED=$((MISSED+1))
  L=$(su -c "select count(*) from public.session_registrations where session_id='$S' and status='cancelled'")
  [ "$L" = 2 ] || fail "round $round: both cancellations must succeed, got $L"
done
expect "rounds with a duplicate manager notification" 0 "$DOUBLE"
expect "rounds with no manager notification" 0 "$MISSED"

echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
