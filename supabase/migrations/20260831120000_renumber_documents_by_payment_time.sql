-- Reassign document_number so numbers run in the order payments were actually received
-- (paid_at, full date+time), instead of the order receipts were issued/created.
-- Requested explicitly by the business owner, who accepted the compliance tradeoff this implies
-- (numbers are normally expected to be sequential by issue date, not backdated).
--
-- The sequence continues from where it already was (it had reached 1074 historically, even
-- though only 162 rows survive today) rather than resetting to 1 — resetting would reuse
-- numbers 1-912 that were already legally issued/consumed before.
do $$
declare
  v_offset bigint := 912;
  v_total bigint;
begin
  -- Phase 1: move every number out of the way to avoid unique-constraint collisions
  -- while reassigning (documents_document_number_key is not deferrable).
  update public.documents set document_number = 'TMP-' || id::text;

  -- Phase 2: assign final numbers in payment-chronological order.
  with ranked as (
    select
      id,
      row_number() over (
        order by coalesce(public._document_payment_paid_at(source_type, source_id), created_at) asc,
                 created_at asc,
                 id asc
      ) as rn
    from public.documents
  )
  update public.documents d
  set document_number = coalesce((select document_prefix from public.receipt_settings limit 1), '') || lpad((ranked.rn + v_offset)::text, 6, '0')
  from ranked
  where ranked.id = d.id;

  select count(*) into v_total from public.documents;

  update public.receipt_settings
  set next_document_number = v_offset + v_total + 1,
      updated_at = now();
end $$;
