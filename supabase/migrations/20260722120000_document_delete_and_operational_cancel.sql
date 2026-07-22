-- Rework receipt cancel/delete to match the legally-required flow:
--   * Testing mode (is_operational = false): managers can fully DELETE a receipt —
--     row, audit events, and PDF are wiped, no trace kept. Testing mode also keeps
--     the CANCEL action available so the real void/reissue flow can be tested.
--   * Live mode (is_operational = true): only CANCEL is allowed (delete stays
--     locked). A cancelled receipt keeps its document number and audit trail,
--     stops counting as a "receipted" payment (via the existing status <> 'CANCELLED'
--     check used elsewhere), and has its PDF reissued — cancel_document clears the
--     pdf fields so the client's next PDF-generation call re-renders (with the
--     "בוטל" stamp already built into generate-document-pdf) and overwrites the
--     same storage path.

create or replace function public.cancel_document(p_document_id uuid, p_reason text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype; v_settings public.receipt_settings%rowtype; v_can_cancel boolean;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  v_can_cancel := public.is_manager(auth.uid())
    or (public.is_coach_or_manager(auth.uid()) and v_settings.staff_can_cancel_documents);
  if not v_can_cancel then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status = 'CANCELLED' then return json_build_object('ok', false, 'error', 'already_cancelled'); end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then return json_build_object('ok', false, 'error', 'reason_required'); end if;

  update public.documents
  set
    status = 'CANCELLED',
    cancelled_at = now(),
    cancelled_by = auth.uid(),
    cancellation_reason = trim(p_reason),
    pdf_url = null,
    signature_hash = null,
    signature_provider = null,
    signed_at = null
  where id = p_document_id;

  perform public._log_document_event(
    p_document_id,
    'document_cancelled',
    jsonb_build_object('reason', trim(p_reason), 'testing_mode', not coalesce(v_settings.is_operational, false))
  );

  return json_build_object('ok', true, 'document_id', p_document_id, 'needs_pdf_reissue', v_doc.pdf_url is not null);
end;
$$;

create or replace function public.delete_document(p_document_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype; v_settings public.receipt_settings%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_settings from public.receipt_settings limit 1;
  if coalesce(v_settings.is_operational, false) then
    return json_build_object('ok', false, 'error', 'operational_mode_locked');
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  delete from public.document_events where document_id = p_document_id;
  delete from public.documents where id = p_document_id;

  return json_build_object('ok', true, 'document_id', p_document_id, 'pdf_url', v_doc.pdf_url);
end;
$$;

grant execute on function public.delete_document(uuid) to authenticated;

-- Managers may remove a receipt PDF from storage directly (used by the testing-mode
-- hard delete above), but never while the business is live — mirrors the DB-level
-- lock in delete_document so a client can't bypass it via a raw storage call.
create policy "document_pdfs_manager_delete_documents" on storage.objects for delete
  using (
    bucket_id = 'document-pdfs'
    and (storage.foldername(name))[1] = 'documents'
    and public.is_manager(auth.uid())
    and not coalesce((select is_operational from public.receipt_settings limit 1), false)
  );
