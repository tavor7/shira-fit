-- Snapshot user display name on each consent record for audit/reporting.

alter table public.user_consents
  add column if not exists full_name text;

comment on column public.user_consents.full_name is
  'User display name at the time consent was recorded.';

update public.user_consents uc
set full_name = nullif(trim(p.full_name), '')
from public.profiles p
where p.user_id = uc.user_id
  and uc.full_name is null;

create or replace function public.record_user_consent(
  p_consent_type public.legal_consent_type,
  p_status public.consent_status,
  p_consent_version int,
  p_ip_address text default null,
  p_user_agent text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_full_name text;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select nullif(trim(p.full_name), '') into v_full_name
  from public.profiles p
  where p.user_id = v_uid;

  insert into public.user_consents (
    user_id,
    full_name,
    consent_type,
    consent_version,
    status,
    ip_address,
    user_agent
  )
  values (
    v_uid,
    v_full_name,
    p_consent_type,
    p_consent_version,
    p_status,
    p_ip_address,
    p_user_agent
  );

  if p_consent_type = 'electronic_receipts' and p_status = 'accepted' then
    update public.profiles
    set
      electronic_receipts_consent_version = p_consent_version,
      electronic_receipts_consented_at = now()
    where user_id = v_uid;
    perform public._log_document_event(
      null,
      'consent_accepted',
      jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version)
    );
  elsif p_consent_type = 'electronic_receipts' and p_status = 'declined' then
    perform public._log_document_event(
      null,
      'consent_declined',
      jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version)
    );
  end if;

  return json_build_object('ok', true);
end;
$$;
