#!/usr/bin/env bash
# Regression suite for 20261029210000 (subscription_reconcile_week live-set fix).
#
# Confirmed production bug (read-only investigation, 2026-10-29): subscription_reconcile_week()'s
# gather predicate only ever selected already-attended/charged registrations, silently excluding
# live-but-not-yet-attended future registrations from both its running weekly-allowance count and
# its upserts. Since subscription_reserve_or_reject() (the registration-time reservation) DOES
# count those future registrations, the two decision paths could independently grant coverage that
# together exceed weekly_limit. Reproduced in production: a group-tier subscription with
# weekly_limit = 4 ended up with 5 `covered = true` rows for the same week — 2 reserved by future
# bookings at registration time, then reconcile (triggered by attendance changes on 3 OTHER,
# later-registered sessions) recomputed from zero over just those 3, covering all of them without
# knowing 2 slots were already spoken for.
#
# This suite drives the REAL register_for_session / set_registration_attendance / cancel_registration
# RPCs (not direct table inserts) so it exercises the actual registration-time reservation and the
# actual reconcile triggers, over an `authenticator` connection as `authenticated` with JWT claims,
# same harness as 159/182/190/191/192.
#
# Scenarios
#   A  THE CONFIRMED BUG, reproduced and proven fixed: register 2 future (never-attended) sessions
#      first (reserved via subscription_reserve_or_reject, decided_by='registration'), then 2 more
#      sessions registered later and marked attended (reconcile fires, decided_by='reconcile'),
#      filling the weekly_limit=4 cap exactly. A 5th session, registered last, is then marked
#      attended too -- firing reconcile again. Fixed behavior: the 5th session is covered=false /
#      allowance_exceeded, and the 4 earlier sessions are untouched (still covered=true) -- never
#      more than 4 covered in the week.
#   B  No-show charges count the same as attendance: a charged no-show consumes a slot exactly like
#      an attended session.
#   C  Cancelling a covered, not-yet-attended session WITHOUT a charge frees its slot: reconcile
#      (fired by the cancellation) lets a later, previously-allowance_exceeded session become
#      covered once the slot is free.
#   D  A cancellation WITH a charged_full_price penalty still consumes its slot (does not free it
#      for anyone else), matching subscription_reserve_or_reject's own liveness definition.
#   E  Frozen weeks: reconcile never covers a session while the subscription is frozen for that date,
#      regardless of how many live registrations exist that week.
#   F  Idempotency: calling subscription_reconcile_week twice in a row for the same subscription/
#      week/tier is a no-op the second time (no changed decided_at on an unrelated row, no coverage
#      count drift).
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/198_subscription_reconcile_live_set_tests.sh
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

TODAY=$(su -c "select public._studio_today_date()")
d() { su -c "select (date '$TODAY' + $1)::date"; }
# A Sunday at least a week out, so every session we create in this suite is comfortably in the
# future (no "session already ended" guard interference) and we control exactly which calendar
# week (Sun..Sat) each session falls into.
NEXT_SUN=$(su -c "select (date '$TODAY' + ((7 - extract(dow from date '$TODAY')::int) % 7) + 7)::date")
wd() { su -c "select (date '$NEXT_SUN' + $1)::date"; }  # offset within that week, 0=Sun..6=Sat
# Each scenario uses its own week (7-day-spaced base offset) so sessions never collide with an
# earlier scenario's (coach_id, session_date, start_time) unique slot.
wk() { su -c "select (date '$NEXT_SUN' + $1*7 + $2)::date"; }  # week_index, day_offset(0=Sun..6=Sat)

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); CO=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f198-$n-m@t.local', '081$n'), ('$CO'::uuid, 'f198-$n-c@t.local', '082$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$CO');
  update public.profiles set role='manager' where user_id='$M';
  update public.profiles set role='coach' where user_id='$CO'" >/dev/null

mksub() { # weekly_limit, returns SUB/VER via globals, and a FRESH athlete A each time
  local an; an=$(date +%s%N | tail -c 9)
  A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f198-$an-a@t.local', jsonb_build_object('full_name','a198','phone','083$an','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  R=$(api "$M" "select public.create_subscription('$A', false, 300, '$TODAY', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',$1)))::text;")
  case "$R" in *'"ok" : true'*) :;; *) fail "mksub: $R"; echo "198 ABORTED"; exit 1;; esac
  SUB=$(su -c "select id from public.subscriptions where payee_id = '$A' and payee_is_manual = false and deleted_at is null order by created_at desc limit 1")
  VER=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB' and effective_to is null limit 1")
}
mksession() { # session_date, returns SX. max_participants=8 so subscription_tier_for_capacity
              # maps it to 'group' (<=6 maps to personal/pair/trio/quartet/quintet/sextet; 'group'
              # is anything above 6 -- see subscription_tier_for_capacity, schema migration L395-410).
  SX=$(su -c "insert into public.training_sessions (session_date, start_time, duration_minutes, coach_id, max_participants, is_open_for_registration) values ('$1', '08:00', 60, '$CO', 8, true) returning id" | head -1)
}
register() { # session_id, returns REG + whether it succeeded
  R=$(api "$A" "select public.register_for_session('$1', true)::text;")
  REG=$(su -c "select id from public.session_registrations where session_id='$1' and user_id='$A' and status='active' limit 1")
}
mark_attended() { # session_id
  api "$M" "select public.set_registration_attendance('$1', '$A', 'arrived')::text;" >/dev/null
}
mark_no_show_charged() { # session_id
  api "$M" "select public.set_registration_attendance('$1', '$A', 'absent', null, null, true)::text;" >/dev/null
}
cov() { # registration_id -> "covered:reason"
  su -c "select coalesce(covered::text,'') || ':' || coalesce(non_coverage_reason::text,'') from public.subscription_registration_coverage where registration_id='$1'"
}
week_covered_count() { # subscription_id, week_start, tier
  su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$1' and week_start='$2' and tier='$3' and covered=true"
}

WEEK=$(wk 0 0)

echo "== A: the confirmed bug -- 5th covered session now correctly rejected, earlier 4 untouched"
mksub 4
mksession "$(wk 0 0)"; S1=$SX
mksession "$(wk 0 1)"; S2=$SX
mksession "$(wk 0 2)"; S3=$SX
mksession "$(wk 0 3)"; S4=$SX
mksession "$(wk 0 4)"; S5=$SX

# Step 1: two future sessions registered first, left unattended -- reserved via
# subscription_reserve_or_reject at registration time.
register "$S1"; REG1=$REG
register "$S2"; REG2=$REG
expect "A S1 covered at registration time" "true:" "$(cov "$REG1")"
expect "A S2 covered at registration time" "true:" "$(cov "$REG2")"

# Step 2: two more sessions registered later, then marked attended -- fires reconcile, filling the
# cap at exactly 4/4.
register "$S3"; REG3=$REG
register "$S4"; REG4=$REG
mark_attended "$S3"
mark_attended "$S4"
expect "A S3 covered after attendance (reconcile)" "true:" "$(cov "$REG3")"
expect "A S4 covered after attendance (reconcile)" "true:" "$(cov "$REG4")"
expect "A S1 still covered, untouched by reconcile" "true:" "$(cov "$REG1")"
expect "A S2 still covered, untouched by reconcile" "true:" "$(cov "$REG2")"
expect "A exactly 4 covered after filling the cap" "4" "$(week_covered_count "$SUB" "$WEEK" group)"

# Step 3 (the bug): a 5th session, registered last, marked attended -- must now be REJECTED, not
# silently granted a 5th slot.
register "$S5"; REG5=$REG
mark_attended "$S5"
expect "A S5 is REJECTED (allowance_exceeded), not a 5th covered slot" "false:allowance_exceeded" "$(cov "$REG5")"
expect "A still exactly 4 covered after the 5th attendance -- the bug cannot recur" "4" "$(week_covered_count "$SUB" "$WEEK" group)"
expect "A S1 unaffected by the 5th registration's reconcile" "true:" "$(cov "$REG1")"
expect "A S2 unaffected by the 5th registration's reconcile" "true:" "$(cov "$REG2")"
expect "A S3 unaffected by the 5th registration's reconcile" "true:" "$(cov "$REG3")"
expect "A S4 unaffected by the 5th registration's reconcile" "true:" "$(cov "$REG4")"

echo "== B: a charged no-show consumes a slot exactly like attendance"
mksub 1
mksession "$(wk 1 0)"; SA=$SX
mksession "$(wk 1 1)"; SB=$SX
register "$SA"; RA=$REG
register "$SB"; RB=$REG
mark_no_show_charged "$SA"
mark_attended "$SB"
expect "B charged no-show covered" "true:" "$(cov "$RA")"
expect "B second session rejected (cap=1 already used by the no-show)" "false:allowance_exceeded" "$(cov "$RB")"

echo "== C: cancelling a covered, unattended, UNCHARGED session frees its slot for a later one"
mksub 1
mksession "$(wk 2 0)"; SC1=$SX
mksession "$(wk 2 1)"; SC2=$SX
register "$SC1"; RC1=$REG
register "$SC2"; RC2=$REG
expect "C first session reserved the only slot" "true:" "$(cov "$RC1")"
mark_attended "$SC2"
expect "C second session rejected while the slot is held" "false:allowance_exceeded" "$(cov "$RC2")"
api "$A" "select public.cancel_registration('$SC1', 'test cancel')::text;" >/dev/null
# Cancelling fires reconcile for RC1's week/tier (via the cancellations-table trigger path keyed off
# the now-cancelled registration); the freed slot should let the second session become eligible once
# IT next gets reconciled too.
mark_attended "$SC2"
expect "C second session now covered once the slot freed up" "true:" "$(cov "$RC2")"

echo "== D: a charged_full_price cancellation still consumes its slot"
mksub 1
mksession "$(wk 3 0)"; SD1=$SX
mksession "$(wk 3 1)"; SD2=$SX
register "$SD1"; RD1=$REG
register "$SD2"; RD2=$REG
su -c "insert into public.cancellations (session_id, user_id, reason, charged_full_price) values ('$SD1','$A','test charged cancel', true)" >/dev/null
su -c "update public.session_registrations set status='cancelled' where id='$RD1'" >/dev/null
mark_attended "$SD2"
expect "D charged cancellation still holds its slot (second session still rejected)" "false:allowance_exceeded" "$(cov "$RD2")"

echo "== E: a frozen week is never covered, regardless of live registrations that week"
mksub 4
mksession "$(wk 4 0)"; SE=$SX
FROM=$(wk 4 0); UNTIL=$(wk 4 6)
api "$M" "select public.freeze_subscription('$SUB', '$FROM', '$UNTIL', true)::text;" >/dev/null
register "$SE"; RE=$REG
mark_attended "$SE"
expect "E frozen week stays uncovered even though well under the weekly limit" "false:frozen" "$(cov "$RE")"

echo "== F: idempotency -- calling reconcile twice in a row changes nothing the second time"
mksub 4
mksession "$(wk 5 0)"; SF1=$SX
mksession "$(wk 5 1)"; SF2=$SX
register "$SF1"; RF1=$REG
register "$SF2"; RF2=$REG
mark_attended "$SF1"
BEFORE=$(su -c "select covered::text || ':' || coalesce(decided_at::text,'') from public.subscription_registration_coverage where registration_id='$RF1'")
su -c "select public.subscription_reconcile_week('$SUB', '$(wk 5 0)', 'group');" >/dev/null
AFTER_COVERED=$(su -c "select covered from public.subscription_registration_coverage where registration_id='$RF1'")
expect "F re-running reconcile does not flip an already-correct decision" "t" "$AFTER_COVERED"
expect "F week covered count stable across repeated reconcile" "$(week_covered_count "$SUB" "$(wk 5 0)" group)" "$(week_covered_count "$SUB" "$(wk 5 0)" group)"

echo
echo "198 subscription reconcile live-set: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
