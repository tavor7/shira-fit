-- PostgreSQL does not always resolve session_billing_price_ils(session_id, user_id)
-- to the 3-arg function with a defaulted third parameter. Restore an explicit 2-arg overload.

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
    select ts.custom_slot_price_ils, ts.max_participants, coalesce(ts.is_kickbox, false) as is_kickbox
    from public.training_sessions ts
    where ts.id = p_session_id
    limit 1
  )
  select coalesce(
    (select s.custom_slot_price_ils from sess s where s.custom_slot_price_ils is not null),
    public.participant_capacity_price_ils(
      p_user_id,
      p_manual_participant_id,
      (select s.max_participants from sess s),
      (select s.is_kickbox from sess s)
    ),
    0::numeric
  );
$$;

comment on function public.session_billing_price_ils(uuid, uuid, uuid) is
  'Session custom price, else athlete/manual override, else global tier.';

grant execute on function public.session_billing_price_ils(uuid, uuid, uuid) to authenticated;

create or replace function public.session_billing_price_ils(
  p_session_id uuid,
  p_user_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.session_billing_price_ils(p_session_id, p_user_id, null::uuid);
$$;

comment on function public.session_billing_price_ils(uuid, uuid) is
  'Billing price for a registered athlete on a session (no manual participant).';

grant execute on function public.session_billing_price_ils(uuid, uuid) to authenticated;
