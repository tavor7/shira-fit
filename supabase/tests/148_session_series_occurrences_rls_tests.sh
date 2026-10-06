#!/usr/bin/env bash
# Security + regression tests for 20261009100000_lockdown_session_series_occurrences_rls.sql.
#
#   S1  catalog state: RLS enabled, no policies, relacl grants only to postgres (owner); anon/authenticated/
#       service_role hold NO privilege of any kind (incl. TRUNCATE)
#   S2  real PostgREST roles: anon and an ordinary athlete cannot SELECT / INSERT / UPDATE / DELETE the ledger
#   S3  EXPLOIT REGRESSION: an anonymous caller can no longer insert a forged future state='deleted' tombstone;
#       the ledger is not mutated, and the authorized SECURITY DEFINER horizon generator then creates the
#       session normally (the previously-suppressed date materialises)
#   S4  authorized flow: the generator runs under a cron-style NULL auth context and still generates/claims;
#       repeated generation is idempotent; staff series RPCs still reach the ledger through the definer path
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" [REST_URL=.. ANON_KEY=.. JWT_SECRET=..] \
#        supabase/tests/148_session_series_occurrences_rls_tests.sh
# Run on a freshly reset disposable stack that INCLUDES this migration. Self-contained: makes its own coach and
# series; the ledger/series rows it creates are left behind (scratch DB only).
set -u
PSQL=${PSQL:?set PSQL to a psql command line}
FAILED=0; PASSED=0
q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "$1"; }
qs() { $PSQL -qAt -c "set shira.skip_activity_log='on'" -c "$1"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }

TBL=public.session_series_occurrences
CO=00000000-0000-0000-0000-000000000148
SER=00000000-0000-0000-0000-00000000f148

echo "S1: catalog state"
expect "RLS enabled"                 "t"  "$(q "select relrowsecurity from pg_class where oid='$TBL'::regclass")"
expect "no policies"                 "0"  "$(q "select count(*) from pg_policies where schemaname='public' and tablename='session_series_occurrences'")"
expect "relacl lists only the owner" "0"  "$(q "select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a where c.oid='$TBL'::regclass and a.grantee <> c.relowner")"
for r in anon authenticated service_role; do
  expect "$r has no privilege (incl TRUNCATE)" "0" \
    "$(q "select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where has_table_privilege('$r','$TBL',p)")"
done
expect "PUBLIC has no privilege"     "0"  "$(q "select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p where has_table_privilege('public','$TBL',p)")"
# structure untouched
expect "table structure untouched (9 cols, pk, 2 fks, 2 checks)" "9|1|2|2" \
  "$(q "select (select count(*) from information_schema.columns where table_schema='public' and table_name='session_series_occurrences')||'|'||(select count(*) from pg_constraint where conrelid='$TBL'::regclass and contype='p')||'|'||(select count(*) from pg_constraint where conrelid='$TBL'::regclass and contype='f')||'|'||(select count(*) from pg_constraint where conrelid='$TBL'::regclass and contype='c')")"

# fixture: a fresh coach + ongoing series (anchored today so the horizon spans several weekly dates)
qs "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values ('$CO','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t148-coach@test.local',
      jsonb_build_object('full_name','T148 Coach','phone','0501480000','gender','female','address','A','zip_code','1'), now(), now())
    on conflict (id) do nothing" >/dev/null
qs "update public.profiles set role='coach', approval_status='approved' where user_id='$CO'" >/dev/null
qs "insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants, is_open_for_registration, repeat_mode, roster_policy, status)
    values ('$SER','$CO', public._studio_today_date(), '06:30', 60, 8, true, 'ongoing', 'none', 'active')
    on conflict (id) do nothing" >/dev/null
# self-clean prior fixture rows so the test is re-runnable (correct FK order; reset skip_dates the delete-trigger adds)
qs "update public.training_sessions set series_occurrence_id=null where series_id='$SER'" >/dev/null
qs "delete from public.session_series_occurrences where series_id='$SER'" >/dev/null
qs "delete from public.training_sessions where series_id='$SER'" >/dev/null
qs "update public.session_series set skip_dates='{}' where id='$SER'" >/dev/null
EXPECT_DATES=$(q "select count(*) from generate_series(public._studio_today_date(), public._series_horizon_end(), interval '7 day')")
FUT=$(q "select (public._studio_today_date() + 7)::text")

echo "S2/S3: real PostgREST roles + exploit regression"
if [ -n "${REST_URL:-}" ] && [ -n "${ANON_KEY:-}" ] && [ -n "${JWT_SECRET:-}" ]; then
  U=$REST_URL/rest/v1
  b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  jwt() { local h p s; h=$(printf '{"alg":"HS256","typ":"JWT"}'|b64); p=$(printf '{"sub":"%s","role":"authenticated","aud":"authenticated","exp":%s}' "$1" $(($(date +%s)+3600))|b64); s=$(printf '%s.%s' "$h" "$p"|openssl dgst -sha256 -hmac "$JWT_SECRET" -binary|b64); printf '%s.%s.%s' "$h" "$p" "$s"; }
  # an ordinary approved athlete
  ATH=00000000-0000-0000-0000-0000000a0148
  qs "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values ('$ATH','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t148-ath@test.local',
        jsonb_build_object('full_name','T148 Ath','phone','0501480001','gender','female','address','A','zip_code','1'), now(), now())
      on conflict (id) do nothing" >/dev/null
  qs "update public.profiles set approval_status='approved' where user_id='$ATH'" >/dev/null
  ATHJWT=$(jwt "$ATH")
  code() { curl -s -o /tmp/t148.$$ -w '%{http_code}' "$@"; }
  hdr_anon=(-H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY")
  hdr_ath=(-H "apikey: $ANON_KEY" -H "Authorization: Bearer $ATHJWT")
  body='{"series_id":"'$SER'","template_occurrence_date":"'$FUT'","template_coach_id":"'$CO'","template_start_time":"06:30","state":"deleted"}'
  c=$(code "$U/session_series_occurrences?select=id&limit=1" "${hdr_anon[@]}");           expect "anon SELECT blocked"   "401" "$c"
  c=$(code -X POST "$U/session_series_occurrences" "${hdr_anon[@]}" -H 'Content-Type: application/json' --data "$body"); expect "anon INSERT blocked" "401" "$c"
  c=$(code -X PATCH "$U/session_series_occurrences?state=eq.generated" "${hdr_anon[@]}" -H 'Content-Type: application/json' --data '{"state":"skipped"}'); expect "anon UPDATE blocked" "401" "$c"
  c=$(code -X DELETE "$U/session_series_occurrences?state=eq.generated" "${hdr_anon[@]}"); expect "anon DELETE blocked" "401" "$c"
  c=$(code "$U/session_series_occurrences?select=id&limit=1" "${hdr_ath[@]}");             expect "athlete SELECT blocked" "403" "$c"
  c=$(code -X POST "$U/session_series_occurrences" "${hdr_ath[@]}" -H 'Content-Type: application/json' --data "$body"); expect "athlete INSERT blocked" "403" "$c"
  expect "ledger NOT mutated by the blocked attack (0 rows for series)" "0" "$(q "select count(*) from $TBL where series_id='$SER'")"
  rm -f /tmp/t148.$$
else
  echo "  (REST checks skipped: REST_URL/ANON_KEY/JWT_SECRET not set) — catalog proof in S1 already shows anon/authenticated hold no privilege"
fi

echo "S3b/S4: authorized definer path still works (cron-style NULL auth)"
expect "no JWT claims set (cron context)" "" "$(q "select current_setting('request.jwt.claims', true)")"
GEN=$(qs "select public._maintain_session_series_horizon_core()::text")
echo "    generator: $GEN"
expect "generator ok, no failures"          "t" "$(q "select (('$GEN'::json->>'failed')::int = 0 and ('$GEN'::json->>'unresolved_ownership')::int = 0)")"
expect "all horizon dates generated for the series" "$EXPECT_DATES" "$(q "select count(*) from public.training_sessions where series_id='$SER'")"
expect "formerly-suppressible future date materialised" "t" "$(q "select exists(select 1 from public.training_sessions where series_id='$SER' and session_date='$FUT')")"
expect "ledger rows created through the authorized path" "$EXPECT_DATES" "$(q "select count(*) from $TBL where series_id='$SER'")"
GEN2=$(qs "select public._maintain_session_series_horizon_core()::text")
expect "repeated generation is idempotent (creates 0)" "0" "$(echo "$GEN2" | sed -E 's/.*\"created\" : ([0-9]+).*/\1/')"
expect "still exactly one session per horizon date (no dups)" "0" \
  "$(q "select count(*) from (select 1 from public.training_sessions where series_id='$SER' group by session_date having count(*)>1) x")"

echo
echo "148 session_series_occurrences RLS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
