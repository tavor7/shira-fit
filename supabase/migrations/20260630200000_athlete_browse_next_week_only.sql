-- Athletes browse: non-hidden sessions in the upcoming Sun–Sat week only (studio timezone).
-- Coaches/managers unchanged. Registered athletes still see their sessions (any week, incl. hidden).

create or replace function public.athlete_browse_week_start()
returns date
language sql
stable
as $$
  select public._week_start_sunday(public._studio_today_date()) + 7;
$$;

create or replace function public.athlete_browse_week_end()
returns date
language sql
stable
as $$
  select public.athlete_browse_week_start() + 6;
$$;

comment on function public.athlete_browse_week_start() is
  'First day (Sun) of the athlete registration browse week — always the calendar week after the current Sun-start week, studio TZ.';
comment on function public.athlete_browse_week_end() is
  'Last day (Sat) of the athlete registration browse week.';

drop policy if exists "sessions_select" on public.training_sessions;
create policy "sessions_select" on public.training_sessions for select using (
  public.is_coach_or_manager(auth.uid())
  or exists (
    select 1
    from public.session_registrations r
    where r.session_id = training_sessions.id
      and r.user_id = auth.uid()
      and r.status = 'active'
  )
  or (
    coalesce(training_sessions.is_hidden, false) = false
    and exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'athlete'
        and p.approval_status = 'approved'
        and p.disabled_at is null
    )
    and training_sessions.session_date >= public.athlete_browse_week_start()
    and training_sessions.session_date <= public.athlete_browse_week_end()
  )
);

grant execute on function public.athlete_browse_week_start() to authenticated;
grant execute on function public.athlete_browse_week_end() to authenticated;
