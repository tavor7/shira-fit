-- Manager "Edit users" list needs an at-a-glance view of who has accepted the current
-- Terms of Use, Privacy Policy, and Marketing Communications consent — one bulk RPC
-- rather than a per-row query. Uses "most recent row for this type wins" (same fix as
-- has_current_marketing_consent, 20260915190000) so a later decline correctly overrides
-- an earlier accept for every type, not just marketing.

create or replace function public.get_users_legal_consent_summary()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_terms_v int;
  v_privacy_v int;
  v_marketing_v int;
  v_rows json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select max(version) into v_terms_v from public.legal_documents where consent_type = 'terms_of_service' and is_current;
  select max(version) into v_privacy_v from public.legal_documents where consent_type = 'privacy_policy' and is_current;
  select max(version) into v_marketing_v from public.legal_documents where consent_type = 'marketing_communications' and is_current;

  select coalesce(json_agg(row_to_json(x)), '[]'::json) into v_rows
  from (
    select
      p.user_id,
      coalesce(lt.status = 'accepted' and lt.consent_version = v_terms_v, false) as terms_ok,
      coalesce(lp.status = 'accepted' and lp.consent_version = v_privacy_v, false) as privacy_ok,
      coalesce(lm.status = 'accepted' and lm.consent_version = v_marketing_v, false) as marketing_ok
    from public.profiles p
    left join lateral (
      select uc.status, uc.consent_version
      from public.user_consents uc
      where uc.user_id = p.user_id and uc.consent_type = 'terms_of_service'
      order by uc.accepted_at desc, uc.created_at desc
      limit 1
    ) lt on true
    left join lateral (
      select uc.status, uc.consent_version
      from public.user_consents uc
      where uc.user_id = p.user_id and uc.consent_type = 'privacy_policy'
      order by uc.accepted_at desc, uc.created_at desc
      limit 1
    ) lp on true
    left join lateral (
      select uc.status, uc.consent_version
      from public.user_consents uc
      where uc.user_id = p.user_id and uc.consent_type = 'marketing_communications'
      order by uc.accepted_at desc, uc.created_at desc
      limit 1
    ) lm on true
  ) x;

  return json_build_object('ok', true, 'users', v_rows);
end;
$$;

grant execute on function public.get_users_legal_consent_summary() to authenticated;
