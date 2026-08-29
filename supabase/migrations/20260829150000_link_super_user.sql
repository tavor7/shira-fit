-- Links the dedicated Super User auth account to is_super_user = true.
--
-- The actual auth.users row (email + password) is provisioned out-of-band
-- (Supabase Auth, not application code or a committed secret) and is not
-- tied to this migration going forward — the flag below is keyed on the
-- account's user_id (via the email it had at creation time), so changing
-- the account's email/password later does not require rerunning or editing
-- this migration.
update public.profiles
set role = 'manager', approval_status = 'approved', is_super_user = true
where user_id = (select id from auth.users where email = 'tavor7+superuser@gmail.com');
