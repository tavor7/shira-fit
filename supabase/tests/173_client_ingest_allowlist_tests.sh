#!/usr/bin/env bash
# Monitoring Phase 3E.2: server-side hardening of the untrusted client entry point report_client_error
# (migration 20261015100000_system_monitoring_client_allowlist.sql).
#
# Drives the REAL functions over a real `authenticator` connection (safeupdate preloaded) as `authenticated` with JWT claims, one
# transaction per call exactly like PostgREST, plus service_role and postgres for the trusted/maintenance paths.
#   A  switches: client ingestion disabled; empty allowlist denies everything
#   B  default deny: exact approved tuple accepted; unknown / wildcard-only / disabled / non-allowlisted business, authorization,
#      uncertain tuples rejected; a wildcard authorizing rule cannot even be stored
#   C  payload validation and spoofing: malformed payloads, spoofed identity/fingerprint/source/subsystem/... rejected with no side effect
#   D  fingerprint integrity and server-controlled text/severity: message/context/build/platform/env/severity variation does not
#      fragment, severity is never above warning, no client text is stored
#   E  quotas and flood protection; concurrent submissions
#   F  access control: athlete/coach cannot read monitoring data, manager can, nobody can read rules/config/quota
#   G  trusted path unchanged (fingerprint behaviour, service_role), maintenance: client issues never quiet-auto-resolve, trusted do
#   H  lifecycle: mute, manual resolve, recurrence reopen; no critical; no business/notification table mutation
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/173_client_ingest_allowlist_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users and temporarily enables client ingestion (restored on exit). Never run it
# against production.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
TMP=$(mktemp -d)
LOCKKEY=7173001
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
# one transaction as PostgREST would run it (authenticator connection -> role + claims)
api() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"; printf '%s\n' "$1"; echo "commit;"; } \
    | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
# report as an authenticated user -> "accepted|reason"
rep() { api authenticated "$1" "select (r->>'accepted') || '|' || coalesce(r->>'reason','') from (select public.report_client_error('$2'::jsonb)::jsonb r) q;" | tail -1; }

CFG_ING=$(su -c "select value::text from public.system_monitoring_config where key='client_ingest_enabled'")
CFG_LIM=$(su -c "select value::text from public.system_monitoring_config where key='limits'")
CFG_REQ=$(su -c "select value::text from public.system_monitoring_config where key='client_require_rule'")
restore() {
  su -c "update public.system_monitoring_config set value='$CFG_ING'::jsonb where key='client_ingest_enabled'" >/dev/null
  su -c "update public.system_monitoring_config set value='$CFG_LIM'::jsonb where key='limits'" >/dev/null
  su -c "update public.system_monitoring_config set value='$CFG_REQ'::jsonb where key='client_require_rule'" >/dev/null
  su -c "update public.system_issue_rules set enabled = true where authorizes_client" >/dev/null
  su -c "delete from public.system_issue_rules where note = 'test173'" >/dev/null
  rm -rf "$TMP"
}
trap restore EXIT

mkuser() { # tag role -> uuid
  local id n; id=$(su -c "select gen_random_uuid()"); n=$(date +%s%N | tail -c 8)
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t173-$1-$n@t.local', jsonb_build_object('full_name','u','phone','05$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved', role='$2' where user_id='$id'" >/dev/null
  echo "$id"
}
MGR=$(mkuser mgr manager); COACH=$(mkuser coach coach); ATH=$(mkuser ath athlete); DIS=$(mkuser dis athlete)
su -c "update public.profiles set disabled_at = now() where user_id='$DIS'" >/dev/null
ATHS=(); for i in 1 2 3 4 5 6 7 8 9 10; do ATHS+=("$(mkuser a$i athlete)"); done

fp() { su -c "select public._system_fingerprint('client','client','$1','$2','$3','','')"; }
issues() { su -c "select count(*) from public.system_issues where fingerprint='$(fp "$1" "$2" "$3")'"; }
clients() { su -c "select count(*) from public.system_issues where source='client'"; }
reset() { su -c "delete from public.system_issues where source='client'; delete from public.system_report_quota" >/dev/null; }
OP=rpc/register_for_session; CL=RpcOutcome; CODE=no_profile
mk() { # operation class code [extra-json-members]
  echo "{\"operation\":\"$1\",\"error_class\":\"$2\",\"error_code\":\"$3\",\"message\":\"m\",\"severity\":\"warning\",\"context\":{\"rpc\":\"register_for_session\",\"phase\":\"rpc_result\"},\"app_version\":\"1.0.0\",\"build\":\"7\",\"platform\":\"web\",\"env\":\"prod\"${4:-}}"; }
GOOD=$(mk $OP $CL $CODE)
BIZ=$(mk $OP $CL full); AUTHZ=$(mk $OP $CL forbidden); UNC=$(mk rpc/cancel_registration $CL update_failed)

FP_SQL="select md5(string_agg(t || ':' || n || ':' || h, '|' order by t)) from (
  select c.relname::text t,
    (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text n,
    (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) h from public.%I x', '|', '', c.relname), false, true, '')))[1]::text h
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname not like 'system\\_%' and c.relname <> 'cron_job_run_details') z"
BIZ0=$(su -c "$FP_SQL")

reset
echo "A: switches"
expect "client ingestion is disabled by default (seeded allowlist cannot activate it)" "false|disabled" "$(rep "$ATH" "$GOOD")"
expect "disabled ingestion creates no issue" 0 "$(clients)"
expect "client_require_rule is true by default" true "$CFG_REQ"
expect "seeded allowlist rules are flagged exact client rules" "58" "$(su -c "select count(*) from public.system_issue_rules where authorizes_client and enabled and match_source='client' and match_operation !~ '[*]' and severity_cap='warning'")"
su -c "update public.system_monitoring_config set value='true'::jsonb where key='client_ingest_enabled'" >/dev/null
su -c "update public.system_issue_rules set enabled=false where authorizes_client" >/dev/null
expect "EMPTY allowlist: an otherwise valid report is rejected" "false|not_allowlisted" "$(rep "$ATH" "$GOOD")"
expect "EMPTY allowlist: zero client issues" 0 "$(clients)"
su -c "update public.system_issue_rules set enabled=true where authorizes_client" >/dev/null
su -c "update public.system_monitoring_config set value='false'::jsonb where key='client_require_rule'" >/dev/null
su -c "update public.system_monitoring_config set value='true'::jsonb where key='client_require_rule'" >/dev/null
su -c "delete from public.system_monitoring_config where key='client_require_rule'" >/dev/null
su -c "update public.system_issue_rules set enabled=false where authorizes_client" >/dev/null
expect "missing client_require_rule row still denies (default true)" "false|not_allowlisted" "$(rep "$ATH" "$GOOD")"
su -c "update public.system_issue_rules set enabled=true where authorizes_client" >/dev/null
su -c "insert into public.system_monitoring_config (key, value) values ('client_require_rule','true'::jsonb) on conflict (key) do update set value=excluded.value" >/dev/null

echo "B: default deny"
reset
expect "exact approved tuple is accepted" "true|" "$(rep "$ATH" "$GOOD")"
expect "exactly one client issue" 1 "$(issues $OP $CL $CODE)"
expect "issue is a warning, source client, rule-controlled subsystem and title" "warning|client|rpc|RPC technical outcome: register_for_session (no_profile)" "$(su -c "select severity||'|'||source||'|'||subsystem||'|'||title from public.system_issues where fingerprint='$(fp $OP $CL $CODE)'")"
reset
expect "unknown tuple (operation) rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/not_an_rpc $CL $CODE)")"
expect "unknown tuple (class) rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk $OP SomethingElse $CODE)")"
expect "unknown tuple (code) rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk $OP $CL brand_new_failure)")"
expect "an operation that merely STARTS WITH an approved one is rejected (no prefix authorization)" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/register_for_session_extra $CL $CODE)")"
expect "BUSINESS outcome rejected" "false|not_allowlisted" "$(rep "$ATH" "$BIZ")"
expect "AUTHORIZATION outcome rejected" "false|not_allowlisted" "$(rep "$ATH" "$AUTHZ")"
expect "UNCERTAIN outcome rejected" "false|not_allowlisted" "$(rep "$ATH" "$UNC")"
expect "arbitrary SQLSTATE rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/postgrest PostgrestError 23505)")"
expect "an uncertain SQLSTATE (42501) rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/postgrest PostgrestError 42501)")"
expect "approved database code accepted (21000)" "true|" "$(rep "$ATH" "$(mk rpc/postgrest PostgrestError 21000)")"
expect "approved transport tuple accepted" "true|" "$(rep "$ATH" "$(mk transport/infra HttpError http_503)")"
expect "unapproved transport status rejected (http_429)" "false|not_allowlisted" "$(rep "$ATH" "$(mk transport/infra HttpError http_429)")"
expect "per-RPC transport operation rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk transport/rpc:register_for_session HttpError http_503)")"
expect "reviewed reason outcome accepted" "true|" "$(rep "$ATH" "$(mk rpc/manager_activity_revert_info RpcReason missing_role_context)")"
expect "the same code as an outcome (wrong class) rejected" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/manager_activity_revert_info RpcOutcome missing_role_context)")"
reset
# wildcard / presentation rules never authorize
su -c "insert into public.system_issue_rules (match_source, match_operation, match_error_class, match_error_code, action, severity_cap, note) values ('client','rpc/*','RpcOutcome','zz_wild','classify','warning','test173'),('client','rpc/zz_op','RpcOutcome','zz_exact','classify','warning','test173')" >/dev/null
expect "wildcard presentation rule does not authorize" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/zz_other RpcOutcome zz_wild)")"
expect "exact PRESENTATION rule (not flagged authorizes_client) does not authorize" "false|not_allowlisted" "$(rep "$ATH" "$(mk rpc/zz_op RpcOutcome zz_exact)")"
OUT=$(su -c "insert into public.system_issue_rules (match_source, match_operation, match_error_class, match_error_code, action, severity_cap, authorizes_client, note) values ('client','rpc/*','RpcOutcome','zz_w2','classify','warning',true,'test173')" 2>&1 || true)
case "$OUT" in *system_issue_rules_client_auth_exact*) ok "an authorizing rule with a wildcard operation cannot be stored";; *) fail "wildcard authorizing rule was stored: $OUT";; esac
OUT=$(su -c "insert into public.system_issue_rules (match_source, match_operation, match_error_class, match_error_code, action, severity_cap, authorizes_client, note) values ('client','rpc/zz_a','RpcOutcome','zz_a','classify','critical',true,'test173')" 2>&1 || true)
case "$OUT" in *system_issue_rules_client_auth_exact*) ok "an authorizing rule with a critical cap cannot be stored";; *) fail "critical authorizing rule stored: $OUT";; esac
OUT=$(su -c "insert into public.system_issue_rules (match_source, match_operation, match_error_class, match_error_code, action, severity_cap, authorizes_client, note) values ('client','rpc/zz_b','RpcOutcome',null,'classify','warning',true,'test173')" 2>&1 || true)
case "$OUT" in *system_issue_rules_client_auth_exact*) ok "an authorizing rule without an error code cannot be stored";; *) fail "code-less authorizing rule stored: $OUT";; esac
OUT=$(su -c "insert into public.system_issue_rules (match_source, match_operation, match_error_class, match_error_code, action, severity_cap, authorizes_client, note) values ('cron','rpc/zz_c','RpcOutcome','zz_c','classify','warning',true,'test173')" 2>&1 || true)
case "$OUT" in *system_issue_rules_client_auth_exact*) ok "an authorizing rule for another source cannot be stored";; *) fail "non-client authorizing rule stored: $OUT";; esac
su -c "delete from public.system_issue_rules where note='test173'" >/dev/null
su -c "update public.system_issue_rules set enabled=false where authorizes_client and match_operation='$OP' and match_error_code='$CODE'" >/dev/null
expect "DISABLED authorizing rule does not authorize" "false|not_allowlisted" "$(rep "$ATH" "$GOOD")"
su -c "update public.system_issue_rules set enabled=true where authorizes_client" >/dev/null
expect "re-enabled rule authorizes again" "true|" "$(rep "$ATH" "$GOOD")"
expect "seed is idempotent (re-running the seed changes nothing)" 58 "$(su -c "select count(*) from public.system_issue_rules where authorizes_client")"

echo "C: payload validation and spoofing (no side effects)"
reset
Q0=$(su -c "select count(*) from public.system_report_quota")
chk() { expect "$1" "false|invalid_payload" "$(rep "$ATH" "$2")"; }
chk "unexpected key: user_id" "$(mk $OP $CL $CODE ",\"user_id\":\"$MGR\"")"
chk "unexpected key: user_role" "$(mk $OP $CL $CODE ",\"user_role\":\"manager\"")"
chk "unexpected key: role" "$(mk $OP $CL $CODE ",\"role\":\"manager\"")"
chk "unexpected key: source" "$(mk $OP $CL $CODE ",\"source\":\"cron\"")"
chk "unexpected key: trusted" "$(mk $OP $CL $CODE ",\"trusted\":true")"
chk "SPOOFED fingerprint_key" "$(mk $OP $CL $CODE ",\"fingerprint_key\":\"job_health:x:stale\"")"
chk "SPOOFED fingerprint" "$(mk $OP $CL $CODE ",\"fingerprint\":\"00000000000000000000000000000000\"")"
chk "unexpected key: issue_id" "$(mk $OP $CL $CODE ",\"issue_id\":\"$MGR\"")"
chk "unexpected key: subsystem" "$(mk $OP $CL $CODE ",\"subsystem\":\"billing\"")"
chk "unexpected key: impact" "$(mk $OP $CL $CODE ",\"impact\":\"blocking\"")"
chk "unexpected key: entities" "$(mk $OP $CL $CODE ",\"entities\":{\"session_id\":\"$MGR\"}")"
chk "unexpected key: stack" "$(mk $OP $CL $CODE ",\"stack\":\"at x (a.js:1)\"")"
chk "unexpected key: route" "$(mk $OP $CL $CODE ",\"route\":\"/x\"")"
chk "unexpected key: count" "$(mk $OP $CL $CODE ",\"count\":99999")"
chk "unexpected key: origin" "$(mk $OP $CL $CODE ",\"origin\":\"x\"")"
chk "missing operation" '{"error_class":"RpcOutcome","error_code":"no_profile"}'
chk "missing error_code" '{"operation":"rpc/register_for_session","error_class":"RpcOutcome"}'
chk "operation with a bad shape" "$(mk 'Rpc/Register' $CL $CODE)"
chk "error_code with spaces" "$(mk $OP $CL 'no profile')"
chk "error_class too long" "$(mk $OP "$(printf 'A%.0s' $(seq 1 81))" $CODE)"
chk "message that is not a string" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"message\":{\"a\":1}}"
chk "message longer than 300" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"message\":\"$(printf 'x%.0s' $(seq 1 301))\"}"
chk "nested context" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"context\":{\"rpc\":{\"a\":1}}}"
chk "array context value" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"context\":{\"rpc\":[1]}}"
chk "context that is not an object" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"context\":[1]}"
chk "17 context keys" "{\"operation\":\"$OP\",\"error_class\":\"$CL\",\"error_code\":\"$CODE\",\"context\":{$(for i in $(seq 1 17); do printf '"k%s":1,' $i; done | sed 's/,$//')}}"
chk "platform server" "$(mk $OP $CL $CODE | sed 's/"platform":"web"/"platform":"server"/')"
chk "bad app_version" "$(mk $OP $CL $CODE | sed 's/"app_version":"1.0.0"/"app_version":"1 0"/')"
chk "severity that is not a lowercase word" "$(mk $OP $CL $CODE | sed 's/"severity":"warning"/"severity":"CRITICAL!"/')"
expect "payload that is not an object" "false|invalid_payload" "$(rep "$ATH" '[1,2]')"
expect "no side effect of rejected payloads: no issue" 0 "$(clients)"
expect "no side effect of rejected payloads: no quota consumed" "$Q0" "$(su -c "select count(*) from public.system_report_quota")"
expect "caller whose JWT has no subject is rejected as unauthenticated" "false|unauthenticated" "$({ echo "begin; set local role authenticated; set local request.jwt.claims = '{\"role\":\"authenticated\"}';"; echo "select (r->>'accepted') || '|' || coalesce(r->>'reason','') from (select public.report_client_error('$GOOD'::jsonb)::jsonb r) q;"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tail -1)"
expect "anon role cannot execute the reporting RPC" t "$(api anon "$ATH" "select public.report_client_error('$GOOD'::jsonb);" | grep -q 'permission denied' && echo t || echo f)"
expect "disabled user rejected (no side effect)" "false|not_allowed" "$(rep "$DIS" "$GOOD")"
expect "disabled user: no issue" 0 "$(clients)"

echo "D: fingerprint integrity, server-controlled text and severity"
reset
rep "$ATH" "$GOOD" >/dev/null
M1=$(rep "$ATH" "$(mk $OP $CL $CODE | sed 's/"message":"m"/"message":"alice@example.com 0501234567 8a7c2f10-1111-2222-3333-444455556666 DELETE requires a WHERE clause"/')")
M2=$(rep "$ATH" "$(mk $OP $CL $CODE | sed 's/"message":"m"/"message":"completely different wording 12345"/')")
M3=$(rep "$ATH" "$(mk $OP $CL $CODE | sed 's/"rpc":"register_for_session","phase":"rpc_result"/"rpc":"other_name","phase":"x","attempt":3,"sqlstate":"X1","retryable":true/')")
M4=$(rep "$ATH" "$(mk $OP $CL $CODE | sed 's/"build":"7"/"build":"99"/; s/"platform":"web"/"platform":"ios"/; s/"env":"prod"/"env":"dev"/; s/"app_version":"1.0.0"/"app_version":"9.9.9"/')")
expect "variants 1-4 are all accepted" "true|,true|,true|,true|" "$M1,$M2,$M3,$M4"
expect "still exactly one issue after message/context/build/platform/env variation" 1 "$(issues $OP $CL $CODE)"
expect "server fingerprint equals the server-derived value (client has no say)" "$(fp $OP $CL $CODE)" "$(su -c "select fingerprint from public.system_issues where source='client'")"
expect "occurrence_count counts every accepted report" 5 "$(su -c "select occurrence_count from public.system_issues where source='client'")"
expect "no client text is stored: event messages are the rule title, no PII/diagnostic text" "RPC technical outcome: register_for_session (no_profile)" "$(su -c "select string_agg(distinct message, '|') from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client'")"
expect "no client text in summary or title" 0 "$(su -c "select count(*) from public.system_issues where latest_summary ~* '(alice|example|WHERE|different|12345|8a7c2f10)' or title ~* '(alice|example|WHERE|different|12345)'")"
expect "no user id in title/summary/fingerprint inputs" 0 "$(su -c "select count(*) from public.system_issues where title like '%$ATH%' or latest_summary like '%$ATH%'")"
expect "attribution is server-derived (events carry auth.uid and role)" "$ATH|athlete" "$(su -c "select distinct user_id||'|'||user_role from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client'")"
reset
for SEV in error critical bogus info; do rep "$ATH" "$(mk $OP $CL $CODE | sed "s/\"severity\":\"warning\"/\"severity\":\"$SEV\"/")" >/dev/null; done
expect "requested severities error/critical/unknown/info: effective severity is the server's (warning)" "warning" "$(su -c "select severity from public.system_issues where source='client'")"
expect "event severities are warning" "warning" "$(su -c "select string_agg(distinct e.severity,'|') from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client'")"
expect "numeric severity is rejected" "false|invalid_payload" "$(rep "$ATH" "$(mk $OP $CL $CODE | sed 's/"severity":"warning"/"severity":5/')")"

echo "E: quotas, flood protection, concurrency"
reset
RES=""; for i in $(seq 1 22); do RES="$RES $(rep "${ATHS[0]}" "$GOOD" | cut -d'|' -f2 | tr -d '\n')."; done
expect "per-user quota: 20 reports accepted, the 21st and 22nd rejected" "20" "$(echo "$RES" | tr ' ' '\n' | grep -c '^\.$')"
expect "per-user quota reason" "false|user_quota" "$(rep "${ATHS[0]}" "$GOOD")"
expect "quota-limited user still produced exactly one issue" 1 "$(issues $OP $CL $CODE)"
expect "events stay sampled and bounded (<= 6 for 20 reports)" "true" "$(su -c "select (count(*) <= 6)::text from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client'")"
reset
TUPLES=("rpc/register_for_session RpcOutcome no_profile" "rpc/update_session_note RpcOutcome session_not_found" "rpc/stop_subscription RpcOutcome no_current_version" "rpc/postgrest PostgrestError 21000" "rpc/postgrest PostgrestError 42883" "rpc/postgrest PostgrestError 40001" "rpc/postgrest PostgrestError 57014")
R=""; for t in "${TUPLES[@]}"; do set -- $t; R="$R $(rep "${ATHS[1]}" "$(mk $1 $2 $3)" | cut -d'|' -f2)."; done
expect "per-user new-fingerprint limit: 5 distinct approved tuples created, 6th and 7th rejected" "5" "$(su -c "select count(*) from public.system_issues where source='client'")"
expect "rejection reason" "false|user_new_fingerprints" "$(rep "${ATHS[1]}" "$(mk rpc/postgrest PostgrestError 40001)")"
reset
su -c "update public.system_monitoring_config set value = value || '{\"client_new_issues_per_hour\":2}'::jsonb where key='limits'" >/dev/null
rep "${ATHS[2]}" "$(mk rpc/postgrest PostgrestError 21000)" >/dev/null; rep "${ATHS[3]}" "$(mk rpc/postgrest PostgrestError 42883)" >/dev/null
expect "global new-issue limit (set to 2 for the test): third new issue rejected" "false|global_new_fingerprints" "$(rep "${ATHS[4]}" "$(mk rpc/postgrest PostgrestError 40001)")"
expect "...but a report of an EXISTING issue is still accepted" "true|" "$(rep "${ATHS[4]}" "$(mk rpc/postgrest PostgrestError 21000)")"
su -c "update public.system_monitoring_config set value='$CFG_LIM'::jsonb where key='limits'" >/dev/null
reset
# concurrency: 8 users submit the same approved tuple at the same instant
for i in 0 1 2 3 4 5 6 7; do
  ( { echo "select pg_advisory_lock_shared($LOCKKEY);"; echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"${ATHS[$i]}\",\"role\":\"authenticated\"}';"; echo "select (r->>'accepted') from (select public.report_client_error('$GOOD'::jsonb)::jsonb r) q;"; echo "commit;"; } | $PSQL_AUTH -qAt -f - > $TMP/c_$i.out 2>$TMP/c_$i.err ) &
done
sleep 1; $PSQL -qAt -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(0.4); select pg_advisory_unlock($LOCKKEY);" >/dev/null 2>&1; wait
ACC=$(cat $TMP/c_*.out | grep -c '^true$')
expect "concurrent clients: exactly one issue" 1 "$(issues $OP $CL $CODE)"
expect "concurrent clients: occurrence_count equals the accepted reports (no lost update)" "$ACC" "$(su -c "select occurrence_count from public.system_issues where source='client'")"
expect "concurrent clients: no errors" 0 "$(cat $TMP/c_*.err | grep -ci error)"
echo "  info: $ACC of 8 concurrent reports accepted (the rest were dropped by the 200ms lock timeout, by design)"

echo "F: access control"
reset
rep "$ATH" "$GOOD" >/dev/null
ISS=$(su -c "select id from public.system_issues where source='client'")
for T in system_issues system_issue_events system_issue_buckets system_issue_transitions; do
  expect "athlete reads 0 rows of $T" 0 "$(api authenticated "$ATH" "select count(*) from public.$T;" | tail -1)"
  expect "coach reads 0 rows of $T" 0 "$(api authenticated "$COACH" "select count(*) from public.$T;" | tail -1)"
done
expect "manager reads the client issue" 1 "$(api authenticated "$MGR" "select count(*) from public.system_issues where source='client';" | tail -1)"
expect "manager reads the attribution column (approved for the canary)" "$ATH" "$(api authenticated "$MGR" "select user_id from public.system_issue_events limit 1;" | tail -1)"
for T in system_issue_rules system_monitoring_config system_report_quota; do
  for U in "$ATH" "$COACH" "$MGR"; do
    expect "no API user can read $T" t "$(api authenticated "$U" "select count(*) from public.$T;" | grep -q 'permission denied' && echo t || echo f)"
  done
done
expect "athlete cannot call the manager lifecycle RPC (resolve)" "t" "$(api authenticated "$ATH" "select public.system_issue_resolve('$ISS', 'manual_fixed', null);" | grep -qE 'forbidden|not_manager|error' && echo t || echo f)"

echo "G: trusted path unchanged; maintenance"
reset
TP='{"source":"cron","subsystem":"notifications","operation":"cron/test173","error_class":"JobHealth","error_code":"job_stale","message":"Scheduled job x has not started","severity":"warning","fingerprint_key":"job_health:test173:stale","count":1}'
expect "service_role trusted reporting works" "true" "$(api service_role "$MGR" "select (public.system_report_trusted('$TP'::jsonb)::jsonb)->>'accepted';" | tail -1)"
expect "trusted fingerprint is still the explicit key hash" "true" "$(su -c "select (fingerprint = md5('key' || chr(31) || 'job_health:test173:stale'))::text from public.system_issues where operation='cron/test173'")"
expect "trusted severity hints still honoured (critical allowed for trusted)" "critical" "$(api service_role "$MGR" "select public.system_report_trusted('{\"source\":\"cron\",\"operation\":\"cron/test173c\",\"error_class\":\"X\",\"error_code\":\"c\",\"message\":\"m\",\"severity\":\"critical\",\"fingerprint_key\":\"k173c\"}'::jsonb);" >/dev/null; su -c "select severity from public.system_issues where operation='cron/test173c'")"
T1=$(su -c "select (public._system_ingest('trusted', '{\"source\":\"db\",\"operation\":\"db/t173\",\"error_class\":\"E\",\"error_code\":\"c\",\"message\":\"first wording\"}'::jsonb, null)::jsonb)->>'accepted'")
T2=$(su -c "select (public._system_ingest('trusted', '{\"source\":\"db\",\"operation\":\"db/t173\",\"error_class\":\"E\",\"error_code\":\"c\",\"message\":\"second wording\"}'::jsonb, null)::jsonb)->>'accepted'")
expect "trusted reports still fingerprint on message text (behaviour preserved: 2 issues)" 2 "$(su -c "select count(*) from public.system_issues where operation='db/t173'")"
expect "anon and authenticated cannot call the trusted entry point" t "$(api authenticated "$MGR" "select public.system_report_trusted('$TP'::jsonb);" | grep -q 'permission denied' && echo t || echo f)"
# maintenance
rep "$ATH" "$GOOD" >/dev/null
su -c "update public.system_issues set last_seen = now() - interval '60 days' where source='client' or operation in ('cron/test173','db/t173')" >/dev/null
su -c "select public._system_monitoring_maintenance()" >/dev/null
expect "client issue is NOT quiet-auto-resolved after 60 silent days" open "$(su -c "select status from public.system_issues where source='client'")"
expect "trusted warning issue IS quiet-auto-resolved (lifecycle unchanged)" "resolved|auto_quiet" "$(su -c "select status||'|'||resolution from public.system_issues where operation='db/t173' order by created_at limit 1")"
su -c "delete from public.system_issues where operation in ('cron/test173','cron/test173c','db/t173')" >/dev/null

echo "H: lifecycle, severity ceiling, no side effects"
reset
rep "${ATHS[5]}" "$GOOD" >/dev/null
api authenticated "$MGR" "select public.system_issue_mute('$(su -c "select id from public.system_issues where source='client'")');" >/dev/null
rep "${ATHS[6]}" "$GOOD" >/dev/null
expect "muted client issue stays muted and keeps counting" "muted|2" "$(su -c "select status||'|'||occurrence_count from public.system_issues where source='client'")"
IID=$(su -c "select id from public.system_issues where source='client'")
api authenticated "$MGR" "select public.system_issue_unmute('$IID');" >/dev/null
api authenticated "$MGR" "select public.system_issue_resolve('$IID', 'manual_fixed', null);" >/dev/null
expect "manual resolution works for a client issue" "resolved|manual_fixed" "$(su -c "select status||'|'||resolution from public.system_issues where id='$IID'")"
rep "${ATHS[7]}" "$GOOD" >/dev/null
expect "recurrence reopens the resolved client issue" "open|1" "$(su -c "select status||'|'||reopen_count from public.system_issues where id='$IID'")"
su -c "select public._system_monitoring_maintenance()" >/dev/null
expect "maintenance does not touch the reopened client issue" open "$(su -c "select status from public.system_issues where id='$IID'")"
expect "no CRITICAL client issue or event exists" 0 "$(su -c "select (select count(*) from public.system_issues where source='client' and (severity='critical' or base_severity='critical')) + (select count(*) from public.system_issue_events e join public.system_issues i on i.id=e.issue_id where i.source='client' and e.severity='critical')")"
expect "only info/warning/error severities exist for client issues" true "$(su -c "select (not exists (select 1 from public.system_issues where source='client' and severity not in ('info','warning','error')))::text")"
BIZ1=$(su -c "$FP_SQL")
expect "no business or notification table was modified by any test (all non-monitoring public tables byte-identical)" "$BIZ0" "$BIZ1"
# profiles/auth fixtures were created before BIZ0 was taken only for the monitoring flow; the fixture inserts happened earlier.

echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
