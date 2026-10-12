#!/usr/bin/env bash
# Regression test for 20261014150000_athlete_subscription_next_week_usage.sql (get_my_subscription.next_week).
#
# Real RPCs over an `authenticator` connection (JWT claims, one transaction per call). Each athlete has a group-tier
# subscription (weekly limit 2) created by the manager; sessions are group sessions (cap 8) in NEXT studio week (N = next
# Sunday). Checks next_week.window_days / active_days / frozen_days and usage[group] = effective / used / extra:
#   E1 full next week: 2 covered + 1 extra (athlete confirmed the charge); an on-time cancellation stops counting; a
#      waitlist entry never counts; this week's rows keep their shape (+ extra)
#   E2 subscription ends Tuesday of next week   -> 3 window days, prorated limit 1
#   E3 subscription ends this week              -> next week inactive (0 days, no usage rows)
#   E4 whole next week frozen                   -> 6 frozen days, limit 0
#   E5 subscription starts Wednesday next week  -> 3 window days, prorated limit 1
#   E6 terms acceptance pending (enforcement on) -> quota shown as usual (consent never affects the subscription)
#   E7 week boundaries are Sunday-Saturday in the studio timezone; anon refused
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/168_athlete_next_week_usage_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
contains() { case "$3" in *"$2"*) ok "$1";; *) fail "$1: expected '$2' in '$(echo "$3" | head -2 | cut -c1-200)'";; esac; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
trap 'su -c "update public.app_settings set subscription_terms_enforced = false where id = 1" >/dev/null 2>&1' EXIT

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); E1=$(uid); E2=$(uid); E3=$(uid); E4=$(uid); E5=$(uid); E6=$(uid); W1=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f168-$n-' || u.k || '@t.local',
         jsonb_build_object('full_name', 'F168 ' || u.k, 'phone', '07' || u.k || '$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, '1'), ('$C'::uuid, '2'), ('$E1'::uuid, '3'), ('$E2'::uuid, '4'), ('$E3'::uuid, '5'),
               ('$E4'::uuid, '6'), ('$E5'::uuid, '7'), ('$E6'::uuid, '8'), ('$W1'::uuid, '9')) u(id, k);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$E1','$E2','$E3','$E4','$E5','$E6','$W1');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
TODAY=$(su -c "select public._studio_today_date()")
W=$(su -c "select public._week_start_sunday(public._studio_today_date())")
N=$(su -c "select date '$W' + 7")
d() { su -c "select date '$1' + $2"; }
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (date '$N' + $1, '$2', '$C', ${3:-8}, true) returning id" | head -1; }
ALLOW="jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2))"
create_sub() { jf "$(api "$M" "select public.create_subscription('$1', false, 280, '$2', $3, null, $ALLOW)::text;" | grep '^{')" subscription_id; }
gms() { api "$1" "select public.get_my_subscription()::text;" | grep '^{'; }
nw() { jf "$1" "next_week,$2"; }
grp() { su -c "select coalesce((select e->>'$3' from jsonb_array_elements(('$1'::jsonb)->'$2') e where e->>'tier' = 'group'), 'none')"; }
grpn() { su -c "select coalesce((select e->>'$2' from jsonb_array_elements(('$1'::jsonb)->'next_week'->'usage') e where e->>'tier' = 'group'), 'none')"; }

echo "== E7: week boundaries"
G=$(gms "$M")
expect "athlete without a subscription" "false" "$(jf "$G" has_subscription)"
SE1=$(create_sub "$E1" "$TODAY" null)
G=$(gms "$E1")
expect "this week starts on Sunday (studio timezone)" "$W|0" "$(jf "$G" week_start)|$(su -c "select extract(dow from date '$W')::int")"
expect "next week = the following Sunday" "$N" "$(nw "$G" week_start)"
expect "next week ends on Saturday" "$(d "$N" 6)|6" "$(nw "$G" week_end)|$(su -c "select extract(dow from date '$(nw "$G" week_end)')::int")"
contains "anon gets nothing (pre-existing not_authenticated guard)" "not_authenticated" "$(api_as anon "" "select public.get_my_subscription()::text;")"

echo "== E1: full next week with covered, extra, cancelled and waitlisted sessions"
S1=$(sess 1 "10:05"); S2=$(sess 2 "10:05"); S3=$(sess 3 "10:05"); S4=$(sess 4 "10:05"); SF=$(sess 5 "10:05" 1)
expect "next week: 6 window / 6 active / 0 frozen" "6|6|0" "$(nw "$G" window_days)|$(nw "$G" active_days)|$(nw "$G" frozen_days)"
expect "next week before registering: limit 2, used 0, extra 0" "2|0|0" "$(grpn "$G" effective_weekly_limit)|$(grpn "$G" used)|$(grpn "$G" extra)"
api "$E1" "select public.register_for_session('$S1')::text;" >/dev/null
api "$E1" "select public.register_for_session('$S2')::text;" >/dev/null
contains "third registration needs the athlete's confirmation" "allowance_exceeded" "$(api "$E1" "select public.register_for_session('$S3')::text;")"
api "$E1" "select public.register_for_session('$S3', true)::text;" >/dev/null
api "$W1" "select public.register_for_session('$SF')::text;" >/dev/null
contains "E1 joins the waitlist of a full session" '"ok" : true' "$(api "$E1" "select public.request_waitlist('$SF')::text;")"
G=$(gms "$E1")
expect "next week: limit 2, used 2, extra 1 (waitlist not counted)" "2|2|1" "$(grpn "$G" effective_weekly_limit)|$(grpn "$G" used)|$(grpn "$G" extra)"
expect "this week unaffected by next week's bookings" "0|0" "$(grp "$G" weekly_usage used)|$(grp "$G" weekly_usage extra)"
contains "this week's rows keep their fields" '"configured_weekly_limit"' "$(su -c "select ('$G'::jsonb)->'weekly_usage'")"
contains "on-time cancellation" '"ok" : true' "$(api "$E1" "select public.cancel_registration('$S1', 'test')::text;")"
G=$(gms "$E1")
expect "on-time cancellation stops counting (no double count, no charge)" "1|1" "$(grpn "$G" used)|$(grpn "$G" extra)"
su -c "update public.cancellations set charged_full_price = true where session_id = '$S1' and user_id = '$E1'" >/dev/null
G=$(gms "$E1")
expect "a full-price late cancellation counts as used" "2" "$(grpn "$G" used)"
expect "registrations counted once each" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id = '$SE1' and week_start = '$N'")" "3"

echo "== E2: subscription ends on Tuesday of next week"
create_sub "$E2" "$TODAY" "date '$N' + 2" >/dev/null
G=$(gms "$E2")
expect "3 window days (Sun-Tue), prorated limit 1" "3|3|1" "$(nw "$G" window_days)|$(nw "$G" active_days)|$(grpn "$G" effective_weekly_limit)"

echo "== E3: subscription ends this week"
create_sub "$E3" "$TODAY" "date '$W' + 6" >/dev/null
G=$(gms "$E3")
expect "next week inactive: 0 window days, no usage rows" "0|0|[]" "$(nw "$G" window_days)|$(nw "$G" active_days)|$(su -c "select ('$G'::jsonb)->'next_week'->'usage'")"

echo "== E4: whole next week frozen"
SE4=$(create_sub "$E4" "$TODAY" null)
contains "freeze next week" '"ok" : true' "$(api "$M" "select public.freeze_subscription('$SE4', '$N', date '$N' + 6, true)::text;")"
G=$(gms "$E4")
expect "6 frozen days, 0 active, limit 0" "6|0|6|0" "$(nw "$G" window_days)|$(nw "$G" active_days)|$(nw "$G" frozen_days)|$(grpn "$G" effective_weekly_limit)"

echo "== E5: subscription starts on Wednesday of next week"
create_sub "$E5" "$(d "$N" 3)" null >/dev/null
G=$(gms "$E5")
expect "3 window days (Wed-Fri), prorated limit 1" "3|3|1" "$(nw "$G" window_days)|$(nw "$G" active_days)|$(grpn "$G" effective_weekly_limit)"

echo "== E6: terms acceptance pending"
su -c "update public.app_settings set subscription_terms_enforced = true where id = 1" >/dev/null
create_sub "$E6" "$TODAY" null >/dev/null
G=$(gms "$E6")
expect "pending acceptance does not change the quota" "6|2" "$(nw "$G" active_days)|$(grpn "$G" effective_weekly_limit)"
su -c "update public.app_settings set subscription_terms_enforced = false where id = 1" >/dev/null

echo
echo "168 athlete next-week usage: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
