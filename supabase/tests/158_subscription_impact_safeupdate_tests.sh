#!/usr/bin/env bash
# Regression tests for the subscription-impact `safeupdate` defect (migration 20261012100000_fix_subscription_impact_safeupdate.sql).
#
# Defect: subscription_compute_impact cleared its scratch table with a bare `delete from _subscription_impact_before;`. PostgREST
# connects as `authenticator`, whose role setting preloads `safeupdate`, which rejects a DELETE/UPDATE without WHERE (SQLSTATE 21000,
# HTTP 400) even inside a SECURITY DEFINER function. edit_subscription_version, freeze_subscription and stop_subscription call it
# unconditionally, so preview AND confirmed calls failed for every API user. The in-repo SQL suites (70-132) run as a superuser on
# a stub schema where safeupdate is not loaded, which is why nothing caught it.
#
# This test therefore drives the REAL functions over a real `authenticator` connection (safeupdate preloaded), as `authenticated`
# with JWT claims, one transaction per call exactly like PostgREST. It covers, for edit/freeze/stop:
#   P  preview: succeeds, returns the impact, and changes NO persistent data (every non-monitoring public table fingerprinted
#      before/after) and creates no monitoring rows
#   C  confirmed (fresh equivalent fixture): succeeds and the database state is the intended one
#   X  preview/confirmed consistency: the previewed impact equals the impact reported by the confirmed call AND the coverage rows that
#      actually flipped (freeze: also preview_next_billing_date == the real effective next billing date afterwards)
#   R  reactivate after a confirmed stop (not a compute_impact caller, verified here because it shares the workflow)
#   D  two previews in ONE transaction (the scratch table is reused: the clearing statement must really clear every row)
#   S  safeupdate is still enforced for the API role (bare DELETE/UPDATE still rejected) and the role setting is untouched
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/158_subscription_impact_safeupdate_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users, sessions and subscriptions (the authenticator password above is the local
# default). Never run it against production.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
# one transaction as the API would run it: authenticator connection -> authenticated + claims. stdout = result rows, stderr merged.
api() { local uid=$1; shift
  { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}';"; printf '%s\n' "$1"; echo "commit;"; } \
    | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }   # json field

FP_SQL="select md5(string_agg(t || ':' || n || ':' || h, '|' order by t)) from (
  select c.relname::text t,
    (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text n,
    (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) h from public.%I x', '|', '', c.relname), false, true, '')))[1]::text h
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname not like 'system\\_%') z"
MON_SQL="select (select count(*) from public.system_issues) || '/' || (select count(*) from public.system_issue_events)"

# fixture: manager + coach + athlete; subscription (pair limit 1, started 20 days ago); two next-week 'pair' registrations (1 covered,
# 1 allowance_exceeded). Sets M A SUB.
fixture() {
  local tag="$1" n; n=$(date +%s%N | tail -c 8)
  M=$(su -c "select gen_random_uuid()"); local C A0; C=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$M','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f158-$tag-$n-m@t.local', jsonb_build_object('full_name','m','phone','05$n','gender','female','address','A','zip_code','1'), now(), now()),
    ('$C','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f158-$tag-$n-c@t.local', jsonb_build_object('full_name','c','phone','06$n','gender','female','address','A','zip_code','1'), now(), now()),
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f158-$tag-$n-a@t.local', jsonb_build_object('full_name','a','phone','07$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
    update public.profiles set role='manager' where user_id='$M';
    update public.profiles set role='coach' where user_id='$C'" >/dev/null
  local start; start=$(su -c "select current_date - 20")
  local r; r=$(api "$M" "select public.create_subscription('$A', false, 300, '$start', null, extract(day from date '$start')::smallint, jsonb_build_array(jsonb_build_object('tier','pair','weekly_limit',1)));" | grep '^{"ok" : true')
  SUB=$(jf "$r" subscription_id)
  local s1 s2
  s1=$(su -c "insert into training_sessions (session_date,start_time,coach_id,max_participants,is_open_for_registration) values (current_date - extract(dow from current_date)::int + 8,'10:00','$C',2,true) returning id" | head -1)
  s2=$(su -c "insert into training_sessions (session_date,start_time,coach_id,max_participants,is_open_for_registration) values (current_date - extract(dow from current_date)::int + 10,'10:00','$C',2,true) returning id" | head -1)
  api "$A" "select public.register_for_session('$s1');" >/dev/null
  api "$A" "select public.register_for_session('$s2', true);" >/dev/null
  su -c "update session_registrations set attended=true where session_id in ('$s1','$s2') and user_id='$A'" >/dev/null
  COVREG=$(su -c "select registration_id from subscription_registration_coverage where subscription_id='$SUB' and covered")
  expect "fixture $tag: 1 covered + 1 allowance_exceeded" "true|false" "$(su -c "select string_agg(covered::text, '|' order by session_date) from subscription_registration_coverage where subscription_id='$SUB'")"
}
# normalized impact (no ids): count + sorted (tier, week_start, session_date, reason)
norm() { su -c "select (j->>'count') || ' ' || coalesce((select string_agg((i->>'tier')||'/'||(i->>'week_start')||'/'||(i->>'session_date')||'/'||(i->>'new_non_coverage_reason'), ',' order by i->>'session_date') from jsonb_array_elements(j->'items') i), '') from (select '$1'::jsonb j) q"; }
# how many of the registrations that WERE covered (COVREG) lost coverage, and how many covered rows remain
flipped() { su -c "select count(*) from subscription_registration_coverage where subscription_id='$1' and registration_id='$COVREG' and covered=false"; }

# calls per operation (monday-based coverage weeks are NEXT week; each call is chosen to flip exactly the covered registration)
call() { # op confirmed(true|false)
  case "$1" in
    edit)   echo "select public.edit_subscription_version('$SUB', current_date, null, current_date + 1, false, null, $2);" ;;
    freeze) echo "select public.freeze_subscription('$SUB', (current_date - extract(dow from current_date)::int + 7), (current_date - extract(dow from current_date)::int + 13), $2);" ;;
    stop)   echo "select public.stop_subscription('$SUB', current_date, $2);" ;;
  esac; }

echo "S0: the API role really has safeupdate (test environment is representative)"
ROLECFG=$(su -c "select rolconfig::text from pg_roles where rolname='authenticator'")
case "$ROLECFG" in *safeupdate*) ok "authenticator role config preloads safeupdate ($ROLECFG)";; *) fail "authenticator has no safeupdate: $ROLECFG";; esac
OUT=$(echo "create temp table zz_s(a int); delete from zz_s;" | $PSQL_AUTH -qAt -f - 2>&1)
case "$OUT" in *"DELETE requires a WHERE clause"*) ok "bare DELETE is rejected on the authenticator connection";; *) fail "bare DELETE was not rejected: $OUT";; esac

for OP in edit freeze stop; do
  echo "== $OP"
  echo "P: $OP preview is side-effect free"
  fixture "$OP-p"; MP=$M; SUBP=$SUB
  F0=$(su -c "$FP_SQL"); MON0=$(su -c "$MON_SQL")
  RP=$(api "$MP" "$(call $OP false)" | grep '^{')
  F1=$(su -c "$FP_SQL"); MON1=$(su -c "$MON_SQL")
  expect "$OP preview returns ok" true "$(jf "$RP" ok)"
  expect "$OP preview action" preview "$(jf "$RP" action)"
  expect "$OP preview impact.count" 1 "$(jf "$RP" impact,count)"
  expect "$OP preview leaves every non-monitoring public table byte-identical" "$F0" "$F1"
  expect "$OP preview creates no monitoring issue/event" "$MON0" "$MON1"
  PREV=$(su -c "select ('$RP'::jsonb)->'impact'"); PN=$(norm "$PREV")

  echo "D: two previews in one transaction (scratch table reused)"
  RD=$(api "$MP" "$(call $OP false)
$(call $OP false)" | grep '^{')
  expect "$OP: both previews in one transaction succeed" "2" "$(printf '%s\n' "$RD" | grep -c '"action" : "preview"')"

  echo "C: $OP confirmed on an equivalent fresh fixture"
  fixture "$OP-c"; MC=$M; SUBC=$SUB; AC=$A
  RC=$(api "$MC" "$(call $OP true)" | grep '^{')
  expect "$OP confirmed returns ok" true "$(jf "$RC" ok)"
  expect "$OP confirmed action" applied "$(jf "$RC" action)"
  expect "$OP confirmed: one confirmed impact event" 1 "$(su -c "select count(*) from subscription_impact_events where subscription_id='$SUBC' and action_type='$OP' and confirmed")"
  case "$OP" in
    edit)
      expect "edit: old version closed, new version appended" "2" "$(su -c "select count(*) from subscription_versions where subscription_id='$SUBC'")"
      expect "edit: new current version carries the new plan_end_date and supersedes the old one" "true" "$(su -c "select (n.plan_end_date = current_date + 1 and o.superseded_by = n.id and o.effective_to = n.effective_from)::text from subscription_versions o join subscription_versions n on n.subscription_id=o.subscription_id and n.version_no=2 where o.subscription_id='$SUBC' and o.version_no=1")" ;;
    freeze)
      expect "freeze: freeze row stored with the requested dates" "true" "$(su -c "select (freeze_from = current_date - extract(dow from current_date)::int + 7 and freeze_until = current_date - extract(dow from current_date)::int + 13)::text from subscription_freezes where subscription_id='$SUBC'")"
      expect "freeze: exactly one freeze" 1 "$(su -c "select count(*) from subscription_freezes where subscription_id='$SUBC'")"
      ACTNB=$(su -c "select public.subscription_effective_next_billing_date('$SUBC')")
      PRNB=$(jf "$RP" impact,preview_next_billing_date)
      echo "  info: freeze preview_next_billing_date (fixture P) = $PRNB; real effective next billing date after confirm (fixture C) = $ACTNB"
      expect "freeze: previewed next billing date equals the real one after confirming" "$PRNB" "$ACTNB" ;;
    stop)
      expect "stop: current version stopped_effective_date = requested date" "true" "$(su -c "select (stopped_effective_date = current_date)::text from subscription_versions where subscription_id='$SUBC' and effective_to is null")" ;;
  esac
  expect "$OP confirmed: exactly the previewed number of previously covered registrations lost coverage" "$(printf '%s' "$PN" | cut -d' ' -f1)" "$(flipped "$SUBC")"

  echo "X: $OP preview == confirmed impact"
  CN=$(norm "$(su -c "select ('$RC'::jsonb)->'impact'")")
  expect "$OP previewed impact equals confirmed impact" "$PN" "$CN"
  expect "$OP previewed reason equals the reason stored on the flipped registration" "$(printf '%s' "$PN" | sed -E 's#.*/([a-z_]+)$#\1#')" "$(su -c "select non_coverage_reason from subscription_registration_coverage where registration_id='$COVREG'")"

  if [ "$OP" = stop ]; then
    echo "R: reactivate after the confirmed stop"
    RR=$(api "$MC" "select public.reactivate_subscription('$SUBC', current_date, null);" | grep '^{')
    expect "reactivate returns ok" true "$(jf "$RR" ok)"
    NEWSUB=$(jf "$RR" subscription_id)
    expect "reactivate creates a current version for the same payee" "true" "$(su -c "select (s.payee_id='$AC' and exists (select 1 from subscription_versions v where v.subscription_id=s.id and v.effective_to is null and v.stopped_effective_date is null))::text from subscriptions s where s.id='$NEWSUB'")"
  fi
done

echo "S: safeupdate unchanged and still protecting the API role"
expect "authenticator role config unchanged" "$ROLECFG" "$(su -c "select rolconfig::text from pg_roles where rolname='authenticator'")"
OUT=$(echo "create temp table zz_s2(a int); update zz_s2 set a = 1;" | $PSQL_AUTH -qAt -f - 2>&1)
case "$OUT" in *"UPDATE requires a WHERE clause"*) ok "bare UPDATE is still rejected for the API role";; *) fail "bare UPDATE was not rejected: $OUT";; esac
OUT=$(echo "create temp table zz_s3(a int); delete from zz_s3;" | $PSQL_AUTH -qAt -f - 2>&1)
case "$OUT" in *"DELETE requires a WHERE clause"*) ok "bare DELETE is still rejected for the API role";; *) fail "bare DELETE was not rejected: $OUT";; esac
expect "subscription_compute_impact contains no bare DELETE/UPDATE" 0 "$(su -c "select count(*) from pg_proc where proname='subscription_compute_impact' and prosrc ~* 'delete\s+from\s+_subscription_impact_before\s*;'")"

echo "RESULT: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
