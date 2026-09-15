-- Terms of Use / Privacy Policy / Accessibility rollout: manager UI asked to show, per
-- document, the full version history (not just the current version) with release dates.
-- legal_documents already keeps every past version as a row (is_current flips to false
-- rather than being deleted when a new version is published) — this just exposes it.

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
    select version, title, title_en, effective_at, is_current
    from public.legal_documents
    where consent_type = p_consent_type
  ) t;

  return json_build_object('ok', true, 'consent_type', p_consent_type, 'versions', v_rows);
end;
$$;

grant execute on function public.get_legal_document_history(public.legal_consent_type) to authenticated;
