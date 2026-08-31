-- The previous renumbering (by payment time) ran before the _document_payment_paid_at
-- placeholder-heuristic bug was fixed, so 23 of 162 receipts ended up with a document_number
-- out of true chronological order. Re-run the same renumbering now that paid_at is correct.
-- Same offset (912) as before, for the same reason: preserve numbers 1-912 already issued
-- pre-digital-receipts.
do $$
declare
  v_offset bigint := 912;
  v_total bigint;
begin
  update public.documents set document_number = 'TMP-' || id::text;

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
