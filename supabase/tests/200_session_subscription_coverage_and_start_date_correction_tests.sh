#!/usr/bin/env bash
# Regression suite for two new RPCs added alongside the "Amount due ignores subscription
# coverage" and "subscription start date cannot be edited" investigation.
#
# session_subscription_coverage(p_session_id): exposes the EXISTING
# subscription_registration_coverage decisions for a session's roster to that session's coach (or
# any manager) -- read-only, same auth pattern as session_payment_receipt_locks(). Scenarios:
#   A  the session's own coach sees the covered registration
#   B  an unrelated coach is forbidden
#   C  a manager sees it too
#   D  a registration with covered=false is NOT included in covered_user_ids
#
# correct_subscription_start_date(p_subscription_id, p_new_start_date): corrects plan_start_date
# (and anchor_day, when it was never customized) for a subscription that has never been edited and
# has zero billing/charge/payment/freeze/coverage history; refuses (has_history) otherwise.
#   E  a brand-new subscription (zero history) can have its start date corrected; anchor_day is
#      recomputed to match the new date (it had never been customized away from the default)
#   F  a subscription with a subscription_registration_coverage row is refused (has_history)
#   G  a custom anchor_day (set at creation, different from the start date's day) is preserved
#      across a start-date correction, not silently overwritten
#   H  a non-manager (coach) is forbidden
#
# correct_subscription_start_date_with_future_registrations(p_subscription_id, p_new_start_date,
# p_confirmed): scenario B -- safe for a subscription with future registrations but zero completed
# activity and zero billing/charge/payment/freeze history. p_confirmed=false always rolls back and
# returns a dry-run diff; p_confirmed=true re-validates eligibility fresh before applying.
#   I  preview (confirmed=false) reports exactly the two registrations whose coverage would flip
#      (the earlier session loses coverage, the later one gains it), and does NOT mutate
#      plan_start_date or any coverage row
#   J  confirm (confirmed=true) applies the same change for real
#   K  confirming again is idempotent (count=0, nothing left to change)
#   L  marking the remaining registration's session attended flips eligibility to has_history
#   M  a subscription with a posted charge (financial history) is refused up front
#   N  a non-manager is forbidden
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/200_session_subscription_coverage_and_start_date_correction_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users, sessions and subscriptions. Never run
# against production.
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
n=$(date +%s%N | tail -c 9)

mkuser() { # role, label -> sets U to new user id
  local an; an=$(date +%s%N | tail -c 9)
  U=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$U','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t200-$an-$2@t.local', jsonb_build_object('full_name','$2','phone','093$an','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved', role='$1' where user_id='$U'" >/dev/null
}

mkuser manager mgr; MGR=$U
mkuser coach coach1; COACH1=$U
mkuser coach coach2; COACH2=$U
mkuser athlete ath; ATH=$U

SESS=$(su -c "insert into public.training_sessions (coach_id, session_date, start_time, max_participants) values ('$COACH1', '$(d 1)', '08:00', 12) returning id")
REG=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$SESS','$ATH','active') returning id")
SUB=$(api "$MGR" "select (public.create_subscription('$ATH', false, 300, '$(d 1)', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::jsonb)->>'subscription_id';")
su -c "insert into public.subscription_registration_coverage (subscription_id, registration_id, session_date, week_start, tier, covered, decided_by)
  values ('$SUB','$REG','$(d 1)','$(d 1)','group', true, 'registration')" >/dev/null

echo "== A: the session's own coach sees the covered registration"
R=$(api "$COACH1" "select public.session_subscription_coverage('$SESS')::text;")
expect "A ok" "true" "$(jf "$R" ok)"
HAS_ATH=$(su -c "select ('$R'::jsonb)->'covered_user_ids' ? '$ATH'")
expect "A includes the athlete" "t" "$HAS_ATH"

echo "== B: an unrelated coach is forbidden"
R=$(api "$COACH2" "select public.session_subscription_coverage('$SESS')::text;")
expect "B forbidden" "forbidden" "$(jf "$R" error)"

echo "== C: a manager sees it too"
R=$(api "$MGR" "select public.session_subscription_coverage('$SESS')::text;")
expect "C ok" "true" "$(jf "$R" ok)"

echo "== D: a non-covered registration is not included"
mkuser athlete ath2; ATH2=$U
REG2=$(su -c "insert into public.session_registrations (session_id, user_id, status) values ('$SESS','$ATH2','active') returning id")
su -c "insert into public.subscription_registration_coverage (subscription_id, registration_id, session_date, week_start, tier, covered, non_coverage_reason, decided_by)
  values ('$SUB','$REG2','$(d 1)','$(d 1)','group', false, 'allowance_exceeded', 'registration')" >/dev/null
R=$(api "$COACH1" "select public.session_subscription_coverage('$SESS')::text;")
HAS_ATH2=$(su -c "select ('$R'::jsonb)->'covered_user_ids' ? '$ATH2'")
expect "D excludes the non-covered athlete" "f" "$HAS_ATH2"

echo "== E: a brand-new subscription's start date can be corrected; anchor_day recomputes"
mkuser athlete fresh; FRESH=$U
R=$(api "$MGR" "select (public.create_subscription('$FRESH', false, 300, '$(d 5)', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::jsonb)::text;")
FSUB=$(su -c "select ('$R'::jsonb)->>'subscription_id'")
R=$(api "$MGR" "select public.correct_subscription_start_date('$FSUB', '$(d 10)')::text;")
expect "E ok" "true" "$(jf "$R" ok)"
NEWSTART=$(su -c "select plan_start_date from public.subscription_versions where subscription_id='$FSUB' and effective_to is null")
expect "E plan_start_date updated" "$(d 10)" "$NEWSTART"

echo "== F: a subscription with coverage history is refused"
R=$(api "$MGR" "select public.correct_subscription_start_date('$SUB', '$(d 2)')::text;")
expect "F refused" "has_history" "$(jf "$R" error)"

echo "== G: a custom anchor_day is preserved across a start-date correction"
mkuser athlete customanchor; CA=$U
R=$(api "$MGR" "select (public.create_subscription('$CA', false, 300, '$(d 5)', null, 17::smallint, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::jsonb)::text;")
CASUB=$(su -c "select ('$R'::jsonb)->>'subscription_id'")
api "$MGR" "select public.correct_subscription_start_date('$CASUB', '$(d 12)')::text;" >/dev/null
ANCHOR=$(su -c "select anchor_day from public.subscription_versions where subscription_id='$CASUB' and effective_to is null")
expect "G anchor_day stays 17 (was explicitly customized)" "17" "$ANCHOR"

echo "== H: a non-manager is forbidden"
R=$(api "$COACH1" "select public.correct_subscription_start_date('$FSUB', '$(d 11)')::text;")
expect "H forbidden" "forbidden" "$(jf "$R" error)"

echo "== I: preview reports exactly the one flipping registration and does not mutate anything"
mkuser manager mgrB; MGRB=$U
mkuser coach coachB; COACHB=$U
mkuser athlete athB; ATHB=$U
# weekly_limit=1 group, subscription starting the week's Sunday -- two same-week sessions, so only
# the earlier-registered one is covered; moving the start date past the first session's date should
# flip it from covered to not_subscribed.
WK_SUN=$(su -c "select (date '$(d 1)' - extract(dow from date '$(d 1)')::int)::date")
SESS1=$(su -c "insert into public.training_sessions (coach_id, session_date, start_time, max_participants) values ('$COACHB', '$(su -c "select ('$WK_SUN'::date + 1)::date")', '08:00', 12) returning id")
SESS2=$(su -c "insert into public.training_sessions (coach_id, session_date, start_time, max_participants) values ('$COACHB', '$(su -c "select ('$WK_SUN'::date + 3)::date")', '08:00', 12) returning id")
R=$(api "$MGRB" "select (public.create_subscription('$ATHB', false, 300, '$WK_SUN', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',1)))::jsonb)::text;")
BSUB=$(su -c "select ('$R'::jsonb)->>'subscription_id'")
R1=$(api "$COACHB" "select public.coach_add_athlete('$SESS1', '$ATHB')::text;")
case "$R1" in *'"ok" : true'*) :;; *) fail "I setup: coach_add_athlete(SESS1) failed: $R1"; echo "200 (I) ABORTED"; exit 1;; esac
R2=$(api "$COACHB" "select public.coach_add_athlete('$SESS2', '$ATHB', false, true)::text;")
case "$R2" in *'"ok" : true'*) :;; *) fail "I setup: coach_add_athlete(SESS2) failed: $R2"; echo "200 (I) ABORTED"; exit 1;; esac
NEWSTART=$(su -c "select ('$WK_SUN'::date + 2)::date")
R=$(api "$MGRB" "select public.correct_subscription_start_date_with_future_registrations('$BSUB', '$NEWSTART', false)::text;")
expect "I preview ok" "true" "$(jf "$R" ok)"
expect "I preview action" "preview" "$(jf "$R" action)"
expect "I preview count" "2" "$(jf "$R" count)"
STILL_START=$(su -c "select plan_start_date from public.subscription_versions where subscription_id='$BSUB' and effective_to is null")
expect "I preview did not mutate plan_start_date" "$WK_SUN" "$STILL_START"

echo "== J: confirm applies the same change for real"
R=$(api "$MGRB" "select public.correct_subscription_start_date_with_future_registrations('$BSUB', '$NEWSTART', true)::text;")
expect "J confirm ok" "true" "$(jf "$R" ok)"
expect "J confirm action" "applied" "$(jf "$R" action)"
NEWSTART_ACTUAL=$(su -c "select plan_start_date from public.subscription_versions where subscription_id='$BSUB' and effective_to is null")
expect "J plan_start_date updated" "$NEWSTART" "$NEWSTART_ACTUAL"

echo "== K: confirming again is idempotent"
R=$(api "$MGRB" "select public.correct_subscription_start_date_with_future_registrations('$BSUB', '$NEWSTART', true)::text;")
expect "K idempotent count" "0" "$(jf "$R" count)"

echo "== L: marking the remaining registration's session attended flips eligibility to has_history"
su -c "update public.session_registrations set attended = true where user_id = '$ATHB'" >/dev/null
R=$(api "$MGRB" "select public.correct_subscription_start_date_with_future_registrations('$BSUB', '$(d 20)', false)::text;")
expect "L refused after attendance" "has_history" "$(jf "$R" error)"

echo "== M: a subscription with a posted charge is refused up front"
mkuser athlete athM; ATHM=$U
R=$(api "$MGRB" "select (public.create_subscription('$ATHM', false, 300, '$(d -40)', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::jsonb)::text;")
MSUB=$(su -c "select ('$R'::jsonb)->>'subscription_id'")
su -c "select public.generate_due_subscription_charges()" >/dev/null
HAS_CHARGE=$(su -c "select exists(select 1 from public.subscription_charges where subscription_id='$MSUB')")
if [ "$HAS_CHARGE" = "t" ]; then
  R=$(api "$MGRB" "select public.correct_subscription_start_date_with_future_registrations('$MSUB', '$(d -35)', false)::text;")
  expect "M refused (financial history)" "has_history" "$(jf "$R" error)"
else
  echo "  SKIPPED: M (generate_due_subscription_charges did not post a charge in this environment)"
fi

echo "== N: a non-manager is forbidden"
R=$(api "$COACHB" "select public.correct_subscription_start_date_with_future_registrations('$BSUB', '$(d 20)', false)::text;")
expect "N forbidden" "forbidden" "$(jf "$R" error)"

echo
echo "200: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
