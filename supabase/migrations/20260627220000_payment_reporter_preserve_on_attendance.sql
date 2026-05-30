-- Preserve original payment reporter when attendance changes but payment stays the same.
-- Set reporter when payment is first saved or when method/amount changes.

create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null,
  p_charge_no_show boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_row public.session_registrations%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
  v_charge_ns boolean := coalesce(p_charge_no_show, false);
  v_payment_changed boolean := false;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid
    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row
  from public.session_registrations
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  if not found then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
    v_charge_ns := false;
  elsif p_status = 'arrived' then
    v_att := true;
    v_charge_ns := false;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    if not v_charge_ns then
      v_pay := null;
      v_amt := null;
    else
      if v_pay is null then
        v_amt := null;
      else
        if p_amount_paid is not null and p_amount_paid < 0 then
          return json_build_object('ok', false, 'error', 'invalid_amount');
        end if;
        v_amt := case
          when p_amount_paid is null then null
          else round(p_amount_paid::numeric, 2)::numeric(12, 2)
        end;
      end if;
    end if;
  end if;

  v_payment_changed :=
    v_pay is distinct from nullif(trim(coalesce(v_row.payment_method, '')), '')
    or v_amt is distinct from v_row.amount_paid;

  update public.session_registrations
  set
    attended = v_att,
    payment_method = v_pay,
    amount_paid = v_amt,
    charge_no_show = case when p_status = 'absent' then v_charge_ns else false end,
    payment_recorded_by = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then v_uid
      else v_row.payment_recorded_by
    end,
    payment_recorded_at = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then now()
      else v_row.payment_recorded_at
    end
  where id = v_row.id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'update_failed');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_attendance(uuid, uuid, text, text, numeric, boolean) to authenticated;

create or replace function public.set_manual_participant_attendance(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null,
  p_charge_no_show boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_row public.session_manual_participants%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
  v_charge_ns boolean := coalesce(p_charge_no_show, false);
  v_payment_changed boolean := false;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row
  from public.session_manual_participants
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_in_session');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
    v_charge_ns := false;
  elsif p_status = 'arrived' then
    v_att := true;
    v_charge_ns := false;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    if not v_charge_ns then
      v_pay := null;
      v_amt := null;
    else
      if v_pay is null then
        v_amt := null;
      else
        if p_amount_paid is not null and p_amount_paid < 0 then
          return json_build_object('ok', false, 'error', 'invalid_amount');
        end if;
        v_amt := case
          when p_amount_paid is null then null
          else round(p_amount_paid::numeric, 2)::numeric(12, 2)
        end;
      end if;
    end if;
  end if;

  v_payment_changed :=
    v_pay is distinct from nullif(trim(coalesce(v_row.payment_method, '')), '')
    or v_amt is distinct from v_row.amount_paid;

  update public.session_manual_participants
  set
    attended = v_att,
    payment_method = v_pay,
    amount_paid = v_amt,
    charge_no_show = case when p_status = 'absent' then v_charge_ns else false end,
    payment_recorded_by = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then v_uid
      else v_row.payment_recorded_by
    end,
    payment_recorded_at = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then now()
      else v_row.payment_recorded_at
    end
  where id = v_row.id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'update_failed');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_manual_participant_attendance(uuid, uuid, text, text, numeric, boolean) to authenticated;
