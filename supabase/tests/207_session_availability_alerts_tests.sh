#!/usr/bin/env bash
# Per-session availability alerts: flag, subscribe rules, genuine openings, one notification per recipient per opening,
# concurrency, re-opening, eligibility at send time, retries and permissions. Real connections as `authenticated`.
# Point the send secrets at a closed local port: the requests fail, and responses are written by hand to drive the worker.
# Usage: PSQL=... supabase/tests/207_session_availability_alerts_tests.sh   (LOCAL stack only: commits fixtures and flips
# session_availability_enabled)
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
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t207-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role' where user_id='$id';
         insert into public.web_push_subscriptions (user_id, endpoint, p256dh, auth) values ('$id','https://push.invalid/$id','k','a') on conflict do nothing" >/dev/null
  echo "$id"; }
new_session() { local cap=$1
  su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
         values (current_date + 2, make_time(6 + floor(random()*14)::int, floor(random()*60)::int, floor(random()*60)::int), '$COACH', $cap, true) returning id"; }
fill_to() { local s=$1 n=$2; local i=0; for U in "${FILLERS[@]}"; do [ "$i" -ge "$n" ] && break; su -c "insert into public.session_registrations (session_id, user_id, status) values ('$s','$U','active') on conflict (session_id,user_id) do update set status='active'" >/dev/null; i=$((i+1)); done; }
openings() { su -c "select count(*) from public.session_availability_openings where session_id='$1'"; }
deliveries() { su -c "select count(*) from public.session_availability_deliveries where session_id='$1' and user_id='$2'"; }
status_of() { su -c "select status || coalesce(':' || skip_reason, '') from public.session_availability_deliveries where session_id='$1' and user_id='$2' order by id desc limit 1"; }
subscribed() { su -c "select count(*) from public.session_availability_subscriptions where session_id='$1' and user_id='$2'"; }
flag() { su -c "insert into public.system_monitoring_config (key, value) values ('session_availability_enabled', '$1'::jsonb) on conflict (key) do update set value = excluded.value" >/dev/null; }
rpc_err() { as "$1" "select coalesce(public.subscribe_session_availability('$2')->>'error','ok')"; }

su -c "delete from vault.secrets where name in ('send_web_push_url','send_web_push_secret');
       select vault.create_secret('http://127.0.0.1:9/never','send_web_push_url'), vault.create_secret('t207-secret','send_web_push_secret')" >/dev/null
COACH=$(new_user coach); MGR=$(new_user manager)
SUB=$(new_user athlete); SUB2=$(new_user athlete); PLAIN=$(new_user athlete)
FILLERS=(); for _ in 1 2 3 4 5 6 7 8; do FILLERS+=("$(new_user athlete)"); done

echo "--- flag off: nothing happens and the RPC refuses"
flag false
S=$(new_session 7); fill_to "$S" 7
expect "subscribe refused while off" feature_disabled "$(rpc_err "$SUB" "$S")"
su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$S','$SUB')" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "no opening recorded while off" 0 "$(openings "$S")"
expect "worker does nothing while off" '{"enabled": false}' "$(su -c "select public._session_availability_outbox_process()")"
expect "unsubscribing still works while off" ok "$(as "$SUB" "select public.unsubscribe_session_availability('$S')->>'ok'" | sed 's/true/ok/')"
expect "state reports off" false "$(as "$SUB" "select public.session_availability_state('$S')->>'enabled'")"

flag true

echo "--- subscribe rules"
S=$(new_session 7); fill_to "$S" 7
expect "full group session accepted" ok "$(rpc_err "$SUB" "$S")"
expect "subscribing twice is harmless" ok "$(rpc_err "$SUB" "$S")"
expect "one row only" 1 "$(subscribed "$S" "$SUB")"
expect "state reports subscribed" true "$(as "$SUB" "select public.session_availability_state('$S')->>'subscribed'")"
expect "subscribing does not join the waitlist" 0 "$(su -c "select count(*) from public.waitlist_requests where session_id='$S' and user_id='$SUB'")"
expect "already registered refused" already_registered "$(rpc_err "${FILLERS[0]}" "$S")"
expect "coach refused" not_approved_athlete "$(rpc_err "$COACH" "$S")"
S6=$(new_session 6); fill_to "$S6" 6
expect "capacity 6 refused" not_group_session "$(rpc_err "$SUB" "$S6")"
S8=$(new_session 8); fill_to "$S8" 3
expect "session with space refused" not_full "$(rpc_err "$SUB" "$S8")"
SC=$(new_session 7); fill_to "$SC" 7; su -c "update public.training_sessions set is_open_for_registration=false where id='$SC'" >/dev/null
expect "closed registration refused" registration_closed "$(rpc_err "$SUB" "$SC")"
SH=$(new_session 7); fill_to "$SH" 7; su -c "update public.training_sessions set is_hidden=true where id='$SH'" >/dev/null
expect "hidden session refused" session_not_available "$(rpc_err "$SUB" "$SH")"
SF=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 60, '10:00', '$COACH', 7, true) returning id"); fill_to "$SF" 7
expect "outside the browse window refused" session_not_available "$(rpc_err "$SUB" "$SF")"

echo "--- genuine openings"
rpc_err "$SUB2" "$S" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "athlete cancellation opens" 1 "$(openings "$S")"
expect "subscriber gets one delivery" 1 "$(deliveries "$S" "$SUB")"
expect "second subscriber gets one delivery" 1 "$(deliveries "$S" "$SUB2")"
expect "non-subscriber gets none" 0 "$(deliveries "$S" "$PLAIN")"
expect "dispatched straight away, no waiting period" processing "$(status_of "$S" "$SUB")"
as "${FILLERS[1]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "already available, another departure is no new opening" 1 "$(openings "$S")"
expect "still one delivery" 1 "$(deliveries "$S" "$SUB")"

echo "--- full again, then available again"
su -c "update public.session_registrations set status='active' where session_id='$S' and user_id in ('${FILLERS[0]}','${FILLERS[1]}')" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "a later opening is a new event" 2 "$(openings "$S")"
expect "subscriber is told about it too" 2 "$(deliveries "$S" "$SUB")"

echo "--- staff removal"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[2]}')" >/dev/null
expect "manager removal opens" 1 "$(openings "$S")"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
as "$COACH" "select public.coach_remove_athlete('$S','${FILLERS[3]}')" >/dev/null
expect "coach removal opens" 1 "$(openings "$S")"
S=$(new_session 7); fill_to "$S" 6
M=$(su -c "insert into public.manual_participants (full_name, phone) values ('Quick', gen_random_uuid()::text) returning id")
su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S','$M')" >/dev/null
rpc_err "$SUB" "$S" >/dev/null
as "$MGR" "select public.remove_manual_participant_from_session('$S','$M')" >/dev/null
expect "quick-add removal opens" 1 "$(openings "$S")"

echo "--- capacity"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
su -c "update public.training_sessions set max_participants=8 where id='$S'" >/dev/null
expect "capacity increase on a full session opens" 1 "$(openings "$S")"
su -c "update public.training_sessions set max_participants=9 where id='$S'" >/dev/null
expect "raising it again while available is no new opening" 1 "$(openings "$S")"
S=$(new_session 7); fill_to "$S" 8; rpc_err "$SUB" "$S" >/dev/null
su -c "update public.training_sessions set max_participants=8 where id='$S'" >/dev/null
expect "over capacity, still full after a raise" 0 "$(openings "$S")"
S=$(new_session 7); fill_to "$S" 4
su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$S','$SUB')" >/dev/null
su -c "update public.training_sessions set max_participants=9 where id='$S'" >/dev/null
expect "raising an already available session is no opening" 0 "$(openings "$S")"
S=$(new_session 6); fill_to "$S" 6
su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$S','$SUB')" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "under capacity 7 is out of scope" 0 "$(openings "$S")"

echo "--- concurrent cancellations (15 rounds)"
DOUBLE=0; MISSED=0
for round in $(seq 1 15); do
  S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
  as "${FILLERS[0]}" "select public.cancel_registration('$S','race'); select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "${FILLERS[1]}" "select public.cancel_registration('$S','race'); select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  N=$(openings "$S"); D=$(deliveries "$S" "$SUB")
  case "$N" in ""|*[!0-9]*) fail "round $round: no count"; continue;; esac
  [ "$N" -gt 1 ] && DOUBLE=$((DOUBLE+1))
  [ "$N" -lt 1 ] && MISSED=$((MISSED+1))
  [ "$D" = "$N" ] || fail "round $round: deliveries $D for openings $N"
done
expect "rounds with a duplicate opening" 0 "$DOUBLE"
expect "rounds with a missed opening" 0 "$MISSED"

echo "--- concurrent staff removals (15 rounds; the manager alert path takes no lock for these, so this tests this feature's own)"
DOUBLE=0; MISSED=0
for round in $(seq 1 15); do
  S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[0]}'); select pg_sleep(0.15)" >/dev/null &
  P1=$!
  as "$MGR" "select public.manager_remove_athlete('$S','${FILLERS[1]}'); select pg_sleep(0.15)" >/dev/null &
  P2=$!
  wait $P1 $P2
  N=$(openings "$S")
  case "$N" in ""|*[!0-9]*) fail "round $round: no count"; continue;; esac
  [ "$N" -gt 1 ] && DOUBLE=$((DOUBLE+1))
  [ "$N" -lt 1 ] && MISSED=$((MISSED+1))
done
expect "staff rounds with a duplicate opening" 0 "$DOUBLE"
expect "staff rounds with a missed opening" 0 "$MISSED"

echo "--- on the waitlist and subscribed"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null; rpc_err "$SUB2" "$S" >/dev/null
su -c "insert into public.waitlist_requests (session_id, user_id, requested_at) values ('$S','$SUB', now() - interval '1 hour'), ('$S','$SUB2', now())" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "first in line gets the waitlist push, not a second one" skipped:waitlist_push_covers "$(status_of "$S" "$SUB")"
expect "second in line, subscribed, is told once" processing "$(status_of "$S" "$SUB2")"
expect "waitlist rows are untouched" 2 "$(su -c "select count(*) from public.waitlist_requests where session_id='$S'")"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
su -c "insert into public.waitlist_requests (session_id, user_id) values ('$S','$SUB')" >/dev/null
su -c "update public.training_sessions set max_participants=8 where id='$S'" >/dev/null
expect "capacity increase has no waitlist push, so the subscriber is told" processing "$(status_of "$S" "$SUB")"

echo "--- eligibility at send time"
reason() { su -c "select coalesce(public._session_availability_skip_reason('$1','$2'),'send')"; }
S=$(new_session 7); fill_to "$S" 6; su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$S','$SUB')" >/dev/null
expect "eligible" send "$(reason "$S" "$SUB")"
expect "no subscription" not_subscribed "$(reason "$S" "$PLAIN")"
su -c "update public.training_sessions set is_open_for_registration=false where id='$S'" >/dev/null; expect "closed" registration_closed "$(reason "$S" "$SUB")"
su -c "update public.training_sessions set is_open_for_registration=true, is_hidden=true where id='$S'" >/dev/null; expect "hidden" session_hidden "$(reason "$S" "$SUB")"
su -c "update public.training_sessions set is_hidden=false where id='$S'" >/dev/null
su -c "update public.profiles set disabled_at=now() where user_id='$SUB'" >/dev/null; expect "disabled" account_disabled "$(reason "$S" "$SUB")"
su -c "update public.profiles set disabled_at=null, approval_status='pending' where user_id='$SUB'" >/dev/null; expect "not approved" not_approved_athlete "$(reason "$S" "$SUB")"
su -c "update public.profiles set approval_status='approved' where user_id='$SUB'" >/dev/null
su -c "insert into public.session_registrations (session_id, user_id, status) values ('$S','${FILLERS[7]}','active')" >/dev/null; expect "refilled" session_full "$(reason "$S" "$SUB")"
ST=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date - 1, '10:00', '$COACH', 7, true) returning id")
su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$ST','$SUB')" >/dev/null
expect "started" session_started "$(reason "$ST" "$SUB")"
su -c "select public._session_availability_outbox_process()" >/dev/null
expect "a started session's subscriptions are removed by the worker" 0 "$(subscribed "$ST" "$SUB")"
SW=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (current_date + 60, '11:00', '$COACH', 7, true) returning id")
su -c "insert into public.session_availability_subscriptions (session_id, user_id) values ('$SW','$SUB')" >/dev/null
expect "outside the browse window" outside_browse_window "$(reason "$SW" "$SUB")"

echo "--- registering ends the subscription"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
as "$SUB" "select public.register_for_session('$S')" >/dev/null
expect "subscription gone after registering" 0 "$(subscribed "$S" "$SUB")"

echo "--- worker: retries, responses, stale rows"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
RID=$(su -c "select net_request_id from public.session_availability_deliveries where session_id='$S' and user_id='$SUB'")
REQ=$(su -c "select net_request_id from public.session_availability_deliveries where session_id='$S' and user_id='$SUB'")
KEY=$(su -c "select idempotency_key from public.session_availability_deliveries where session_id='$S' and user_id='$SUB'")
case "$KEY" in avail:*) ok "idempotency key is per opening and user";; *) fail "bad key: $KEY";; esac
su -c "delete from net._http_response where id=$REQ; insert into net._http_response (id, status_code, content, headers, created) values ($REQ, 500, 'boom', '{}'::jsonb, now())" >/dev/null
su -c "select public._session_availability_outbox_process()" >/dev/null
expect "a failed response goes back to pending" pending "$(status_of "$S" "$SUB")"
expect "attempt recorded" 1 "$(su -c "select attempts from public.session_availability_deliveries where net_request_id=$REQ")"
su -c "update public.session_availability_deliveries set next_attempt_at=now() where session_id='$S'" >/dev/null
su -c "select public._session_availability_outbox_process()" >/dev/null
expect "the retry is dispatched again" processing "$(status_of "$S" "$SUB")"
expect "still one delivery row for this opening" 1 "$(deliveries "$S" "$SUB")"
REQ2=$(su -c "select net_request_id from public.session_availability_deliveries where session_id='$S' and user_id='$SUB'")
su -c "delete from net._http_response where id=$REQ2; insert into net._http_response (id, status_code, content, headers, created) values ($REQ2, 200, '{\"ok\":true,\"sent\":2,\"pruned\":0}', '{}'::jsonb, now())" >/dev/null
su -c "select public._session_availability_outbox_process()" >/dev/null
expect "accepted, never called delivered" accepted "$(status_of "$S" "$SUB")"
expect "records what the sender accepted" 2 "$(su -c "select devices_accepted from public.session_availability_deliveries where net_request_id=$REQ2")"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB2" "$S" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
su -c "update public.session_availability_deliveries set status='pending', created_at=now() - interval '20 minutes' where session_id='$S'" >/dev/null
su -c "select public._session_availability_outbox_process()" >/dev/null
expect "too old to be useful, expired instead of sent" skipped:expired "$(status_of "$S" "$SUB2")"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB2" "$S" >/dev/null
su -c "update app_settings set push_notifications_enabled=false where id=1" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "the push kill switch is respected" skipped:push_disabled "$(status_of "$S" "$SUB2")"
su -c "update app_settings set push_notifications_enabled=true where id=1" >/dev/null
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB2" "$S" >/dev/null
su -c "delete from public.web_push_subscriptions where user_id='$SUB2'" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "no push device is not a failure" skipped:no_push_device "$(status_of "$S" "$SUB2")"

echo "--- a notification failure never blocks the change that caused it"
S=$(new_session 7); fill_to "$S" 7; rpc_err "$SUB" "$S" >/dev/null
su -c "alter table public.session_availability_openings add constraint t207_boom check (false) not valid" >/dev/null
as "${FILLERS[0]}" "select public.cancel_registration('$S','t')" >/dev/null
expect "the cancellation still happened" cancelled "$(su -c "select status from public.session_registrations where session_id='$S' and user_id='${FILLERS[0]}'")"
su -c "alter table public.session_availability_openings drop constraint t207_boom" >/dev/null

echo "--- permissions"
for FN in "_session_availability_note_opening(uuid,text,integer)" "_session_availability_outbox_process(integer)" "_session_availability_dispatch_row(bigint,text,text)" "_session_availability_skip_reason(uuid,uuid)"; do
  expect "$FN not callable by clients" f "$(su -c "select has_function_privilege('authenticated','public.$FN','execute') or has_function_privilege('anon','public.$FN','execute')")"
done
expect "anon cannot subscribe" f "$(su -c "select has_function_privilege('anon','public.subscribe_session_availability(uuid)','execute')")"
expect "athlete sees only their own subscriptions" 0 "$(as "$PLAIN" "select count(*) from public.session_availability_subscriptions where user_id='$SUB'")"
DENIED=$(as "$PLAIN" "insert into public.session_availability_subscriptions (session_id,user_id) values ('$S','$PLAIN')" | grep -c "permission denied")
expect "direct insert is refused" 1 "$DENIED"
DENIED=$(as "$SUB" "select count(*) from public.session_availability_deliveries" | grep -c "permission denied")
expect "delivery rows are not readable by clients" 1 "$DENIED"

flag false
su -c "delete from vault.secrets where name in ('send_web_push_url','send_web_push_secret')" >/dev/null
echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
