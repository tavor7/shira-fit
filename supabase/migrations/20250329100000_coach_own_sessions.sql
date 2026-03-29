-- Coaches may create, update, and delete training sessions where they are the assigned coach.
-- Managers keep existing unrestricted policies.

drop policy if exists "sessions_coach_insert_self" on public.training_sessions;
create policy "sessions_coach_insert_self" on public.training_sessions
  for insert
  with check (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and coach_id = auth.uid()
  );

drop policy if exists "sessions_coach_update_self" on public.training_sessions;
create policy "sessions_coach_update_self" on public.training_sessions
  for update
  using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and coach_id = auth.uid()
  )
  with check (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and coach_id = auth.uid()
  );

drop policy if exists "sessions_coach_delete_self" on public.training_sessions;
create policy "sessions_coach_delete_self" on public.training_sessions
  for delete
  using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'coach')
    and coach_id = auth.uid()
  );
