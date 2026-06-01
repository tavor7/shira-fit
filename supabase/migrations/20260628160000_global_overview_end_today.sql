-- Global overview: end at today (not last session date).

create or replace function public._manager_stats_period_bounds(p_anchor date, p_mode text)
returns table (period_start date, period_end date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_start date;
  v_end date;
begin
  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month', 'global') then
    v_mode := 'week';
  end if;

  if v_mode = 'global' then
    v_end := current_date;
    v_start := coalesce((select min(s.session_date) from public.training_sessions s), v_end);
  elsif v_mode = 'month' then
    v_start := date_trunc('month', p_anchor::timestamp)::date;
    v_end := (v_start + interval '1 month - 1 day')::date;
  else
    v_start := public._week_start_sunday(p_anchor);
    v_end := v_start + 6;
  end if;

  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;
