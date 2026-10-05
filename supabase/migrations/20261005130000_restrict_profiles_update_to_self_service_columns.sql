-- Security: stop authenticated users from rewriting privileged/system columns on their own profile.
--
-- Problem: the RLS policy profiles_update_own (and the leftover profiles_update_own_athlete) only
-- check that the row is the caller's own (auth.uid() = user_id). RLS is row-level, and
-- `authenticated` held a table-wide UPDATE grant, so any signed-in user could PATCH their own row
-- and set any column -- e.g. role = 'manager', approval_status = 'approved', clear
-- disabled_at / disabled_by, is_super_user = true, must_change_password, temp_password_plaintext,
-- consent / WhatsApp / notification-state columns. No trigger guards these columns, and the
-- profile audit trigger does not log changes to role / approval / disabled / super-user state.
--
-- Fix: remove the table-wide UPDATE privilege and grant UPDATE only on the columns that
-- self-service client flows actually write. Column privileges are enforced before RLS, apply to
-- the whole statement (one forbidden column makes the entire UPDATE fail), and fail closed: a
-- column added to profiles later is NOT writable by clients unless it is explicitly granted here
-- or in a later migration.
--
-- Writable by `authenticated` (the only client-side writers, audited in the app code):
--   full_name, phone, address, zip_code, gender, date_of_birth, age,
--   health_declaration_confirmed_at   -- signup (signup.tsx / signup.web.tsx) post-signUp update
--   phone, address, zip_code          -- profile.tsx, ReceiptRequirementsGateModal
--   expo_push_token                   -- pushTokenSync
--   notification_prompt_queued_at     -- notificationActivation
--   calendar_color                    -- StaffEditProfileScreen
-- `age` and `health_declaration_confirmed_at` are also derived server-side at signup (from the
-- signUp metadata by handle_new_user / _apply_signup_profile_from_metadata), so the client write is
-- redundant for current builds; they stay writable only so already-installed builds, which send
-- them in the same UPDATE statement, keep working. They are not privilege-bearing. Revoke them once
-- no supported client sends them.
--
-- Everything else -- role, approval_status, disabled_at, disabled_by, is_super_user, user_id,
-- username, must_change_password, temp_password_plaintext, consent / receipts / WhatsApp columns,
-- notifications_onboarded_at, manager notification prefs, created_at, updated_at -- is changed only
-- through the existing SECURITY DEFINER RPCs (set_user_role, set_athlete_approval,
-- staff_set_account_disabled, staff_update_profile_text, clear_must_change_password,
-- mark_notifications_onboarded, record_user_consent, set_whatsapp_notifications_enabled,
-- set_manager_notification_prefs, ...) or the service role (staff-set-temp-password edge function).
-- Those run as the function owner and are unaffected by this change.
--
-- Note: revoking at TABLE level is what makes this effective. A column-level REVOKE alone does
-- nothing while a table-level grant exists (that is why the revoke select (temp_password_plaintext)
-- in 20260904130000 never took effect). REVOKE on the table also clears any column-level UPDATE
-- grants, so this is safe to re-run.
--
-- Schema/privilege change only: no policies, constraints or data are touched.

revoke update on table public.profiles from authenticated;
revoke update on table public.profiles from anon;

grant update (
  full_name,
  phone,
  address,
  zip_code,
  gender,
  date_of_birth,
  age,
  health_declaration_confirmed_at,
  expo_push_token,
  notification_prompt_queued_at,
  calendar_color
) on public.profiles to authenticated;

-- Self-check: abort the migration if the privilege state is not exactly what is intended, so a
-- silently ineffective REVOKE/GRANT can never ship.
do $$
declare
  v_allowed constant text[] := array[
    'full_name', 'phone', 'address', 'zip_code', 'gender', 'date_of_birth', 'age',
    'health_declaration_confirmed_at', 'expo_push_token', 'notification_prompt_queued_at',
    'calendar_color'
  ];
  v_actual text[];
begin
  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     or has_table_privilege('anon', 'public.profiles', 'UPDATE') then
    raise exception 'profiles still has a table-wide UPDATE privilege for authenticated/anon';
  end if;

  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
  into v_actual
  from pg_attribute a
  where a.attrelid = 'public.profiles'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and has_column_privilege('authenticated', 'public.profiles', a.attname, 'UPDATE');

  if v_actual is distinct from (select array_agg(x order by x) from unnest(v_allowed) x) then
    raise exception 'profiles column UPDATE privileges for authenticated are not the intended allowlist: %', v_actual;
  end if;

  if exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', 'public.profiles', a.attname, 'UPDATE')
  ) then
    raise exception 'anon still has UPDATE on a profiles column';
  end if;
end $$;
