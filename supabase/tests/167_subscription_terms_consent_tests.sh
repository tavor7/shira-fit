#!/usr/bin/env bash
# Regression test for 20261014120000/20261014130000 (subscription terms: explicit athlete consent; app access only).
#
# Drives the real RPCs over an `authenticator` connection (JWT claims, one transaction per call, like PostgREST); the billing
# job runs as `postgres`, like pg_cron. Group sessions (cap 8) next week; subscriptions start today, group limit 2.
#   1  switch OFF (shipped state): nobody is asked, acceptance refused
#   2  only a manager can switch enforcement
#   3  billing and coverage never depend on acceptance: a pending athlete's subscription is billed from its start date by
#      create_subscription and the daily job exactly like an accepted one; staff can still add the athlete (covered);
#      only the athlete's OWN registration is refused (subscription_terms_required) - the server side of the mandatory screen
#   4  consent cannot be fabricated: manager / coach cannot record it, record_user_consent refuses the type, direct table
#      writes are denied, wrong / null versions refused
#   5  the athlete accepts: athlete + version + timestamp stored once; idempotent; self-registration works again
#   6  consent belongs to athlete + version: subscription A stopped, B created -> no new acceptance needed, no new row
#   7  cancelling (stop / delete) the only subscription before accepting lifts the requirement; history kept
#   8  lifecycle states: completed-only -> not required; future-dated -> required; frozen -> required; manual payee never
#   9  new version without requires_reconsent -> still accepted; with it -> pending again until accepted
#  10  manager status reflects persisted consent (version + date); athletes / coaches / anon cannot read it
#  11  financial history untouched (payments, documents, monthly summaries)
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/167_subscription_terms_consent_tests.sh   (SCRATCH/LOCAL DATABASES ONLY; toggles
# the global app_settings.subscription_terms_enforced switch and restores it to FALSE at the end - do not run in parallel)
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
cron() { su -c "select public.generate_due_subscription_charges()::text" >/dev/null; }
trap 'su -c "update public.app_settings set subscription_terms_enforced = false where id = 1" >/dev/null 2>&1' EXIT

FP_SQL="select md5(coalesce((select string_agg(x::text, '|' order by x::text) from public.athlete_account_payments x), '')
            || coalesce((select string_agg(x::text, '|' order by x::text) from public.documents x), '')
            || coalesce((select string_agg(x::text, '|' order by x::text) from public.monthly_summaries x), ''))"
FP0=$(su -c "$FP_SQL")

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); A=$(uid); B=$(uid); D=$(uid); E=$(uid); F=$(uid); G=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f167-$n-' || u.k || '@t.local',
         jsonb_build_object('full_name', 'F167 ' || u.k, 'phone', '06' || u.k || '$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'm'), ('$C'::uuid, 'c'), ('$A'::uuid, 'a'), ('$B'::uuid, 'b'), ('$D'::uuid, 'd'),
               ('$E'::uuid, 'e'), ('$F'::uuid, 'f'), ('$G'::uuid, 'g')) u(id, k);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A','$B','$D','$E','$F','$G');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
MP=$(su -c "insert into public.manual_participants (full_name, phone, created_by) values ('MP167', '0699$n', '$M') returning id" | head -1)
TODAY=$(su -c "select public._studio_today_date()")
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (public._week_start_sunday(public._studio_today_date()) + 7 + $1, '$2', '$C', 8, true) returning id" | head -1; }
S1=$(sess 1 "09:05"); S2=$(sess 2 "09:05"); S3=$(sess 3 "09:05"); S4=$(sess 4 "09:05")
ALLOW="jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2))"
create_sub() { jf "$(api "$M" "select public.create_subscription('$1', $2, 300, '${3:-$TODAY}', ${4:-null}, null, $ALLOW)::text;" | grep '^{')" subscription_id; }
status() { api "$M" "select (public.get_subscription_terms_status(array['$1']::uuid[])->'items'->0->>'status')" | tail -1; }
mine() { api "$1" "select public.get_my_subscription_terms()::text;" | grep '^{'; }
charges() { su -c "select count(*) || '|' || coalesce(sum(amount_ils), 0) from public.subscription_charges where subscription_id = '$1'"; }
consents() { su -c "select count(*) from public.user_consents where user_id = '$1' and consent_type = 'subscription_terms'"; }
VER=$(su -c "select version from public.legal_documents where consent_type = 'subscription_terms' and is_current")

echo "== 1: switch OFF (shipped state)"
expect "enforcement ships disabled" "f" "$(su -c "select subscription_terms_enforced from public.app_settings where id = 1")"
SB=$(create_sub "$B" false)
expect "B: not required while off" "not_required" "$(status "$SB")"
contains "acceptance refused while off" "not_enabled" "$(api "$B" "select public.accept_subscription_terms($VER)::text;")"
contains "B registers normally while off" '"ok" : true' "$(api "$B" "select public.register_for_session('$S1')::text;")"

echo "== 2: only a manager can switch enforcement"
for who in "coach:$C" "athlete:$A"; do contains "${who%%:*} cannot enable" "forbidden" "$(api "${who#*:}" "select public.set_subscription_terms_enforced(true)::text;")"; done
contains "anon cannot enable" "permission denied" "$(api_as anon "" "select public.set_subscription_terms_enforced(true)::text;")"
contains "manager enables" '"enforced" : true' "$(api "$M" "select public.set_subscription_terms_enforced(true)::text;")"
expect "existing subscriber B is now asked (athlete-level rule)" "pending" "$(status "$SB")"

echo "== 3: billing and coverage never depend on acceptance"
SA=$(create_sub "$A" false)
expect "A pending" "pending" "$(status "$SA")"
contains "A is told to accept (blocking + document)" '"blocking" : true' "$(mine "$A")"
contains "document carries Hebrew text" "תקנון" "$(mine "$A")"
contains "document carries English text" "Weekly session quota" "$(mine "$A")"
expect "A billed from the start date immediately, at the configured price" "1|300.00" "$(charges "$SA")"
expect "first billing period starts on the plan start date" "$TODAY" "$(su -c "select min(period_start) from public.subscription_billing_periods where subscription_id = '$SA'")"
cron; expect "daily job: no double billing, nothing deferred" "1|300.00" "$(charges "$SA")"
expect "same as an accepted subscription would be billed (B)" "$(charges "$SB")" "$(charges "$SA")"
contains "A's OWN registration is refused (mandatory screen, server side)" "subscription_terms_required" "$(api "$A" "select public.register_for_session('$S1')::text;")"
contains "also when accepting an extra charge" "subscription_terms_required" "$(api "$A" "select public.register_for_session('$S1', true)::text;")"
contains "coach can still add A" '"ok" : true' "$(api "$C" "select public.coach_add_athlete('$S2', '$A', false, false)::text;")"
expect "staff-added session is covered by the subscription (coverage independent of consent)" "t" "$(su -c "select covered from public.subscription_registration_coverage where subscription_id = '$SA'")"

echo "== 4: consent cannot be fabricated"
contains "record_user_consent refuses the type (athlete)" "use_accept_subscription_terms" "$(api "$A" "select public.record_user_consent('subscription_terms', 'accepted', $VER, null, null)::text;")"
contains "record_user_consent refuses the type (manager)" "use_accept_subscription_terms" "$(api "$M" "select public.record_user_consent('subscription_terms', 'accepted', $VER, null, null)::text;")"
contains "manager cannot accept (never on behalf)" "no_subscription" "$(api "$M" "select public.accept_subscription_terms($VER)::text;")"
contains "coach cannot accept" "no_subscription" "$(api "$C" "select public.accept_subscription_terms($VER)::text;")"
R=$(api "$M" "insert into public.user_consents (user_id, consent_type, consent_version, status) values ('$A', 'subscription_terms', $VER, 'accepted'); select 1;")
case "$R" in *"row-level security"*|*"permission denied"*) ok "manager cannot insert a consent row directly";; *) fail "manager direct consent insert: $R";; esac
R=$(api "$A" "insert into public.user_consents (user_id, consent_type, consent_version, status) values ('$A', 'subscription_terms', $VER, 'accepted'); select 1;")
case "$R" in *"row-level security"*|*"permission denied"*) ok "athlete cannot bypass the RPC with a direct insert";; *) fail "athlete direct insert: $R";; esac
contains "wrong version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms($((VER + 5)))::text;")"
contains "null version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms(null)::text;")"
contains "anon cannot accept" "permission denied" "$(api_as anon "" "select public.accept_subscription_terms($VER)::text;")"
expect "still no consent rows for A" "0" "$(consents "$A")"

echo "== 5: the athlete accepts"
contains "acceptance ok" '"ok" : true' "$(api "$A" "select public.accept_subscription_terms($VER, 'agent/1.0')::text;")"
expect "stored: athlete, version, timestamp, name, agent" "$A|$VER|t|F167 a|agent/1.0|accepted" "$(su -c "select user_id || '|' || consent_version || '|' || (accepted_at > now() - interval '5 minutes')::text::char(1) || '|' || full_name || '|' || user_agent || '|' || status from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
contains "idempotent" "already_recorded" "$(api "$A" "select public.accept_subscription_terms($VER)::text;")"
expect "one consent row" "1" "$(consents "$A")"
expect "A accepted" "accepted" "$(status "$SA")"
contains "screen lifted for A" '"blocking" : false' "$(mine "$A")"
contains "A registers again" '"ok" : true' "$(api "$A" "select public.register_for_session('$S1')::text;")"
expect "billing unchanged by acceptance" "1|300.00" "$(charges "$SA")"

echo "== 6: consent belongs to the athlete + version"
contains "manager stops A today" '"ok"' "$(api "$M" "select public.stop_subscription('$SA', '$TODAY', true)::text;")"
SA2=$(create_sub "$A" false "$(su -c "select date '$TODAY' + 1")")
expect "new subscription B for A needs no new acceptance" "accepted" "$(status "$SA2")"
contains "no screen for A" '"blocking" : false' "$(mine "$A")"
expect "no duplicate consent row" "1" "$(consents "$A")"

echo "== 7: cancelling before accepting lifts the requirement"
SD=$(create_sub "$D" false)
expect "D pending" "pending" "$(status "$SD")"
CHG_D=$(charges "$SD")
contains "manager stops D's only subscription today" '"ok"' "$(api "$M" "select public.stop_subscription('$SD', '$TODAY', true)::text;")"
expect "D no longer required, never accepted" "not_required|0" "$(status "$SD")|$(consents "$D")"
contains "D can use the app (registers)" '"ok" : true' "$(api "$D" "select public.register_for_session('$S3')::text;")"
expect "D's subscription and charges kept" "1" "$(su -c "select count(*) from public.subscriptions where id = '$SD'")"
SE=$(create_sub "$E" false "$(su -c "select date '$TODAY' + 10")")
expect "E (future-dated) pending" "pending" "$(status "$SE")"
contains "manager deletes E's subscription" '"ok" : true' "$(api "$M" "select public.delete_subscription('$SE')::text;")"
expect "E no longer required after deletion" "not_required" "$(status "$SE")"
expect "E's tombstoned subscription kept" "1" "$(su -c "select count(*) from public.subscriptions where id = '$SE' and deleted_at is not null")"

echo "== 8: lifecycle states"
SF=$(create_sub "$F" false "$(su -c "select date '$TODAY' - 70")" "date '$TODAY' - 40")
expect "F with only a completed (expired) subscription: not required" "not_required" "$(status "$SF")"
SF2=$(create_sub "$F" false "$(su -c "select date '$TODAY' + 5")")
expect "F with a future-dated subscription: pending" "pending" "$(status "$SF2")"
SG=$(create_sub "$G" false)
contains "freeze G next week" '"ok" : true' "$(api "$M" "select public.freeze_subscription('$SG', public._week_start_sunday(public._studio_today_date()) + 7, public._week_start_sunday(public._studio_today_date()) + 13, true)::text;")"
expect "G frozen: still pending" "pending" "$(status "$SG")"
SM=$(jf "$(api "$M" "select public.create_subscription('$MP', true, 300, '$TODAY', null, null, $ALLOW)::text;" | grep '^{')" subscription_id)
expect "manual participant never required" "not_required" "$(status "$SM")"
contains "manual participant can be added" '"ok" : true' "$(api "$M" "select public.add_manual_participant_to_session('$S4', '$MP', false, false)::text;")"
expect "manual participant billed normally" "1|300.00" "$(charges "$SM")"

echo "== 9: new terms versions (published through the management RPCs; versions are immutable)"
publish() { local at; at=$(su -c "select updated_at from public.legal_document_drafts where consent_type = 'subscription_terms'");
  api "$M" "select public.publish_subscription_terms_draft($1, '$at'::timestamptz)::text;"; }
contains "copy the current text into a draft" '"ok" : true' "$(api "$M" "select public.copy_subscription_terms_version_to_draft($VER)::text;")"
R=$(publish false); contains "publish a new version WITHOUT renewed acceptance" '"ok" : true' "$R"; V2=$(jf "$(echo "$R" | grep '^{')" version)
expect "A stays accepted (no renewed acceptance required)" "accepted" "$(status "$SA2")"
api "$M" "select public.copy_subscription_terms_version_to_draft($VER)::text;" >/dev/null
R=$(publish true); contains "publish a new version WITH renewed acceptance" '"ok" : true' "$R"; V3=$(jf "$(echo "$R" | grep '^{')" version)
expect "A pending again" "pending" "$(status "$SA2")"
contains "old version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms($VER)::text;")"
contains "new version accepted" '"ok" : true' "$(api "$A" "select public.accept_subscription_terms($V3)::text;")"
expect "A accepted on the new version, one row per version" "accepted|2" "$(status "$SA2")|$(consents "$A")"
expect "earlier acceptance kept" "1" "$(su -c "select count(*) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms' and consent_version = $VER")"
VER=$V3

echo "== 10: manager visibility"
R=$(api "$M" "select public.get_subscription_terms_status(array['$SA2']::uuid[])::text;")
contains "manager sees accepted version" "\"accepted_version\": $VER" "$R"
contains "manager sees acceptance date" "\"accepted_at\": \"$(su -c "select to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD') from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms' and consent_version = $VER")" "$R"
contains "manager settings counts athletes" '"pending"' "$(api "$M" "select public.get_subscription_terms_settings()::text;")"
for who in "coach:$C" "athlete:$A"; do
  contains "${who%%:*} cannot read terms status" "forbidden" "$(api "${who#*:}" "select public.get_subscription_terms_status(array['$SB']::uuid[])::text;")"
  contains "${who%%:*} cannot read the settings" "forbidden" "$(api "${who#*:}" "select public.get_subscription_terms_settings()::text;")"
done
for call in "public.get_my_subscription_terms()" "public.get_subscription_terms_status(array[]::uuid[])" "public.get_subscription_terms_settings()"; do
  contains "anon refused: ${call%%(*}" "permission denied" "$(api_as anon "" "select ($call)::text;")"
done
contains "manager disables" '"enforced" : false' "$(api "$M" "select public.set_subscription_terms_enforced(false)::text;")"
expect "switch off: nobody blocked" "not_required" "$(status "$SB")"

echo "== 11: financial history"
expect "payments / documents / monthly summaries untouched" "$FP0" "$(su -c "$FP_SQL")"

echo
echo "167 subscription terms consent: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
