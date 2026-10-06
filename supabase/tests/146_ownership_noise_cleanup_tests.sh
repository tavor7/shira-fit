#!/usr/bin/env bash
# Tests for 20261008100000_cleanup_series_unresolved_ownership_noise.sql on the production-shaped fixture
# (146_ownership_noise_cleanup_fixture.sql). Every scenario runs the migration exactly as `db push` does: one
# autocommit statement, separate connection.
#
#   T0  test copy = the real migration with ONLY the two md5 constants replaced by the fixture's fingerprints
#   T1  guard aborts (each must raise the named STOP and leave the database byte-identical, ops_archive absent):
#       wrong count, changed production (incident rows pruned), wrong id fingerprint, wrong full fingerprint,
#       post-recovery event (exact boundary), unexpected shape (actor / extra key), invariant failure (duplicate
#       active series; survivor ended), wrong summary grouping
#   T2  fault injection after guards (must roll back archive schema, archive rows, summary and deletion):
#       partial archive copy, corrupted archive copy, summary loss, delete-count mismatch (row skipped by a
#       trigger), post-check failures (target row reappears, unrelated row written, unrelated table written)
#   T3  success: exact counts, archive fingerprints, 54-row summary, every non-target row byte-identical,
#       near misses preserved, archive ACL/RLS/ownership/no sequences/no FKs, optional REST exposure check
#   T4  restore from the archive recreates the exact original dataset (ids, timestamps, every column) and both
#       fingerprints
#   T5  concurrency: a writer that tries to add an incident-shaped row (and an ordinary event) while the cleanup
#       holds its lock waits until commit and can never enter the deletion set
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" MIG=supabase/migrations/20261008100000_cleanup_series_unresolved_ownership_noise.sql \
#        [REST_URL=http://127.0.0.1:54321 ANON_KEY=...] supabase/tests/146_ownership_noise_cleanup_tests.sh
# SCRATCH DATABASE ONLY (commits, mutates and restores data). Requires the fixture to be loaded.
set -u
PSQL=${PSQL:?set PSQL to a psql command line}
MIG=${MIG:-supabase/migrations/20261008100000_cleanup_series_unresolved_ownership_noise.sql}
TMP=$(mktemp -d)
FAILED=0
PASSED=0

q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "set timezone = 'UTC'" -c "$1"; }
qs() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "set shira.skip_activity_log = 'on'" -c "$1" >/dev/null; }   # setup/undo, no activity logging
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }

# whole-database state the cleanup may touch: every activity row (all columns), the series, the archive schema
snap() {
  q "select (select count(*) || ':' || md5(coalesce(string_agg(e::text, ',' order by e.id), '')) from public.user_activity_events e)
         || '|' || (select md5(string_agg(s::text, ',' order by s.id)) from (select id, coach_id, anchor_date, start_time, status, ended_from_date, skip_dates, repeat_mode, max_participants from public.session_series) s)
         || '|' || (select count(*) from public.training_sessions)
         || '|' || (select count(*) from pg_namespace where nspname = 'ops_archive')"
}
run_mig() { $PSQL -v ON_ERROR_STOP=1 -q -f - < "$1" > "$TMP/out.log" 2>&1; }
# variant <name> <marker> <sql>: test copy with <sql> inserted after the "-- @inject:<marker>" line
variant() {
  perl -pe "if (/-- \@inject:$2\$/) { \$_ .= q{    $3} . qq{\n} }" "$TMP/mig_test.sql" > "$TMP/$1.sql"
  if cmp -s "$TMP/mig_test.sql" "$TMP/$1.sql"; then echo "variant $1: marker $2 not found"; exit 2; fi
}
expect_abort() {   # <label> <migration file> <expected STOP tag>
  local before after
  before=$(snap)
  if run_mig "$2"; then fail "$1: migration succeeded but must abort"; return; fi
  if grep -q "$3" "$TMP/out.log"; then ok "$1 aborts with $3"; else fail "$1: expected $3, got: $(grep -m1 ERROR "$TMP/out.log")"; fi
  after=$(snap)
  if [ "$before" = "$after" ]; then ok "$1 left the database byte-identical (no archive schema)"; else fail "$1: state changed: $before -> $after"; fi
}

BASE=$(snap)
expect "fixture loaded: 38132 incident rows" "38132" "$(q "select count(*) from public.user_activity_events where event_type = 'series_unresolved_ownership'")"
expect "no ops_archive before the tests" "0" "$(q "select count(*) from pg_namespace where nspname = 'ops_archive'")"

echo "T0: test copy of the migration"
FP_IDS=$(q "select md5(string_agg(id::text, ',' order by id)) from public.user_activity_events where event_type = 'series_unresolved_ownership'")
FP_FULL=$(q "select md5(string_agg(id::text || '|' || created_at::text || '|' || metadata::text, ',' order by id)) from public.user_activity_events where event_type = 'series_unresolved_ownership'")
perl -pe "s/'a2438e2ba6dc665e3d135fc7fdd4e16b'/'$FP_IDS'/; s/'0a239bf9bba0fe8a01f2c617f5e9a73a'/'$FP_FULL'/" "$MIG" > "$TMP/mig_test.sql"
expect "test copy differs from the migration in exactly the 2 fingerprint lines" "2" "$(diff "$MIG" "$TMP/mig_test.sql" | grep -c '^<')"

echo "T1: guard aborts"
T1=$(q "select id from public.user_activity_events where event_type = 'series_unresolved_ownership' order by id offset 1000 limit 1")
qs "create table if not exists public.t146_saved as select * from public.user_activity_events where false"

qs "insert into public.t146_saved select * from public.user_activity_events where id = '$T1'; delete from public.user_activity_events where id = '$T1'"
expect_abort "wrong count (one incident row missing)" "$TMP/mig_test.sql" "STOP B2"
qs "insert into public.user_activity_events select * from public.t146_saved; truncate public.t146_saved"
expect "restored after wrong-count" "$BASE" "$(snap)"

qs "insert into public.t146_saved select * from public.user_activity_events where event_type = 'series_unresolved_ownership';
    delete from public.user_activity_events where event_type = 'series_unresolved_ownership'"
expect_abort "changed production: all incident rows pruned, reviewed series present (must not no-op)" "$TMP/mig_test.sql" "STOP B2"
qs "insert into public.user_activity_events select * from public.t146_saved; truncate public.t146_saved"
expect "restored after pruned-production" "$BASE" "$(snap)"

perl -pe "s/'$FP_IDS'/'00000000000000000000000000000000'/" "$TMP/mig_test.sql" > "$TMP/wrong_ids.sql"
expect_abort "wrong id fingerprint" "$TMP/wrong_ids.sql" "STOP B3"

qs "insert into public.t146_saved select * from public.user_activity_events where id = '$T1';
    update public.user_activity_events set metadata = jsonb_set(metadata, '{candidate_series_ids}',
      (select jsonb_agg(x order by o desc) from jsonb_array_elements(metadata -> 'candidate_series_ids') with ordinality t(x, o))) where id = '$T1'"
expect_abort "wrong full fingerprint (candidate order of one row changed)" "$TMP/mig_test.sql" "STOP B4"
qs "update public.user_activity_events u set metadata = s.metadata from public.t146_saved s where u.id = s.id; truncate public.t146_saved"
qs "insert into public.t146_saved select * from public.user_activity_events where id = '$T1';
    update public.user_activity_events set created_at = created_at + interval '1 microsecond' where id = '$T1'"
expect_abort "wrong full fingerprint (one timestamp moved by 1 microsecond)" "$TMP/mig_test.sql" "STOP B4"
qs "update public.user_activity_events u set created_at = s.created_at from public.t146_saved s where u.id = s.id; truncate public.t146_saved"
expect "restored after fingerprint tests" "$BASE" "$(snap)"

NEWROW="'{\"template_coach_id\":\"358d14ba-9971-4a6b-b317-1a435001ea83\",\"template_start_time\":\"09:00:00\",\"template_occurrence_date\":\"2026-11-15\",\"candidate_series_ids\":[\"00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2\",\"f5c2c55a-4da4-411c-9541-e0d8155d1e29\"]}'"
qs "insert into public.user_activity_events (id, created_at, event_type, target_type, metadata) values
    ('aaaaaaaa-0000-0000-0000-000000000001', '2026-10-05 19:53:26.176934+00', 'series_unresolved_ownership', 'session_series', $NEWROW)"
expect_abort "post-recovery ownership event (exactly at the recovery boundary)" "$TMP/mig_test.sql" "STOP B6"
qs "delete from public.user_activity_events where id = 'aaaaaaaa-0000-0000-0000-000000000001'"
qs "insert into public.user_activity_events (id, created_at, event_type, target_type, metadata) values
    ('aaaaaaaa-0000-0000-0000-000000000002', now(), 'series_unresolved_ownership', 'session_series', $NEWROW)"
expect_abort "new ownership event now (generation resumed)" "$TMP/mig_test.sql" "STOP B6"
qs "delete from public.user_activity_events where id = 'aaaaaaaa-0000-0000-0000-000000000002'"
qs "insert into public.user_activity_events (id, created_at, actor_user_id, event_type, target_type, metadata) values
    ('aaaaaaaa-0000-0000-0000-000000000003', '2026-10-03 00:00+00', '358d14ba-9971-4a6b-b317-1a435001ea83', 'series_unresolved_ownership', 'session_series', $NEWROW)"
expect_abort "unexpected shape (actor present)" "$TMP/mig_test.sql" "STOP B7"
qs "delete from public.user_activity_events where id = 'aaaaaaaa-0000-0000-0000-000000000003'"
qs "insert into public.user_activity_events (id, created_at, event_type, target_type, metadata) values
    ('aaaaaaaa-0000-0000-0000-000000000004', '2026-10-03 00:00+00', 'series_unresolved_ownership', 'session_series', $NEWROW::jsonb || '{\"extra\":1}')"
expect_abort "unexpected shape (extra metadata key)" "$TMP/mig_test.sql" "STOP B7"
qs "delete from public.user_activity_events where id = 'aaaaaaaa-0000-0000-0000-000000000004'"
qs "insert into public.user_activity_events (id, created_at, event_type, target_type, metadata) values
    ('aaaaaaaa-0000-0000-0000-000000000005', '2026-10-03 00:00+00', 'series_unresolved_ownership', 'session_series',
     jsonb_set($NEWROW::jsonb, '{candidate_series_ids}', '[\"00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2\",\"11111111-1111-1111-1111-111111111111\"]'))"
expect_abort "unexpected shape (candidate outside the reviewed series)" "$TMP/mig_test.sql" "STOP B7"
qs "delete from public.user_activity_events where id = 'aaaaaaaa-0000-0000-0000-000000000005'"
expect "restored after shape tests" "$BASE" "$(snap)"

qs "update public.session_series set status = 'active', ended_from_date = null where id = 'df74284d-add2-4c46-913b-4ad6cbfd1c48'"
expect_abort "invariant failure (a retired duplicate series re-activated)" "$TMP/mig_test.sql" "STOP B8"
qs "update public.session_series set status = 'ended', ended_from_date = '2026-10-02' where id = 'df74284d-add2-4c46-913b-4ad6cbfd1c48'"
qs "update public.session_series set status = 'ended', ended_from_date = '2099-01-01' where id = 'bf756f0b-b4e7-435d-8a05-3cda60d3e021'"
expect_abort "reviewed survivor no longer active" "$TMP/mig_test.sql" "STOP B9"
qs "update public.session_series set status = 'active', ended_from_date = null where id = 'bf756f0b-b4e7-435d-8a05-3cda60d3e021'"
SER_NOW=$(q "select md5(string_agg(s::text, ',' order by s.id)) from (select id, coach_id, anchor_date, start_time, status, ended_from_date, skip_dates from public.session_series) s")
perl -pe "s/c_expected_groups constant int         := 54;/c_expected_groups constant int         := 53;/" "$TMP/mig_test.sql" > "$TMP/wrong_groups.sql"
expect_abort "wrong summary grouping count (54 expected 53)" "$TMP/wrong_groups.sql" "STOP B10"

echo "T2: fault injection after the guards (full rollback)"
variant partial_archive after_archive "delete from ops_archive.user_activity_events_ownership_incident_20261005 where id = (select id from ops_archive.user_activity_events_ownership_incident_20261005 order by id limit 1);"
expect_abort "archive copy incomplete" "$TMP/partial_archive.sql" "STOP D2"
variant corrupt_archive after_archive "update ops_archive.user_activity_events_ownership_incident_20261005 set created_at = created_at + interval '1 second' where id = (select id from ops_archive.user_activity_events_ownership_incident_20261005 order by id limit 1);"
expect_abort "archive copy corrupted" "$TMP/corrupt_archive.sql" "STOP D2"
variant lost_summary after_summary "delete from ops_archive.series_ownership_incident_summary where template_occurrence_date = '2026-11-08';"
expect_abort "summary rows lost" "$TMP/lost_summary.sql" "STOP D5"
variant tamper_summary after_delete "delete from ops_archive.series_ownership_incident_summary where template_occurrence_date = '2026-11-08';"
expect_abort "summary tampered after its checks (transaction write audit)" "$TMP/tamper_summary.sql" "STOP E5"
qs "create function public.t146_skip_one() returns trigger language plpgsql as \$f\$ begin if old.id = '$T1' then return null; end if; return old; end \$f\$;
    create trigger t146_skip_one before delete on public.user_activity_events for each row execute function public.t146_skip_one()"
expect_abort "delete-count mismatch (one row not deleted)" "$TMP/mig_test.sql" "STOP D6"
qs "drop trigger t146_skip_one on public.user_activity_events; drop function public.t146_skip_one()"
variant reappear after_delete "insert into public.user_activity_events (created_at, event_type, target_type, metadata) select created_at, event_type, target_type, metadata from ops_archive.user_activity_events_ownership_incident_20261005 limit 1;"
expect_abort "post-check: an incident row reappears" "$TMP/reappear.sql" "STOP E1"
variant other_row after_delete "insert into public.user_activity_events (event_type) values ('t146_unrelated_write');"
expect_abort "post-check: a non-target row appears" "$TMP/other_row.sql" "STOP E2"
variant other_table after_delete "insert into public.app_kv_settings (key, value_json, updated_at) values ('t146_probe', '1', now());"
expect_abort "post-check: an unrelated table is written" "$TMP/other_table.sql" "STOP E5"
expect "restored after fault injection" "$BASE" "$(snap)"

echo "T3: successful cleanup"
NT_BEFORE=$(q "select count(*) || ':' || md5(string_agg(e::text, ',' order by e.id)) from public.user_activity_events e where event_type <> 'series_unresolved_ownership'")
NEAR_BEFORE=$(q "select count(*) from public.user_activity_events where event_type <> 'series_unresolved_ownership' and (event_type like 'series%' or metadata::text like '%ownership%' or metadata::text like '%candidate_series_ids%' or jsonb_typeof(metadata) <> 'object')")
TOTAL_BEFORE=$(q "select count(*) from public.user_activity_events")
if run_mig "$TMP/mig_test.sql" && grep -q "OWNERSHIP-NOISE CLEANUP OK" "$TMP/out.log"; then ok "cleanup migration succeeded"; else fail "cleanup failed: $(cat "$TMP/out.log")"; fi
expect "live incident rows" "0" "$(q "select count(*) from public.user_activity_events where event_type = 'series_unresolved_ownership'")"
expect "live rows decreased by exactly 38132" "$((TOTAL_BEFORE - 38132))" "$(q "select count(*) from public.user_activity_events")"
expect "every non-target row byte-identical" "$NT_BEFORE" "$(q "select count(*) || ':' || md5(string_agg(e::text, ',' order by e.id)) from public.user_activity_events e")"
expect "near-miss rows preserved" "$NEAR_BEFORE" "$(q "select count(*) from public.user_activity_events where event_type like 'series%' or metadata::text like '%ownership%' or metadata::text like '%candidate_series_ids%' or jsonb_typeof(metadata) <> 'object'")"
expect "reverted business event preserved" "1" "$(q "select count(*) from public.user_activity_events where reverted_at is not null")"
expect "archive rows" "38132" "$(q "select count(*) from ops_archive.user_activity_events_ownership_incident_20261005")"
expect "archive id fingerprint" "$FP_IDS" "$(q "select md5(string_agg(id::text, ',' order by id)) from ops_archive.user_activity_events_ownership_incident_20261005")"
expect "archive full fingerprint" "$FP_FULL" "$(q "select md5(string_agg(id::text || '|' || created_at::text || '|' || metadata::text, ',' order by id)) from ops_archive.user_activity_events_ownership_incident_20261005")"
expect "summary rows / total events / incident" "54|38132|1|1" "$(q "select count(*) || '|' || sum(event_count) || '|' || count(distinct incident_id) || '|' || count(distinct (recovery_migration, cleanup_migration)) from ops_archive.series_ownership_incident_summary")"
expect "two candidate orders folded into one logical conflict" "692|{00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2,f5c2c55a-4da4-411c-9541-e0d8155d1e29}|2026-10-01 11:50:05.054777+00" \
  "$(q "select event_count || '|' || candidate_series_ids::text || '|' || first_seen_at from ops_archive.series_ownership_incident_summary where template_coach_id = '358d14ba-9971-4a6b-b317-1a435001ea83' and template_start_time = '09:00' and template_occurrence_date = '2026-10-04'")"
expect "summary window" "2026-10-01 11:50:05.054777+00|2026-10-05 19:42:13.157028+00" "$(q "select min(first_seen_at) || '|' || max(last_seen_at) from ops_archive.series_ownership_incident_summary")"
expect "series unchanged" "$SER_NOW" "$(q "select md5(string_agg(s::text, ',' order by s.id)) from (select id, coach_id, anchor_date, start_time, status, ended_from_date, skip_dates from public.session_series) s")"
# archive security
expect "schema/table owners are postgres" "postgres|postgres|postgres" "$(q "select (select nspowner::regrole::text from pg_namespace where nspname = 'ops_archive') || '|' || string_agg(relowner::regrole::text, '|' order by relname) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'r'")"
expect "no schema USAGE/CREATE for public/anon/authenticated/service_role" "0" \
  "$(q "select count(*) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['USAGE','CREATE']) p where has_schema_privilege(r, 'ops_archive', p)")"
expect "no table privilege of any kind for anon/authenticated/service_role" "0" \
  "$(q "select count(*) from pg_class c, unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'ops_archive'::regnamespace and c.relkind = 'r' and has_table_privilege(r, c.oid, p)")"
expect "ACLs list only the owner" "0" "$(q "select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.relnamespace = 'ops_archive'::regnamespace and a.grantee <> c.relowner")"
expect "schema ACL lists only the owner" "0" "$(q "select count(*) from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'ops_archive' and a.grantee <> n.nspowner")"
expect "RLS enabled on both tables, no policies" "2|0" "$(q "select count(*) filter (where relrowsecurity) || '|' || (select count(*) from pg_policies where schemaname = 'ops_archive') from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'r'")"
expect "no sequences / identity / defaults in ops_archive" "0|0|0" "$(q "select (select count(*) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'S') || '|' || (select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'ops_archive'::regnamespace and a.attidentity <> '') || '|' || (select count(*) from pg_attrdef d join pg_class c on c.oid = d.adrelid where c.relnamespace = 'ops_archive'::regnamespace)")"
expect "no foreign keys from the archive" "0" "$(q "select count(*) from pg_constraint where connamespace = 'ops_archive'::regnamespace and contype = 'f'")"
expect "anon cannot read the summary" "permission denied" "$($PSQL -qAt -c "set role anon" -c "select count(*) from ops_archive.series_ownership_incident_summary" 2>&1 | grep -o 'permission denied' | head -1)"
expect "service_role cannot read the archive" "permission denied" "$($PSQL -qAt -c "set role service_role" -c "select count(*) from ops_archive.user_activity_events_ownership_incident_20261005" 2>&1 | grep -o 'permission denied' | head -1)"
if [ -n "${REST_URL:-}" ] && [ -n "${ANON_KEY:-}" ]; then
  CODE=$(curl -s -o "$TMP/rest.json" -w '%{http_code}' -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Accept-Profile: ops_archive" "$REST_URL/rest/v1/series_ownership_incident_summary?select=*")
  if [ "$CODE" != "200" ]; then ok "REST refuses the ops_archive profile (HTTP $CODE: $(head -c 120 "$TMP/rest.json"))"; else fail "REST exposed ops_archive"; fi
else
  echo "  (REST exposure check skipped: REST_URL/ANON_KEY not set)"
fi

echo "T4: exact restoration from the archive"
qs "insert into public.user_activity_events (id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by)
    select id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by
    from ops_archive.user_activity_events_ownership_incident_20261005"
expect "restored ids fingerprint" "$FP_IDS" "$(q "select md5(string_agg(id::text, ',' order by id)) from public.user_activity_events where event_type = 'series_unresolved_ownership'")"
expect "restored id/created_at/metadata fingerprint" "$FP_FULL" "$(q "select md5(string_agg(id::text || '|' || created_at::text || '|' || metadata::text, ',' order by id)) from public.user_activity_events where event_type = 'series_unresolved_ownership'")"
qs "drop schema ops_archive cascade"   # test reset only
expect "restored dataset identical to the original (every row, every column)" "$BASE" "$(snap)"

echo "T5: concurrency"
variant slow after_guards "perform pg_sleep(4);"
( run_mig "$TMP/slow.sql"; echo $? > "$TMP/a.rc"; cp "$TMP/out.log" "$TMP/a.log" ) &
APID=$!
sleep 1.5
T0=$(now_ms)
qs "insert into public.user_activity_events (id, created_at, event_type, target_type, metadata) values
      ('bbbbbbbb-0000-0000-0000-000000000001', '2026-10-03 00:00+00', 'series_unresolved_ownership', 'session_series', $NEWROW);
    insert into public.user_activity_events (id, event_type, target_type) values ('bbbbbbbb-0000-0000-0000-000000000002', 't146_concurrent', 'profile')"
WAITED=$(( $(now_ms) - T0 ))
wait $APID
expect "cleanup with a concurrent writer succeeded" "0" "$(cat "$TMP/a.rc")"
if [ "$WAITED" -ge 2000 ]; then ok "concurrent writer waited ${WAITED} ms for the cleanup lock"; else fail "concurrent writer did not wait (${WAITED} ms)"; fi
expect "archive holds exactly the reviewed rows" "38132|$FP_IDS|0" "$(q "select count(*) || '|' || md5(string_agg(id::text, ',' order by id)) || '|' || count(*) filter (where id::text like 'bbbbbbbb%') from ops_archive.user_activity_events_ownership_incident_20261005")"
expect "the incident-shaped row written concurrently was NOT deleted; the ordinary event survives" "2" "$(q "select count(*) from public.user_activity_events where id::text like 'bbbbbbbb%'")"
qs "delete from public.user_activity_events where id::text like 'bbbbbbbb%';
    insert into public.user_activity_events select id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by
    from ops_archive.user_activity_events_ownership_incident_20261005;
    drop schema ops_archive cascade; drop table public.t146_saved"
expect "fixture restored after the concurrency test" "$BASE" "$(snap)"

echo
echo "146 ownership-noise cleanup: $PASSED passed, $FAILED failed"
rm -rf "$TMP"
[ "$FAILED" -eq 0 ]
