#!/usr/bin/env bash
# Structural / fresh-replay tests for 20261008100000_cleanup_series_unresolved_ownership_noise.sql.
#
#   S1  fresh replay created the restricted archive objects, empty
#   S2  ownership, ACLs (schema + tables), RLS without policies, no sequences/identity/defaults, no foreign keys,
#       real API roles are refused
#   S3  fresh-empty vs changed environment: a database holding a series_unresolved_ownership row but none of the
#       reviewed series is NOT treated as a fresh replay -- the migration raises (STOP B2) instead of no-op'ing
#
# Usage: PSQL="docker exec -i <db-container> psql -U postgres" MIG=supabase/migrations/20261008100000_cleanup_series_unresolved_ownership_noise.sql \
#        supabase/tests/147_ownership_noise_cleanup_structural_tests.sh
# Run on a freshly replayed scratch database. S3 runs inside a transaction that is always rolled back.
set -u
PSQL=${PSQL:?set PSQL to a psql command line}
MIG=${MIG:-supabase/migrations/20261008100000_cleanup_series_unresolved_ownership_noise.sql}
FAILED=0
PASSED=0
q() { $PSQL -qAt -v ON_ERROR_STOP=1 -c "$1"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }

echo "S1: fresh replay"
expect "migration recorded" "1" "$(q "select count(*) from supabase_migrations.schema_migrations where version = '20261008100000'")"
expect "archive tables exist and are empty" "user_activity_events_ownership_incident_20261005:0|series_ownership_incident_summary:0" \
  "$(q "select 'user_activity_events_ownership_incident_20261005:' || (select count(*) from ops_archive.user_activity_events_ownership_incident_20261005) || '|series_ownership_incident_summary:' || (select count(*) from ops_archive.series_ownership_incident_summary)")"
expect "archive columns mirror user_activity_events exactly" \
  "$(q "select string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' order by attnum) from pg_attribute where attrelid = 'public.user_activity_events'::regclass and attnum > 0 and not attisdropped")" \
  "$(q "select string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' order by attnum) from pg_attribute where attrelid = 'ops_archive.user_activity_events_ownership_incident_20261005'::regclass and attnum > 0 and not attisdropped")"
expect "archive primary key on id" "PRIMARY KEY (id)" "$(q "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'ops_archive.user_activity_events_ownership_incident_20261005'::regclass and contype = 'p'")"

echo "S2: security"
expect "owners" "postgres|postgres|postgres" "$(q "select (select nspowner::regrole::text from pg_namespace where nspname = 'ops_archive') || '|' || string_agg(relowner::regrole::text, '|' order by relname) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'r'")"
expect "schema ACL: owner only" "0" "$(q "select count(*) from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'ops_archive' and a.grantee <> n.nspowner")"
expect "table ACLs: owner only" "0" "$(q "select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.relnamespace = 'ops_archive'::regnamespace and a.grantee <> c.relowner")"
expect "no schema privilege for public/anon/authenticated/service_role" "0" \
  "$(q "select count(*) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['USAGE','CREATE']) p where has_schema_privilege(r, 'ops_archive', p)")"
expect "no table privilege for anon/authenticated/service_role" "0" \
  "$(q "select count(*) from pg_class c, unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'ops_archive'::regnamespace and c.relkind = 'r' and has_table_privilege(r, c.oid, p)")"
expect "RLS enabled on both tables, no policies" "2|0" "$(q "select count(*) filter (where relrowsecurity) || '|' || (select count(*) from pg_policies where schemaname = 'ops_archive') from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'r'")"
expect "no sequences, identity columns or defaults" "0|0|0" "$(q "select (select count(*) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'S') || '|' || (select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'ops_archive'::regnamespace and a.attidentity <> '') || '|' || (select count(*) from pg_attrdef d join pg_class c on c.oid = d.adrelid where c.relnamespace = 'ops_archive'::regnamespace)")"
expect "no foreign keys" "0" "$(q "select count(*) from pg_constraint where connamespace = 'ops_archive'::regnamespace and contype = 'f'")"
expect "no functions/views in ops_archive" "0|0" "$(q "select (select count(*) from pg_proc where pronamespace = 'ops_archive'::regnamespace) || '|' || (select count(*) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind in ('v','m'))")"
for r in anon authenticated service_role; do
  expect "$r refused" "permission denied" "$($PSQL -qAt -c "set role $r" -c "select 1 from ops_archive.series_ownership_incident_summary limit 1" 2>&1 | grep -o 'permission denied' | head -1)"
done

echo "S3: changed environment is not a fresh replay"
OUT=$( { echo "begin;"
         echo "drop schema ops_archive cascade;"
         echo "insert into public.user_activity_events (event_type, target_type, metadata) values ('series_unresolved_ownership', 'session_series', '{}');"
         cat "$MIG"
         echo "rollback;"; } | $PSQL -q -v ON_ERROR_STOP=1 -f - 2>&1 )
if echo "$OUT" | grep -q "CLEANUP STOP B2"; then ok "stray incident row without the reviewed series raises STOP B2"; else fail "expected STOP B2, got: $OUT"; fi
expect "S3 rolled back (archive still present, no stray row)" "2|0" "$(q "select (select count(*) from pg_class where relnamespace = 'ops_archive'::regnamespace and relkind = 'r') || '|' || (select count(*) from public.user_activity_events where event_type = 'series_unresolved_ownership')")"

echo
echo "147 ownership-noise cleanup structural: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
