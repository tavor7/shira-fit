-- Athletes browse: current Sun–Sat week through next Sun–Sat week (studio TZ).
-- Nothing beyond next week. Coaches/managers unchanged.

create or replace function public.athlete_browse_week_start()
returns date
language sql
stable
as $$
  select public._week_start_sunday(public._studio_today_date());
$$;

create or replace function public.athlete_browse_week_end()
returns date
language sql
stable
as $$
  select public._week_start_sunday(public._studio_today_date()) + 13;
$$;

comment on function public.athlete_browse_week_start() is
  'First day (Sun) of the current studio week — start of athlete browse window.';
comment on function public.athlete_browse_week_end() is
  'Last day (Sat) of next studio week — end of athlete browse window.';
