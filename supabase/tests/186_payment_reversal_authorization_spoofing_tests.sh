#!/usr/bin/env bash
# Security verification for the shira.allow_payment_reversal mechanism (20261022100000, final pre-deployment
# check, 2026-10-22). Unlike every other suite in this directory, this one goes through the REAL REST/PostgREST
# gateway (real HTTP, a real signed JWT) instead of simulating roles over a raw psql session -- a raw-SQL
# simulation cannot prove whether a client-exposed path to set_config exists, since psql bypasses PostgREST's own
# schema-exposure restriction entirely. This suite mints its own JWTs with the local project's dev JWT secret.
#   1  set_config / current_setting are not resolvable as PostgREST RPCs at all (404, not merely forbidden) --
#      they live in pg_catalog, never exposed by Supabase's default `public`-only schema exposure
#   2  _revert_document_payment itself is not callable (permission denied -- EXECUTE revoked, confirmed again
#      through the real gateway, not just by reading a GRANT table)
#   3  a direct PATCH on athlete_account_payments setting reversed_at/reversed_by (bypassing cancel_document
#      entirely) is refused, and leaves the row completely unchanged
#   4  the same refusal holds even when reversed_at is combined with an otherwise-ordinary field change in one
#      request (no smuggling the flag in alongside a legitimate-looking update)
#   5  a crude SQL-injection-style attempt through PostgREST's filter syntax cannot reach set_config either
#      (PostgREST parameterizes its filters; this is expected to fail as a syntax/type error, not succeed)
#   6  anonymous and athlete callers cannot even see or touch the row (RLS, unchanged from the existing policy)
#   7  the legitimate workflow (cancel_document with payment reversal) still succeeds through the same real
#      gateway, proving the lockdown does not also break the authorized path
# Requires: a running local Supabase stack (REST gateway + DB), reachable at $REST_URL, with the local dev JWT
# secret in $JWT_SECRET (the Supabase CLI default, "super-secret-jwt-token-with-at-least-32-characters-long",
# unless the project's config.toml overrides it). SCRATCH/LOCAL ONLY -- never run against a real JWT secret.
set -u
PSQL=${PSQL:?set PSQL}
REST_URL=${REST_URL:?set REST_URL (e.g. http://127.0.0.1:57921)}
APIKEY=${APIKEY:?set APIKEY (the local anon/publishable key)}
JWT_SECRET=${JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }

b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {
  local sub=$1
  local h p s
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64)
  p=$(printf '{"sub":"%s","role":"authenticated","aud":"authenticated","exp":%s}' "$sub" "$(($(date +%s)+3600))" | b64)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64)
  printf '%s.%s.%s' "$h" "$p" "$s"
}
rest() {
  # rest <method> <path> <jwt-or-empty> <body-or-empty>
  local method=$1 path=$2 token=${3:-$APIKEY} body=${4:-}
  if [ -n "$body" ]; then
    curl -s -o /tmp/186_resp.json -w "%{http_code}" -X "$method" "$REST_URL$path" \
      -H "apikey: $APIKEY" -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
      -H "Prefer: return=representation" -d "$body"
  else
    curl -s -o /tmp/186_resp.json -w "%{http_code}" -X "$method" "$REST_URL$path" \
      -H "apikey: $APIKEY" -H "Authorization: Bearer $token"
  fi
}

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()"); ATH=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f186-$n-m@t.local', '071$n'), ('$A'::uuid, 'f186-$n-a@t.local', '072$n'), ('$ATH'::uuid, 'f186-$n-ath@t.local', '073$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A','$ATH');
  update public.profiles set role='manager' where user_id='$M'" >/dev/null
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id,''), 'TEST-186') where true" >/dev/null
PAY=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 77, 'cash', current_date, '$M') returning id" | head -1)
MJWT=$(jwt "$M")
AJWT=$(jwt "$ATH")

echo "== 1: set_config / current_setting are not reachable as PostgREST RPCs"
code=$(rest POST "/rpc/set_config" "$MJWT" '{"setting_name":"shira.allow_payment_reversal","new_value":"on","is_local":true}')
[ "$code" = "404" ] && ok "1 rpc/set_config -> 404 (not in the exposed schema)" || fail "1 rpc/set_config -> $code ($(cat /tmp/186_resp.json))"
code=$(rest POST "/rpc/current_setting" "$MJWT" '{"setting_name":"shira.allow_payment_reversal"}')
[ "$code" = "404" ] && ok "1 rpc/current_setting -> 404 (not in the exposed schema)" || fail "1 rpc/current_setting -> $code ($(cat /tmp/186_resp.json))"

echo "== 2: _revert_document_payment is not callable directly"
code=$(rest POST "/rpc/_revert_document_payment" "$MJWT" "{\"p_source_type\":\"account_payment\",\"p_source_id\":\"$PAY\"}")
grep -q "permission denied for function _revert_document_payment" /tmp/186_resp.json && ok "2 rpc/_revert_document_payment -> permission denied (HTTP $code)" || fail "2 rpc/_revert_document_payment -> $code ($(cat /tmp/186_resp.json))"

echo "== 3: a direct PATCH setting reversed_at/reversed_by (bypassing cancel_document) is refused"
code=$(rest PATCH "/athlete_account_payments?id=eq.$PAY" "$MJWT" "{\"reversed_at\":\"2026-10-20T00:00:00Z\",\"reversed_by\":\"$M\"}")
grep -q "unauthorized_payment_reversal" /tmp/186_resp.json && ok "3 direct PATCH of reversed_at/reversed_by refused (unauthorized_payment_reversal)" || fail "3 direct PATCH NOT refused: HTTP $code $(cat /tmp/186_resp.json)"
expect "3 reversed_at is still null in the database" "" "$(su -c "select reversed_at::text from public.athlete_account_payments where id = '$PAY'")"

echo "== 4: combining reversed_at with an ordinary field change does not smuggle it through"
code=$(rest PATCH "/athlete_account_payments?id=eq.$PAY" "$MJWT" "{\"amount_ils\":1,\"reversed_at\":\"2026-10-20T00:00:00Z\",\"reversed_by\":\"$M\"}")
grep -q "unauthorized_payment_reversal" /tmp/186_resp.json && ok "4 combined attempt refused (whole statement rejected)" || fail "4 combined attempt NOT refused: HTTP $code $(cat /tmp/186_resp.json)"
expect "4 amount_ils is unchanged (the whole statement was rejected, not partially applied)" "77.00" "$(su -c "select amount_ils::text from public.athlete_account_payments where id = '$PAY'")"

echo "== 5: a crude SQL-injection-style attempt through the filter syntax cannot reach set_config"
code=$(curl -s -o /tmp/186_resp.json -w "%{http_code}" \
  "$REST_URL/athlete_account_payments?select=*&id=eq.${PAY}%3Bselect+set_config(%27x%27%2C%27y%27%2Ctrue)--" \
  -H "apikey: $APIKEY" -H "Authorization: Bearer $MJWT")
[ "$code" = "400" ] && grep -q "invalid input syntax" /tmp/186_resp.json && ok "5 injection-style filter rejected as a syntax/type error (PostgREST parameterizes filters)" || fail "5 injection attempt: HTTP $code $(cat /tmp/186_resp.json)"

echo "== 6: anonymous and athlete callers cannot even see or touch the row (unchanged RLS)"
code=$(rest GET "/athlete_account_payments?id=eq.$PAY" "$APIKEY")
expect "6 anon GET returns an empty list (RLS, manager-only select)" "200" "$code"
grep -q '^\[\]$' /tmp/186_resp.json && ok "6 anon sees zero rows" || fail "6 anon response: $(cat /tmp/186_resp.json)"
code=$(rest PATCH "/athlete_account_payments?id=eq.$PAY" "$AJWT" '{"reversed_at":"2026-10-20T00:00:00Z"}')
grep -q '^\[\]$' /tmp/186_resp.json && ok "6 athlete PATCH affects zero rows (RLS, manager-only write)" || fail "6 athlete PATCH: HTTP $code $(cat /tmp/186_resp.json)"
expect "6 reversed_at is still null after every attempt" "" "$(su -c "select reversed_at::text from public.athlete_account_payments where id = '$PAY'")"

echo "== 7: the legitimate workflow still works through the same real gateway"
code=$(rest POST "/rpc/create_document" "$MJWT" "{\"p_gross_amount\":77,\"p_service_type\":\"other\",\"p_customer_name\":\"Cust 186\",\"p_payment_method\":\"cash\",\"p_service_description\":\"svc\",\"p_profile_user_id\":\"$A\",\"p_source_type\":\"account_payment\",\"p_source_id\":\"$PAY\",\"p_source_payment_method\":\"cash\"}")
expect "7 create_document succeeds (HTTP 200)" "200" "$code"
grep -q '"ok" : true' /tmp/186_resp.json && ok "7 receipt issued" || fail "7 create_document: $(cat /tmp/186_resp.json)"
DOC=$(su -c "select id from public.documents where source_id = '$PAY' and status <> 'CANCELLED' limit 1")
code=$(rest POST "/rpc/cancel_document" "$MJWT" "{\"p_document_id\":\"$DOC\",\"p_reason\":\"test 186\",\"p_revert_payment\":true}")
expect "7 cancel_document with revert succeeds (HTTP 200)" "200" "$code"
grep -q '"payment_reverted" : true' /tmp/186_resp.json && ok "7 the authorized reversal succeeds through the real gateway" || fail "7 cancel_document: $(cat /tmp/186_resp.json)"
expect "7 reversed_at is now set via the legitimate path" "true" "$(su -c "select (reversed_at is not null)::text from public.athlete_account_payments where id = '$PAY'")"

echo
echo "186 payment reversal authorization spoofing: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
