-- Enforce hidden-athlete-per-workout at the RLS layer: an athlete's own
-- direct-table reads must exclude rows hidden by the Super User, while
-- coach/manager access (is_coach_or_manager) stays completely unfiltered.
--
-- This is the key leverage point: training_sessions.sessions_select already
-- grants athlete visibility via an `exists (select 1 from session_registrations
-- r where r.user_id = auth.uid() ...)` subquery. That subquery runs under the
-- athlete's own RLS, so once reg_select stops returning the hidden row, the
-- athlete also loses SELECT on the training_sessions row itself (unless it's
-- independently visible via the open-for-registration browse branch) — no
-- separate change to sessions_select is needed.

drop policy if exists "reg_select" on public.session_registrations;
create policy "reg_select" on public.session_registrations for select using (
  public.is_coach_or_manager(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(session_registrations.session_id, session_registrations.user_id)
  )
);

drop policy if exists "cancellations_select" on public.cancellations;
create policy "cancellations_select" on public.cancellations for select using (
  public.is_coach_or_manager(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(cancellations.session_id, cancellations.user_id)
  )
);

drop policy if exists "history_select" on public.registration_history;
create policy "history_select" on public.registration_history for select using (
  public.is_coach_or_manager(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(registration_history.session_id, registration_history.user_id)
  )
);
