-- Lets managers clear their own receipt fields to reproduce the in-app requirement gate.

create or replace function public.manager_reset_own_receipt_requirements_for_testing(
  p_reset_consent boolean default true,
  p_reset_address boolean default true
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.profiles
  set
    address = case when p_reset_address then '' else address end,
    zip_code = case when p_reset_address then '' else zip_code end,
    electronic_receipts_consent_version = case when p_reset_consent then null else electronic_receipts_consent_version end,
    electronic_receipts_consented_at = case when p_reset_consent then null else electronic_receipts_consented_at end
  where user_id = v_uid;

  return json_build_object(
    'ok', true,
    'reset_consent', coalesce(p_reset_consent, true),
    'reset_address', coalesce(p_reset_address, true)
  );
end;
$$;

grant execute on function public.manager_reset_own_receipt_requirements_for_testing(boolean, boolean) to authenticated;
