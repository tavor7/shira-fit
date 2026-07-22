-- Allow managers to delete a generated monthly summary report (row + PDF).
-- The RPC removes the DB row; the client follows up with a best-effort storage
-- removal of the PDF, gated by a manager-only delete policy scoped to the
-- 'summaries/' prefix so this can't be used to touch other document PDFs.

create or replace function public.delete_monthly_summary(p_summary_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  delete from public.monthly_summaries where id = p_summary_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  return json_build_object('ok', true);
end; $$;

grant execute on function public.delete_monthly_summary(uuid) to authenticated;

create policy "document_pdfs_manager_delete_summaries" on storage.objects for delete
  using (bucket_id = 'document-pdfs' and (storage.foldername(name))[1] = 'summaries' and public.is_manager(auth.uid()));
