-- Extend delete_document (testing-mode-only, manager-only receipt deletion) with an optional
-- "also delete the underlying payment" flag, so staff can choose to keep the payment record
-- (receipt was wrong/duplicate) or fully reverse it (payment itself was a mistake).
drop function if exists public.delete_document(uuid);

create or replace function public.delete_document(p_document_id uuid, p_delete_payment boolean default false)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_doc public.documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_rows int;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_settings from public.receipt_settings limit 1;
  if coalesce(v_settings.is_operational, false) then
    return json_build_object('ok', false, 'error', 'operational_mode_locked');
  end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  if p_delete_payment and v_doc.source_id is not null then
    if v_doc.source_type = 'account_payment' then
      delete from public.athlete_account_payments where id = v_doc.source_id;
    elsif v_doc.source_type = 'cancellation_penalty' then
      update public.cancellations
        set penalty_collected_ils = 0, charged_full_price = false
        where id = v_doc.source_id;
    elsif v_doc.source_type = 'session_payment' then
      -- source_id may point at either table (both row kinds map to 'session_payment'),
      -- so try session_registrations first and fall back to session_manual_participants.
      update public.session_registrations
        set amount_paid = null, payment_method = null, payment_recorded_at = null
        where id = v_doc.source_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        update public.session_manual_participants
          set amount_paid = null, payment_method = null, payment_recorded_at = null
          where id = v_doc.source_id;
      end if;
    end if;
  end if;

  delete from public.document_events where document_id = p_document_id;
  delete from public.documents where id = p_document_id;

  return json_build_object('ok', true, 'document_id', p_document_id, 'pdf_url', v_doc.pdf_url, 'deleted_payment', p_delete_payment);
end;
$function$;
