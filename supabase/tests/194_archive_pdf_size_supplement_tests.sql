-- archive.document_pdf_version_sizes (20261027200000): the separate, insert-once supplementary
-- table for historical PDF size_bytes backfill, built after the original UPDATE-based approach
-- (20261027190000) was correctly rejected in production by document_pdf_versions_immutable (that
-- table and its trigger are untouched by this design -- see the migration's own header comment).
--
-- Unlike 188, this does NOT run against the real local Supabase stack: it only needs
-- archive.document_pdf_versions / archive.r2_archive_jobs / public._report_system_error /
-- public.is_manager / auth.uid(), so it runs against a disposable "scratch container" (see
-- supabase/tests/README.md) with a minimal stub schema -- no app-level fixtures (customers,
-- auth.users, profiles) needed at all.
--
-- Run (three steps against a throwaway container, safe to discard afterwards):
--   docker run -d --name pdfsize_scratch -e POSTGRES_PASSWORD=postgres postgres:17
--   docker exec -i pdfsize_scratch psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/194_archive_pdf_size_supplement_tests.sql   -- (this file: stub + tests, in order)
--   -- with the real migration applied in between the stub and the tests section below, e.g.:
--   --   docker cp supabase/migrations/20261027200000_archive_pdf_size_supplement.sql pdfsize_scratch:/mig.sql && docker exec -i pdfsize_scratch psql -U postgres -v ON_ERROR_STOP=1 -f /mig.sql
--   docker rm -f pdfsize_scratch
--
-- Covers the 8 requested scenarios: successful registration, duplicate registration, conflicting
-- size values, missing R2 objects, incorrect object-to-record mapping, unauthorized writes,
-- correct archive-size aggregation, no modification of original immutable records -- plus two
-- bonus checks (no double-counting when a stray supplement row coexists with a real size_bytes,
-- and the new table's own insert-once trigger).

-- ===== STUB SCHEMA (apply first) =====
create extension if not exists pgcrypto;
create schema archive;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid; $$;

create table archive.document_pdf_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid,
  document_number text,
  pdf_version integer,
  storage_path text unique,
  sha256 text,
  size_bytes bigint,
  signature_provider text,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid
);

create function archive._reject_archive_hard_mutation()
returns trigger language plpgsql security definer set search_path = archive, public as $$
begin
  raise exception 'archive_record_immutable' using errcode = 'P0001',
    detail = format('Rows in %I are append-only archive history and cannot be updated or deleted directly.', tg_table_name);
  return old;
end;
$$;

create trigger document_pdf_versions_immutable before update or delete on archive.document_pdf_versions
  for each row execute function archive._reject_archive_hard_mutation();

create table archive.r2_archive_jobs (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid references archive.document_pdf_versions(id),
  r2_key text,
  status text,
  is_ops_test boolean not null default false
);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;

create table public.reported_system_errors (
  id serial primary key,
  source text, subsystem text, operation text, error_class text, severity text,
  message text, entities jsonb, fingerprint_key text, reported_at timestamptz default now()
);

create function public._report_system_error(
  p_source text, p_subsystem text, p_operation text, p_error_class text, p_severity text,
  p_message text, p_entities jsonb, p_fingerprint_key text
) returns void language sql as $$
  insert into public.reported_system_errors (source, subsystem, operation, error_class, severity, message, entities, fingerprint_key)
  values (p_source, p_subsystem, p_operation, p_error_class, p_severity, p_message, p_entities, p_fingerprint_key);
$$;

create function public.is_manager(uuid) returns boolean language sql as $$ select true; $$;

create table archive.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  kind text,
  started_at timestamptz,
  finished_at timestamptz,
  status text,
  missing_count integer,
  newly_queued_count integer,
  hash_mismatch_count integer,
  expected_count integer
);

-- ===== Apply supabase/migrations/20261027200000_archive_pdf_size_supplement.sql here =====
-- (see run instructions above -- it must run between the stub and the tests below)

-- ===== TESTS (apply after the real migration) =====
do $$
declare
  v_v1 uuid; v_v2 uuid; v_v3 uuid; v_v4 uuid;
  v_count int;
  v_known int; v_unknown int; v_total bigint;
begin
  insert into archive.document_pdf_versions (storage_path, document_number, pdf_version) values
    ('documents/d1/TEST-001.pdf', 'TEST-001', 1) returning id into v_v1;
  insert into archive.document_pdf_versions (storage_path, document_number, pdf_version) values
    ('documents/d2/TEST-002.pdf', 'TEST-002', 1) returning id into v_v2;
  insert into archive.document_pdf_versions (storage_path, document_number, pdf_version) values
    ('documents/d3/TEST-003.pdf', 'TEST-003', 1) returning id into v_v3;
  insert into archive.document_pdf_versions (storage_path, document_number, pdf_version, size_bytes) values
    ('documents/d4/TEST-004.pdf', 'TEST-004', 1, 999) returning id into v_v4; -- already has a real size

  insert into archive.r2_archive_jobs (document_version_id, r2_key, status) values
    (v_v1, 'objects/d1/test-001.pdf', 'completed'),
    (v_v2, 'objects/d2/test-002.pdf', 'completed'),
    (v_v3, 'objects/d3/test-003.pdf', 'completed'),
    (v_v4, 'objects/d4/test-004.pdf', 'completed');

  -- 1. Successful historical size registration.
  perform archive.record_pdf_size_supplement(v_v1, 12345);
  if not exists (select 1 from archive.document_pdf_version_sizes where version_id = v_v1 and size_bytes = 12345) then
    raise exception 'FAILED 1: expected a recorded size for v1';
  end if;
  raise notice '1. PASSED: successful historical size registration';

  -- 2. Duplicate registration (same value) must be a silent no-op, not an error, not a second row.
  perform archive.record_pdf_size_supplement(v_v1, 12345);
  select count(*) into v_count from archive.document_pdf_version_sizes where version_id = v_v1;
  if v_count <> 1 then raise exception 'FAILED 2: duplicate registration must not create a second row, count=%', v_count; end if;
  raise notice '2. PASSED: duplicate registration is an idempotent no-op';

  -- 3. Conflicting size values: a different size for the same version_id must NOT overwrite the
  --    original, and must be reported to System Issues.
  perform archive.record_pdf_size_supplement(v_v1, 99999);
  if (select size_bytes from archive.document_pdf_version_sizes where version_id = v_v1) <> 12345 then
    raise exception 'FAILED 3: a conflicting size must never overwrite the original recorded value';
  end if;
  if not exists (select 1 from public.reported_system_errors where subsystem = 'receipt_archive' and error_class = 'size_conflict' and (entities->>'version_id')::uuid = v_v1) then
    raise exception 'FAILED 3: a conflicting size must be reported to System Issues';
  end if;
  raise notice '3. PASSED: conflicting size values are rejected (never overwritten) and reported';

  -- 4. Missing R2 objects: a version the backfill skips (simulating a HEAD 404) must simply stay
  --    absent from the supplement table -- still correctly "unknown", never fabricated.
  if exists (select 1 from archive.document_pdf_version_sizes where version_id = v_v3) then
    raise exception 'FAILED 4: a version never registered (simulating a missing R2 object) must have no row';
  end if;
  raise notice '4. PASSED: a version with no HEAD result stays correctly unknown, no fabricated row';

  -- 5. Incorrect object-to-record mapping: the version_id foreign key means a bogus/unrelated id
  --    can never register a size (there's no document_pdf_versions row to attach to).
  begin
    perform archive.record_pdf_size_supplement('00000000-0000-0000-0000-0000000000ff'::uuid, 42);
    raise exception 'FAILED 5: registering a size against a nonexistent version_id must fail (FK violation)';
  exception when foreign_key_violation then
    raise notice '5. PASSED: a size can never be attached to a nonexistent/mismatched version_id (FK enforced)';
  end;

  -- 6. Unauthorized writes: authenticated/anon must not be able to call the insert/record path,
  --    the pick-candidates path, or touch the table directly.
  if has_function_privilege('authenticated', 'archive.record_pdf_size_supplement(uuid,bigint)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'archive.record_pdf_size_supplement(uuid,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'FAILED 6: record_pdf_size_supplement must be service_role-only';
  end if;
  if has_function_privilege('authenticated', 'public.record_pdf_size_supplement_for_worker(uuid,bigint)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.record_pdf_size_supplement_for_worker(uuid,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'FAILED 6: record_pdf_size_supplement_for_worker must be service_role-only';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'archive' and table_name = 'document_pdf_version_sizes' and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'FAILED 6: anon/authenticated must have no grants at all on archive.document_pdf_version_sizes';
  end if;
  raise notice '6. PASSED: unauthorized roles cannot write size metadata directly or via RPC';

  -- 7. Correct archive-size aggregation: v1=12345 (via supplement), v2=NULL (unknown), v3=NULL
  --    (unknown), v4=999 (own size_bytes, never double-counted). Expected: known=2, unknown=2,
  --    total=12345+999=13344.
  select
    count(*) filter (where coalesce(dpv.size_bytes, sup.size_bytes) is not null),
    count(*) filter (where coalesce(dpv.size_bytes, sup.size_bytes) is null),
    sum(coalesce(dpv.size_bytes, sup.size_bytes))
  into v_known, v_unknown, v_total
  from archive.document_pdf_versions dpv
  left join archive.document_pdf_version_sizes sup on sup.version_id = dpv.id
  where dpv.id in (v_v1, v_v2, v_v3, v_v4);
  if v_known <> 2 or v_unknown <> 2 or v_total <> 13344 then
    raise exception 'FAILED 7: expected known=2 unknown=2 total=13344, got known=% unknown=% total=%', v_known, v_unknown, v_total;
  end if;
  raise notice '7. PASSED: aggregation combines both sources correctly with no double-counting';

  -- 7b. Double-counting guard: even if a supplement row existed for v4 (which already has its
  --     own size_bytes), the primary value must win, never summed with the supplement's.
  insert into archive.document_pdf_version_sizes (version_id, size_bytes) values (v_v4, 1);
  select sum(coalesce(dpv.size_bytes, sup.size_bytes)) into v_total
  from archive.document_pdf_versions dpv
  left join archive.document_pdf_version_sizes sup on sup.version_id = dpv.id
  where dpv.id in (v_v1, v_v4);
  if v_total <> 12345 + 999 then
    raise exception 'FAILED 7b: a row with its own size_bytes must never also add the supplement value, got total=%', v_total;
  end if;
  raise notice '7b. PASSED: a version with its own size_bytes is never double-counted against a stray supplement row';

  -- 8. No modification of original immutable records: document_pdf_versions must stay
  --    completely unmodified by any of the above.
  begin
    update archive.document_pdf_versions set size_bytes = 1 where id = v_v1;
    raise exception 'FAILED 8: document_pdf_versions must remain fully immutable (UPDATE)';
  exception when others then
    if sqlerrm <> 'archive_record_immutable' then raise exception 'FAILED 8: unexpected error on UPDATE: %', sqlerrm; end if;
  end;
  begin
    delete from archive.document_pdf_versions where id = v_v1;
    raise exception 'FAILED 8: document_pdf_versions must remain fully immutable (DELETE)';
  exception when others then
    if sqlerrm <> 'archive_record_immutable' then raise exception 'FAILED 8: unexpected error on DELETE: %', sqlerrm; end if;
  end;
  if (select size_bytes from archive.document_pdf_versions where id = v_v1) is not null then
    raise exception 'FAILED 8: v1.size_bytes must still be NULL on the original row -- the supplement table is the only place v1''s size lives';
  end if;
  if (select size_bytes from archive.document_pdf_versions where id = v_v4) <> 999 then
    raise exception 'FAILED 8: v4.size_bytes must remain exactly 999, untouched';
  end if;
  raise notice '8. PASSED: document_pdf_versions and its immutability trigger are completely untouched';

  -- 9 (bonus). The new supplementary table is itself insert-once: UPDATE/DELETE on it must also
  --    be rejected, so a recorded size can never be silently altered either.
  begin
    update archive.document_pdf_version_sizes set size_bytes = 1 where version_id = v_v1;
    raise exception 'FAILED 9: document_pdf_version_sizes must reject UPDATE too';
  exception when others then
    if sqlerrm <> 'archive_size_supplement_immutable' then raise exception 'FAILED 9: unexpected error: %', sqlerrm; end if;
  end;
  begin
    delete from archive.document_pdf_version_sizes where version_id = v_v1;
    raise exception 'FAILED 9: document_pdf_version_sizes must reject DELETE too';
  exception when others then
    if sqlerrm <> 'archive_size_supplement_immutable' then raise exception 'FAILED 9: unexpected error: %', sqlerrm; end if;
  end;
  raise notice '9. PASSED: the new supplementary table is itself insert-once (no UPDATE/DELETE, ever)';

  -- 10 (bonus). pick_missing_size_candidates resumability: must return v2/v3 (still no size
  --     anywhere) but never v1 (now has a supplement row) or v4 (has its own size_bytes).
  if exists (select version_id from archive.pick_missing_size_candidates(100) where version_id in (v_v1, v_v4)) then
    raise exception 'FAILED 10: pick_missing_size_candidates must exclude versions already covered by either source';
  end if;
  if not exists (select version_id from archive.pick_missing_size_candidates(100) where version_id = v_v2) then
    raise exception 'FAILED 10: pick_missing_size_candidates must still return v2 (genuinely still missing)';
  end if;
  raise notice '10. PASSED: pick_missing_size_candidates stays correctly resumable/bounded';

  raise notice 'ALL PDF SIZE SUPPLEMENT TESTS PASSED';
end $$;
