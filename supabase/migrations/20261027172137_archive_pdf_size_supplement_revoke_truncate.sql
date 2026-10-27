-- Follow-up to 20261027172038_archive_pdf_size_supplement: TRUNCATE on a table is not blocked by
-- a BEFORE DELETE/UPDATE row trigger in Postgres (TRUNCATE skips row-level triggers entirely), so
-- the archive schema's default ACL granting service_role TRUNCATE on every new table left a real
-- gap in document_pdf_version_sizes' "insert-once, no exceptions" guarantee. Revoke-only, no data
-- touched, no existing grant this table actually needs removed (the backfill script and worker
-- only ever SELECT/INSERT).
revoke truncate on table archive.document_pdf_version_sizes from service_role;

do $$
begin
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'archive' and table_name = 'document_pdf_version_sizes'
      and grantee = 'service_role' and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception 'self-check: service_role must not have UPDATE/DELETE/TRUNCATE on archive.document_pdf_version_sizes';
  end if;
end $$;
