-- Athletes should be able to SEE sessions even when registration is closed,
-- as long as the session is not hidden.
--
-- Hidden sessions remain staff-only, except for athletes already registered.

drop policy if exists "sessions_select" on public.training_sessions;
create policy "sessions_select" on public.training_sessions for select using (
  public.is_coach_or_manager(auth.uid())
  or coalesce(is_hidden, false) = false
  or exists (
    select 1 from public.session_registrations r
    where r.session_id = training_sessions.id
      and r.user_id = auth.uid()
      and r.status = 'active'
  )
);

