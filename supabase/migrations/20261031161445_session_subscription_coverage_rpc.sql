-- Session Detail's "Amount due" line currently ignores subscription_registration_coverage
-- entirely: it shows the raw session price for every roster row, even when that row's
-- registration (or manual participant) was already decided `covered = true` by the existing
-- subscription coverage engine (subscription_registration_coverage, written by registration /
-- subscription_reconcile_week). This exposes that EXISTING authoritative decision — read-only,
-- no new eligibility logic — to the session's coach or any manager, the same way
-- session_payment_receipt_locks() exposes receipt-lock state to the roster screen.
create or replace function public.session_subscription_coverage(p_session_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid)
     and not exists (select 1 from public.training_sessions s where s.id = p_session_id and s.coach_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  return json_build_object(
    'ok', true,
    'covered_user_ids', coalesce((
      select json_agg(r.user_id)
      from public.subscription_registration_coverage src
      join public.session_registrations r on r.id = src.registration_id
      where r.session_id = p_session_id and src.covered = true), '[]'::json),
    'covered_manual_ids', coalesce((
      select json_agg(m.manual_participant_id)
      from public.subscription_registration_coverage src
      join public.session_manual_participants m on m.id = src.manual_participant_id
      where m.session_id = p_session_id and src.covered = true), '[]'::json)
  );
end;
$$;

revoke execute on function public.session_subscription_coverage(uuid) from public, anon;
grant execute on function public.session_subscription_coverage(uuid) to authenticated, service_role;

-- Self-check
do $$
begin
  if has_function_privilege('anon', 'public.session_subscription_coverage(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unexpected anon privilege on session_subscription_coverage';
  end if;
end $$;
