-- Structural security regression test: which columns of public.profiles may client roles UPDATE.
--
-- Guards 20261005130000_restrict_profiles_update_to_self_service_columns.sql. RLS on profiles is
-- row-level only (a user may touch their own row), so the column-level privilege set is the ONLY
-- thing preventing a signed-in user from rewriting privileged fields on their own profile
-- (role, approval_status, disabled_at, is_super_user, ...). This test fails if a later migration
-- restores a table-wide UPDATE grant or grants a sensitive/system column.
--
-- Pure catalog checks: no fixtures, no auth.users rows, and no dependency on the old stub schema,
-- so it runs against the real migrated schema (plain psql: any failure raises an exception).
--
-- A column added to profiles in the future is NOT in the allowlist below, so it must stay
-- non-writable for clients until this test is deliberately updated alongside an explicit GRANT.
set client_min_messages to notice;

do $$
declare
  -- The ONLY columns clients may update directly (self-service flows). Keep in sync with the
  -- migration's GRANT. Everything else goes through SECURITY DEFINER RPCs / the service role.
  v_allowed constant text[] := array[
    'address', 'age', 'calendar_color', 'date_of_birth', 'expo_push_token', 'full_name', 'gender',
    'health_declaration_confirmed_at', 'notification_prompt_queued_at', 'phone', 'zip_code'
  ];
  -- Privileged / system-controlled columns that must never be client-writable.
  v_protected constant text[] := array[
    'user_id', 'username', 'role', 'approval_status', 'disabled_at', 'disabled_by', 'is_super_user',
    'must_change_password', 'temp_password_plaintext', 'created_at', 'updated_at',
    'electronic_receipts_consent_version', 'electronic_receipts_consented_at',
    'whatsapp_notifications_enabled', 'whatsapp_opted_in_at', 'whatsapp_phone_e164',
    'notifications_onboarded_at', 'notify_group_spot_available', 'notify_nongroup_removal'
  ];
  v_role text;
  v_col text;
  v_actual text[];
  v_unknown text[];
begin
  foreach v_role in array array['authenticated', 'anon'] loop
    if has_table_privilege(v_role, 'public.profiles', 'UPDATE') then
      raise exception 'T1 FAILED: % has a table-wide UPDATE privilege on public.profiles', v_role;
    end if;
  end loop;
  raise notice 'T1 PASSED: no table-wide UPDATE on public.profiles for authenticated or anon';

  -- Every protected column must exist (so a rename cannot silently weaken this test) and be denied.
  foreach v_col in array v_protected loop
    if not exists (
      select 1 from pg_attribute
      where attrelid = 'public.profiles'::regclass and attname = v_col and attnum > 0 and not attisdropped
    ) then
      raise exception 'T2 FAILED: protected column % no longer exists on public.profiles; update this test', v_col;
    end if;
    foreach v_role in array array['authenticated', 'anon'] loop
      if has_column_privilege(v_role, 'public.profiles', v_col, 'UPDATE') then
        raise exception 'T2 FAILED: % can UPDATE protected column profiles.%', v_role, v_col;
      end if;
    end loop;
  end loop;
  raise notice 'T2 PASSED: % protected columns are not writable by authenticated or anon', cardinality(v_protected);

  -- The intended self-edit columns stay writable by authenticated.
  foreach v_col in array v_allowed loop
    if not has_column_privilege('authenticated', 'public.profiles', v_col, 'UPDATE') then
      raise exception 'T3 FAILED: authenticated can no longer UPDATE self-service column profiles.%', v_col;
    end if;
  end loop;
  raise notice 'T3 PASSED: all % self-service columns remain writable by authenticated', cardinality(v_allowed);

  -- Fail-closed catch-all: the writable set must equal the allowlist EXACTLY, so any column that is
  -- not listed (including columns added in future migrations) must be non-writable.
  select coalesce(array_agg(attname::text order by attname), '{}') into v_actual
  from pg_attribute
  where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
    and has_column_privilege('authenticated', 'public.profiles', attname, 'UPDATE');
  select coalesce(array_agg(x order by x), '{}') into v_unknown
  from unnest(v_actual) x where x <> all (v_allowed);
  if cardinality(v_unknown) > 0 then
    raise exception 'T4 FAILED: authenticated can UPDATE columns outside the allowlist: %', v_unknown;
  end if;
  raise notice 'T4 PASSED: the authenticated-writable column set equals the allowlist exactly (%)', v_actual;

  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
      and has_column_privilege('anon', 'public.profiles', attname, 'UPDATE')
  ) then
    raise exception 'T5 FAILED: anon can UPDATE a column on public.profiles';
  end if;
  raise notice 'T5 PASSED: anon cannot UPDATE any column on public.profiles';

  raise notice 'ALL PROFILES UPDATE-PRIVILEGE TESTS (T1-T5) PASSED';
end $$;
