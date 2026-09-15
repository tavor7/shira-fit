-- Manager version-history modal only showed version number + date, not the actual text —
-- add the stored short acknowledgment body so managers can see what each version said,
-- not just when it was published.

create or replace function public.get_legal_document_history(p_consent_type public.legal_consent_type)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_rows json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(json_agg(row_to_json(t) order by t.version desc), '[]'::json) into v_rows
  from (
    select version, title, title_en, body_text, body_text_en, effective_at, is_current
    from public.legal_documents
    where consent_type = p_consent_type
  ) t;

  return json_build_object('ok', true, 'consent_type', p_consent_type, 'versions', v_rows);
end;
$$;
