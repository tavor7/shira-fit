-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 2 support).
-- The Privacy Policy / Terms pages must show accurate, current business identity
-- (name, address, contact, and dealer status derived from the live VAT toggle) even to
-- signed-out visitors on the signup/login screens. receipt_settings itself is
-- staff-only (has pricing/document-numbering internals), so expose only the public-safe
-- identity subset via a dedicated read-only RPC instead of loosening receipt_settings RLS.

create or replace function public.get_public_business_info()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_row public.receipt_settings%rowtype;
begin
  select * into v_row from public.receipt_settings limit 1;
  if v_row.id is null then
    return json_build_object('ok', true, 'business_name', 'Shira Fit');
  end if;
  return json_build_object(
    'ok', true,
    'business_name', nullif(trim(v_row.business_name), ''),
    'business_id', nullif(trim(v_row.business_id), ''),
    'address', nullif(trim(v_row.address), ''),
    'phone', nullif(trim(v_row.phone), ''),
    'email', nullif(trim(v_row.email), ''),
    'vat_enabled', coalesce(v_row.vat_enabled, false)
  );
end;
$$;

grant execute on function public.get_public_business_info() to anon, authenticated;
