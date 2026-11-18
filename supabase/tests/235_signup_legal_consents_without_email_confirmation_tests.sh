#!/usr/bin/env bash
# Regression test for 20261118120000_signup_legal_consents_without_email_confirmation.sql: Terms / Privacy / Marketing answers
# from the signup form are recorded in user_consents when the account is created, without waiting for email confirmation.
# Signups go through the real GoTrue /signup endpoint with the same metadata the app sends; the stack MUST have
# [auth.email] enable_confirmations = true (and mailpit running so the confirmation email can be sent).
#   1  unconfirmed signup: 3 rows at once (types, versions, statuses, full_name, signup_sync), pending key removed,
#      email still unconfirmed, electronic_receipts still waits for confirmation (unchanged)
#   2  manager summary shows terms/privacy accepted, marketing as answered; athletes cannot read it
#   3  confirming the email adds the receipts row, no duplicate legal rows, legal accepted_at unchanged
#   4  signing up again with the same unconfirmed email (GoTrue resend path) creates no duplicates
#   5  the client fallback RPC is a harmless no-op; the internal function stays service_role only
#   6  malformed / unknown pending entries never block signup
#   7  backfill: an account left with pending answers gets them recorded with accepted_at = account creation time,
#      created_at = backfill time; its existing rows and other users' rows are untouched; re-running is a no-op
# Usage: PSQL="docker exec -i <db> psql -U postgres" PSQL_ADMIN="docker exec -i -e PGPASSWORD=postgres <db> psql -U supabase_admin -d postgres" \
#        API_URL=http://127.0.0.1:<port> ANON_KEY=... SERVICE_ROLE_KEY=... \
#        supabase/tests/235_signup_legal_consents_without_email_confirmation_tests.sh
# SCRATCH/LOCAL ONLY: commits fixture users and re-executes the migration file.
set -u
PSQL=${PSQL:?set PSQL}; PSQL_ADMIN=${PSQL_ADMIN:?set PSQL_ADMIN}; API_URL=${API_URL:?set API_URL}; ANON_KEY=${ANON_KEY:?}; SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY:?}
MIGRATION=$(dirname "$0")/../migrations/20261118120000_signup_legal_consents_without_email_confirmation.sql
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
contains() { case "$3" in *"$2"*) ok "$1";; *) fail "$1: expected '$2' in '$(echo "$3" | head -2 | cut -c1-200)'";; esac; }
jq1() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=eval("j"+process.argv[1]);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"; }
rpc() { curl -s -X POST "$API_URL/rest/v1/rpc/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H 'content-type: application/json' -d "${3:-"{}"}"; }
login() { curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"Passw0rd!x\"}" | jq1 ".access_token"; }
n=$(date +%s%N | tail -c 8)
signup() { # email marketing_status [legal_consent_pending json] -> GoTrue response
  local legal=${3:-"{\"terms_of_service\":{\"version\":1,\"status\":\"accepted\"},\"privacy_policy\":{\"version\":1,\"status\":\"accepted\"},\"marketing_communications\":{\"version\":1,\"status\":\"$2\"}}"}
  curl -s -X POST "$API_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"Passw0rd!x\",\"data\":{
    \"full_name\":\"T235 Signup\",\"phone\":\"05$n\",\"date_of_birth\":\"1998-02-09\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\",
    \"health_declaration_confirmed\":true,\"electronic_receipts_consent_pending\":true,\"electronic_receipts_consent_version\":1,
    \"legal_consent_pending\":$legal}}"
}
rows() { su -c "select coalesce(string_agg(consent_type || ':' || consent_version || ':' || status, ',' order by consent_type::text, consent_version), '') from public.user_consents where user_id = '$1'"; }
legal_fp() { su -c "select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.user_consents x where user_id = '$1' and consent_type <> 'electronic_receipts'"; }
OTHERS_SQL="select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.user_consents x where x.user_id not in (select id from auth.users where email like 't235-$n-%')"
OTHERS0=$(su -c "$OTHERS_SQL")

# Manager fixture (confirmed through the admin API).
MGR_EMAIL="t235-$n-mgr@t.local"
MGR_ID=$(curl -s -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'content-type: application/json' \
  -d "{\"email\":\"$MGR_EMAIL\",\"password\":\"Passw0rd!x\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"T235 Mgr\",\"phone\":\"07$n\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\"}}" | jq1 ".id")
su -c "update public.profiles set approval_status='approved', role='manager' where user_id='$MGR_ID'" >/dev/null
MGR=$(login "$MGR_EMAIL")
[ -n "$MGR" ] || { echo "could not create manager fixture"; exit 1; }

echo "1  unconfirmed signup records legal consent immediately"
A_EMAIL="t235-$n-a@t.local"
R=$(signup "$A_EMAIL" declined)
A_ID=$(echo "$R" | jq1 ".id"); [ -n "$A_ID" ] || A_ID=$(echo "$R" | jq1 ".user.id")
[ -n "$A_ID" ] || { echo "signup failed (is enable_confirmations on and mailpit running?): $R"; exit 1; }
expect "no session returned (confirmation required)" "" "$(echo "$R" | jq1 ".access_token")"
expect "email unconfirmed" "t" "$(su -c "select email_confirmed_at is null from auth.users where id='$A_ID'")"
expect "legal rows" "marketing_communications:1:declined,privacy_policy:1:accepted,terms_of_service:1:accepted" "$(rows "$A_ID")"
expect "full_name + signup_sync on every row" "3" "$(su -c "select count(*) from public.user_consents where user_id='$A_ID' and full_name='T235 Signup' and user_agent='signup_sync'")"
expect "accepted_at = signup time" "t" "$(su -c "select bool_and(abs(extract(epoch from uc.accepted_at - u.created_at)) < 5) from public.user_consents uc join auth.users u on u.id=uc.user_id where uc.user_id='$A_ID'")"
expect "pending key removed" "f" "$(su -c "select raw_user_meta_data ? 'legal_consent_pending' from auth.users where id='$A_ID'")"
expect "receipts still pending (unchanged)" "t|" "$(su -c "select (raw_user_meta_data->>'electronic_receipts_consent_pending')::boolean, p.electronic_receipts_consented_at from auth.users u join public.profiles p on p.user_id=u.id where u.id='$A_ID'")"

echo "2  manager sees the real status"
S=$(rpc "$MGR" get_users_legal_consent_summary)
expect "terms_ok" "true" "$(echo "$S" | jq1 ".users.find(u=>u.user_id==='$A_ID').terms_ok")"
expect "privacy_ok" "true" "$(echo "$S" | jq1 ".users.find(u=>u.user_id==='$A_ID').privacy_ok")"
expect "marketing_ok follows the answer (declined)" "false" "$(echo "$S" | jq1 ".users.find(u=>u.user_id==='$A_ID').marketing_ok")"

echo "3  confirming the email: receipts recorded, no duplicate legal rows"
FP_A=$(legal_fp "$A_ID")
su -c "update auth.users set email_confirmed_at = now() where id='$A_ID'" >/dev/null
expect "rows after confirmation" "electronic_receipts:1:accepted,marketing_communications:1:declined,privacy_policy:1:accepted,terms_of_service:1:accepted" "$(rows "$A_ID")"
expect "legal rows byte-identical after confirmation" "$FP_A" "$(legal_fp "$A_ID")"
ATH=$(login "$A_EMAIL")
expect "athlete can log in after confirmation" "t" "$([ -n "$ATH" ] && echo t || echo f)"
expect "athlete cannot read the manager summary" "forbidden" "$(rpc "$ATH" get_users_legal_consent_summary | jq1 ".error")"

echo "4  repeated signup with the same unconfirmed email"
B_EMAIL="t235-$n-b@t.local"
R=$(signup "$B_EMAIL" accepted); B_ID=$(echo "$R" | jq1 ".id"); [ -n "$B_ID" ] || B_ID=$(echo "$R" | jq1 ".user.id")
FP_B=$(legal_fp "$B_ID")
signup "$B_EMAIL" accepted >/dev/null
expect "one account" "1" "$(su -c "select count(*) from auth.users where email='$B_EMAIL'")"
expect "rows unchanged" "$FP_B" "$(legal_fp "$B_ID")"
expect "marketing accepted recorded" "marketing_communications:1:accepted,privacy_policy:1:accepted,terms_of_service:1:accepted" "$(rows "$B_ID")"

echo "5  fallback RPC and privileges"
expect "sync_signup_legal_consents is a no-op" "0" "$(rpc "$ATH" sync_signup_legal_consents | jq1 ".synced")"
expect "rows unchanged after fallback RPC" "$FP_A" "$(legal_fp "$A_ID")"
contains "authenticated cannot call the internal function" "permission denied" "$(rpc "$ATH" _try_sync_signup_legal_consents_for_user "{\"p_user_id\":\"$B_ID\"}" | jq1 ".message")"
contains "anon cannot call the internal function" "permission denied" "$(rpc "$ANON_KEY" _try_sync_signup_legal_consents_for_user "{\"p_user_id\":\"$B_ID\"}" | jq1 ".message")"
expect "execute grants" "f|f|t" "$(su -c "select has_function_privilege('anon','public._try_sync_signup_legal_consents_for_user(uuid)','execute'), has_function_privilege('authenticated','public._try_sync_signup_legal_consents_for_user(uuid)','execute'), has_function_privilege('service_role','public._try_sync_signup_legal_consents_for_user(uuid)','execute')")"

echo "6  malformed pending entries never block signup"
C_EMAIL="t235-$n-c@t.local"
R=$(signup "$C_EMAIL" x '{"terms_of_service":{"version":"x","status":"accepted"},"privacy_policy":{"version":1,"status":"maybe"},"future_type":{"version":1,"status":"accepted"}}')
C_ID=$(echo "$R" | jq1 ".id"); [ -n "$C_ID" ] || C_ID=$(echo "$R" | jq1 ".user.id")
expect "signup still succeeds" "1" "$(su -c "select count(*) from auth.users where email='$C_EMAIL'")"
expect "nothing recorded from invalid entries" "" "$(rows "$C_ID")"
expect "invalid entries dropped, not retried forever" "f" "$(su -c "select raw_user_meta_data ? 'legal_consent_pending' from auth.users where id='$C_ID'")"

echo "7  backfill of accounts left pending (re-executes the migration)"
D_EMAIL="t235-$n-d@t.local"
R=$(signup "$D_EMAIL" accepted); D_ID=$(echo "$R" | jq1 ".id"); [ -n "$D_ID" ] || D_ID=$(echo "$R" | jq1 ".user.id")
# Recreate the pre-fix state: answers only in metadata, account created 3 days ago, plus an existing terms v1 row (10 days old)
# that must win over the pending terms answer and stay byte-identical.
$PSQL_ADMIN -qAt -v ON_ERROR_STOP=1 >/dev/null <<SQL
set session_replication_role = replica;
delete from public.user_consents where user_id = '$D_ID';
insert into public.user_consents (user_id, consent_type, consent_version, status, accepted_at, created_at, user_agent)
  values ('$D_ID', 'terms_of_service', 1, 'accepted', now() - interval '10 days', now() - interval '10 days', 'old');
update auth.users set created_at = now() - interval '3 days',
  raw_user_meta_data = raw_user_meta_data || '{"legal_consent_pending":{"terms_of_service":{"version":1,"status":"accepted"},"privacy_policy":{"version":1,"status":"accepted"},"marketing_communications":{"version":1,"status":"declined"}}}'
  where id = '$D_ID';
SQL
OLD_ROW=$(su -c "select x::text from public.user_consents x where user_id='$D_ID' and user_agent='old'")
[ -n "$OLD_ROW" ] || fail "backfill fixture not created"
FP_A=$(legal_fp "$A_ID")
su -f - < "$MIGRATION" >/dev/null || fail "migration re-execution"
expect "backfilled rows" "marketing_communications:1:declined,privacy_policy:1:accepted,terms_of_service:1:accepted" "$(rows "$D_ID")"
expect "accepted_at = account creation (3 days ago), created_at = now" "2" "$(su -c "select count(*) from public.user_consents uc join auth.users u on u.id=uc.user_id where uc.user_id='$D_ID' and uc.user_agent='signup_sync' and uc.accepted_at = u.created_at and uc.created_at > now() - interval '1 minute'")"
expect "existing row untouched" "$OLD_ROW" "$(su -c "select x::text from public.user_consents x where user_id='$D_ID' and user_agent='old'")"
expect "other test user untouched" "$FP_A" "$(legal_fp "$A_ID")"
expect "pending key removed" "f" "$(su -c "select raw_user_meta_data ? 'legal_consent_pending' from auth.users where id='$D_ID'")"
FP_D=$(legal_fp "$D_ID")
su -f - < "$MIGRATION" >/dev/null || fail "second migration re-execution"
expect "re-running the migration is a no-op" "$FP_D" "$(legal_fp "$D_ID")"
expect "non-test consent rows untouched" "$OTHERS0" "$(su -c "$OTHERS_SQL")"

echo
echo "235: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
