-- Subscription terms management (Setup -> Legal): managers edit a draft, preview it, publish new versions (choosing
-- whether renewed acceptance is required) and restore an earlier version as a new one. Enforcement on/off already exists
-- (set_subscription_terms_enforced, 20261014130000) and takes effect immediately - every check reads the setting live.
--
-- Reuses the existing versioned legal-document / consent infrastructure:
--   * published versions are legal_documents rows (consent_type 'subscription_terms', bilingual, version + 1, is_current);
--   * an acceptance is a user_consents row (athlete, version, timestamp). Because a published subscription_terms version is
--     made IMMUTABLE here (title, text and requires_reconsent can never change, rows can never be deleted), the version
--     number in each acceptance identifies the exact text the athlete accepted, permanently.
--   * the draft lives in its own manager-only table, so editing it never changes what athletes see.
-- Nothing here touches billing, subscriptions, existing acceptances, or the other legal documents (Terms of Use,
-- Privacy Policy, electronic receipts, marketing). Enforcement stays exactly as it is (FALSE when shipped).

-- 1. Published versions are immutable ----------------------------------------------------------------------------------
create or replace function public._legal_documents_subscription_terms_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.consent_type = 'subscription_terms' then
      raise exception 'published subscription terms versions cannot be deleted';
    end if;
    return old;
  end if;
  if old.consent_type = 'subscription_terms' and (
       new.consent_type is distinct from old.consent_type
    or new.version is distinct from old.version
    or new.title is distinct from old.title
    or new.title_en is distinct from old.title_en
    or new.body_text is distinct from old.body_text
    or new.body_text_en is distinct from old.body_text_en
    or new.requires_reconsent is distinct from old.requires_reconsent
    or new.effective_at is distinct from old.effective_at
  ) then
    raise exception 'published subscription terms versions are immutable (only is_current may change)';
  end if;
  return new;
end;
$$;
revoke execute on function public._legal_documents_subscription_terms_immutable() from public, anon, authenticated;

drop trigger if exists legal_documents_subscription_terms_immutable on public.legal_documents;
create trigger legal_documents_subscription_terms_immutable
  before update or delete on public.legal_documents
  for each row execute function public._legal_documents_subscription_terms_immutable();

-- 2. Draft (one per document type; manager-only) -------------------------------------------------------------------------
create table if not exists public.legal_document_drafts (
  consent_type public.legal_consent_type primary key
    constraint legal_document_drafts_type_chk check (consent_type = 'subscription_terms'),
  title text not null default '',
  title_en text not null default '',
  body_text text not null default '',
  body_text_en text not null default '',
  based_on_version int null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (user_id) on delete set null
);
comment on table public.legal_document_drafts is
  'Unpublished edits of a versioned legal document (subscription terms). Never shown to athletes; publishing copies it '
  'into a new immutable legal_documents version.';

alter table public.legal_document_drafts enable row level security;
drop policy if exists legal_document_drafts_manager_select on public.legal_document_drafts;
create policy legal_document_drafts_manager_select on public.legal_document_drafts
  for select using (public.is_manager(auth.uid()));
-- Writes only through the RPCs below.
revoke all on table public.legal_document_drafts from anon, authenticated;
grant select on table public.legal_document_drafts to authenticated;

-- 3. Validation (internal) ----------------------------------------------------------------------------------------------
-- Both languages must be complete: non-empty titles and bodies of at least 200 characters each.
create or replace function public._subscription_terms_text_problems(p_title text, p_title_en text, p_body text, p_body_en text)
returns text[]
language sql
immutable
set search_path = public
as $$
  select array_remove(array[
    case when coalesce(btrim(p_title), '') = '' then 'title_he_missing' end,
    case when coalesce(btrim(p_title_en), '') = '' then 'title_en_missing' end,
    case when length(coalesce(btrim(p_body), '')) < 200 then 'body_he_incomplete' end,
    case when length(coalesce(btrim(p_body_en), '')) < 200 then 'body_en_incomplete' end
  ], null);
$$;
revoke execute on function public._subscription_terms_text_problems(text, text, text, text) from public, anon, authenticated;

-- 4. Manager RPCs -------------------------------------------------------------------------------------------------------

-- Everything the management screen needs: switch, current published version, all versions (immutable history with how
-- many athletes accepted each), the draft, and athlete counts.
create or replace function public.get_subscription_terms_admin()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enforced boolean;
  v_counts json;
begin
  if auth.uid() is null or not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select coalesce(st.subscription_terms_enforced, false) into v_enforced from public.app_settings st where st.id = 1;
  select json_object_agg(x.status, x.n) into v_counts
  from (
    select public._subscription_terms_status_for_user(a.payee_id)->>'status' as status, count(*) as n
    from (select distinct s.payee_id from public.subscriptions s where s.deleted_at is null and not s.payee_is_manual) a
    group by 1
  ) x;
  return json_build_object(
    'ok', true,
    'enforced', coalesce(v_enforced, false),
    'required_version', (
      select coalesce(max(version) filter (where requires_reconsent), min(version))
      from public.legal_documents where consent_type = 'subscription_terms'
    ),
    'versions', coalesce((
      select json_agg(json_build_object(
        'version', ld.version, 'is_current', ld.is_current, 'requires_reconsent', ld.requires_reconsent,
        'title', ld.title, 'title_en', ld.title_en, 'body_text', ld.body_text, 'body_text_en', ld.body_text_en,
        'effective_at', ld.effective_at,
        'accepted_count', (select count(*) from public.user_consents uc
                           where uc.consent_type = 'subscription_terms' and uc.consent_version = ld.version and uc.status = 'accepted')
      ) order by ld.version desc)
      from public.legal_documents ld where ld.consent_type = 'subscription_terms'
    ), '[]'::json),
    'draft', (
      select json_build_object(
        'title', d.title, 'title_en', d.title_en, 'body_text', d.body_text, 'body_text_en', d.body_text_en,
        'based_on_version', d.based_on_version, 'updated_at', d.updated_at,
        'problems', to_json(public._subscription_terms_text_problems(d.title, d.title_en, d.body_text, d.body_text_en))
      )
      from public.legal_document_drafts d where d.consent_type = 'subscription_terms'
    ),
    'counts', coalesce(v_counts, '{}'::json)
  );
end;
$$;
revoke execute on function public.get_subscription_terms_admin() from public, anon;
grant execute on function public.get_subscription_terms_admin() to authenticated;

-- Save the draft. Never touches published versions.
create or replace function public.save_subscription_terms_draft(
  p_title text, p_title_en text, p_body_text text, p_body_text_en text, p_based_on_version int default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if length(coalesce(p_title, '')) > 300 or length(coalesce(p_title_en, '')) > 300
     or length(coalesce(p_body_text, '')) > 100000 or length(coalesce(p_body_text_en, '')) > 100000 then
    return json_build_object('ok', false, 'error', 'too_long');
  end if;
  insert into public.legal_document_drafts (consent_type, title, title_en, body_text, body_text_en, based_on_version, updated_at, updated_by)
  values ('subscription_terms', coalesce(p_title, ''), coalesce(p_title_en, ''), coalesce(p_body_text, ''), coalesce(p_body_text_en, ''),
          p_based_on_version, now(), v_uid)
  on conflict (consent_type) do update set
    title = excluded.title, title_en = excluded.title_en, body_text = excluded.body_text, body_text_en = excluded.body_text_en,
    based_on_version = coalesce(excluded.based_on_version, legal_document_drafts.based_on_version),
    updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning updated_at into v_at;
  perform public._insert_activity_event(v_uid, 'subscription_terms_draft_saved', 'legal_document_draft', 'subscription_terms', '{}'::jsonb);
  return json_build_object('ok', true, 'updated_at', v_at,
    'problems', to_json(public._subscription_terms_text_problems(p_title, p_title_en, p_body_text, p_body_text_en)));
end;
$$;
revoke execute on function public.save_subscription_terms_draft(text, text, text, text, int) from public, anon;
grant execute on function public.save_subscription_terms_draft(text, text, text, text, int) to authenticated;

-- Restore: copy a published version's text into the draft (publishing it then creates a NEW version).
create or replace function public.copy_subscription_terms_version_to_draft(p_version int)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.legal_documents%rowtype;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_doc from public.legal_documents where consent_type = 'subscription_terms' and version = p_version;
  if v_doc.id is null then
    return json_build_object('ok', false, 'error', 'version_not_found');
  end if;
  return public.save_subscription_terms_draft(v_doc.title, v_doc.title_en, v_doc.body_text, v_doc.body_text_en, v_doc.version);
end;
$$;
revoke execute on function public.copy_subscription_terms_version_to_draft(int) from public, anon;
grant execute on function public.copy_subscription_terms_version_to_draft(int) to authenticated;

-- Publish the draft as a new immutable version. p_requires_reconsent: athletes who accepted an earlier version must
-- accept again (only while enforcement is on). p_expected_updated_at guards against publishing a draft that changed
-- since the manager reviewed it.
create or replace function public.publish_subscription_terms_draft(p_requires_reconsent boolean, p_expected_updated_at timestamptz)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_draft public.legal_document_drafts%rowtype;
  v_problems text[];
  v_version int;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_requires_reconsent is null then
    return json_build_object('ok', false, 'error', 'invalid_value');
  end if;
  perform pg_advisory_xact_lock(hashtext('publish_subscription_terms'));
  select * into v_draft from public.legal_document_drafts where consent_type = 'subscription_terms' for update;
  if v_draft.consent_type is null then
    return json_build_object('ok', false, 'error', 'no_draft');
  end if;
  if p_expected_updated_at is null or v_draft.updated_at <> p_expected_updated_at then
    return json_build_object('ok', false, 'error', 'draft_changed');
  end if;
  v_problems := public._subscription_terms_text_problems(v_draft.title, v_draft.title_en, v_draft.body_text, v_draft.body_text_en);
  if cardinality(v_problems) > 0 then
    return json_build_object('ok', false, 'error', 'incomplete', 'problems', to_json(v_problems));
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.legal_documents where consent_type = 'subscription_terms';
  update public.legal_documents set is_current = false where consent_type = 'subscription_terms' and is_current;
  insert into public.legal_documents (consent_type, version, title, title_en, body_text, body_text_en, is_current, requires_reconsent, created_by)
  values ('subscription_terms', v_version, btrim(v_draft.title), btrim(v_draft.title_en), btrim(v_draft.body_text), btrim(v_draft.body_text_en),
          true, p_requires_reconsent, v_uid);
  delete from public.legal_document_drafts where consent_type = 'subscription_terms';

  perform public._insert_activity_event(v_uid, 'subscription_terms_published', 'legal_document', 'subscription_terms',
    jsonb_build_object('version', v_version, 'requires_reconsent', p_requires_reconsent));
  return json_build_object('ok', true, 'version', v_version, 'requires_reconsent', p_requires_reconsent);
end;
$$;
revoke execute on function public.publish_subscription_terms_draft(boolean, timestamptz) from public, anon;
grant execute on function public.publish_subscription_terms_draft(boolean, timestamptz) to authenticated;

-- Self-check -----------------------------------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if coalesce((select subscription_terms_enforced from public.app_settings where id = 1), false) then
    raise exception 'self-check: enforcement must stay disabled';
  end if;
  foreach v_fn in array array['public.get_subscription_terms_admin()', 'public.save_subscription_terms_draft(text,text,text,text,integer)',
    'public.copy_subscription_terms_version_to_draft(integer)', 'public.publish_subscription_terms_draft(boolean,timestamp with time zone)'] loop
    if has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') or not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: % has wrong EXECUTE privileges', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public._legal_documents_subscription_terms_immutable()', 'public._subscription_terms_text_problems(text,text,text,text)'] loop
    if has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: internal % is client-executable', v_fn;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.legal_document_drafts', 'INSERT')
     or has_table_privilege('anon', 'public.legal_document_drafts', 'SELECT') then
    raise exception 'self-check: legal_document_drafts must be RPC-write-only and hidden from anon';
  end if;
end $$;
