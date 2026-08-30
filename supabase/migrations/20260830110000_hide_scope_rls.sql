-- Role-aware RLS: coaches and (non-super) managers each independently lose
-- visibility on rows hidden from their specific audience. The Super User
-- branch is checked first and grants unconditional access regardless of any
-- hide flag.

drop policy if exists "reg_select" on public.session_registrations;
create policy "reg_select" on public.session_registrations for select using (
  public.is_super_user(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(session_registrations.session_id, session_registrations.user_id)
  )
  or (
    public.is_coach(auth.uid())
    and not public.is_registration_hidden_from_coach(session_registrations.session_id, session_registrations.user_id)
  )
  or (
    public.is_manager(auth.uid())
    and not public.is_registration_hidden_from_manager(session_registrations.session_id, session_registrations.user_id)
  )
);

drop policy if exists "cancellations_select" on public.cancellations;
create policy "cancellations_select" on public.cancellations for select using (
  public.is_super_user(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(cancellations.session_id, cancellations.user_id)
  )
  or (
    public.is_coach(auth.uid())
    and not public.is_registration_hidden_from_coach(cancellations.session_id, cancellations.user_id)
  )
  or (
    public.is_manager(auth.uid())
    and not public.is_registration_hidden_from_manager(cancellations.session_id, cancellations.user_id)
  )
);

drop policy if exists "history_select" on public.registration_history;
create policy "history_select" on public.registration_history for select using (
  public.is_super_user(auth.uid())
  or (
    user_id = auth.uid()
    and not public.is_registration_hidden(registration_history.session_id, registration_history.user_id)
  )
  or (
    public.is_coach(auth.uid())
    and not public.is_registration_hidden_from_coach(registration_history.session_id, registration_history.user_id)
  )
  or (
    public.is_manager(auth.uid())
    and not public.is_registration_hidden_from_manager(registration_history.session_id, registration_history.user_id)
  )
);
