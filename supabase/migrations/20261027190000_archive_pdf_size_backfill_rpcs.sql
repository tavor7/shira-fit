-- Backup Management: RPCs for a bounded, resumable, idempotent size_bytes backfill.
--
-- archive.document_pdf_versions.size_bytes has been NULL for every row since the historical
-- backfill and the ongoing archive-document-pdf worker both never populated it (confirmed, this
-- investigation). R2's HEAD response includes Content-Length -- the real object size is
-- obtainable WITHOUT downloading any PDF content, using the reader credential already present.
--
-- This migration only adds the read/write entry points a script needs; it does not itself write
-- any size_bytes value. Running scripts/receipt-archive/src/backfill-pdf-sizes.js is a separate,
-- explicitly-approved step (bounded by --limit; idempotent -- re-running only ever touches rows
-- still NULL, since filled rows are naturally excluded from the next pick; never downloads PDF
-- content; never touches any R2 object, financial record, or accounting document).
--
-- Also fixes archive-document-pdf (the ongoing worker, separate deploy) going forward: it now
-- records size_bytes right after a successful upload, using the bytes it already has in memory
-- (no extra fetch) -- so this gap cannot reopen for NEW documents once that's deployed. The
-- one-time historical backfill (scripts/receipt-archive/src/backfill.js) already ran before this
-- gap was found and is not re-run by this fix -- its 177 historical/orphaned rows are covered by
-- the size-backfill script instead, same as every other already-archived row.

create or replace function archive.pick_missing_size_candidates(p_limit integer default 200)
returns table (version_id uuid, r2_key text)
language sql
security definer
set search_path = archive, public
as $$
  select dpv.id, raj.r2_key
  from archive.document_pdf_versions dpv
  join archive.r2_archive_jobs raj on raj.document_version_id = dpv.id
  where dpv.size_bytes is null
    and raj.status = 'completed'
    and not raj.is_ops_test
  order by dpv.created_at asc
  limit p_limit;
$$;

comment on function archive.pick_missing_size_candidates(integer) is
  'Rows still missing size_bytes, oldest first, bounded by p_limit -- same "eventually cover '
  'everything over repeated bounded runs" idiom as pick_verification_candidates/'
  'pick_reconcile_candidates. A filled row is never picked again (excluded by the size_bytes is '
  'null filter), so this is naturally resumable with no separate cursor/offset state.';

-- Guarded by `and size_bytes is null` so a retry (e.g. a script re-run after a crash) is a true
-- no-op on a row already filled -- never overwrites a previously-recorded size, known-zero or
-- otherwise.
create or replace function archive.record_pdf_size(p_version_id uuid, p_size_bytes bigint)
returns void
language sql
security definer
set search_path = archive, public
as $$
  update archive.document_pdf_versions
  set size_bytes = p_size_bytes
  where id = p_version_id and size_bytes is null;
$$;

comment on function archive.record_pdf_size(uuid, bigint) is
  'Idempotent: only ever writes size_bytes for a row that is still NULL (a retry can never '
  'overwrite an already-recorded size). p_size_bytes = 0 is a legitimate, real zero-byte object '
  '-- distinct from NULL, which means "not backfilled yet," never conflated.';

create or replace function public.pick_missing_size_candidates_for_worker(p_limit integer default 200)
returns table (version_id uuid, r2_key text)
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.pick_missing_size_candidates(p_limit);
$$;

create or replace function public.record_pdf_size_for_worker(p_version_id uuid, p_size_bytes bigint)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.record_pdf_size(p_version_id, p_size_bytes);
$$;

revoke execute on function archive.pick_missing_size_candidates(integer) from public, anon, authenticated;
revoke execute on function archive.record_pdf_size(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.pick_missing_size_candidates_for_worker(integer) from public, anon, authenticated;
revoke execute on function public.record_pdf_size_for_worker(uuid, bigint) from public, anon, authenticated;
grant execute on function archive.pick_missing_size_candidates(integer) to service_role;
grant execute on function archive.record_pdf_size(uuid, bigint) to service_role;
grant execute on function public.pick_missing_size_candidates_for_worker(integer) to service_role;
grant execute on function public.record_pdf_size_for_worker(uuid, bigint) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'archive.pick_missing_size_candidates(integer)',
    'archive.record_pdf_size(uuid, bigint)',
    'public.pick_missing_size_candidates_for_worker(integer)',
    'public.record_pdf_size_for_worker(uuid, bigint)'
  ]
  loop
    if has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: % must stay service_role-only', v_fn;
    end if;
  end loop;
end $$;
