-- Independent receipt archive (R2): structural guard against ever overwriting a receipt PDF
-- object in Supabase Storage, by any code path -- not just by convention/code review.
--
-- Why this exists (rollback safety): the previous migrations make overwrite impossible through
-- the *new* finalize_document_pdf contract (it always allocates a fresh, unique path). But that
-- guarantee only holds as long as nothing ever uploads with upsert:true against an existing
-- documents/* path. A rollback of generate-document-pdf to any version older than
-- 20261025110000_document_pdf_versioning.sql would do exactly that (remove-then-upsert the
-- unversioned path) -- directly contradicting "a rollback must preserve all previously issued
-- document versions and their metadata." Verified locally: Supabase Storage's upsert=true path
-- performs a real UPDATE against storage.objects (not an internal bypass), so a BEFORE UPDATE
-- trigger reliably intercepts it, regardless of which version of which Edge Function (or any
-- other caller, including a manual fix-up) issued the call.
--
-- Scope: only bucket_id = 'document-pdfs' AND name like 'documents/%' (receipts). Monthly
-- summaries (summaries/*) are deliberately excluded -- generate-monthly-summary-pdf and
-- deleteMonthlySummaryReport still replace/remove those normally; this guard is specific to the
-- receipt-archive integrity guarantee, not a blanket change to Storage behavior.
--
-- This does not need to touch DELETE: Supabase's own storage.protect_delete() already rejects
-- direct SQL deletes on storage.objects (confirmed locally), and the Storage API's own delete
-- path for a `documents/*` object is never called by any code in this repo once this feature is
-- live (the old remove()-before-upload call this migration's predecessor already removed from
-- generate-document-pdf is the only place that ever did).

create or replace function public._reject_document_pdf_overwrite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'document_pdf_object_immutable'
    using errcode = 'P0001',
          detail = format(
            'Storage object %I in document-pdfs under documents/ already exists and cannot be overwritten -- '
            'every PDF version must use a new, unique path (see archive.document_pdf_versions / '
            'finalize_document_pdf). This guard exists specifically so that redeploying an older '
            'generate-document-pdf (e.g. during a rollback) cannot silently destroy a previously issued receipt.',
            old.name
          );
  return old;
end;
$$;

comment on function public._reject_document_pdf_overwrite() is
  'Blocks any UPDATE (including Storage upsert=true) to an existing documents/* object in the '
  'document-pdfs bucket. Scoped to that one bucket+prefix -- does not affect summaries/* or any '
  'other bucket.';

drop trigger if exists document_pdf_overwrite_guard on storage.objects;
create trigger document_pdf_overwrite_guard
  before update on storage.objects
  for each row
  when (old.bucket_id = 'document-pdfs' and old.name like 'documents/%')
  execute function public._reject_document_pdf_overwrite();

revoke execute on function public._reject_document_pdf_overwrite() from public, anon, authenticated;

-- Self-check.
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects' and t.tgname = 'document_pdf_overwrite_guard'
      and not t.tgisinternal
  ) then
    raise exception 'self-check: document_pdf_overwrite_guard trigger missing';
  end if;
end $$;
