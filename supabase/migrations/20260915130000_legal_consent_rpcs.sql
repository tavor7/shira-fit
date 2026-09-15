-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 1d).
-- Extends the existing consent RPCs rather than building a parallel system.

-- get_required_consents(): unchanged electronic_receipts behavior (still always
-- evaluated, exactly as today). terms_of_service / privacy_policy are now evaluated too,
-- but ONLY counted as "required" when app_settings.legal_consent_gate_enabled is true —
-- this is the manager-controlled rollout switch. Until a manager flips it on, publishing
-- these legal_documents rows has no gating effect on existing sessions.
-- marketing_communications is intentionally never included here: it must never block
-- app use, so it is never part of the "required" gate. It has its own fetch/record path.
create or replace function public.get_required_consents()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_doc public.legal_documents%rowtype;
  v_gate_enabled boolean := false;
  v_required jsonb := '[]'::jsonb;
  v_has_current boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from public.profiles where user_id = v_uid;

  -- electronic_receipts: unchanged from the pre-existing behavior.
  select * into v_doc from public.legal_documents where consent_type = 'electronic_receipts' and is_current limit 1;
  if v_doc.id is not null and (v_profile.electronic_receipts_consent_version is null or v_profile.electronic_receipts_consent_version < v_doc.version) then
    v_required := v_required || jsonb_build_array(jsonb_build_object(
      'consent_type', v_doc.consent_type, 'version', v_doc.version,
      'title', v_doc.title, 'body_text', v_doc.body_text,
      'title_en', v_doc.title_en, 'body_text_en', v_doc.body_text_en
    ));
  end if;

  select coalesce(s.legal_consent_gate_enabled, false) into v_gate_enabled
  from public.app_settings s where s.id = 1;

  if v_gate_enabled then
    for v_doc in
      select * from public.legal_documents
      where consent_type in ('terms_of_service', 'privacy_policy') and is_current
    loop
      select exists (
        select 1 from public.user_consents uc
        where uc.user_id = v_uid
          and uc.consent_type = v_doc.consent_type
          and uc.status = 'accepted'
          and uc.consent_version = v_doc.version
      ) into v_has_current;
      if not v_has_current then
        v_required := v_required || jsonb_build_array(jsonb_build_object(
          'consent_type', v_doc.consent_type, 'version', v_doc.version,
          'title', v_doc.title, 'body_text', v_doc.body_text,
          'title_en', v_doc.title_en, 'body_text_en', v_doc.body_text_en
        ));
      end if;
    end loop;
  end if;

  return json_build_object('ok', true, 'required', v_required);
end; $$;

-- Manager-only: read the current rollout state + published legal document versions, for a
-- small settings screen (mirrors the existing WhatsApp rollout / receipt go-live pattern).
create or replace function public.get_legal_consent_settings()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_gate_enabled boolean;
  v_docs json;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(legal_consent_gate_enabled, false) into v_gate_enabled from public.app_settings where id = 1;

  select coalesce(json_agg(row_to_json(t) order by t.consent_type), '[]'::json) into v_docs
  from (
    select consent_type, version, title, title_en, effective_at
    from public.legal_documents
    where consent_type in ('terms_of_service', 'privacy_policy', 'marketing_communications') and is_current
  ) t;

  return json_build_object('ok', true, 'gate_enabled', v_gate_enabled, 'documents', v_docs);
end; $$;

-- Manager-only: flip the existing-user mandatory re-consent gate on/off. Deliberately does
-- not touch new-user signup behavior (that always captures consent once this ships) and
-- does not touch electronic_receipts (governed by its own existing
-- request_consent_from_existing_users setting).
create or replace function public.set_legal_consent_gate_enabled(p_enabled boolean)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.app_settings set legal_consent_gate_enabled = coalesce(p_enabled, false) where id = 1;

  return json_build_object('ok', true, 'gate_enabled', coalesce(p_enabled, false));
end; $$;

grant execute on function public.get_legal_consent_settings() to authenticated;
grant execute on function public.set_legal_consent_gate_enabled(boolean) to authenticated;
