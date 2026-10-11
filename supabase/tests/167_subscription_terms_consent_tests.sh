#!/usr/bin/env bash
# Regression test for 20261014120000/20261014130000 (subscription terms: explicit athlete consent).
#
# Drives the real RPCs over an `authenticator` connection (JWT claims, one transaction per call, like PostgREST); the billing
# job runs as `postgres`, like pg_cron. Fixture: manager M, coach C, athletes A (new subscriber), B (legacy subscriber), D,
# manual participant MP; group sessions (cap 8) inside the subscriptions' window.
#   1  switch OFF (shipped state): nothing changes - no stamp, no prompt, acceptance refused, registration covered
#   2  only a manager can turn enforcement on
#   3  new subscription under enforcement: awaiting consent - no immediate charge, no billing by the daily job,
#      athlete / coach / move registrations refused with subscription_terms_required (also when accepting an extra charge),
#      nothing written (no registration, no coverage)
#   4  consent cannot be fabricated: manager (or anyone) cannot record it for the athlete, record_user_consent refuses the
#      type, direct table writes are denied, the stamp cannot be cleared, wrong version refused
#   5  athlete accepts: identity + version + timestamp stored; benefits usable at once; the next daily run bills the deferred
#      period at the configured price (deferred, not altered); acceptance is idempotent
#   6  legacy subscriber: prompted (legacy_pending) but never blocked; manual participant: never requires consent
#   7  terms updated (v2): update_available, not blocking; old version refused; v2 accepted
#   8  switch OFF again releases a pending subscription (benefits + deferred billing resume)
#   9  financial history untouched (payments, documents, monthly summaries fingerprints); anon refused everywhere
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
M=$(uid); C=$(uid); A=$(uid); B=$(uid); D=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.nm, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f167-$n-m@t.local', 'M167', '061$n'), ('$C'::uuid, 'f167-$n-c@t.local', 'C167', '062$n'),
               ('$A'::uuid, 'f167-$n-a@t.local', 'Athlete A167', '063$n'), ('$B'::uuid, 'f167-$n-b@t.local', 'Athlete B167', '064$n'),
               ('$D'::uuid, 'f167-$n-d@t.local', 'Athlete D167', '065$n')) u(id, e, nm, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A','$B','$D');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
MP=$(su -c "insert into public.manual_participants (full_name, phone, created_by) values ('MP167', '066$n', '$M') returning id" | head -1)
TODAY=$(su -c "select public._studio_today_date()")
# group sessions (cap 8) inside next week, so every subscription (started today) covers them
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (public._week_start_sunday(public._studio_today_date()) + 7 + $1, '$2', '$C', 8, true) returning id" | head -1; }
S1=$(sess 1 "09:05"); S2=$(sess 2 "09:05"); S3=$(sess 3 "09:05"); S4=$(sess 4 "09:05")
ALLOW="jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2))"
create_sub() { api "$M" "select public.create_subscription('$1', $2, 300, '$TODAY', null, null, $ALLOW)::text;" | grep '^{'; }
status() { api "$M" "select (public.get_subscription_terms_status(array['$1']::uuid[])->'items'->0->>'status')" | tail -1; }
charges() { su -c "select count(*) || '|' || coalesce(sum(amount_ils), 0) from public.subscription_charges where subscription_id = '$1'"; }
regs() { su -c "select count(*) from public.session_registrations where user_id = '$1' and status = 'active'"; }
covs() { su -c "select count(*) from public.subscription_registration_coverage where subscription_id = '$1'"; }
VER=$(su -c "select version from public.legal_documents where consent_type = 'subscription_terms' and is_current")

echo "== 1: switch OFF (shipped state) changes nothing"
expect "enforcement ships disabled" "f" "$(su -c "select subscription_terms_enforced from public.app_settings where id = 1")"
SB=$(jf "$(create_sub "$B" false)" subscription_id)
expect "subscription created while off is not stamped (grandfathered)" "f" "$(su -c "select requires_terms_consent from public.subscriptions where id = '$SB'")"
expect "status while off" "not_required" "$(status "$SB")"
expect "B charged immediately as before" "1|300.00" "$(charges "$SB")"
contains "acceptance refused while off" "not_enabled" "$(api "$B" "select public.accept_subscription_terms($VER)::text;")"
contains "athlete sees no document while off" '"status" : "not_required"' "$(api "$B" "select public.get_my_subscription_terms()::text;")"
contains "B registers, covered" '"ok" : true' "$(api "$B" "select public.register_for_session('$S1')::text;")"
expect "B coverage row covered" "t" "$(su -c "select covered from public.subscription_registration_coverage where subscription_id = '$SB'")"

echo "== 2: only a manager can switch enforcement"
for who in "coach:$C" "athlete:$A"; do contains "${who%%:*} cannot enable" "forbidden" "$(api "${who#*:}" "select public.set_subscription_terms_enforced(true)::text;")"; done
contains "anon cannot enable" "permission denied" "$(api_as anon "" "select public.set_subscription_terms_enforced(true)::text;")"
expect "still off" "f" "$(su -c "select subscription_terms_enforced from public.app_settings where id = 1")"
contains "manager enables" '"enforced" : true' "$(api "$M" "select public.set_subscription_terms_enforced(true)::text;")"
expect "enforcement change logged" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$M' and event_type = 'subscription_terms_enforcement_changed'")"

echo "== 3: new subscription awaits the athlete's consent"
SA=$(jf "$(create_sub "$A" false)" subscription_id)
expect "stamped requires_terms_consent" "t" "$(su -c "select requires_terms_consent from public.subscriptions where id = '$SA'")"
expect "status pending (blocking)" "pending" "$(status "$SA")"
contains "manager sees blocking" '"blocking": true' "$(api "$M" "select public.get_subscription_terms_status(array['$SA']::uuid[])::text;")"
expect "no immediate first charge" "0|0" "$(charges "$SA")"
cron; expect "daily job does not bill it" "0|0" "$(charges "$SA")"
expect "no billing period created" "0" "$(su -c "select count(*) from public.subscription_billing_periods where subscription_id = '$SA'")"
contains "athlete registration refused" "subscription_terms_required" "$(api "$A" "select public.register_for_session('$S1')::text;")"
contains "athlete registration refused even accepting an extra charge" "subscription_terms_required" "$(api "$A" "select public.register_for_session('$S1', true)::text;")"
contains "coach adding the athlete refused" "subscription_terms_required" "$(api "$C" "select public.coach_add_athlete('$S2', '$A', false, true)::text;")"
contains "manager adding the athlete refused" "subscription_terms_required" "$(api "$M" "select public.coach_add_athlete('$S2', '$A', false, true)::text;")"
expect "nothing written: no registration" "0" "$(regs "$A")"
expect "nothing written: no coverage" "0" "$(covs "$SA")"
GM=$(api "$A" "select public.get_my_subscription_terms()::text;")
contains "athlete is told it is pending" '"status" : "pending"' "$GM"
contains "athlete receives the current document" "\"version\" : $VER" "$GM"
contains "document has Hebrew text" "תקנון" "$GM"
contains "document has English text" "Weekly session quota" "$GM"
contains "get_my_subscription (benefits) shows no usable weekly quota" '"weekly_usage"' "$(api "$A" "select public.get_my_subscription()::text;")"

echo "== 4: consent cannot be fabricated"
contains "record_user_consent refuses the type (athlete)" "use_accept_subscription_terms" "$(api "$A" "select public.record_user_consent('subscription_terms', 'accepted', $VER, null, null)::text;")"
contains "record_user_consent refuses the type (manager)" "use_accept_subscription_terms" "$(api "$M" "select public.record_user_consent('subscription_terms', 'accepted', $VER, null, null)::text;")"
contains "manager cannot accept (no subscription of their own; never on behalf)" "no_subscription" "$(api "$M" "select public.accept_subscription_terms($VER)::text;")"
contains "coach cannot accept for the athlete" "no_subscription" "$(api "$C" "select public.accept_subscription_terms($VER)::text;")"
R=$(api "$M" "insert into public.user_consents (user_id, consent_type, consent_version, status) values ('$A', 'subscription_terms', $VER, 'accepted'); select 1;")
case "$R" in *"row-level security"*|*"permission denied"*) ok "manager cannot insert a consent row directly";; *) fail "manager direct consent insert: $R";; esac
R=$(api "$A" "insert into public.user_consents (user_id, consent_type, consent_version, status) values ('$A', 'subscription_terms', $VER, 'accepted'); select 1;")
case "$R" in *"row-level security"*|*"permission denied"*) ok "athlete cannot bypass the RPC with a direct insert";; *) fail "athlete direct consent insert: $R";; esac
R=$(api "$M" "update public.subscriptions set requires_terms_consent = false where id = '$SA'; select 1;")
contains "manager cannot clear the consent requirement" "immutable" "$R"
contains "wrong version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms($((VER + 5)))::text;")"
contains "null version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms(null)::text;")"
contains "anon cannot accept" "permission denied" "$(api_as anon "" "select public.accept_subscription_terms($VER)::text;")"
expect "still no consent rows" "0" "$(su -c "select count(*) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
expect "still pending" "pending" "$(status "$SA")"

echo "== 5: the athlete accepts"
R=$(api "$A" "select public.accept_subscription_terms($VER, 'jest-agent/1.0')::text;")
contains "acceptance ok" '"ok" : true' "$R"; contains "acceptance released the hold" '"released_hold" : true' "$R"
expect "stored: athlete, version, timestamp, name, agent" "$A|$VER|t|Athlete A167|jest-agent/1.0|accepted" "$(su -c "select user_id || '|' || consent_version || '|' || (accepted_at > now() - interval '5 minutes')::text::char(1) || '|' || full_name || '|' || user_agent || '|' || status from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
expect "acceptance logged" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$A' and event_type = 'subscription_terms_accepted'")"
contains "idempotent" "already_recorded" "$(api "$A" "select public.accept_subscription_terms($VER)::text;")"
expect "one consent row" "1" "$(su -c "select count(*) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
expect "status accepted" "accepted" "$(status "$SA")"
contains "registration now covered" '"ok" : true' "$(api "$A" "select public.register_for_session('$S1')::text;")"
expect "coverage covered" "t" "$(su -c "select covered from public.subscription_registration_coverage where subscription_id = '$SA'")"
expect "still nothing billed before the daily run" "0|0" "$(charges "$SA")"
cron; expect "daily run bills the deferred first period at the configured price" "1|300.00" "$(charges "$SA")"
expect "billing period starts at the plan start (deferred, not altered)" "$TODAY" "$(su -c "select min(period_start) from public.subscription_billing_periods where subscription_id = '$SA'")"
cron; expect "no double billing on the next run" "1|300.00" "$(charges "$SA")"
contains "no document pushed once accepted" '"document" : null' "$(api "$A" "select public.get_my_subscription_terms()::text;")"

echo "== 6: legacy and manual subscribers"
expect "legacy subscriber is prompted" "legacy_pending" "$(status "$SB")"
contains "legacy subscriber not blocked" '"blocking" : false' "$(api "$B" "select public.get_my_subscription_terms()::text;")"
contains "legacy subscriber still registers, covered" '"ok" : true' "$(api "$B" "select public.register_for_session('$S2')::text;")"
expect "legacy subscriber billing unaffected" "1|300.00" "$(charges "$SB")"
SM=$(jf "$(create_sub "$MP" true)" subscription_id)
expect "manual participant subscription never requires consent" "f|not_required" "$(su -c "select requires_terms_consent from public.subscriptions where id = '$SM'")|$(status "$SM")"
expect "manual participant billed as before" "1|300.00" "$(charges "$SM")"
contains "manual participant can be added" '"ok" : true' "$(api "$M" "select public.add_manual_participant_to_session('$S3', '$MP', false, false)::text;")"

echo "== 7: terms updated to v2"
su -c "update public.legal_documents set is_current = false where consent_type = 'subscription_terms' and is_current;
       insert into public.legal_documents (consent_type, version, title, title_en, body_text, body_text_en, is_current)
       values ('subscription_terms', $VER + 1, 't', 't', 'גרסה 2', 'version 2', true)" >/dev/null
expect "athlete on v1 sees update_available" "update_available" "$(status "$SA")"
contains "update is not blocking" '"blocking" : false' "$(api "$A" "select public.get_my_subscription_terms()::text;")"
contains "benefits continue" '"ok" : true' "$(api "$A" "select public.register_for_session('$S2')::text;")"
contains "old version refused" "version_mismatch" "$(api "$A" "select public.accept_subscription_terms($VER)::text;")"
contains "v2 accepted" '"ok" : true' "$(api "$A" "select public.accept_subscription_terms($((VER + 1)))::text;")"
expect "status accepted on v2" "accepted" "$(status "$SA")"
expect "both versions on record" "$VER,$((VER + 1))" "$(su -c "select string_agg(consent_version::text, ',' order by consent_version) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
su -c "delete from public.user_consents where consent_type = 'subscription_terms' and consent_version = $VER + 1 and user_id = '$A';
       delete from public.legal_documents where consent_type = 'subscription_terms' and version = $VER + 1;
       update public.legal_documents set is_current = true where consent_type = 'subscription_terms' and version = $VER" >/dev/null

echo "== 8: switching enforcement off releases a pending subscription"
SD=$(jf "$(create_sub "$D" false)" subscription_id)
expect "D pending" "pending" "$(status "$SD")"
contains "D refused while pending" "subscription_terms_required" "$(api "$D" "select public.register_for_session('$S4')::text;")"
contains "manager disables" '"enforced" : false' "$(api "$M" "select public.set_subscription_terms_enforced(false)::text;")"
contains "D registers after the switch is off" '"ok" : true' "$(api "$D" "select public.register_for_session('$S4')::text;")"
expect "D covered" "t" "$(su -c "select covered from public.subscription_registration_coverage where subscription_id = '$SD'")"
cron; expect "D's deferred period billed by the daily job" "1|300.00" "$(charges "$SD")"
expect "D still has no fabricated consent" "0" "$(su -c "select count(*) from public.user_consents where user_id = '$D' and consent_type = 'subscription_terms'")"

echo "== 9: financial history and anon"
expect "payments / documents / monthly summaries untouched" "$FP0" "$(su -c "$FP_SQL")"
for call in "public.get_my_subscription_terms()" "public.get_subscription_terms_status(array[]::uuid[])" "public.get_subscription_terms_settings()"; do
  contains "anon refused: ${call%%(*}" "permission denied" "$(api_as anon "" "select ($call)::text;")"
done
for who in "coach:$C" "athlete:$A"; do
  contains "${who%%:*} cannot read others' terms status" "forbidden" "$(api "${who#*:}" "select public.get_subscription_terms_status(array['$SB']::uuid[])::text;")"
  contains "${who%%:*} cannot read the settings" "forbidden" "$(api "${who#*:}" "select public.get_subscription_terms_settings()::text;")"
done
contains "manager settings" '"enforced" : false' "$(api "$M" "select public.get_subscription_terms_settings()::text;")"

echo
echo "167 subscription terms consent: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
