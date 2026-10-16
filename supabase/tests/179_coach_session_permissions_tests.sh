#!/usr/bin/env bash
# Regression test for 20261020100000_coach_session_configuration_manager_only.sql (owner policy 2026-10-15: session
# configuration is manager-only; a coach manages only the participants, attendance, payments and own notes of sessions
# they are assigned to).
#
# Every call goes over a real `authenticator` connection as anon / authenticated with JWT claims (one transaction per
# call, like PostgREST). Fixture: manager M, super user SU (a manager with is_super_user), coach C (owns S1, S1B, SF,
# the race session SR and a recurring series), coach C2 (owns S2), athletes A..A5, walk-in W. All sessions are in one
# future studio week (moves require that).
#   N  for every vulnerability V1-V10 and Q2/Q3: coach C on own and on C2's sessions, coach C2, athlete and anon are
#      refused, explicitly (forbidden / full / permission denied / RLS), and a snapshot of every session, series,
#      occurrence, registration, walk-in, roster price and note row of both coaches is byte-identical afterwards
#   P  coach C on own sessions: add / remove athlete and walk-in, move between own sessions, attendance with a partial
#      payment and a payment method (owed amount unchanged, activity logged), own notes; manager and super user keep
#      every configuration operation (create series, update this / future, prices, roster price, move with capacity
#      change, over-capacity add, horizon, delete this / future)
#   C  concurrency: two coaches' adds, and a coach add racing an athlete's self-registration, for the last place never
#      exceed capacity (the session row lock serializes them)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/179_coach_session_permissions_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
#   PSQL="docker exec -i <db> psql -U postgres"
#   PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres"
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
anon() { api_as anon "" "$1"; }
# refused = permission denied, forbidden JSON, an RLS error, or an RLS-filtered zero-row write
refused() { case "$2" in *"permission denied"*|*forbidden*|*not_authenticated*|*"row-level security"*|"0"|"") ok "N $1 refused";; *) fail "N $1 NOT refused: $(echo "$2" | head -1 | cut -c1-160)";; esac; }
is_full() { case "$2" in *'"full"'*) ok "N $1 refused as full";; *) fail "N $1: expected full, got $(echo "$2" | head -1 | cut -c1-160)";; esac; }
okjson() { case "$2" in *'"ok" : true'*|*'"ok":true'*|*'"ok": true'*) ok "P $1";; *) fail "P $1: $(echo "$2" | head -1 | cut -c1-200)";; esac; }
works() { case "$2" in *"permission denied"*|*forbidden*|*"row-level security"*|*ERROR*) fail "P $1: $(echo "$2" | grep -m1 -E 'ERROR|denied|forbidden' | cut -c1-160)";; *) ok "P $1";; esac; }

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); SU=$(uid); C=$(uid); C2=$(uid); A=$(uid); A2=$(uid); A3=$(uid); A4=$(uid); A5=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f179-$n-m@t.local', '071$n'), ('$SU'::uuid, 'f179-$n-su@t.local', '072$n'),
               ('$C'::uuid, 'f179-$n-c@t.local', '073$n'), ('$C2'::uuid, 'f179-$n-c2@t.local', '074$n'),
               ('$A'::uuid, 'f179-$n-a@t.local', '075$n'), ('$A2'::uuid, 'f179-$n-a2@t.local', '076$n'),
               ('$A3'::uuid, 'f179-$n-a3@t.local', '077$n'), ('$A4'::uuid, 'f179-$n-a4@t.local', '078$n'),
               ('$A5'::uuid, 'f179-$n-a5@t.local', '079$n')) u(id, e, p);
  update public.profiles set approval_status = 'approved' where user_id in ('$M','$SU','$C','$C2','$A','$A2','$A3','$A4','$A5');
  update public.profiles set role = 'manager' where user_id in ('$M','$SU');
  update public.profiles set is_super_user = true where user_id = '$SU';
  update public.profiles set role = 'coach' where user_id in ('$C','$C2')" >/dev/null
# A future studio week (Sunday-based): Monday D1 and Tuesday D2 of next week.
D1=$(su -c "select (current_date + (7 - extract(dow from current_date)::int) + 1)::date")
D2=$(su -c "select ('$D1'::date + 1)")
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values ('$1', '$2', '$3', $4, true) returning id" | head -1; }
S1=$(sess "$D1" 06:05 "$C" 3); S1B=$(sess "$D2" 06:05 "$C" 3); SF=$(sess "$D1" 06:35 "$C" 1); S2=$(sess "$D1" 07:05 "$C2" 3)
su -c "insert into public.session_registrations (session_id, user_id, status) values
  ('$S1', '$A', 'active'), ('$S1', '$A2', 'active'), ('$SF', '$A3', 'active'), ('$S2', '$A4', 'active')" >/dev/null
W=$(su -c "insert into public.manual_participants (full_name, phone, created_by) values ('W179 $n', '070$n', '$M') returning id" | head -1)
su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S1', '$W')" >/dev/null
NOTE_C=$(su -c "insert into public.session_notes (session_id, author_id, body) values ('$S1', '$C', 'coach note') returning id" | head -1)
NOTE_C2=$(su -c "insert into public.session_notes (session_id, author_id, body) values ('$S2', '$C2', 'other coach note') returning id" | head -1)
# A recurring series for coach C, created by the manager (also the P check for manager series creation).
R=$(api "$M" "select public.staff_create_session_series('$D1', '05:05', '$C', 4, 60, true, false, false, null, 'fixed_weeks', 3, false, '{}', '{}')::text;")
okjson "manager creates a recurring series for coach C" "$R"
SER=$(su -c "select id from public.session_series where coach_id = '$C' and start_time = '05:05' order by created_at desc limit 1")
SS1=$(su -c "select id from public.training_sessions where series_id = '$SER' order by session_date limit 1")
expect "series generated sessions" "3" "$(su -c "select count(*) from public.training_sessions where series_id = '$SER'")"

snapshot() { su -c "select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'T' || row(t.*)::text x from public.training_sessions t where t.coach_id in ('$C','$C2')
  union all select 'S' || row(s.*)::text from public.session_series s where s.coach_id in ('$C','$C2')
  union all select 'O' || row(o.*)::text from public.session_series_occurrences o join public.session_series s on s.id = o.series_id where s.coach_id in ('$C','$C2')
  union all select 'R' || row(r.*)::text from public.session_registrations r join public.training_sessions t on t.id = r.session_id where t.coach_id in ('$C','$C2')
  union all select 'M' || row(m.*)::text from public.session_manual_participants m join public.training_sessions t on t.id = m.session_id where t.coach_id in ('$C','$C2')
  union all select 'P' || row(p.*)::text from public.session_roster_slot_prices p join public.training_sessions t on t.id = p.session_id where t.coach_id in ('$C','$C2')
  union all select 'N' || row(nn.*)::text from public.session_notes nn join public.training_sessions t on t.id = nn.session_id where t.coach_id in ('$C','$C2')
  union all select 'W' || row(w.*)::text from public.waitlist_requests w join public.training_sessions t on t.id = w.session_id where t.coach_id in ('$C','$C2')
) q"; }
BEFORE=$(snapshot)

echo "== V3 create sessions"
refused "coach creates a series for self" "$(api "$C" "select public.staff_create_session_series('$D2', '04:35', '$C', 4, 60, true, false, false, null, 'fixed_weeks', 2, false, '{}', '{}')::text;")"
refused "coach creates a one-off (fixed 1 week) session" "$(api "$C" "select public.staff_create_session_series('$D2', '04:35', '$C', 4, 60, true, false, false, null, 'fixed_weeks', 1, false, '{}', '{}')::text;")"
refused "coach creates a series for another coach" "$(api "$C" "select public.staff_create_session_series('$D2', '04:35', '$C2', 4, 60, true, false, false, null, 'ongoing', null, false, '{}', '{}')::text;")"
refused "coach inserts a session directly" "$(api "$C" "insert into public.training_sessions (session_date, start_time, coach_id, max_participants) values ('$D2', '04:35', '$C', 4); select 1;")"
echo "== V4 edit session configuration"
refused "coach changes own session time" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, '08:30', null, null, 60, null, null, null, null)::text;")"
refused "coach changes own session capacity" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, null, 9, 60, null, null, null, null)::text;")"
refused "coach changes own session duration" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, null, null, 90, null, null, null, null)::text;")"
refused "coach closes registration" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, null, null, 60, false, null, null, null)::text;")"
refused "coach hides own session" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, null, null, 60, null, true, null, null)::text;")"
refused "coach sets price through the edit RPC" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, null, null, 60, null, null, null, 1)::text;")"
refused "coach edits own series (this and future)" "$(api "$C" "select public.staff_update_session_series_scope('$SS1', 'future', null, '05:35', null, 6, 60, null, null, null, null)::text;")"
refused "coach reassigns own session" "$(api "$C" "select public.staff_update_session_series_scope('$S1', 'this', null, null, '$C2', null, 60, null, null, null, null)::text;")"
refused "coach edits another coach's session" "$(api "$C" "select public.staff_update_session_series_scope('$S2', 'this', null, '08:30', null, null, 60, null, null, null, null)::text;")"
refused "coach updates own session directly" "$(api "$C" "with u as (update public.training_sessions set max_participants = 9 where id = '$S1' returning 1) select count(*) from u;")"
echo "== V5 move with capacity change / to another coach's session"
refused "coach move raising destination capacity" "$(api "$C" "select public.staff_move_session_participant('$S1', '$SF', '$A', null, false, false, true, false)::text;")"
refused "coach move lowering source capacity" "$(api "$C" "select public.staff_move_session_participant('$S1', '$S1B', '$A', null, false, true, false, false)::text;")"
refused "coach move over capacity" "$(api "$C" "select public.staff_move_session_participant('$S1', '$SF', '$A', null, true, false, false, false)::text;")"
is_full "coach move into a full own session" "$(api "$C" "select public.staff_move_session_participant('$S1', '$SF', '$A', null, false, false, false, false)::text;")"
refused "coach moves into another coach's session" "$(api "$C" "select public.staff_move_session_participant('$S1', '$S2', '$A', null, false, false, false, false)::text;")"
refused "coach moves out of another coach's session" "$(api "$C" "select public.staff_move_session_participant('$S2', '$S1', '$A4', null, false, false, false, false)::text;")"
refused "coach moves a walk-in to own full session over capacity" "$(api "$C" "select public.staff_move_session_participant('$S1', '$SF', null, '$W', true, false, false, false)::text;")"
echo "== V6 / V7 prices"
refused "coach sets own session price" "$(api "$C" "select public.staff_set_session_custom_slot_price('$S1', 1)::text;")"
refused "coach clears own session price" "$(api "$C" "select public.staff_set_session_custom_slot_price('$S1', null)::text;")"
refused "coach sets another coach's session price" "$(api "$C" "select public.staff_set_session_custom_slot_price('$S2', 1)::text;")"
refused "coach sets an athlete's price in own session" "$(api "$C" "select public.staff_set_session_roster_slot_price('$S1', '$A', null, 1)::text;")"
refused "coach sets a walk-in's price in own session" "$(api "$C" "select public.staff_set_session_roster_slot_price('$S1', null, '$W', 1)::text;")"
refused "coach inserts a roster price directly" "$(api "$C" "insert into public.session_roster_slot_prices (session_id, user_id, price_ils) values ('$S1', '$A', 1); select 1;")"
echo "== V8 / Q2 add participants"
refused "coach adds an athlete to another coach's session" "$(api "$C" "select public.coach_add_athlete('$S2', '$A5', false, false)::text;")"
refused "coach adds a walk-in to another coach's session" "$(api "$C" "select public.add_manual_participant_to_session('$S2', '$W', false, false)::text;")"
is_full "coach adds an athlete over capacity to own full session" "$(api "$C" "select public.coach_add_athlete('$SF', '$A5', true, false)::text;")"
is_full "coach adds an athlete to own full session" "$(api "$C" "select public.coach_add_athlete('$SF', '$A5', false, false)::text;")"
is_full "coach adds a walk-in over capacity to own full session" "$(api "$C" "select public.add_manual_participant_to_session('$SF', '$W', true, false)::text;")"
echo "== V9 system maintenance"
refused "coach runs series horizon generation" "$(api "$C" "select public.maintain_session_series_horizon()::text;")"
refused "coach runs duplicate-session cleanup" "$(api "$C" "select public.reconcile_series_duplicate_sessions()::text;")"
echo "== V10 direct walk-in rewrite"
refused "coach moves a walk-in by rewriting session_id" "$(api "$C" "with u as (update public.session_manual_participants set session_id = '$S1B' where session_id = '$S1' and manual_participant_id = '$W' returning 1) select count(*) from u;")"
refused "coach swaps the walk-in on a row" "$(api "$C" "with u as (update public.session_manual_participants set manual_participant_id = gen_random_uuid() where session_id = '$S1' returning 1) select count(*) from u;")"
refused "coach writes a walk-in payment directly" "$(api "$C" "with u as (update public.session_manual_participants set amount_paid = 1 where session_id = '$S1' returning 1) select count(*) from u;")"
echo "== Q3 notes on another coach's session"
refused "coach adds a note to another coach's session" "$(api "$C" "select public.add_session_note('$S2', 'x')::text;")"
refused "coach edits another coach's note" "$(api "$C" "select public.update_session_note('$NOTE_C2', 'x')::text;")"
refused "coach deletes another coach's note" "$(api "$C" "select public.delete_session_note('$NOTE_C2')::text;")"
refused "coach deletes another coach's note directly" "$(api "$C" "with d as (delete from public.session_notes where id = '$NOTE_C2' returning 1) select count(*) from d;")"
echo "== Q1 payments on another coach's session"
refused "coach records attendance in another coach's session" "$(api "$C" "select public.set_registration_attendance('$S2', '$A4', 'arrived', 'cash', 10, false)::text;")"
refused "coach writes a payment directly" "$(api "$C" "with u as (update public.session_registrations set amount_paid = 1 where session_id = '$S1' returning 1) select count(*) from u;")"
echo "== athlete, anon and the other coach"
for who in "athlete:$A" "coach2:$C2"; do label=${who%%:*}; u=${who#*:}
  refused "$label creates a series" "$(api "$u" "select public.staff_create_session_series('$D2', '04:35', '$C', 4, 60, true, false, false, null, 'fixed_weeks', 1, false, '{}', '{}')::text;")"
  refused "$label edits C's session" "$(api "$u" "select public.staff_update_session_series_scope('$S1', 'this', null, '08:30', null, null, 60, null, null, null, null)::text;")"
  refused "$label adds to C's session" "$(api "$u" "select public.coach_add_athlete('$S1', '$A5', false, false)::text;")"
  refused "$label moves in C's sessions" "$(api "$u" "select public.staff_move_session_participant('$S1', '$S1B', '$A', null, false, false, false, false)::text;")"
  refused "$label sets C's session price" "$(api "$u" "select public.staff_set_session_custom_slot_price('$S1', 1)::text;")"
  refused "$label writes series rows" "$(api "$u" "with u as (update public.session_series set max_participants = 9 where id = '$SER' returning 1) select count(*) from u;")"
  refused "$label runs horizon generation" "$(api "$u" "select public.maintain_session_series_horizon()::text;")"
done
for f in "staff_delete_session_series_scope('$S1', 'this')" "staff_create_session_series('$D2', '04:35', '$C', 4, 60, true, false, false, null, 'fixed_weeks', 1, false, '{}', '{}')" \
         "staff_update_session_series_scope('$S1', 'this', null, '08:30', null, null, 60, null, null, null, null)" \
         "staff_move_session_participant('$S1', '$S1B', '$A', null, false, false, false, false)" "staff_set_session_custom_slot_price('$S1', 1)" \
         "staff_set_session_roster_slot_price('$S1', '$A', null, 1)" "coach_add_athlete('$S1', '$A5', false, false)" \
         "add_manual_participant_to_session('$S1', '$W', false, false)" "maintain_session_series_horizon()" "reconcile_series_duplicate_sessions()" "delete_session_note('$NOTE_C')"; do
  refused "anon calls ${f%%(*}" "$(anon "select public.$f::text;")"
done
refused "anon writes series rows" "$(anon "with u as (update public.session_series set max_participants = 9 where id = '$SER' returning 1) select count(*) from u;")"
refused "authenticated truncates session tables" "$(api "$C" "truncate public.session_roster_slot_prices; select 1;")"
echo "== V1 delete sessions"
refused "coach deletes own session" "$(api "$C" "select public.staff_delete_session_series_scope('$S1', 'this')::text;")"
refused "coach deletes another coach's session" "$(api "$C" "select public.staff_delete_session_series_scope('$S2', 'this')::text;")"
refused "coach deletes own series occurrence (this)" "$(api "$C" "select public.staff_delete_session_series_scope('$SS1', 'this')::text;")"
refused "coach ends own series (this and future)" "$(api "$C" "select public.staff_delete_session_series_scope('$SS1', 'future')::text;")"
refused "coach deletes a session directly" "$(api "$C" "with d as (delete from public.training_sessions where id = '$S1' returning 1) select count(*) from d;")"
echo "== V2 recurring series rows"
refused "coach inserts a series row directly" "$(api "$C" "insert into public.session_series (coach_id, anchor_date, start_time, max_participants, repeat_mode) values ('$C', '$D1', '04:05', 4, 'ongoing'); select 1;")"
refused "coach updates own series directly" "$(api "$C" "with u as (update public.session_series set max_participants = 9 where id = '$SER' returning 1) select count(*) from u;")"
refused "coach ends own series directly" "$(api "$C" "with u as (update public.session_series set status = 'ended' where id = '$SER' returning 1) select count(*) from u;")"
refused "coach deletes own series directly" "$(api "$C" "with d as (delete from public.session_series where id = '$SER' returning 1) select count(*) from d;")"
refused "coach C2 rewrites C's series directly" "$(api "$C2" "with u as (update public.session_series set coach_id = '$C2' where id = '$SER' returning 1) select count(*) from u;")"
# Destructive refusals last, so that against an unpatched database every check above still meets intact fixtures.
for who in "athlete:$A" "coach2:$C2"; do label=${who%%:*}; u=${who#*:}
  refused "$label deletes C's session" "$(api "$u" "select public.staff_delete_session_series_scope('$S1', 'this')::text;")"
done
expect "every refusal left every session / series / roster / note row unchanged" "$BEFORE" "$(snapshot)"

echo "== P coach on own sessions"
okjson "coach adds an athlete to own session" "$(api "$C" "select public.coach_add_athlete('$S1B', '$A5', false, false)::text;")"
okjson "coach removes an athlete from own session" "$(api "$C" "select public.coach_remove_athlete('$S1B', '$A5')::text;")"
okjson "coach adds a walk-in to own session" "$(api "$C" "select public.add_manual_participant_to_session('$S1B', '$W', false, false)::text;")"
okjson "coach removes a walk-in from own session" "$(api "$C" "select public.remove_manual_participant_from_session('$S1B', '$W')::text;")"
okjson "coach moves an athlete between own sessions" "$(api "$C" "select public.staff_move_session_participant('$S1', '$S1B', '$A2', null, false, false, false, false)::text;")"
expect "athlete moved, capacities unchanged" "active|3|3" "$(su -c "select r.status || '|' || (select max_participants from public.training_sessions where id = '$S1') || '|' || (select max_participants from public.training_sessions where id = '$S1B') from public.session_registrations r where r.session_id = '$S1B' and r.user_id = '$A2'")"
expect "athlete no longer active in the source" "0" "$(su -c "select count(*) from public.session_registrations where session_id = '$S1' and user_id = '$A2' and status = 'active'")"
OWED_BEFORE=$(su -c "select public.session_billing_price_ils('$S1', '$A')")
okjson "coach records arrival with a partial payment and a method" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'arrived', 'cash', 7.5, false)::text;")"
expect "paid amount, method and recorder stored separately" "true|cash|7.50|$C" "$(su -c "select attended || '|' || payment_method || '|' || amount_paid || '|' || payment_recorded_by from public.session_registrations where session_id = '$S1' and user_id = '$A'")"
expect "the amount owed did not change by recording a payment" "$OWED_BEFORE" "$(su -c "select public.session_billing_price_ils('$S1', '$A')")"
expect "session price untouched" "" "$(su -c "select custom_slot_price_ils from public.training_sessions where id = '$S1' and custom_slot_price_ils is not null")"
expect "payment change written to the activity log" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$C' and event_type = 'registration_attendance_updated' and metadata->>'session_id' = '$S1'")"
okjson "coach records a walk-in's attendance and payment" "$(api "$C" "select public.set_manual_participant_attendance('$S1', '$W', 'arrived', 'bit', 20, false)::text;")"
okjson "coach adds a note to own session" "$(api "$C" "select public.add_session_note('$S1', 'second note')::text;")"
okjson "coach edits own note" "$(api "$C" "select public.update_session_note('$NOTE_C', 'edited')::text;")"
NOTE_C3=$(su -c "select id from public.session_notes where session_id = '$S1' and body = 'second note'")
okjson "coach deletes own note" "$(api "$C" "select public.delete_session_note('$NOTE_C3')::text;")"
expect "coach still reads own session's series" "1" "$(api "$C" "select count(*) from public.session_series where id = '$SER';" | tail -1)"

echo "== P payment corrections and no-show charges (owner decisions 2026-10-15: allowed while unreceipted, audited)"
evts() { su -c "select count(*) from public.user_activity_events where actor_user_id = '$C' and event_type = '$1' and metadata->>'session_id' = '$2'"; }
OWED_A=$(su -c "select public.session_billing_price_ils('$S1', '$A')")
PRICE_S1=$(su -c "select coalesce(custom_slot_price_ils::text, '-') from public.training_sessions where id = '$S1'")
E0=$(evts registration_attendance_updated "$S1")
okjson "coach records a payment (cash 50)" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'arrived', 'cash', 50, false)::text;")"
okjson "coach corrects it (bit 40)" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'arrived', 'bit', 40, false)::text;")"
expect "correction stored" "bit|40.00" "$(su -c "select payment_method || '|' || amount_paid from public.session_registrations where session_id = '$S1' and user_id = '$A'")"
okjson "coach clears the payment (recorded by mistake)" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'arrived', null, null, false)::text;")"
expect "payment cleared, attendance kept" "true|-|-" "$(su -c "select attended || '|' || coalesce(payment_method, '-') || '|' || coalesce(amount_paid::text, '-') from public.session_registrations where session_id = '$S1' and user_id = '$A'")"
okjson "coach marks the athlete absent with a no-show charge" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'absent', null, null, true)::text;")"
expect "no-show charge stored" "false|true" "$(su -c "select attended || '|' || charge_no_show from public.session_registrations where session_id = '$S1' and user_id = '$A'")"
expect "each of the 4 changes is in the activity log" "$((E0 + 4))" "$(evts registration_attendance_updated "$S1")"
expect "the log records the correction from cash 50 to bit 40" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$C' and metadata->>'session_id' = '$S1' and metadata->'changes'->'amount_paid'->>'from' = '50.00' and metadata->'changes'->'amount_paid'->>'to' = '40.00'")"
expect "the log records the no-show charge" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$C' and metadata->>'session_id' = '$S1' and metadata->'changes'->'charge_no_show'->>'to' = 'true'")"
expect "the amount owed is unchanged by corrections" "$OWED_A" "$(su -c "select public.session_billing_price_ils('$S1', '$A')")"
expect "the session price is unchanged" "$PRICE_S1" "$(su -c "select coalesce(custom_slot_price_ils::text, '-') from public.training_sessions where id = '$S1'")"
EW0=$(evts manual_participant_attendance_updated "$S1")
okjson "coach corrects a walk-in payment (cash 15)" "$(api "$C" "select public.set_manual_participant_attendance('$S1', '$W', 'arrived', 'cash', 15, false)::text;")"
expect "walk-in correction stored" "cash|15.00" "$(su -c "select payment_method || '|' || amount_paid from public.session_manual_participants where session_id = '$S1' and manual_participant_id = '$W'")"
expect "walk-in correction is in the activity log" "$((EW0 + 1))" "$(evts manual_participant_attendance_updated "$S1")"

echo "== P manager and super user keep configuration"
okjson "manager changes time and capacity (this)" "$(api "$M" "select public.staff_update_session_series_scope('$S1', 'this', null, '06:10', null, 4, 60, null, null, null, null)::text;")"
okjson "manager edits a series (this and future)" "$(api "$M" "select public.staff_update_session_series_scope('$SS1', 'future', null, '05:10', null, 5, 60, null, null, null, null)::text;")"
expect "series update reached every future occurrence" "3" "$(su -c "select count(*) from public.training_sessions where series_id = '$SER' and start_time = '05:10' and max_participants = 5")"
okjson "manager sets a session price" "$(api "$M" "select public.staff_set_session_custom_slot_price('$S1', 55)::text;")"
okjson "manager sets an athlete's price in a session" "$(api "$M" "select public.staff_set_session_roster_slot_price('$S1', '$A', null, 44)::text;")"
works "manager writes a roster price directly" "$(api "$M" "update public.session_roster_slot_prices set price_ils = 45 where session_id = '$S1' and user_id = '$A'; select 1;")"
works "manager writes series rows directly" "$(api "$M" "update public.session_series set skip_dates = skip_dates where id = '$SER'; select 1;")"
okjson "manager moves with destination capacity raised" "$(api "$M" "select public.staff_move_session_participant('$S1B', '$SF', '$A2', null, false, false, true, false)::text;")"
expect "manager move raised the destination capacity" "2" "$(su -c "select max_participants from public.training_sessions where id = '$SF'")"
okjson "manager adds over capacity" "$(api "$M" "select public.coach_add_athlete('$SF', '$A5', true, false)::text;")"
expect "manager over-capacity add stored" "3" "$(su -c "select count(*) from public.session_registrations where session_id = '$SF' and status = 'active'")"
okjson "manager runs horizon generation" "$(api "$M" "select public.maintain_session_series_horizon()::text;")"
okjson "manager runs duplicate cleanup" "$(api "$M" "select public.reconcile_series_duplicate_sessions()::text;")"
works "manager updates a walk-in row directly" "$(api "$M" "update public.session_manual_participants set amount_paid = amount_paid where session_id = '$S1'; select 1;")"
okjson "super user edits a session" "$(api "$SU" "select public.staff_update_session_series_scope('$S2', 'this', null, '07:10', null, null, 60, null, null, null, null)::text;")"
SX=$(sess "$D2" 09:05 "$C2" 2)
okjson "super user deletes a session" "$(api "$SU" "select public.staff_delete_session_series_scope('$SX', 'this')::text;")"
okjson "manager deletes one occurrence" "$(api "$M" "select public.staff_delete_session_series_scope('$SS1', 'this')::text;")"
SS2=$(su -c "select id from public.training_sessions where series_id = '$SER' order by session_date limit 1")
okjson "manager ends the series (this and future)" "$(api "$M" "select public.staff_delete_session_series_scope('$SS2', 'future')::text;")"
expect "series ended and its future sessions removed" "ended|0" "$(su -c "select status || '|' || (select count(*) from public.training_sessions where series_id = '$SER') from public.session_series where id = '$SER'")"

echo "== Q3 note after the session is reassigned"
okjson "manager reassigns S1 to coach C2" "$(api "$M" "select public.staff_update_session_series_scope('$S1', 'this', null, null, '$C2', null, 60, null, null, null, null)::text;")"
refused "former coach edits own note on a session no longer theirs" "$(api "$C" "select public.update_session_note('$NOTE_C', 'late edit')::text;")"
refused "former coach deletes own note on a session no longer theirs" "$(api "$C" "select public.delete_session_note('$NOTE_C')::text;")"
refused "former coach edits that note directly" "$(api "$C" "with u as (update public.session_notes set body = 'late' where id = '$NOTE_C' returning 1) select count(*) from u;")"
refused "former coach deletes that note directly" "$(api "$C" "with d as (delete from public.session_notes where id = '$NOTE_C' returning 1) select count(*) from d;")"
refused "former coach records attendance there" "$(api "$C" "select public.set_registration_attendance('$S1', '$A', 'absent', null, null, false)::text;")"
expect "note unchanged" "edited" "$(su -c "select body from public.session_notes where id = '$NOTE_C'")"

echo "== C concurrency: the last place in a session"
race() { # $1 label, $2 sql for the first (holds the session row lock for 2 s), $3 uid1, $4 sql second, $5 uid2
  local o1; o1=$(mktemp)
  ( api "$3" "$2 select pg_sleep(2);" > "$o1" ) &
  sleep 0.7
  local r2; r2=$(api "$5" "$4"); wait
  echo "$(cat "$o1" | head -1) || $r2"; rm -f "$o1"; }
SR=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 1, '23:05', '$C', 1, true) returning id" | head -1)
OUT=$(race "two coach adds" "select public.coach_add_athlete('$SR', '$A3', false, false)::text;" "$C" "select public.coach_add_athlete('$SR', '$A4', true, false)::text;" "$C")
expect "two concurrent coach adds (one asking over capacity) fill exactly 1 of 1 places" "1" "$(su -c "select count(*) from public.session_registrations where session_id = '$SR' and status = 'active'")"
case "$OUT" in *'"full"'*) ok "C the second add was told the session is full";; *) fail "C second add: $OUT";; esac
SR2=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 1, '23:35', '$C', 1, true) returning id" | head -1)
OUT=$(race "coach vs athlete" "select public.coach_add_athlete('$SR2', '$A3', true, false)::text;" "$C" "select public.register_for_session('$SR2', false)::text;" "$A5")
expect "coach add racing an athlete's self-registration fills exactly 1 of 1 places" "1" "$(su -c "select count(*) from public.session_registrations where session_id = '$SR2' and status = 'active'")"
case "$OUT" in *'"ok" : true'*) ok "C the coach got the place";; *) fail "C coach vs athlete: $OUT";; esac

SR3=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 1, '22:05', '$C', 1, true) returning id" | head -1)
OUT=$(race "manager override vs coach" "select public.coach_add_athlete('$SR3', '$A3', true, false)::text;" "$M" "select public.coach_add_athlete('$SR3', '$A4', true, false)::text;" "$C")
expect "manager override racing a coach's over-capacity attempt: manager in, coach held to capacity (1 of 1)" "1" "$(su -c "select count(*) from public.session_registrations where session_id = '$SR3' and status = 'active'")"
case "$OUT" in *'"ok" : true'*'"full"'*) ok "C manager got the place, the coach was told full";; *) fail "C manager vs coach: $OUT";; esac
SR4=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date + 1, '22:35', '$C', 1, true) returning id" | head -1)
OUT=$(race "coach first, manager override second" "select public.coach_add_athlete('$SR4', '$A3', false, false)::text;" "$C" "select public.coach_add_athlete('$SR4', '$A4', true, false)::text;" "$M")
expect "coach takes the last place, the manager's override still adds one over capacity (2 on a 1-place session)" "2" "$(su -c "select count(*) from public.session_registrations where session_id = '$SR4' and status = 'active'")"
case "$OUT" in *'"ok" : true'*'"ok" : true'*) ok "C both succeeded (manager override works on the first attempt)";; *) fail "C coach then manager: $OUT";; esac
expect "capacity itself unchanged by the override" "1" "$(su -c "select max_participants from public.training_sessions where id = '$SR4'")"
OUT=$(race "manager without override vs coach" "select public.coach_add_athlete('$SR3', '$A5', false, false)::text;" "$M" "select public.add_manual_participant_to_session('$SR3', '$W', true, false)::text;" "$C")
case "$OUT" in *'"full"'*'"full"'*) ok "C on a full session, a manager without the override and a coach walk-in over capacity are both refused";; *) fail "C full refusals: $OUT";; esac
expect "full session still 1 of 1" "1|0" "$(su -c "select (select count(*) from public.session_registrations where session_id = '$SR3' and status = 'active') || '|' || (select count(*) from public.session_manual_participants where session_id = '$SR3')")"

echo
echo "179 coach session permissions: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
