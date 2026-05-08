-- One-argument overload delegates to week mode (PostgREST + legacy callers).

create or replace function public.manager_weekly_stats(p_week_start date)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select public.manager_weekly_stats(p_week_start, 'week');
$$;

grant execute on function public.manager_weekly_stats(date) to authenticated;
