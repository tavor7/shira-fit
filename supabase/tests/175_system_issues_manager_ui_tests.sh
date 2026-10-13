#!/usr/bin/env bash
# Phase 4A: the manager "System issues" screens against the REAL local stack (PostgREST + RLS + the Phase 1 lifecycle RPCs) and the
# migration 20261016100000_system_issues_manager_list_support.sql. Exercises exactly the requests the app sends.
#   A  severity_rank (generated, readable only through the manager policy, never writable)
#   B  list / sort / paging / head counts / detail reads as a manager over HTTP
#   C  access: athlete, coach, anonymous see nothing and change nothing; rules/config/quota are closed
#   D  lifecycle RPCs over HTTP (ack, mute, unmute, resolve incl. the stale guard, reopen) and their refusals
#   E  scale: 3000 issues, every list ordering uses an index, no full sort, millisecond execution
#   F  no business/notification table changed
# Usage: PSQL="docker exec -i <db> psql -U postgres" API_URL=http://127.0.0.1:<port> ANON_KEY=... SERVICE_ROLE_KEY=... \
#        supabase/tests/175_system_issues_manager_ui_tests.sh
# SCRATCH/LOCAL ONLY: it commits fixture users and issues (the issues are removed at the end).
set -u
PSQL=${PSQL:?set PSQL}; API_URL=${API_URL:?set API_URL}; ANON_KEY=${ANON_KEY:?}; SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY:?}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
jq1() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=eval("j"+process.argv[1]);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"; }
http() { local tok=$1 method=$2 path=$3; shift 3; curl -s -X "$method" "$API_URL$path" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $tok" -H "content-type: application/json" "$@"; }
mkuser() { # tag role -> "uuid token"
  local n; n=$(date +%s%N | tail -c 8)
  local r; r=$(curl -s -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'content-type: application/json' -d "{\"email\":\"t175-$1-$n@t.local\",\"password\":\"Passw0rd!x\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"u\",\"phone\":\"05$n\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\"}}")
  local id; id=$(echo "$r" | jq1 ".id")
  su -c "update public.profiles set approval_status='approved', role='$2' where user_id='$id'" >/dev/null
  local tok; tok=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"t175-$1-$n@t.local\",\"password\":\"Passw0rd!x\"}" | jq1 ".access_token")
  echo "$id $tok"
}
read -r MGR_ID MGR <<<"$(mkuser mgr manager)"; read -r COACH_ID COACH <<<"$(mkuser coach coach)"; read -r ATH_ID ATH <<<"$(mkuser ath athlete)"
[ -n "$MGR" ] && [ -n "$ATH" ] || { echo "could not create fixture users"; exit 1; }

FP_SQL="select md5(string_agg(t || ':' || n || ':' || h, '|' order by t)) from (
  select c.relname::text t,
    (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text n,
    (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) h from public.%I x', '|', '', c.relname), false, true, '')))[1]::text h
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname not like 'system\\_%' and c.relname not in ('cron_job_run_details')) z"
BIZ0=$(su -c "$FP_SQL")
su -c "delete from public.system_issues where operation like 'cron/t175%'" >/dev/null

# fixtures through the real trusted ingestion path (so events, buckets and transitions exist)
ing() { su -c "select public._system_ingest('trusted', '{\"source\":\"cron\",\"subsystem\":\"notifications\",\"operation\":\"cron/t175-$1\",\"error_class\":\"JobHealth\",\"error_code\":\"job_stale\",\"message\":\"Scheduled job x is late\",\"severity\":\"$2\",\"fingerprint_key\":\"t175:$1\",\"context\":{\"job\":\"t175-$1\",\"reason\":\"stale\"}}'::jsonb, null)" >/dev/null; }
ing crit critical; ing err error; ing warn warning; ing info info
for i in 1 2 3; do ing warn warning; done
CRIT=$(su -c "select id from public.system_issues where operation='cron/t175-crit'"); ERR=$(su -c "select id from public.system_issues where operation='cron/t175-err'")
WARN=$(su -c "select id from public.system_issues where operation='cron/t175-warn'"); INFO=$(su -c "select id from public.system_issues where operation='cron/t175-info'")

echo "A: severity_rank"
expect "rank follows severity (critical 4, error 3, warning 2, info 1)" "4|3|2|1" "$(su -c "select string_agg(severity_rank::text, '|' order by severity_rank desc) from public.system_issues where operation like 'cron/t175-%'")"
su -c "update public.system_issues set severity='error' where id='$INFO'" >/dev/null
expect "rank is regenerated when severity changes" 3 "$(su -c "select severity_rank from public.system_issues where id='$INFO'")"
su -c "update public.system_issues set severity='info' where id='$INFO'" >/dev/null
expect "severity_rank is a generated column" "ALWAYS" "$(su -c "select case attgenerated when 's' then 'ALWAYS' else 'no' end from pg_attribute where attrelid='public.system_issues'::regclass and attname='severity_rank'")"
OUT=$(su -c "update public.system_issues set severity_rank = 1 where id='$INFO'" 2>&1 || true)
case "$OUT" in *"generated column"*) ok "severity_rank cannot be written";; *) fail "severity_rank was writable: $OUT";; esac
expect "anon / service_role have no privilege on severity_rank" "false|false" "$(su -c "select has_column_privilege('anon','public.system_issues','severity_rank','SELECT')::text || '|' || has_column_privilege('service_role','public.system_issues','severity_rank','SELECT')::text")"
expect "authenticated: SELECT yes, UPDATE no" "true|false" "$(su -c "select has_column_privilege('authenticated','public.system_issues','severity_rank','SELECT')::text || '|' || has_column_privilege('authenticated','public.system_issues','severity_rank','UPDATE')::text")"

echo "B: manager reads (the app's exact requests)"
ISSUE_COLS="id,source,subsystem,operation,error_class,error_code,title,latest_summary,severity,base_severity,impact,status,resolution,muted_until,first_seen,last_seen,occurrence_count,reopen_count,reopened_at,acknowledged_at,resolved_at,first_seen_version,last_seen_version,regressed_in_version"
R=$(http "$MGR" GET "/rest/v1/system_issues?select=$ISSUE_COLS&operation=like.cron/t175-*&order=severity_rank.desc,last_seen.desc&offset=0&limit=21")
expect "most severe first (server-side ordering)" "critical,error,warning,info" "$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(r=>r.severity).join(",")))')"
R=$(http "$MGR" GET "/rest/v1/system_issues?select=id,occurrence_count&operation=like.cron/t175-*&order=occurrence_count.desc,last_seen.desc&limit=1")
expect "most frequent first" "$WARN" "$(echo "$R" | jq1 "[0].id")"
R=$(http "$MGR" GET "/rest/v1/system_issues?select=id&operation=like.cron/t175-*&status=in.(open,acknowledged)&order=last_seen.desc&offset=2&limit=21")
expect "paging with offset/limit returns the remaining rows" 2 "$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
CR=$(curl -s -I -X HEAD "$API_URL/rest/v1/system_issues?select=id&status=eq.open&operation=like.cron/t175-*" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR" -H "Prefer: count=exact" | tr -d '\r' | grep -i "^content-range" | sed 's/.*\///')
expect "head-only exact count (dashboard) works and returns no rows" 4 "$CR"
EV="id,occurred_at,severity,app_version,build,platform,env,user_role,message,context,sample_reason,coalesced_count"
expect "events (granted columns, newest first, limited)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/system_issue_events?select=$EV&issue_id=eq.$WARN&order=occurred_at.desc&limit=20" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")"
expect "transitions (granted columns)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/system_issue_transitions?select=id,at,from_status,to_status,kind,reason&issue_id=eq.$WARN&order=at.desc&limit=100" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")"
expect "buckets (granted columns)" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/system_issue_buckets?select=bucket_start,count&issue_id=eq.$WARN&order=bucket_start.desc&limit=24" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")"
expect "the single-issue read used by the detail screen" "$WARN" "$(http "$MGR" GET "/rest/v1/system_issues?select=$ISSUE_COLS&id=eq.$WARN" -H "Accept: application/vnd.pgrst.object+json" | jq1 ".id")"

echo "C: access control"
for who in ATH COACH; do
  tok=${!who}
  for T in system_issues system_issue_events system_issue_buckets system_issue_transitions; do
    col=id; [ "$T" = system_issue_buckets ] && col=issue_id
    expect "$who reads 0 rows of $T" "[]" "$(http "$tok" GET "/rest/v1/$T?select=$col&limit=5" 2>/dev/null | sed 's/ //g' | sed 's/{"id".*/[nonempty]/')"
  done
  for T in system_issue_rules system_monitoring_config system_report_quota; do
    expect "$who cannot read $T" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/$T?select=*&limit=1" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $tok")"
  done
  expect "$who cannot count issues (head count is 0)" 0 "$(curl -s -I -X HEAD "$API_URL/rest/v1/system_issues?select=id" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $tok" -H "Prefer: count=exact" | tr -d '\r' | grep -i '^content-range' | sed 's/.*\///')"
done
for T in system_issue_rules system_monitoring_config system_report_quota; do
  expect "even a manager cannot read $T (no rule/config/ingestion switch is exposed)" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/$T?select=*&limit=1" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")"
done
expect "anonymous (anon key only) cannot read issues" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/system_issues?select=id&limit=1" -H "apikey: $ANON_KEY")"
expect "a manager cannot modify issues through the table API (PATCH)" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API_URL/rest/v1/system_issues?id=eq.$WARN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"status":"resolved"}')"
expect "...DELETE" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API_URL/rest/v1/system_issues?id=eq.$WARN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")"
expect "...POST" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/rest/v1/system_issues" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"title":"x"}')"
expect "...nor events or rules" "403|403" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API_URL/rest/v1/system_issue_events?issue_id=eq.$WARN" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR")|$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/rest/v1/system_issue_rules" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"match_operation":"x"}')"

echo "D: lifecycle actions over HTTP"
TOMORROW=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+1 day" +%Y-%m-%dT%H:%M:%SZ)
rpc() { http "$1" POST "/rest/v1/rpc/$2" -d "$3"; }
b_id() { printf '{"p_issue_id":"%s"}' "$1"; }
b_resolve() { printf '{"p_issue_id":"%s","p_reason":"%s","p_expected_last_seen":%s}' "$1" "$2" "$3"; }
b_mute() { printf '{"p_issue_id":"%s","p_until":%s}' "$1" "$2"; }
expect "athlete cannot acknowledge" "forbidden" "$(rpc "$ATH" system_issue_acknowledge "$(b_id $WARN)" | jq1 ".error")"
expect "coach cannot resolve" "forbidden" "$(rpc "$COACH" system_issue_resolve "$(b_resolve $WARN manual_fixed null)" | jq1 ".error")"
expect "manager acknowledges" "acknowledged" "$(rpc "$MGR" system_issue_acknowledge "$(b_id $WARN)" | jq1 ".status")"
expect "acknowledging twice is idempotent" "acknowledged" "$(rpc "$MGR" system_issue_acknowledge "$(b_id $WARN)" | jq1 ".status")"
expect "manager mutes for 24 hours" "muted" "$(rpc "$MGR" system_issue_mute "$(b_mute $WARN \"$TOMORROW\")" | jq1 ".status")"
expect "an invalid mute end is refused" "invalid_until" "$(rpc "$MGR" system_issue_mute "$(b_mute $ERR \"2000-01-01T00:00:00Z\")" | jq1 ".error")"
expect "unmute" "open" "$(rpc "$MGR" system_issue_unmute "$(b_id $WARN)" | jq1 ".status")"
expect "unmuting a non-muted issue is invalid_state" "invalid_state" "$(rpc "$MGR" system_issue_unmute "$(b_id $WARN)" | jq1 ".error")"
LS=$(su -c "select to_char(last_seen at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') from public.system_issues where id='$WARN'")
su -c "select public._system_ingest('trusted', '{\"source\":\"cron\",\"subsystem\":\"notifications\",\"operation\":\"cron/t175-warn\",\"error_class\":\"JobHealth\",\"error_code\":\"job_stale\",\"message\":\"again\",\"severity\":\"warning\",\"fingerprint_key\":\"t175:warn\"}'::jsonb, null)" >/dev/null
expect "resolving with a stale last_seen is refused (a newer occurrence arrived)" "stale" "$(rpc "$MGR" system_issue_resolve "$(b_resolve $WARN manual_fixed \"$LS\")" | jq1 ".error")"
LS2=$(su -c "select to_char(last_seen at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') from public.system_issues where id='$WARN'")
expect "resolving with the current last_seen succeeds" "resolved" "$(rpc "$MGR" system_issue_resolve "$(b_resolve $WARN manual_expected \"$LS2\")" | jq1 ".status")"
expect "resolving again is invalid_state" "invalid_state" "$(rpc "$MGR" system_issue_resolve "$(b_resolve $WARN manual_fixed null)" | jq1 ".error")"
expect "reopen" "open" "$(rpc "$MGR" system_issue_reopen "$(b_id $WARN)" | jq1 ".status")"
expect "the lifecycle history lists every transition for the detail screen" "t" "$(su -c "select (count(*) >= 6 and bool_or(kind='ack') and bool_or(kind='mute') and bool_or(kind='unmute') and bool_or(kind='resolve') and bool_or(kind='reopen'))::text from public.system_issue_transitions where issue_id='$WARN'" | sed 's/true/t/')"
expect "an unknown issue id is not_found" "not_found" "$(rpc "$MGR" system_issue_acknowledge "$(b_id 00000000-0000-0000-0000-000000000000)" | jq1 ".error")"
expect "no manager notification table or queue was written" 0 "$(su -c "select count(*) from public.manager_operational_notifications where created_at > now() - interval '5 minutes'" 2>/dev/null || echo 0)"

echo "E: scale (3000 issues)"
su -c "insert into public.system_issues (fingerprint, source, reported_subsystem, subsystem, operation, error_class, error_code, title, latest_summary, base_severity, severity, status, resolved_at, first_seen, last_seen, occurrence_count)
  select md5('t175bulk' || g), 'cron', 'notifications', 'notifications', 'cron/t175-bulk-' || (g % 40), 'JobHealth', 'job_stale', 'bulk ' || g, 'bulk', 'warning',
         (array['info','warning','error','critical'])[1 + g % 4], (array['open','acknowledged','resolved','muted'])[1 + g % 4], case when g % 4 = 2 then now() else null end, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, 1 + (g * 7) % 500
  from generate_series(1, 3000) g" >/dev/null
su -c "analyze public.system_issues" >/dev/null
plan() { su -c "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s)[0];const txt=JSON.stringify(p.Plan);console.log((txt.includes("\"Node Type\":\"Sort\"")?"SORT":"nosort")+" "+(/Index/.test(txt)?"index":"noindex")+" "+Math.round(p["Execution Time"])+" "+(/external/.test(txt)?"disk":"memory"))})'; }
for spec in "last_seen desc|recent" "severity_rank desc, last_seen desc|severe" "occurrence_count desc, last_seen desc|frequent"; do
  ord=${spec%%|*}; nm=${spec##*|}
  P1=$(plan "explain (analyze, format json) select id from public.system_issues order by $ord limit 21 offset 0")
  [ "$(echo "$P1" | cut -d' ' -f3)" -le 50 ] && [ "$(echo "$P1" | cut -d' ' -f4)" = memory ] && ok "$nm ordering executes in <= 50 ms in memory ($P1)" || fail "$nm ordering too slow: $P1"
  P3=$(plan "set enable_seqscan = off; explain (analyze, format json) select id from public.system_issues order by $ord limit 21 offset 0" | tail -1)
  expect "$nm ordering can be served by an index (no sort node)" "nosort index" "$(echo "$P3" | cut -d' ' -f1-2)"
done
P2=$(plan "explain (analyze, format json) select id from public.system_issues where status in ('open','acknowledged') order by last_seen desc limit 21")
[ "$(echo "$P2" | cut -d' ' -f3)" -le 50 ] && ok "filtered list (active, recent) <= 50 ms" || fail "filtered list slow: $P2"
CNT=$(curl -s -I -X HEAD "$API_URL/rest/v1/system_issues?select=id&status=eq.open" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR" -H "Prefer: count=exact" | tr -d '\r' | grep -i '^content-range' | sed 's/.*\///')
[ "${CNT:-0}" -gt 700 ] && ok "head count over thousands of rows works ($CNT open)" || fail "head count over bulk rows: $CNT"
su -c "delete from public.system_issues where operation like 'cron/t175%'" >/dev/null
expect "fixtures removed" 0 "$(su -c "select count(*) from public.system_issues where operation like 'cron/t175%'")"

echo "F: no business data touched"
expect "all non-monitoring public tables byte-identical (apart from the three fixture profiles created before the snapshot)" "$BIZ0" "$(su -c "$FP_SQL")"

echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
