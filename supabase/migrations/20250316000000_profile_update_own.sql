-- Allow any authenticated user to update their own profile (phone, etc.)
-- Previously this was limited to athletes + managers.

drop policy if exists profiles_update_own_athlete on public.profiles;

create policy profiles_update_own on public.profiles
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

