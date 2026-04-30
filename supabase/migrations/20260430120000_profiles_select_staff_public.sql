-- Allow athletes to display coach/manager names in calendar + session screens.
-- Without this, RLS blocks joins like `trainer:profiles!coach_id(full_name)` for athletes.

-- Authenticated users may read staff profiles (coach/manager).
drop policy if exists "profiles_select_staff_public" on public.profiles;
create policy "profiles_select_staff_public"
on public.profiles
for select
to authenticated
using (role in ('coach', 'manager'));

