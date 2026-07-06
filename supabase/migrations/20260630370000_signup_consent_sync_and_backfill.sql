-- Signup consent was checked in UI but often not logged: record_user_consent needs a session.

create or replace function public.get_current_electronic_receipts_consent_version()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'ok', true,
    'version', coalesce(
      (select ld.version from public.legal_documents ld
       where ld.consent_type = 'electronic_receipts' and ld.is_current
       limit 1),
      1
    )
  );
$$;

grant execute on function public.get_current_electronic_receipts_consent_version() to anon, authenticated;

create or replace function public.sync_signup_electronic_receipts_consent()
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_meta jsonb;
  v_pending boolean := false;
  v_version int;
  v_profile public.profiles%rowtype;
  v_current_version int;
  v_consent_result json;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select coalesce(max(version), 1) into v_current_version
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current;

  select raw_user_meta_data into v_meta from auth.users where id = v_uid;
  if coalesce(v_meta->>'electronic_receipts_consent_pending', '') in ('true', '1') then
    v_pending := true;
    v_version := nullif(v_meta->>'electronic_receipts_consent_version', '')::int;
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;

  if not v_pending
     and v_profile.health_declaration_confirmed_at is not null
     and not exists (
       select 1
       from public.user_consents uc
       where uc.user_id = v_uid
         and uc.consent_type = 'electronic_receipts'
         and uc.status = 'accepted'
     ) then
    v_pending := true;
  end if;

  if not v_pending then
    return json_build_object('ok', true, 'synced', false);
  end if;

  v_version := coalesce(v_version, v_profile.electronic_receipts_consent_version, v_current_version);

  if exists (
    select 1
    from public.user_consents uc
    where uc.user_id = v_uid
      and uc.consent_type = 'electronic_receipts'
      and uc.consent_version = v_version
      and uc.status = 'accepted'
  ) then
    update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      - 'electronic_receipts_consent_pending'
      - 'electronic_receipts_consent_version'
    where id = v_uid;
    return json_build_object('ok', true, 'synced', false);
  end if;

  select public.record_user_consent(
    'electronic_receipts',
    'accepted',
    v_version,
    null,
    'signup_sync'
  ) into v_consent_result;

  if coalesce((v_consent_result->>'ok')::boolean, false) is not true then
    return v_consent_result;
  end if;

  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
    - 'electronic_receipts_consent_pending'
    - 'electronic_receipts_consent_version'
  where id = v_uid;

  return json_build_object('ok', true, 'synced', true, 'version', v_version);
end;
$$;

grant execute on function public.sync_signup_electronic_receipts_consent() to authenticated;

-- Backfill audit rows for users who completed signup (health declaration) before consent was logged.
insert into public.user_consents (user_id, consent_type, consent_version, status, accepted_at)
select
  p.user_id,
  'electronic_receipts'::public.legal_consent_type,
  coalesce(ld.version, 1),
  'accepted'::public.consent_status,
  coalesce(p.electronic_receipts_consented_at, p.health_declaration_confirmed_at, p.created_at)
from public.profiles p
cross join lateral (
  select ld2.version
  from public.legal_documents ld2
  where ld2.consent_type = 'electronic_receipts' and ld2.is_current
  limit 1
) ld
where p.health_declaration_confirmed_at is not null
  and not exists (
    select 1
    from public.user_consents uc
    where uc.user_id = p.user_id
      and uc.consent_type = 'electronic_receipts'
      and uc.status = 'accepted'
  );

update public.profiles p
set
  electronic_receipts_consent_version = coalesce(
    p.electronic_receipts_consent_version,
    (select ld.version from public.legal_documents ld
     where ld.consent_type = 'electronic_receipts' and ld.is_current
     limit 1),
    1
  ),
  electronic_receipts_consented_at = coalesce(
    p.electronic_receipts_consented_at,
    p.health_declaration_confirmed_at,
    p.created_at
  )
where p.health_declaration_confirmed_at is not null
  and (
    p.electronic_receipts_consent_version is null
    or p.electronic_receipts_consented_at is null
  );
