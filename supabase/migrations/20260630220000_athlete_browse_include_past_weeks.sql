-- Athletes browse: any past week through end of next week (studio TZ).
-- No lower date cap. Still nothing beyond next week. Coaches/managers unchanged.

comment on function public.athlete_browse_week_start() is
  'Unused for RLS — athlete browse has no start date cap. Kept for compatibility.';

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
    and training_sessions.session_date <= public.athlete_browse_week_end()
  )
);
