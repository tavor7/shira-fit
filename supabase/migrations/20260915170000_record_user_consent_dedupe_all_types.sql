-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 4 static review fix).
--
-- Bug found on re-review: user_consents_one_accepted_per_version_idx (added in
-- 20260630430000_user_consents_dedupe_unique.sql) is a unique index on
-- (user_id, consent_type, consent_version) where status = 'accepted', across ALL consent
-- types. record_user_consent only pre-checked/short-circuited this for
-- 'electronic_receipts' before inserting — every other consent_type had no guard, so a
-- second "accepted" insert for the same (user, type, version) would raise an unhandled
-- unique_violation instead of returning a graceful {ok:false}.
--
-- A second, subtler bug was found while tracing the marketing-consent test matrix
-- (opt-in -> opt-out -> opt-in-again, same published version each time): a naive
-- "does an accepted row already exist" guard would silently no-op the second opt-in,
-- leaving the earlier opt-out's decline row as the most recent one — so
-- has_current_marketing_consent (which reads the MOST RECENT row, see
-- 20260915190000) would keep reporting the user as opted out even after they
-- explicitly opted back in. The unique index forbids inserting a second 'accepted' row
-- for the same version, so re-opting-in must REAFFIRM the existing accepted row
-- (bump its accepted_at) rather than either inserting (blocked by the index) or silently
-- doing nothing (loses the recency signal).
--
-- Net behavior:
--   * No prior row for (user, type, version)              -> normal insert.
--   * Most recent prior row for that version is 'accepted' -> true duplicate/redundant
--     resubmit (e.g. a double-tap): no-op, original accepted_at is preserved as the
--     evidentiary "first accepted" anchor — this matters for Terms/Privacy/receipts,
--     which are not exposed as re-toggleable in the UI.
--   * Most recent prior row for that version is 'declined' -> genuine re-opt-in: reaffirm
--     the existing accepted row's timestamp so recency-based checks see it as current
--     again, without violating the unique index.

create or replace function public.record_user_consent(
  p_consent_type public.legal_consent_type,
  p_status public.consent_status,
  p_consent_version int,
  p_ip_address text default null,
  p_user_agent text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_full_name text;
  v_latest_status public.consent_status;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select nullif(trim(p.full_name), '') into v_full_name
  from public.profiles p
  where p.user_id = v_uid;

  if p_status = 'accepted' then
    select uc.status into v_latest_status
    from public.user_consents uc
    where uc.user_id = v_uid
      and uc.consent_type = p_consent_type
      and uc.consent_version = p_consent_version
    order by uc.accepted_at desc, uc.created_at desc
    limit 1;

    if v_latest_status = 'accepted' then
      if p_consent_type = 'electronic_receipts' then
        update public.profiles
        set
          electronic_receipts_consent_version = p_consent_version,
          electronic_receipts_consented_at = coalesce(electronic_receipts_consented_at, now())
        where user_id = v_uid;
      end if;
      return json_build_object('ok', true, 'already_recorded', true);
    elsif v_latest_status = 'declined' then
      update public.user_consents
      set
        accepted_at = now(),
        ip_address = coalesce(p_ip_address, ip_address),
        user_agent = coalesce(p_user_agent, user_agent)
      where user_id = v_uid
        and consent_type = p_consent_type
        and consent_version = p_consent_version
        and status = 'accepted';

      if p_consent_type = 'electronic_receipts' then
        update public.profiles
        set
          electronic_receipts_consent_version = p_consent_version,
          electronic_receipts_consented_at = coalesce(electronic_receipts_consented_at, now())
        where user_id = v_uid;
      end if;
      return json_build_object('ok', true, 're_affirmed', true);
    end if;
    -- v_latest_status is null: no prior row at all for this version — fall through to insert.
  end if;

  insert into public.user_consents (
    user_id,
    full_name,
    consent_type,
    consent_version,
    status,
    ip_address,
    user_agent
  )
  values (
    v_uid,
    v_full_name,
    p_consent_type,
    p_consent_version,
    p_status,
    p_ip_address,
    p_user_agent
  );

  if p_consent_type = 'electronic_receipts' and p_status = 'accepted' then
    update public.profiles
    set
      electronic_receipts_consent_version = p_consent_version,
      electronic_receipts_consented_at = now()
    where user_id = v_uid;
    perform public._log_document_event(
      null,
      'consent_accepted',
      jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version)
    );
  elsif p_consent_type = 'electronic_receipts' and p_status = 'declined' then
    perform public._log_document_event(
      null,
      'consent_declined',
      jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version)
    );
  end if;

  return json_build_object('ok', true);
end;
$$;
