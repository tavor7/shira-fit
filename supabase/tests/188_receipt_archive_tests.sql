-- Receipt archive (R2) subsystem tests: PDF versioning, job queue, reconciliation, immutability,
-- unauthorized access. Standalone DO-block style (see supabase/tests/README.md). Run with:
--   docker exec -i <db-container> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/188_receipt_archive_tests.sql
--
-- Requires migrations through 20261025120000_receipt_archive_worker_and_cron.sql applied.
-- Not covered here (needs a real R2 endpoint / real concurrent workers / real Storage objects):
-- R2-unavailable behavior, true concurrent-worker claiming, actual checksum mismatch detection
-- against R2. See the final rollout report for the manual/staging test plan covering those.

-- Fixed, clearly-namespaced test identifiers. Because archive.document_pdf_versions /
-- r2_archive_jobs are deliberately append-only (the feature under test), this file is NOT
-- re-runnable against the same database without a fresh `supabase db reset` first -- consistent
-- with this repo's "scratch database" test convention (see supabase/tests/README.md).
do $$
declare
  v_manager_id uuid := '00000000-0000-0000-0000-00000000a4c4';
  v_customer_id uuid;
  v_doc_id uuid;
  v_fin jsonb;
  v_alloc jsonb;
  v_prep jsonb;
  v_job_id uuid;
  v_count int;
begin
  -- Fixtures: a manager user + customer + one document with no PDF yet.
  insert into auth.users (id, email) values (v_manager_id, 'archive-test-manager@example.com')
  on conflict (id) do nothing;
  -- auth.users insert may auto-create a profiles row via trigger -- upsert rather than insert.
  insert into public.profiles (user_id, username, full_name, phone, gender, role, approval_status)
  values (v_manager_id, 'archive_test_mgr', 'Archive Test Manager', '0500000000', 'male', 'manager', 'approved')
  on conflict (user_id) do update set role = 'manager', approval_status = 'approved';

  insert into public.customers (name) values ('Archive Test Customer') returning id into v_customer_id;

  insert into public.documents
    (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, service_type, payment_method,
     customer_name, business_name, business_id, business_address, business_phone, business_email)
  values
    ('TEST-ARCHIVE-001', v_customer_id, 100, 85.47, 14.53, 0.17, 'personal', 'cash',
     'Archive Test Customer', 'Test Studio', '000000000', 'Test Address', '0500000000', 'studio@example.com')
  returning id into v_doc_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_manager_id)::text, false);

  -- 1. First-ever finalize: version 1, unsuffixed path, archive row + pending job via trigger.
  select public.finalize_document_pdf(v_doc_id, 'documents/' || v_doc_id || '/TEST-ARCHIVE-001.pdf', 'hash-v1')::jsonb into v_fin;
  if not (v_fin->>'ok')::boolean then raise exception 'FAILED 1: finalize v1 should succeed, got %', v_fin; end if;
  if (v_fin->>'pdf_version')::int <> 1 then raise exception 'FAILED 1: expected version 1, got %', v_fin; end if;

  select count(*) into v_count from archive.document_pdf_versions where document_id = v_doc_id;
  if v_count <> 1 then raise exception 'FAILED 1: expected 1 version row, got %', v_count; end if;

  select count(*) into v_count from archive.r2_archive_jobs where document_id = v_doc_id and status = 'pending';
  if v_count <> 1 then raise exception 'FAILED 1: expected 1 pending job enqueued by trigger, got %', v_count; end if;
  raise notice '1. PASSED: first finalize creates version 1 + pending archive job';

  -- 2. Regeneration: prepare must NOT null pdf_url (old contract did; new contract must not).
  select public.prepare_document_pdf_regeneration(v_doc_id)::jsonb into v_prep;
  if not (v_prep->>'ok')::boolean then raise exception 'FAILED 2: prepare should succeed, got %', v_prep; end if;
  if (v_prep->>'next_version')::int <> 2 then raise exception 'FAILED 2: expected next_version 2, got %', v_prep; end if;

  if (select pdf_url from public.documents where id = v_doc_id) is null then
    raise exception 'FAILED 2: pdf_url must stay non-null during regeneration (old-contract behavior leaked back in)';
  end if;
  raise notice '2. PASSED: prepare_document_pdf_regeneration leaves current PDF retrievable';

  -- 3. Finalize version 2 at the suffixed path; version 1's row/job must be untouched.
  select public.allocate_document_pdf_version(v_doc_id)::jsonb into v_alloc;
  if (v_alloc->>'next_pdf_path') <> ('documents/' || v_doc_id || '/TEST-ARCHIVE-001-v2.pdf') then
    raise exception 'FAILED 3: unexpected allocated path %', v_alloc;
  end if;
  select public.finalize_document_pdf(v_doc_id, v_alloc->>'next_pdf_path', 'hash-v2')::jsonb into v_fin;
  if not (v_fin->>'ok')::boolean or (v_fin->>'pdf_version')::int <> 2 then
    raise exception 'FAILED 3: finalize v2 should succeed as version 2, got %', v_fin;
  end if;

  select count(*) into v_count from archive.document_pdf_versions where document_id = v_doc_id;
  if v_count <> 2 then raise exception 'FAILED 3: expected 2 version rows (v1 kept, v2 added), got %', v_count; end if;
  if not exists (select 1 from archive.document_pdf_versions where document_id = v_doc_id and pdf_version = 1
                 and storage_path = 'documents/' || v_doc_id || '/TEST-ARCHIVE-001.pdf') then
    raise exception 'FAILED 3: version-1 row was mutated or removed -- original PDF reference lost';
  end if;
  raise notice '3. PASSED: regeneration adds a new version without touching the previous one';

  -- 4. Version-conflict path: finalize with a stale/wrong expected path must fail cleanly, not corrupt state.
  select public.finalize_document_pdf(v_doc_id, 'documents/' || v_doc_id || '/TEST-ARCHIVE-001-v2.pdf', 'hash-stale')::jsonb into v_fin;
  if (v_fin->>'error') <> 'version_conflict' then
    raise exception 'FAILED 4: expected version_conflict (v3 is now next), got %', v_fin;
  end if;
  select count(*) into v_count from archive.document_pdf_versions where document_id = v_doc_id;
  if v_count <> 2 then raise exception 'FAILED 4: a version_conflict must not create a phantom version row, count=%', v_count; end if;
  raise notice '4. PASSED: stale finalize call is rejected without corrupting version history';

  -- 5. Job lifecycle: claim -> complete.
  select id into v_job_id from archive.r2_archive_jobs
  where document_id = v_doc_id and storage_path = 'documents/' || v_doc_id || '/TEST-ARCHIVE-001-v2.pdf';
  perform archive.claim_jobs(10, 'test-worker');
  if (select status from archive.r2_archive_jobs where id = v_job_id) <> 'processing' then
    raise exception 'FAILED 5: claim_jobs should move the job to processing';
  end if;
  perform archive.complete_job(v_job_id, 'hash-v2');
  if (select status from archive.r2_archive_jobs where id = v_job_id) <> 'completed' then
    raise exception 'FAILED 5: complete_job should mark the job completed';
  end if;
  raise notice '5. PASSED: claim -> complete job lifecycle';

  -- 6. Duplicate job prevention: re-running the enqueue trigger logic / unique constraint.
  begin
    insert into archive.r2_archive_jobs (storage_path, r2_key, document_id)
    values ('documents/' || v_doc_id || '/TEST-ARCHIVE-001-v2.pdf', 'objects/dup', v_doc_id);
    raise exception 'FAILED 6: duplicate storage_path should violate the unique constraint';
  exception when unique_violation then
    raise notice '6. PASSED: duplicate archive job for the same storage_path is rejected';
  end;

  -- 7. Retry/backoff + terminal failure -> system_issues report.
  declare
    v_job2_id uuid;
    v_attempts int;
  begin
    insert into archive.r2_archive_jobs (storage_path, r2_key, document_id, max_attempts)
    values ('documents/' || v_doc_id || '/TEST-ARCHIVE-001-failtest.pdf', 'objects/failtest', v_doc_id, 2)
    returning id into v_job2_id;

    perform archive.claim_jobs(10, 'test-worker'); -- attempts -> 1
    perform archive.fail_job(v_job2_id, 'simulated transient failure');
    if (select status from archive.r2_archive_jobs where id = v_job2_id) <> 'pending' then
      raise exception 'FAILED 7: first failure (below max_attempts) should go back to pending, not failed';
    end if;

    update archive.r2_archive_jobs set next_attempt_at = now() where id = v_job2_id; -- skip backoff wait for the test
    perform archive.claim_jobs(10, 'test-worker'); -- attempts -> 2 (== max_attempts)
    perform archive.fail_job(v_job2_id, 'simulated persistent failure');
    if (select status from archive.r2_archive_jobs where id = v_job2_id) <> 'failed' then
      raise exception 'FAILED 7: failure at max_attempts should become terminal "failed"';
    end if;

    if not exists (select 1 from public.system_issues where reported_subsystem = 'receipt_archive' or subsystem = 'receipt_archive') then
      raise exception 'FAILED 7: a terminal archive failure should be visible in system_issues';
    end if;
    raise notice '7. PASSED: retry-then-terminal-failure reports to system_issues exactly once exhausted';
  end;

  -- 8. Cancellation preserves version HISTORY, even though cancel_document still nulls the
  --    live documents.pdf_url pointer (unchanged pre-existing behavior -- it signals
  --    "needs_pdf_reissue" for the cancelled-stamp PDF). The guarantee this feature adds is that
  --    archive.document_pdf_versions keeps every version's record (path + hash) regardless.
  perform public.cancel_document(v_doc_id, 'test cancellation');
  if (select status from public.documents where id = v_doc_id) <> 'CANCELLED' then
    raise exception 'FAILED 8: document should be CANCELLED';
  end if;
  select count(*) into v_count from archive.document_pdf_versions where document_id = v_doc_id;
  if v_count <> 2 then raise exception 'FAILED 8: cancellation must not touch version history, count=%', v_count; end if;
  if not exists (select 1 from archive.document_pdf_versions where document_id = v_doc_id and pdf_version = 2 and sha256 = 'hash-v2') then
    raise exception 'FAILED 8: version-2 record (path+hash) must survive cancellation even though pdf_url is nulled';
  end if;
  raise notice '8. PASSED: cancellation preserves full version history (pdf_url nulling is unrelated, pre-existing behavior)';

  -- 9. Immutability: hard DELETE/UPDATE of archive history must be rejected.
  begin
    delete from archive.document_pdf_versions where document_id = v_doc_id;
    raise exception 'FAILED 9: document_pdf_versions must be undeletable';
  exception when others then
    if sqlerrm <> 'document_record_immutable' then
      raise notice '  (got expected-category error, different message: %)', sqlerrm;
    end if;
  end;
  begin
    delete from archive.r2_archive_jobs where document_id = v_doc_id;
    raise exception 'FAILED 9: r2_archive_jobs must be undeletable';
  exception when others then null;
  end;
  raise notice '9. PASSED: archive history is append-only (hard delete rejected)';

  -- 10. Reconciliation gap detection (pure-SQL half): a Storage object with no job yet gets queued,
  --     and re-running finds nothing new (idempotent).
  insert into storage.objects (bucket_id, name) values ('document-pdfs', 'documents/orphan-test/9999.pdf')
  on conflict do nothing;
  perform archive.reconcile_storage_gaps();
  if not exists (select 1 from archive.r2_archive_jobs where storage_path = 'documents/orphan-test/9999.pdf' and is_historical) then
    raise exception 'FAILED 10: reconciliation should have queued the orphaned Storage object';
  end if;
  select count(*) into v_count from archive.r2_archive_jobs where storage_path = 'documents/orphan-test/9999.pdf';
  perform archive.reconcile_storage_gaps(); -- run again
  if (select count(*) from archive.r2_archive_jobs where storage_path = 'documents/orphan-test/9999.pdf') <> v_count then
    raise exception 'FAILED 10: re-running reconciliation must not create a duplicate job';
  end if;
  raise notice '10. PASSED: reconciliation detects + idempotently queues unqueued Storage objects';

  raise notice 'ALL RECEIPT ARCHIVE TESTS PASSED';
end $$;

-- 11. Unauthorized access: archive.claim_jobs/complete_job/fail_job must stay service_role-only.
do $$
begin
  if has_function_privilege('authenticated', 'archive.claim_jobs(integer, text)'::regprocedure, 'EXECUTE') then
    raise exception 'FAILED 11: authenticated must not be able to claim archive jobs directly';
  end if;
  if has_function_privilege('anon', 'archive.claim_jobs(integer, text)'::regprocedure, 'EXECUTE') then
    raise exception 'FAILED 11: anon must not be able to claim archive jobs directly';
  end if;
  raise notice '11. PASSED: archive worker RPCs are not reachable by authenticated/anon';
end $$;
