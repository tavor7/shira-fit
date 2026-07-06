-- Include managers (with athletes) in receipt address/consent gates and go-live gap reports.

create or replace function public._is_receipt_existing_user_profile(p public.profiles)
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
      or (p.role = 'athlete' and p.approval_status = 'approved')
    );
$$;

comment on function public._is_receipt_existing_user_profile(public.profiles) is
  'Active athletes (approved) and managers eligible for receipt address/consent collection.';

comment on column public.receipt_settings.request_address_from_existing_users is
  'When true, athletes and managers missing address/zip are prompted in the app.';

create or replace function public.get_address_collection_required()
returns json
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_settings public.receipt_settings%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;
  if not found or not public._is_receipt_existing_user_profile(v_profile) then
    return json_build_object('ok', true, 'required', false);
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not coalesce(v_settings.digital_receipts_enabled, false)
     or not coalesce(v_settings.request_address_from_existing_users, false) then
    return json_build_object('ok', true, 'required', false);
  end if;

  if nullif(trim(coalesce(v_profile.address, '')), '') is null
     or nullif(trim(coalesce(v_profile.zip_code, '')), '') is null then
    return json_build_object('ok', true, 'required', true);
  end if;

  return json_build_object('ok', true, 'required', false);
end;
$$;

create or replace function public.get_required_consents()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_doc public.legal_documents%rowtype;
  v_settings public.receipt_settings%rowtype;
  v_required jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select * into v_settings from public.receipt_settings limit 1;
  if not coalesce(v_settings.digital_receipts_enabled, false)
     or not coalesce(v_settings.is_operational, false) then
    return json_build_object('ok', true, 'required', v_required);
  end if;

  select * into v_profile from public.profiles where user_id = v_uid;
  if not found or not public._is_receipt_existing_user_profile(v_profile) then
    return json_build_object('ok', true, 'required', v_required);
  end if;

  select * into v_doc
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current
  limit 1;

  if v_doc.id is not null
     and (v_profile.electronic_receipts_consent_version is null
          or v_profile.electronic_receipts_consent_version < v_doc.version) then
    v_required := v_required || jsonb_build_array(
      jsonb_build_object(
        'consent_type', v_doc.consent_type,
        'version', v_doc.version,
        'title', v_doc.title,
        'body_text', v_doc.body_text
      )
    );
  end if;

  return json_build_object('ok', true, 'required', v_required);
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
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(max(version), 0) into v_consent_version
  from public.legal_documents
  where consent_type = 'electronic_receipts' and is_current;

  select count(*) into v_missing_address
  from public.profiles p
  where public._is_receipt_existing_user_profile(p)
    and nullif(trim(coalesce(p.address, '')), '') is null;

  select count(*) into v_missing_zip
  from public.profiles p
  where public._is_receipt_existing_user_profile(p)
    and nullif(trim(coalesce(p.zip_code, '')), '') is null;

  select count(*) into v_missing_consent
  from public.profiles p
  where public._is_receipt_existing_user_profile(p)
    and v_consent_version > 0
    and (
      p.electronic_receipts_consent_version is null
      or p.electronic_receipts_consent_version < v_consent_version
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
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
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
      nullif(trim(coalesce(p.address, '')), '') as address,
      nullif(trim(coalesce(p.zip_code, '')), '') as zip_code,
      p.electronic_receipts_consent_version as consent_version,
      (select u.email from auth.users u where u.id = p.user_id) as email
    from public.profiles p
    where public._is_receipt_existing_user_profile(p)
      and (
        (p_gap_type = 'address' and nullif(trim(coalesce(p.address, '')), '') is null)
        or (p_gap_type = 'zip' and nullif(trim(coalesce(p.zip_code, '')), '') is null)
        or (
          p_gap_type = 'consent'
          and v_consent_version > 0
          and (
            p.electronic_receipts_consent_version is null
            or p.electronic_receipts_consent_version < v_consent_version
          )
        )
      )
    order by p.full_name
    limit 500
  ) x;

  return json_build_object('ok', true, 'gap_type', p_gap_type, 'rows', v_rows);
end;
$$;
