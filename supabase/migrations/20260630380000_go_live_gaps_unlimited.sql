-- Return all go-live gap users (no arbitrary cap).

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
  ) x;

  return json_build_object('ok', true, 'gap_type', p_gap_type, 'rows', v_rows);
end;
$$;
