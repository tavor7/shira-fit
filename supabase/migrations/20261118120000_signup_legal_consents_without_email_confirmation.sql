-- Record signup Terms / Privacy / Marketing consent when the account is created, not when
-- the email is confirmed.
--
-- Accepting Terms of Use and the Privacy Policy is mandatory on the signup form, so an
-- account that exists has given those answers. Until now
-- _try_sync_signup_legal_consents_for_user (20260915160000) returned early while
-- email_confirmed_at was null, leaving the answers in raw_user_meta_data.legal_consent_pending.
-- An account a manager approved before its owner clicked the confirmation link then showed
-- Terms / Privacy as "not accepted" on the staff profile screen
-- (get_users_legal_consent_summary only reads user_consents).
--
-- The function is now called by the existing AFTER INSERT trigger on auth.users
-- (trg_auth_user_signup_consent) at signup itself. on_auth_user_created sorts before
-- trg_auth_user_signup_consent, so the profile row the user_consents FK needs already
-- exists. Everything else is unchanged: same keys and versions from the signup payload,
-- same dedupe (one row per user/type/version), same per-key exception handling so a
-- failure can never block signup, same pending-key cleanup, same execute privileges
-- (service_role only; CREATE OR REPLACE keeps the ACL from 20261013120000).
-- full_name is now stored too, as record_user_consent already does for every other path.
-- A malformed version / missing status in the payload is now dropped instead of raising.
--
-- electronic_receipts (_try_sync_signup_consent_for_user) deliberately still waits for a
-- confirmed email: that consent is about delivering receipts to the address.

create or replace function public._try_sync_signup_legal_consents_for_user(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_meta jsonb;
  v_pending jsonb;
  v_remaining jsonb;
  v_type text;
  v_entry jsonb;
  v_version int;
  v_status text;
  v_full_name text;
  v_synced_count int := 0;
  v_resolved_count int := 0;
begin
  if p_user_id is null then
    return json_build_object('ok', false, 'error', 'missing_user_id');
  end if;

  select raw_user_meta_data into v_meta
  from auth.users where id = p_user_id;

  if not found then
    return json_build_object('ok', true, 'synced', 0);
  end if;

  v_pending := v_meta->'legal_consent_pending';
  if v_pending is null or jsonb_typeof(v_pending) <> 'object' then
    return json_build_object('ok', true, 'synced', 0);
  end if;
  v_remaining := v_pending;

  select nullif(trim(p.full_name), '') into v_full_name
  from public.profiles p
  where p.user_id = p_user_id;

  for v_type, v_entry in select * from jsonb_each(v_pending)
  loop
    if v_type not in ('terms_of_service', 'privacy_policy', 'marketing_communications') then
      -- Unknown/future key: never resolvable by this function version. Drop it rather
      -- than keep retrying it forever.
      v_remaining := v_remaining - v_type;
      v_resolved_count := v_resolved_count + 1;
      continue;
    end if;
    -- Parsed defensively: a non-numeric version used to raise outside the per-key handler
    -- below, aborting the whole sync and leaving every key pending forever.
    v_version := case when v_entry->>'version' ~ '^[0-9]{1,9}$' then (v_entry->>'version')::int end;
    v_status := v_entry->>'status';
    if v_version is null or coalesce(v_status, '') not in ('accepted', 'declined') then
      v_remaining := v_remaining - v_type;
      v_resolved_count := v_resolved_count + 1;
      continue;
    end if;
    -- Runs inside an AFTER trigger on auth.users, now at signup itself: an unhandled
    -- exception here (e.g. no profile row yet, or a consent_type the DB migrations
    -- haven't added) must never abort signup/login. On failure, leave this key in
    -- v_remaining so the email-confirmation / first-login retry can still pick it up.
    begin
      if not exists (
        select 1 from public.user_consents uc
        where uc.user_id = p_user_id
          and uc.consent_type = v_type::public.legal_consent_type
          and uc.consent_version = v_version
      ) then
        insert into public.user_consents (user_id, full_name, consent_type, consent_version, status, user_agent)
        values (p_user_id, v_full_name, v_type::public.legal_consent_type, v_version, v_status::public.consent_status, 'signup_sync');
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

-- Existing accounts still holding signup answers (unconfirmed email). The consent was
-- given when the signup form was submitted, so accepted_at is the account's creation time;
-- created_at stays the time of this backfill, so the audit row shows when it was recorded.
-- Rows already in user_consents are never touched.
do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select u.id
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where jsonb_typeof(u.raw_user_meta_data->'legal_consent_pending') = 'object'
  loop
    begin
      perform public._try_sync_signup_legal_consents_for_user(v_user_id);
    exception when others then
      raise warning 'signup legal consent backfill skipped user %: %', v_user_id, sqlerrm;
    end;
  end loop;

  update public.user_consents uc
  set accepted_at = u.created_at
  from auth.users u
  where u.id = uc.user_id
    and uc.user_agent = 'signup_sync'
    and uc.consent_type in ('terms_of_service', 'privacy_policy', 'marketing_communications')
    and uc.created_at = now()
    and uc.accepted_at = now()
    and u.created_at < now();
end;
$$;
