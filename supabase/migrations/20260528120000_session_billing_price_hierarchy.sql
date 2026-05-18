-- Enforce billing price hierarchy:
--   1) training_sessions.custom_slot_price_ils (session special rate)
--   2) athlete_session_capacity_pricing (athlete special rate at capacity tier)
--   3) session_capacity_pricing (global tier rate by max_participants)

create or replace function public.global_session_capacity_price_ils(p_max_participants int)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select g.price_ils
      from public.session_capacity_pricing g
      where g.max_participants = p_max_participants
      limit 1
    ),
    0::numeric
  );
$$;

comment on function public.global_session_capacity_price_ils(int) is
  'Global studio tier price for a session capacity (max_participants).';

grant execute on function public.global_session_capacity_price_ils(int) to authenticated;

create or replace function public.effective_session_price_ils(p_user_id uuid, p_max_participants int)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select o.price_ils
      from public.athlete_session_capacity_pricing o
      where o.user_id = p_user_id
        and o.max_participants = p_max_participants
      limit 1
    ),
    public.global_session_capacity_price_ils(p_max_participants)
  );
$$;

comment on function public.effective_session_price_ils(uuid, int) is
  'Athlete special rate at a capacity tier, else global tier rate. Does not include per-session custom_slot_price_ils; use session_billing_price_ils for that.';

grant execute on function public.effective_session_price_ils(uuid, int) to authenticated;

create or replace function public.session_billing_price_ils(p_session_id uuid, p_user_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with sess as (
    select ts.custom_slot_price_ils, ts.max_participants
    from public.training_sessions ts
    where ts.id = p_session_id
    limit 1
  )
  select coalesce(
    (select s.custom_slot_price_ils from sess s where s.custom_slot_price_ils is not null),
    case
      when p_user_id is not null then
        public.effective_session_price_ils(
          p_user_id,
          (select s.max_participants from sess s)
        )
      else
        public.global_session_capacity_price_ils((select s.max_participants from sess s))
    end,
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid) is
  'Resolved slot price: session custom_slot_price_ils, else athlete override, else global tier.';

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;

create or replace function public.manager_set_cancellation_penalty_collected(
  p_cancellation_id uuid,
  p_collected_ils numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  c_row cancellations%rowtype;
  v_price numeric(12, 2);
  v_amt numeric(12, 2);
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_collected_ils is null or p_collected_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into c_row from public.cancellations where id = p_cancellation_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if c_row.charged_full_price is not true then
    return json_build_object('ok', false, 'error', 'not_chargeable');
  end if;

  v_price := round(public.session_billing_price_ils(c_row.session_id, c_row.user_id)::numeric, 2)::numeric(12, 2);
  if v_price is null then v_price := 0; end if;

  v_amt := least(round(p_collected_ils::numeric, 2), v_price)::numeric(12, 2);

  update public.cancellations
  set penalty_collected_ils = v_amt
  where id = p_cancellation_id;

  return json_build_object('ok', true);
end;
$$;
