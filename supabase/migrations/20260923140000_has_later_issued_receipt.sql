-- Backing check for a client-side warning: adding/backdating an account payment to a date
-- on or after one that already has an issued receipt means that payment's future receipt
-- will get a document_number *higher* than one already issued for a later date (numbers are
-- allocated sequentially at issue time, not by payment date — see _allocate_document_number
-- and the two 20260831*_renumber_documents_*.sql migrations, which had to fix exactly this
-- after the fact). documents.paid_at is not reliably populated, so this uses
-- _document_payment_paid_at(source_type, source_id) to compute the real underlying date.

create or replace function public.has_later_issued_receipt(
  p_paid_at date,
  p_exclude_source_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_coach_or_manager(v_uid) then
    return false;
  end if;

  return exists (
    select 1
    from public.documents d
    where d.status <> 'CANCELLED'
      and (p_exclude_source_id is null or d.source_id <> p_exclude_source_id)
      and public._document_payment_paid_at(d.source_type, d.source_id) >= p_paid_at::timestamptz
  );
end;
$$;

grant execute on function public.has_later_issued_receipt(date, uuid) to authenticated;
