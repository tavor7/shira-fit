-- manager_set_cancellation_charge used (date + time)::timestamptz (DB TZ, often UTC) while the app
-- treats session_date + start_time as Asia/Jerusalem wall clock. That made late cancels look
-- chargeable in the UI but return not_late_cancellation from the server.

create or replace function public.manager_set_cancellation_charge(
  p_cancellation_id uuid,
  p_charge boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  s_row training_sessions%rowtype;
  v_start timestamptz;
  v_late boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  select * into s_row from public.training_sessions where id = c_row.session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_start :=
    ((s_row.session_date + coalesce(s_row.start_time, time '00:00'))::timestamp
      at time zone 'Asia/Jerusalem');

  v_late :=
    c_row.cancelled_at <= v_start
    and (v_start - c_row.cancelled_at) <= interval '12 hours';

  if not v_late then
    return json_build_object('ok', false, 'error', 'not_late_cancellation');
  end if;

  update public.cancellations
  set
    charged_full_price = p_charge,
    penalty_collected_ils = case when p_charge then penalty_collected_ils else 0 end
  where id = p_cancellation_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.manager_set_cancellation_charge(uuid, boolean) to authenticated;
