-- Per-participant rate override for a specific session (above session-wide custom_slot_price_ils).

create table if not exists public.session_roster_slot_prices (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  user_id uuid references public.profiles (user_id) on delete cascade,
  manual_participant_id uuid references public.manual_participants (id) on delete cascade,
  price_ils numeric(12, 2) not null check (price_ils >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_roster_slot_prices_one_payee check (
    (user_id is not null and manual_participant_id is null)
    or (user_id is null and manual_participant_id is not null)
  )
);

create unique index if not exists session_roster_slot_prices_session_user_idx
  on public.session_roster_slot_prices (session_id, user_id)
  where user_id is not null;

create unique index if not exists session_roster_slot_prices_session_manual_idx
  on public.session_roster_slot_prices (session_id, manual_participant_id)
  where manual_participant_id is not null;

create index if not exists session_roster_slot_prices_session_idx
  on public.session_roster_slot_prices (session_id);

comment on table public.session_roster_slot_prices is
  'Optional billing rate (ILS) for one roster slot on one session; overrides session custom_slot_price_ils for that participant only.';

drop trigger if exists session_roster_slot_prices_updated on public.session_roster_slot_prices;
create trigger session_roster_slot_prices_updated
  before update on public.session_roster_slot_prices
  for each row execute function public.set_updated_at();

alter table public.session_roster_slot_prices enable row level security;

drop policy if exists session_roster_slot_prices_staff_select on public.session_roster_slot_prices;
create policy session_roster_slot_prices_staff_select on public.session_roster_slot_prices
  for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_roster_slot_prices_staff_write on public.session_roster_slot_prices;
create policy session_roster_slot_prices_staff_write on public.session_roster_slot_prices
  for all
  using (public.is_coach_or_manager(auth.uid()))
  with check (public.is_coach_or_manager(auth.uid()));

create or replace function public.staff_set_session_roster_slot_price(
  p_session_id uuid,
  p_user_id uuid,
  p_manual_participant_id uuid,
  p_price_ils numeric
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if (p_user_id is null) = (p_manual_participant_id is null) then
    return json_build_object('ok', false, 'error', 'invalid_payee');
  end if;

  if p_price_ils is not null and p_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid and exists (
    select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach'
  ) then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_user_id is not null then
    if not exists (
      select 1 from public.session_registrations r
      where r.session_id = p_session_id and r.user_id = p_user_id and r.status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'not_on_roster');
    end if;
  else
    if not exists (
      select 1 from public.session_manual_participants m
      where m.session_id = p_session_id and m.manual_participant_id = p_manual_participant_id
    ) then
      return json_build_object('ok', false, 'error', 'not_on_roster');
    end if;
  end if;

  if p_price_ils is null then
    delete from public.session_roster_slot_prices
    where session_id = p_session_id
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_manual_participant_id is not null and manual_participant_id = p_manual_participant_id)
      );
    return json_build_object('ok', true);
  end if;

  if p_user_id is not null then
    update public.session_roster_slot_prices
    set price_ils = round(p_price_ils::numeric, 2), updated_at = now()
    where session_id = p_session_id and user_id = p_user_id;
    if not found then
      insert into public.session_roster_slot_prices (session_id, user_id, price_ils)
      values (p_session_id, p_user_id, round(p_price_ils::numeric, 2));
    end if;
  else
    update public.session_roster_slot_prices
    set price_ils = round(p_price_ils::numeric, 2), updated_at = now()
    where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
    if not found then
      insert into public.session_roster_slot_prices (session_id, manual_participant_id, price_ils)
      values (p_session_id, p_manual_participant_id, round(p_price_ils::numeric, 2));
    end if;
  end if;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.staff_set_session_roster_slot_price(uuid, uuid, uuid, numeric) to authenticated;

-- Billing hierarchy: roster override → session custom → athlete/manual/global tier.
create or replace function public.session_billing_price_ils(
  p_session_id uuid,
  p_user_id uuid,
  p_manual_participant_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with sess as (
    select
      ts.custom_slot_price_ils,
      ts.max_participants,
      coalesce(ts.is_kickbox, false) as is_kickbox,
      ts.session_date
    from public.training_sessions ts
    where ts.id = p_session_id
    limit 1
  )
  select coalesce(
    (
      select r.price_ils
      from public.session_roster_slot_prices r
      where r.session_id = p_session_id
        and (
          (p_user_id is not null and r.user_id = p_user_id)
          or (p_manual_participant_id is not null and r.manual_participant_id = p_manual_participant_id)
        )
      limit 1
    ),
    (select s.custom_slot_price_ils from sess s where s.custom_slot_price_ils is not null),
    public.participant_capacity_price_ils(
      p_user_id,
      p_manual_participant_id,
      (select s.max_participants from sess s),
      (select s.is_kickbox from sess s),
      (select s.session_date from sess s)
    ),
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid, uuid) is
  'Roster slot override, else session custom price, else athlete/manual/global tier for session date.';

grant execute on function public.session_billing_price_ils(uuid, uuid, uuid) to authenticated;
