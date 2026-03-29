-- After first user signs up (athlete), promote to manager + approve:
-- replace YOUR_USER_UUID with auth.users.id from Supabase Dashboard → Authentication
/*
update public.profiles
set role = 'manager', approval_status = 'approved'
where user_id = 'YOUR_USER_UUID';
*/

-- Create a coach user: sign up as athlete, then:
/*
update public.profiles
set role = 'coach', approval_status = 'approved'
where user_id = 'COACH_USER_UUID';
*/
