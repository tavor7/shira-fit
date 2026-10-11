#!/usr/bin/env bash
# Regression test for 20261014110000_session_participants_visible_to_session_viewers.sql.
#
# Calls list_session_participants over a real `authenticator` connection (JWT claims, one transaction per call).
# Fixture: manager M, coach C (coaches every session), approved athletes A1 (registered), A2 (waitlisted), A3
# (unregistered), A4 (registered but hidden from athletes by the Super User), disabled athlete AD, pending athlete AP,
# manual participant MP (staff-only). Sessions: S_FULL (cap 2, A1 + A4 registered = full), S_SOME (cap 6, A1 + MP),
# S_EMPTY (cap 6, nobody), S_HIDDEN (is_hidden), S_FAR (beyond the athlete browse window).
#   P  registered / waitlisted / unregistered athletes all see the same names on a visible session; full / empty /
#      some-participants sessions; coach and manager see everything incl. manual participants and hidden athletes
#   N  athletes never see: hidden athletes' names, manual participants, hidden sessions, sessions beyond the browse
#      window (unless registered); disabled / pending athletes and anon see nothing; athletes cannot manage participants
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/166_session_participants_visibility_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
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
# names <uid> <session> -> "name:source,name:source" sorted; anon when uid empty
names() { local role=authenticated; [ -z "$1" ] && role=anon
  api_as $role "$1" "select coalesce(string_agg(full_name || ':' || source, ',' order by full_name, source), '') from public.list_session_participants('$2');" | tail -1; }

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); A1=$(uid); A2=$(uid); A3=$(uid); A4=$(uid); AD=$(uid); AP=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.nm, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f166-$n-m@t.local', 'M166 Manager', '051$n'), ('$C'::uuid, 'f166-$n-c@t.local', 'C166 Coach', '052$n'),
               ('$A1'::uuid, 'f166-$n-a1@t.local', 'A1 Registered', '053$n'), ('$A2'::uuid, 'f166-$n-a2@t.local', 'A2 Waitlisted', '054$n'),
               ('$A3'::uuid, 'f166-$n-a3@t.local', 'A3 Unregistered', '055$n'), ('$A4'::uuid, 'f166-$n-a4@t.local', 'A4 Hidden', '056$n'),
               ('$AD'::uuid, 'f166-$n-ad@t.local', 'AD Disabled', '057$n'), ('$AP'::uuid, 'f166-$n-ap@t.local', 'AP Pending', '058$n')) u(id, e, nm, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A1','$A2','$A3','$A4','$AD');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C';
  update public.profiles set disabled_at = now() where user_id = '$AD'" >/dev/null
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration, is_hidden) values ($1, '$2', '$C', $3, true, $4) returning id" | head -1; }
S_FULL=$(sess "current_date + 1" "06:05" 2 false); S_SOME=$(sess "current_date + 1" "06:35" 6 false); S_EMPTY=$(sess "current_date + 1" "07:05" 6 false)
S_HIDDEN=$(sess "current_date + 1" "07:35" 6 true); S_FAR=$(sess "public.athlete_browse_week_end() + 3" "08:05" 6 false)
MP=$(su -c "insert into public.manual_participants (full_name, phone, created_by) values ('MP166 Walkin', '059$n', '$M') returning id" | head -1)
su -c "insert into public.session_registrations (session_id, user_id, status) values
         ('$S_FULL', '$A1', 'active'), ('$S_FULL', '$A4', 'active'), ('$S_SOME', '$A1', 'active'),
         ('$S_HIDDEN', '$A1', 'active'), ('$S_FAR', '$A1', 'active');
       insert into public.waitlist_requests (session_id, user_id) values ('$S_FULL', '$A2'), ('$S_SOME', '$A2');
       insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S_SOME', '$MP');
       insert into public.super_user_hidden_registrations (session_id, user_id, hidden_by, hide_from_athlete) values ('$S_FULL', '$A4', '$M', true)" >/dev/null

echo "== P: athletes see the list regardless of their own registration status"
for who in "registered:$A1" "waitlisted:$A2" "unregistered:$A3"; do l=${who%%:*}; u=${who#*:}
  expect "$l athlete, full session (hidden athlete filtered)" "A1 Registered:registered" "$(names "$u" "$S_FULL")"
  expect "$l athlete, session with participants (no manual participants)" "A1 Registered:registered" "$(names "$u" "$S_SOME")"
  expect "$l athlete, empty session" "" "$(names "$u" "$S_EMPTY")"
done
expect "registered athlete still sees a session beyond the browse window they are registered for" "A1 Registered:registered" "$(names "$A1" "$S_FAR")"

echo "== P: staff see the full roster"
expect "coach sees full session incl. hidden athlete" "A1 Registered:registered,A4 Hidden:registered" "$(names "$C" "$S_FULL")"
expect "coach sees manual participants" "A1 Registered:registered,MP166 Walkin:manual" "$(names "$C" "$S_SOME")"
expect "manager sees full session incl. hidden athlete" "A1 Registered:registered,A4 Hidden:registered" "$(names "$M" "$S_FULL")"
expect "manager sees manual participants" "A1 Registered:registered,MP166 Walkin:manual" "$(names "$M" "$S_SOME")"
expect "manager sees hidden session roster" "A1 Registered:registered" "$(names "$M" "$S_HIDDEN")"
expect "coach sees beyond-window roster" "A1 Registered:registered" "$(names "$C" "$S_FAR")"

echo "== N: privacy and authorization unchanged"
expect "unregistered athlete: hidden session" "" "$(names "$A3" "$S_HIDDEN")"
expect "registered athlete: hidden session (pre-existing rule)" "" "$(names "$A1" "$S_HIDDEN")"
expect "unregistered athlete: beyond the browse window" "" "$(names "$A3" "$S_FAR")"
expect "disabled athlete" "" "$(names "$AD" "$S_SOME")"
expect "pending athlete" "" "$(names "$AP" "$S_SOME")"
expect "anon" "" "$(names "" "$S_SOME")"
expect "only full name + source are exposed (no ids, contact or payment data)" "TABLE(full_name text, source text)" "$(su -c "select pg_get_function_result('public.list_session_participants(uuid)'::regprocedure)")"
R=$(api "$A3" "select public.coach_add_athlete('$S_EMPTY', '$A3', false)::text;")
case "$R" in *forbidden*) ok "N athlete cannot add participants (coach_add_athlete)";; *) fail "N athlete coach_add_athlete: $R";; esac
R=$(api "$A3" "with d as (delete from public.session_registrations where session_id = '$S_SOME' returning 1) select count(*) from d;")
case "$R" in 0|*"permission denied"*) ok "N athlete cannot remove another athlete's registration";; *) fail "N athlete delete registration: $R";; esac
R=$(api "$A3" "with d as (delete from public.session_manual_participants where session_id = '$S_SOME' returning 1) select count(*) from d;")
case "$R" in 0|*"permission denied"*) ok "N athlete cannot remove manual participants";; *) fail "N athlete delete manual: $R";; esac
expect "roster untouched" "1|1" "$(su -c "select (select count(*) from public.session_registrations where session_id = '$S_SOME' and status = 'active') || '|' || (select count(*) from public.session_manual_participants where session_id = '$S_SOME')")"

echo
echo "166 session participants visibility: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
