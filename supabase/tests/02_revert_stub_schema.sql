-- Supplementary stand-in schema for testing manager_revert_activity_event's
-- session_registration_status_changed fix.

alter table public.user_activity_events add column if not exists reverted_at timestamptz;
alter table public.user_activity_events add column if not exists reverted_by uuid;

create or replace function public._activity_jsonb_to_boolean(p_val jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when p_val is null or p_val = 'null'::jsonb then null
    else (p_val #>> '{}')::boolean
  end;
$$;

create or replace function public._activity_jsonb_to_numeric(p_val jsonb)
returns numeric
language sql
immutable
as $$
  select case
    when p_val is null or p_val = 'null'::jsonb then null
    else (p_val #>> '{}')::numeric
  end;
$$;

-- Minimal stand-in for manager_activity_revert_info: real function has one branch per
-- event_type; only the session_registration_status_changed branch matters for these tests.
create or replace function public.manager_activity_revert_info(p_event_id uuid)
returns json
language plpgsql
stable
as $$
declare
  ev public.user_activity_events%rowtype;
  v_reg_id uuid;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into ev from public.user_activity_events where id = p_event_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if ev.reverted_at is not null then
    return json_build_object('ok', true, 'can_revert', false, 'reason', 'already_reverted');
  end if;

  if ev.event_type = 'session_registration_status_changed' then
    v_reg_id := nullif(ev.target_id, '')::uuid;
    if v_reg_id is null or ev.metadata->>'from' is null then
      return json_build_object('ok', true, 'can_revert', false, 'reason', 'missing_status_context');
    end if;
    if not exists (select 1 from public.session_registrations where id = v_reg_id) then
      return json_build_object('ok', true, 'can_revert', false, 'reason', 'registration_missing');
    end if;
    return json_build_object('ok', true, 'can_revert', true);
  end if;

  return json_build_object('ok', true, 'can_revert', false, 'reason', 'not_revertible');
end;
$$;
