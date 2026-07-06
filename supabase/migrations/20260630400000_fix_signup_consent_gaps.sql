-- Signup profile/consent data was stored client-side without a session, so updates and
-- user_consents audit rows were often skipped. Pending athletes were also excluded from go-live.

create or replace function public._signup_consent_pending_from_meta(p_meta jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    (p_meta->'electronic_receipts_consent_pending')::boolean,
    (p_meta->>'electronic_receipts_consent_pending') in ('true', '1'),
    false
  );
$$;

create or replace function public._signup_health_confirmed_from_meta(p_meta jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    (p_meta->'health_declaration_confirmed')::boolean,
    (p_meta->>'health_declaration_confirmed') in ('true', '1'),
    false
  );
$$;

create or replace function public._is_receipt_go_live_profile(p public.profiles)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    p.user_id is not null
    and p.disabled_at is null
    and (
      p.role = 'manager'
      or (p.role = 'athlete' and p.approval_status in ('pending', 'approved'))
    );
$$;

comment on function public._is_receipt_go_live_profile(public.profiles) is
  'Athletes (pending or approved) and managers included in go-live readiness reports.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dob date;
  v_gender text;
  v_username text;
  v_age int;
  v_address text;
  v_zip_code text;
  v_health_confirmed boolean;
begin
  v_dob := nullif(trim(new.raw_user_meta_data->>'date_of_birth'), '')::date;
  if v_dob is null then
    v_dob := '2000-01-01'::date;
  end if;

  v_gender := lower(trim(coalesce(new.raw_user_meta_data->>'gender', 'male')));
  if v_gender not in ('male', 'female') then
    v_gender := 'male';
  end if;

  v_username := split_part(new.email, '@', 1) || '_' || left(replace(new.id::text, '-', ''), 8);
  v_age := extract(year from age(v_dob))::int;
  v_address := nullif(trim(coalesce(new.raw_user_meta_data->>'address', '')), '');
  v_zip_code := nullif(trim(coalesce(new.raw_user_meta_data->>'zip_code', '')), '');
  v_health_confirmed := public._signup_health_confirmed_from_meta(new.raw_user_meta_data);

  insert into public.profiles (
    user_id,
    username,
    full_name,
    phone,
    age,
    gender,
    date_of_birth,
    address,
    zip_code,
    health_declaration_confirmed_at,
    approval_status,
    role
  )
  values (
    new.id,
    v_username,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), v_username),
    coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), ''),
    v_age,
    v_gender,
    v_dob,
    v_address,
    v_zip_code,
    case when v_health_confirmed then now() else null end,
    'pending',
    'athlete'
  );

  return new;
exception
  when unique_violation then
    return new;
end;
$$;

create or replace function public._insert_electronic_receipts_consent_audit(
  p_user_id uuid,
  p_consent_version int,
  p_user_agent text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_full_name text;
begin
  if exists (
    select 1
    from public.user_consents uc
    where uc.user_id = p_user_id
      and uc.consent_type = 'electronic_receipts'
      and uc.consent_version = p_consent_version
      and uc.status = 'accepted'
  ) then
    return false;
  end if;

  select nullif(trim(p.full_name), '') into v_full_name
  from public.profiles p
  where p.user_id = p_user_id;

  insert into public.user_consents (
    user_id,
    full_name,
    consent_type,
    consent_version,
    status,
    user_agent
  )
  values (
    p_user_id,
    v_full_name,
    'electronic_receipts',
    p_consent_version,
    'accepted',
    p_user_agent
  );

  update public.profiles
  set
    electronic_receipts_consent_version = p_consent_version,
    electronic_receipts_consented_at = coalesce(electronic_receipts_consented_at, now())
  where user_id = p_user_id;

  return true;
end;
$$;

create or replace function public._try_sync_signup_consent_for_user(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_meta jsonb;
  v_email_confirmed timestamptz;
  v_pending boolean := false;
  v_version int;
  v_profile public.profiles%rowtype;
  v_current_version int;
  v_synced boolean := false;
begin
  if p_user_id is null then
    return json_build_object('ok', false, 'error', 'missing_user_id');
  end if;

  select raw_user_meta_data, email_confirmed_at
  into v_meta, v_email_confirmed
  from auth.users
  where id = p_user_id;

  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_email_confirmed is null then
    return json_build_object('ok', true, 'synced', false, 'reason', 'email_not_confirmed');
  end if;

  select coalesce(max(version), 1) into v_current_version
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current;

  if public._signup_consent_pending_from_meta(v_meta) then
    v_pending := true;
    v_version := nullif(v_meta->>'electronic_receipts_consent_version', '')::int;
  end if;

  select * into v_profile from public.profiles where user_id = p_user_id;

  if not v_pending
     and (
       v_profile.health_declaration_confirmed_at is not null
       or public._signup_health_confirmed_from_meta(v_meta)
     )
     and not exists (
       select 1
       from public.user_consents uc
       where uc.user_id = p_user_id
         and uc.consent_type = 'electronic_receipts'
         and uc.status = 'accepted'
     ) then
    v_pending := true;
  end if;

  if not v_pending then
    return json_build_object('ok', true, 'synced', false);
  end if;

  v_version := coalesce(v_version, v_profile.electronic_receipts_consent_version, v_current_version);
  v_synced := public._insert_electronic_receipts_consent_audit(p_user_id, v_version, 'signup_sync');

  if v_synced then
    update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      - 'electronic_receipts_consent_pending'
      - 'electronic_receipts_consent_version'
    where id = p_user_id;
  end if;

  return json_build_object('ok', true, 'synced', v_synced, 'version', v_version);
end;
$$;

create or replace function public.sync_signup_electronic_receipts_consent()
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  return public._try_sync_signup_consent_for_user(v_uid);
end;
$$;

create or replace function public.tg_auth_user_signup_consent()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public._try_sync_signup_consent_for_user(new.id);
  return new;
end;
$$;

drop trigger if exists trg_auth_user_signup_consent on auth.users;
create trigger trg_auth_user_signup_consent
after insert or update of email_confirmed_at, raw_user_meta_data
on auth.users
for each row
execute function public.tg_auth_user_signup_consent();

-- Backfill profile fields from signup metadata when the client update ran without a session.
update public.profiles p
set
  address = coalesce(nullif(trim(p.address), ''), nullif(trim(u.raw_user_meta_data->>'address'), '')),
  zip_code = coalesce(nullif(trim(p.zip_code), ''), nullif(trim(u.raw_user_meta_data->>'zip_code'), '')),
  health_declaration_confirmed_at = coalesce(
    p.health_declaration_confirmed_at,
    case when public._signup_health_confirmed_from_meta(u.raw_user_meta_data) then p.created_at end
  )
from auth.users u
where u.id = p.user_id
  and p.role = 'athlete'
  and (
    (p.address is null or trim(p.address) = '') and nullif(trim(u.raw_user_meta_data->>'address'), '') is not null
    or (p.zip_code is null or trim(p.zip_code) = '') and nullif(trim(u.raw_user_meta_data->>'zip_code'), '') is not null
    or (
      p.health_declaration_confirmed_at is null
      and public._signup_health_confirmed_from_meta(u.raw_user_meta_data)
    )
  );

-- Backfill consent audit rows for confirmed users who signed up with consent checked.
do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select u.id
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where u.email_confirmed_at is not null
      and (
        public._signup_consent_pending_from_meta(u.raw_user_meta_data)
        or p.health_declaration_confirmed_at is not null
        or public._signup_health_confirmed_from_meta(u.raw_user_meta_data)
      )
      and not exists (
        select 1
        from public.user_consents uc
        where uc.user_id = u.id
          and uc.consent_type = 'electronic_receipts'
          and uc.status = 'accepted'
      )
  loop
    perform public._try_sync_signup_consent_for_user(v_user_id);
  end loop;
end;
$$;

create or replace function public.get_receipt_go_live_stats()
returns json
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_consent_version int;
  v_missing_address bigint;
  v_missing_zip bigint;
  v_missing_consent bigint;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select coalesce(max(version), 0) into v_consent_version
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current;

  select count(*) into v_missing_address
  from public.profiles p
  where public._is_receipt_go_live_profile(p)
    and nullif(trim(coalesce(p.address, '')), '') is null;

  select count(*) into v_missing_zip
  from public.profiles p
  where public._is_receipt_go_live_profile(p)
    and nullif(trim(coalesce(p.zip_code, '')), '') is null;

  select count(*) into v_missing_consent
  from public.profiles p
  where public._is_receipt_go_live_profile(p)
    and v_consent_version > 0
    and (
      p.electronic_receipts_consent_version is null
      or p.electronic_receipts_consent_version < v_consent_version
      or not exists (
        select 1
        from public.user_consents uc
        where uc.user_id = p.user_id
          and uc.consent_type = 'electronic_receipts'
          and uc.status = 'accepted'
      )
    );

  return json_build_object(
    'ok', true,
    'missing_address_count', v_missing_address,
    'missing_zip_count', v_missing_zip,
    'missing_consent_count', v_missing_consent,
    'current_consent_version', v_consent_version
  );
end;
$$;

create or replace function public.list_receipt_go_live_gaps(p_gap_type text)
returns json
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_consent_version int;
  v_rows json;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_gap_type not in ('address', 'zip', 'consent') then
    return json_build_object('ok', false, 'error', 'invalid_gap_type');
  end if;

  select coalesce(max(version), 0) into v_consent_version
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current;

  select coalesce(json_agg(row_to_json(x) order by x.full_name), '[]'::json) into v_rows
  from (
    select
      p.user_id,
      p.full_name,
      p.username,
      p.phone,
      p.role,
      p.approval_status,
      nullif(trim(coalesce(p.address, '')), '') as address,
      nullif(trim(coalesce(p.zip_code, '')), '') as zip_code,
      p.electronic_receipts_consent_version as consent_version,
      (select u.email from auth.users u where u.id = p.user_id) as email
    from public.profiles p
    where public._is_receipt_go_live_profile(p)
      and (
        (p_gap_type = 'address' and nullif(trim(coalesce(p.address, '')), '') is null)
        or (p_gap_type = 'zip' and nullif(trim(coalesce(p.zip_code, '')), '') is null)
        or (
          p_gap_type = 'consent'
          and v_consent_version > 0
          and (
            p.electronic_receipts_consent_version is null
            or p.electronic_receipts_consent_version < v_consent_version
            or not exists (
              select 1
              from public.user_consents uc
              where uc.user_id = p.user_id
                and uc.consent_type = 'electronic_receipts'
                and uc.status = 'accepted'
            )
          )
        )
      )
    order by p.full_name
  ) x;

  return json_build_object('ok', true, 'gap_type', p_gap_type, 'rows', v_rows);
end;
$$;
