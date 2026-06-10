-- Go-live readiness stats, accountant email, document customer filters, email update.

alter table public.receipt_settings
  add column if not exists accountant_email text not null default '';

create or replace function public.update_receipt_settings(
  p_business_id text default null,
  p_business_name text default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_accountant_email text default null,
  p_digital_receipts_enabled boolean default null,
  p_vat_rate numeric default null,
  p_document_prefix text default null,
  p_staff_can_cancel_documents boolean default null,
  p_is_operational boolean default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_old public.receipt_settings%rowtype; v_new public.receipt_settings%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_old from public.receipt_settings where id = '00000000-0000-4000-8000-000000000001'::uuid for update;
  update public.receipt_settings set
    business_id = coalesce(nullif(trim(p_business_id), ''), business_id),
    business_name = coalesce(nullif(trim(p_business_name), ''), business_name),
    address = coalesce(nullif(trim(p_address), ''), address),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    email = coalesce(nullif(trim(p_email), ''), email),
    accountant_email = coalesce(nullif(trim(p_accountant_email), ''), accountant_email),
    digital_receipts_enabled = coalesce(p_digital_receipts_enabled, digital_receipts_enabled),
    vat_rate = coalesce(p_vat_rate, vat_rate),
    document_prefix = coalesce(p_document_prefix, document_prefix),
    staff_can_cancel_documents = coalesce(p_staff_can_cancel_documents, staff_can_cancel_documents),
    is_operational = coalesce(p_is_operational, is_operational),
    updated_by = auth.uid(), updated_at = now()
  where id = v_old.id returning * into v_new;
  if v_old.vat_rate is distinct from v_new.vat_rate then
    perform public._log_document_event(null, 'vat_rate_updated', jsonb_build_object('old_rate', v_old.vat_rate, 'new_rate', v_new.vat_rate));
  end if;
  if v_old.is_operational is distinct from v_new.is_operational then
    perform public._log_document_event(null, 'operational_mode_changed', jsonb_build_object('is_operational', v_new.is_operational));
  end if;
  return json_build_object('ok', true, 'settings', row_to_json(v_new));
end;
$$;

create or replace function public.get_receipt_go_live_stats()
returns json
language plpgsql stable security definer set search_path = public, auth
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
  where p.role = 'athlete'
    and p.disabled_at is null
    and nullif(trim(coalesce(p.address, '')), '') is null;

  select count(*) into v_missing_zip
  from public.profiles p
  where p.role = 'athlete'
    and p.disabled_at is null
    and nullif(trim(coalesce(p.zip_code, '')), '') is null;

  select count(*) into v_missing_consent
  from public.profiles p
  where p.role = 'athlete'
    and p.disabled_at is null
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
language plpgsql stable security definer set search_path = public, auth
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
      nullif(trim(coalesce(p.address, '')), '') as address,
      nullif(trim(coalesce(p.zip_code, '')), '') as zip_code,
      p.electronic_receipts_consent_version as consent_version,
      (select u.email from auth.users u where u.id = p.user_id) as email
    from public.profiles p
    where p.role = 'athlete'
      and p.disabled_at is null
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

create or replace function public._document_customer_type(
  p_profile_user_id uuid,
  p_manual_participant_id uuid
)
returns text
language sql stable set search_path = public
as $$
  select case
    when p_profile_user_id is not null and exists (
      select 1 from public.athlete_family_members afm where afm.user_id = p_profile_user_id
    ) then 'family'
    when p_manual_participant_id is not null and exists (
      select 1 from public.athlete_family_members afm where afm.manual_participant_id = p_manual_participant_id
    ) then 'family'
    when p_manual_participant_id is not null then 'manual'
    else 'regular'
  end;
$$;

create or replace function public.list_documents(
  p_date_start timestamptz default null,
  p_date_end timestamptz default null,
  p_status public.document_status default null,
  p_customer_type text default null,
  p_limit int default 200,
  p_offset int default 0
)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  v_rows json;
  v_total bigint;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_customer_type is not null and p_customer_type not in ('regular', 'manual', 'family') then
    return json_build_object('ok', false, 'error', 'invalid_customer_type');
  end if;

  select count(*) into v_total
  from public.documents d
  join public.customers c on c.id = d.customer_id
  where (p_date_start is null or d.created_at >= p_date_start)
    and (p_date_end is null or d.created_at <= p_date_end)
    and (p_status is null or d.status = p_status)
    and (
      p_customer_type is null
      or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
    );

  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json) into v_rows
  from (
    select
      d.*,
      c.profile_user_id as customer_profile_user_id,
      c.manual_participant_id as customer_manual_participant_id,
      public._document_customer_type(c.profile_user_id, c.manual_participant_id) as customer_type
    from public.documents d
    join public.customers c on c.id = d.customer_id
    where (p_date_start is null or d.created_at >= p_date_start)
      and (p_date_end is null or d.created_at <= p_date_end)
      and (p_status is null or d.status = p_status)
      and (
        p_customer_type is null
        or public._document_customer_type(c.profile_user_id, c.manual_participant_id) = p_customer_type
      )
    order by d.created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return json_build_object('ok', true, 'rows', v_rows, 'total', v_total);
end;
$$;

create or replace function public.update_document_customer_email(
  p_document_id uuid,
  p_email text
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_doc public.documents%rowtype;
  v_email text := nullif(trim(coalesce(p_email, '')), '');
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  update public.documents
  set customer_email = v_email
  where id = p_document_id;

  update public.customers
  set email = v_email, updated_at = now()
  where id = v_doc.customer_id;

  return json_build_object('ok', true, 'document_id', p_document_id, 'customer_email', v_email);
end;
$$;

grant execute on function public.get_receipt_go_live_stats() to authenticated;
grant execute on function public.list_receipt_go_live_gaps(text) to authenticated;
grant execute on function public.update_document_customer_email(uuid, text) to authenticated;
