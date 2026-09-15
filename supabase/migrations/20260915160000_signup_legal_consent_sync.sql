-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 3 support).
-- Mirrors the electronic_receipts signup-consent-sync pattern (see
-- 20260630400000_fix_signup_consent_gaps.sql): the client tries to record consent
-- immediately after signup, but if there's no session yet (email confirmation pending),
-- that call fails silently and must be recovered once the session exists. Rather than add
-- three more single-purpose "_pending" flags like electronic_receipts has, this uses one
-- generic `legal_consent_pending` JSON object in signup metadata:
--   { "terms_of_service": {"version":1,"status":"accepted"}, "privacy_policy": {...}, ... }
-- so future consent types don't need another bespoke sync function.

create or replace function public._try_sync_signup_legal_consents_for_user(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_meta jsonb;
  v_email_confirmed timestamptz;
  v_pending jsonb;
  v_remaining jsonb;
  v_type text;
  v_entry jsonb;
  v_version int;
  v_status text;
  v_synced_count int := 0;
  v_resolved_count int := 0;
begin
  if p_user_id is null then
    return json_build_object('ok', false, 'error', 'missing_user_id');
  end if;

  select raw_user_meta_data, email_confirmed_at into v_meta, v_email_confirmed
  from auth.users where id = p_user_id;

  if not found or v_email_confirmed is null then
    return json_build_object('ok', true, 'synced', 0);
  end if;

  v_pending := v_meta->'legal_consent_pending';
  if v_pending is null or jsonb_typeof(v_pending) <> 'object' then
    return json_build_object('ok', true, 'synced', 0);
  end if;
  v_remaining := v_pending;

  for v_type, v_entry in select * from jsonb_each(v_pending)
  loop
    if v_type not in ('terms_of_service', 'privacy_policy', 'marketing_communications') then
      -- Unknown/future key: never resolvable by this function version. Drop it rather
      -- than keep retrying it forever.
      v_remaining := v_remaining - v_type;
      v_resolved_count := v_resolved_count + 1;
      continue;
    end if;
    v_version := nullif(v_entry->>'version', '')::int;
    v_status := v_entry->>'status';
    if v_version is null or v_status not in ('accepted', 'declined') then
      v_remaining := v_remaining - v_type;
      v_resolved_count := v_resolved_count + 1;
      continue;
    end if;
    -- Defensive: this runs inside an AFTER trigger on auth.users (via
    -- tg_auth_user_signup_consent), so an unhandled exception here — e.g. a client
    -- deployed with a consent_type the DB migrations haven't added yet — must not be
    -- allowed to abort the triggering auth.users statement and block signup/login
    -- app-wide. On failure, leave this specific key in v_remaining (not the whole
    -- object) so a later, correctly migrated retry can still pick up just that entry.
    begin
      if not exists (
        select 1 from public.user_consents uc
        where uc.user_id = p_user_id
          and uc.consent_type = v_type::public.legal_consent_type
          and uc.consent_version = v_version
      ) then
        insert into public.user_consents (user_id, consent_type, consent_version, status, user_agent)
        values (p_user_id, v_type::public.legal_consent_type, v_version, v_status::public.consent_status, 'signup_sync');
        v_synced_count := v_synced_count + 1;
      end if;
      v_remaining := v_remaining - v_type;
      v_resolved_count := v_resolved_count + 1;
    exception when others then
      null; -- v_type stays in v_remaining for a future retry
    end;
  end loop;

  if v_resolved_count > 0 then
    if v_remaining = '{}'::jsonb then
      update auth.users set raw_user_meta_data = raw_user_meta_data - 'legal_consent_pending' where id = p_user_id;
    else
      update auth.users
      set raw_user_meta_data = jsonb_set(raw_user_meta_data, '{legal_consent_pending}', v_remaining)
      where id = p_user_id;
    end if;
  end if;

  return json_build_object('ok', true, 'synced', v_synced_count);
end;
$$;

create or replace function public.sync_signup_legal_consents()
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  return public._try_sync_signup_legal_consents_for_user(v_uid);
end;
$$;

grant execute on function public.sync_signup_legal_consents() to authenticated;

-- Reuse the existing trigger (fires after insert, and after email_confirmed_at /
-- raw_user_meta_data update) rather than adding a second trigger on auth.users.
create or replace function public.tg_auth_user_signup_consent()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public._try_sync_signup_consent_for_user(new.id);
  -- Belt-and-suspenders on top of the exception handling already inside
  -- _try_sync_signup_legal_consents_for_user: this is an AFTER trigger on auth.users,
  -- so nothing added here may ever raise and block signup/login/email-confirmation
  -- app-wide.
  begin
    perform public._try_sync_signup_legal_consents_for_user(new.id);
  exception when others then
    null;
  end;
  return new;
end;
$$;
