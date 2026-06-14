-- Recurring sessions deleted "this date only" must land in session_series.skip_dates.
-- Some client paths deleted the row directly (detached occurrences, legacy series_id null),
-- so maintain_session_series_horizon regenerated empty duplicates on those dates.

create or replace function public._series_add_skip_date(p_series_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_series_id is null or p_date is null then
    return;
  end if;

  update public.session_series
  set skip_dates = coalesce(
    (
      select array_agg(distinct d order by d)
      from (
        select unnest(coalesce(skip_dates, '{}'::date[])) as d
        union all
        select p_date
      ) u
    ),
    '{}'::date[]
  )
  where id = p_series_id;
end;
$$;

create or replace function public.trg_training_sessions_before_delete_series_skip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.series_id is not null then
    perform public._series_add_skip_date(old.series_id, old.session_date);
  end if;

  return old;
end;
$$;

drop trigger if exists training_sessions_before_delete_series_skip on public.training_sessions;

create trigger training_sessions_before_delete_series_skip
before delete on public.training_sessions
for each row
execute function public.trg_training_sessions_before_delete_series_skip();

create or replace function public.staff_delete_session_series_scope(
  p_session_id uuid,
  p_scope text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  if v_sess.series_id is null then
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    perform public._series_add_skip_date(v_sess.series_id, v_sess.session_date);
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  update public.session_series
  set
    status = 'ended',
    ended_from_date = v_sess.session_date,
    updated_at = now()
  where id = v_sess.series_id;

  delete from public.training_sessions t
  where t.series_id = v_sess.series_id
    and t.session_date >= v_sess.session_date
    and t.series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$$;

-- Remove empty ghosts that were regenerated on dates already marked skipped.
delete from public.training_sessions t
using public.session_series s
where t.series_id = s.id
  and t.session_date = any(coalesce(s.skip_dates, '{}'::date[]))
  and t.series_detached = false
  and public._session_roster_size(t.id) = 0;
