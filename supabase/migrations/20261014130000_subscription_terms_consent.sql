-- Subscription terms consent (step 2 of 2): the athlete - not the manager who creates the subscription - must explicitly
-- accept the subscription terms before the subscription's benefits can be used.
--
-- Reuses the existing versioned legal-document / consent infrastructure: the terms are a legal_documents row
-- (consent_type 'subscription_terms', bilingual, versioned with is_current), and an acceptance is a user_consents row
-- (user, full name, version, accepted_at, user agent) protected by the existing one-accepted-row-per-version index.
-- No parallel consent system, no change to billing amounts, prices, charges, coverage history or registrations.
--
-- Rollout safety (nothing changes in production until a manager turns it on):
--   * app_settings.subscription_terms_enforced (default FALSE) is the switch, mirroring legal_consent_gate_enabled. The
--     seeded document is a draft for business/legal approval; while the switch is off nobody is prompted or blocked and
--     acceptance is refused ('not_enabled').
--   * subscriptions.requires_terms_consent is stamped by trigger when a subscription is created (any workflow: create,
--     reactivate, direct insert) = switch on AND payee is an app user (manual participants have no login and cannot
--     consent). Existing subscriptions keep FALSE: they are grandfathered - never blocked - and only prompted to accept.
--     It is immutable afterwards, so it cannot be cleared to skip consent. No consent row is ever fabricated.
--   * Production had 0 live subscriptions when this was written (only tombstoned test lineages).
--
-- While a subscription is awaiting consent (_subscription_awaiting_terms_consent: switch on, requires_terms_consent,
-- payee has no accepted subscription_terms consent of any version):
--   * no subscription benefit: subscription_effective_context treats it as not in window, so reconcile / weekly limits /
--     coverage behave exactly as before the subscription existed;
--   * no accidental charge: subscription_reserve_or_reject raises 'subscription_terms_required' for dates the subscription
--     covers, so neither the athlete nor staff can register that athlete into a covered date as a silently-paid session
--     (every caller rolls back: register_for_session / coach_add_athlete / staff_move_session_participant /
--     manager_revert_activity_event; the cron roster copy skips that one athlete as it already does on any error);
--   * billing is deferred, not altered: the daily job and the immediate first charge in create_subscription /
--     reactivate_subscription skip it. Once the athlete accepts, the unchanged daily job generates every due period exactly
--     as it would have (same engine, same amounts). If the athlete never accepts, nothing is charged; the manager can stop
--     or delete it.
-- Terms updated later: publish a new legal_documents version (is_current flips, version + 1). Accepting any version keeps
-- benefits active; athletes whose latest acceptance is older are shown the new version for review and acceptance
-- ('update_available'), which does not block (owner decision documented in the release report).
--
-- Functions changed by small reviewed text patches (each aborts unless the deployed source is byte-identical to the
-- reviewed one - md5 precondition - and the anchor occurs exactly once): subscription_effective_context,
-- generate_due_subscription_charges, create_subscription, reactivate_subscription,
-- record_user_consent (refuses 'subscription_terms', which must go through accept_subscription_terms so the version is
-- validated server-side). subscription_reserve_or_reject is replaced by its full reviewed definition (same md5 guard).

-- 1. Settings and per-subscription flag --------------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists subscription_terms_enforced boolean not null default false;
comment on column public.app_settings.subscription_terms_enforced is
  'Subscription terms consent switch. FALSE: dormant (no prompt, no blocking). TRUE: subscriptions created from now on for '
  'app users require the athlete''s explicit acceptance before benefits are usable and before billing starts.';

alter table public.subscriptions
  add column if not exists requires_terms_consent boolean not null default false;
comment on column public.subscriptions.requires_terms_consent is
  'Stamped at creation by trigger (enforcement on and payee is an app user). Immutable. FALSE = grandfathered / manual payee.';

create or replace function public._subscriptions_stamp_terms_consent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.requires_terms_consent := (not new.payee_is_manual)
      and coalesce((select s.subscription_terms_enforced from public.app_settings s where s.id = 1), false);
  elsif new.requires_terms_consent is distinct from old.requires_terms_consent then
    raise exception 'requires_terms_consent is immutable';
  end if;
  return new;
end;
$$;
revoke execute on function public._subscriptions_stamp_terms_consent() from public, anon, authenticated;

drop trigger if exists subscriptions_stamp_terms_consent on public.subscriptions;
create trigger subscriptions_stamp_terms_consent
  before insert or update of requires_terms_consent on public.subscriptions
  for each row execute function public._subscriptions_stamp_terms_consent();

-- 2. Status helpers (internal) -----------------------------------------------------------------------------------------
create or replace function public._subscription_awaiting_terms_consent(p_subscription_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select st.subscription_terms_enforced from public.app_settings st where st.id = 1), false)
     and exists (
       select 1 from public.subscriptions s
       where s.id = p_subscription_id
         and s.requires_terms_consent
         and not s.payee_is_manual
         and not exists (
           select 1 from public.user_consents uc
           where uc.user_id = s.payee_id and uc.consent_type = 'subscription_terms' and uc.status = 'accepted'
         )
     );
$$;
revoke execute on function public._subscription_awaiting_terms_consent(uuid) from public, anon, authenticated;

-- Same window predicate as subscription_effective_context, restricted to subscriptions awaiting consent.
create or replace function public._subscription_terms_block(p_payee_id uuid, p_payee_is_manual boolean, p_session_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    join public.subscription_versions v
      on v.subscription_id = s.id
     and v.effective_from <= p_session_date
     and (v.effective_to is null or v.effective_to > p_session_date)
    where s.payee_id = p_payee_id
      and s.payee_is_manual = p_payee_is_manual
      and s.deleted_at is null
      and v.plan_start_date <= p_session_date
      and (v.plan_end_date is null or v.plan_end_date >= p_session_date)
      and (v.stopped_effective_date is null or v.stopped_effective_date > p_session_date)
      and public._subscription_awaiting_terms_consent(s.id)
  );
$$;
revoke execute on function public._subscription_terms_block(uuid, boolean, date) from public, anon, authenticated;

-- Per-subscription consent status for the manager and athlete read models.
--   not_required   manual payee, or nothing to show (switch off and no acceptance on record)
--   pending        awaiting consent: benefits and billing on hold (blocking)
--   legacy_pending created before enforcement (grandfathered): asked to accept, not blocked
--   update_available accepted an older version; the current version is shown for acceptance, not blocked
--   accepted       accepted the current version
create or replace function public._subscription_terms_status(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_enforced boolean;
  v_current int;
  v_latest_version int;
  v_latest_at timestamptz;
  v_status text;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then return null; end if;
  select coalesce(st.subscription_terms_enforced, false) into v_enforced from public.app_settings st where st.id = 1;
  v_enforced := coalesce(v_enforced, false);
  select ld.version into v_current from public.legal_documents ld where ld.consent_type = 'subscription_terms' and ld.is_current limit 1;

  if not v_sub.payee_is_manual then
    select uc.consent_version, uc.accepted_at into v_latest_version, v_latest_at
    from public.user_consents uc
    where uc.user_id = v_sub.payee_id and uc.consent_type = 'subscription_terms' and uc.status = 'accepted'
    order by uc.consent_version desc, uc.accepted_at desc
    limit 1;
  end if;

  if v_sub.payee_is_manual then
    v_status := 'not_required';
  elsif v_latest_version is not null then
    v_status := case when v_current is null or v_latest_version >= v_current then 'accepted'
                     when v_enforced then 'update_available' else 'accepted' end;
  elsif not v_enforced then
    v_status := 'not_required';
  elsif v_sub.requires_terms_consent then
    v_status := 'pending';
  else
    v_status := 'legacy_pending';
  end if;

  return jsonb_build_object(
    'status', v_status,
    'blocking', v_status = 'pending',
    'enforced', v_enforced,
    'requires_terms_consent', v_sub.requires_terms_consent,
    'current_version', v_current,
    'accepted_version', v_latest_version,
    'accepted_at', v_latest_at
  );
end;
$$;
revoke execute on function public._subscription_terms_status(uuid) from public, anon, authenticated;

-- 3. Engine patches ----------------------------------------------------------------------------------------------------
do $$
declare
  r record;
  v_src text;
begin
  for r in
    select * from (values
      ('public.subscription_effective_context(uuid,boolean,date,public.subscription_tier)', '4cba21ba5d92456eca51e6383364d2f0',
       E'    and s.deleted_at is null\n    and v.plan_start_date <= p_session_date\n',
       E'    and s.deleted_at is null\n    and not public._subscription_awaiting_terms_consent(s.id)\n    and v.plan_start_date <= p_session_date\n'),
      ('public.generate_due_subscription_charges()', 'cec6498d4157506027722e6613f04422',
       E'    where s.deleted_at is null\n      and v.plan_start_date <= v_today\n',
       E'    where s.deleted_at is null\n      and not public._subscription_awaiting_terms_consent(s.id)\n      and v.plan_start_date <= v_today\n'),
      ('public.create_subscription(uuid,boolean,numeric,date,date,smallint,jsonb)', 'b45519dffabcff9fc5c5fa36f848c5f8',
       E'  if p_start_date <= public._studio_today_date() then\n',
       E'  -- Awaiting the athlete''s terms consent: billing starts (via the daily job) once accepted.\n'
       || E'  if p_start_date <= public._studio_today_date() and not public._subscription_awaiting_terms_consent(v_subscription_id) then\n'),
      ('public.reactivate_subscription(uuid,date,date)', 'f7fefcb14759412835b8c7dacd047ae0',
       E'  if p_start_date <= public._studio_today_date() then\n',
       E'  -- Awaiting the athlete''s terms consent: billing starts (via the daily job) once accepted.\n'
       || E'  if p_start_date <= public._studio_today_date() and not public._subscription_awaiting_terms_consent(v_new_sub_id) then\n'),
      ('public.record_user_consent(public.legal_consent_type,public.consent_status,integer,text,text)', 'dec86dbdb62230573ddbcf3ba2fee92d',
       E'  if v_uid is null then\n    return json_build_object(''ok'', false, ''error'', ''not_authenticated'');\n  end if;\n',
       E'  if v_uid is null then\n    return json_build_object(''ok'', false, ''error'', ''not_authenticated'');\n  end if;\n\n'
       || E'  -- Subscription terms are accepted only through accept_subscription_terms (server-side version validation).\n'
       || E'  if p_consent_type = ''subscription_terms'' then\n'
       || E'    return json_build_object(''ok'', false, ''error'', ''use_accept_subscription_terms'');\n'
       || E'  end if;\n')
    ) v(sig, src_md5, old_text, new_text)
  loop
    select prosrc into v_src from pg_proc where oid = r.sig::regprocedure;
    if md5(v_src) <> r.src_md5 then
      raise exception 'precondition: % differs from the reviewed version; refusing to change it', r.sig;
    end if;
    if (length(v_src) - length(replace(v_src, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'precondition: patch anchor must occur exactly once in %', r.sig;
    end if;
    -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
    execute replace(pg_get_functiondef(r.sig::regprocedure), r.old_text, r.new_text);
  end loop;
end $$;

-- subscription_reserve_or_reject: full reviewed definition (not a text patch) so the new RAISE token is visible to the
-- RPC-outcome registry extractor (mobile/src/lib/rpcOutcomes). Identical to the deployed body plus the one consent block.
do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.subscription_reserve_or_reject(uuid,boolean,uuid,boolean)'::regprocedure)
     <> 'c60fe4c1cacb22c9856e6e25ab86785a' then
    raise exception 'precondition: subscription_reserve_or_reject differs from the reviewed version; refusing to replace it';
  end if;
end $$;

create or replace function public.subscription_reserve_or_reject(p_payee_id uuid, p_payee_is_manual boolean, p_session_id uuid, p_accept_extra boolean DEFAULT false)
 RETURNS public.subscription_reserve_decision
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sess public.training_sessions%rowtype;
  v_tier public.subscription_tier;
  v_week_start date;
  v_ctx public.subscription_effective_context_result;
  v_lock_key bigint;
  v_covered_count int;
  v_effective_limit int;
  v_result public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    raise exception 'session_not_found';
  end if;

  v_tier := public.subscription_tier_for_capacity(v_sess.max_participants);
  v_week_start := v_sess.session_date - extract(dow from v_sess.session_date)::int;

  -- A subscription awaiting the athlete's terms consent covers nothing and must not turn into a silently paid
  -- session either: refuse registrations on the dates it covers until the athlete accepts.
  if public._subscription_terms_block(p_payee_id, p_payee_is_manual, v_sess.session_date) then
    raise exception 'subscription_terms_required'
      using errcode = 'P0001', hint = 'The athlete must accept the subscription terms in the app first.';
  end if;

  v_lock_key := public.subscription_lock_key(p_payee_id, p_payee_is_manual, v_week_start, v_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, v_sess.session_date, v_tier);

  v_result.tier := v_tier;
  v_result.week_start := v_week_start;

  if v_ctx.subscription_id is null or not v_ctx.in_window then
    v_result.outcome := 'not_subscribed';
    v_result.ok := true;
    v_result.subscription_id := null;
    v_result.version_id := null;
    v_result.covered := null;
    v_result.non_coverage_reason := null;
    return v_result;
  end if;

  v_result.subscription_id := v_ctx.subscription_id;
  v_result.version_id := v_ctx.version_id;

  if v_ctx.is_frozen then
    -- Session-date freeze eligibility is unchanged: a session ON a frozen date is never covered,
    -- regardless of the week's effective allowance.
    v_result.outcome := 'frozen';
    v_result.non_coverage_reason := 'frozen';
  elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
    v_result.outcome := 'tier_not_included';
    v_result.non_coverage_reason := 'tier_not_included';
  else
    v_effective_limit := public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, v_tier, v_week_start);

    select count(*) into v_covered_count
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    where cov.subscription_id = v_ctx.subscription_id
      and cov.tier = v_tier
      and cov.week_start = v_week_start
      and cov.covered = true
      and (
        cov.manual_participant_id is not null
        or reg.status = 'active'
        or exists (
          select 1 from public.cancellations c
          where c.session_id = reg.session_id
            and c.user_id = reg.user_id
            and c.charged_full_price is true
        )
      );

    if v_covered_count < v_effective_limit then
      v_result.outcome := 'covered';
      v_result.non_coverage_reason := null;
    else
      v_result.outcome := 'allowance_exceeded';
      v_result.non_coverage_reason := 'allowance_exceeded';
    end if;
  end if;

  if v_result.outcome = 'covered' then
    v_result.covered := true;
    v_result.ok := true;
  else
    v_result.covered := false;
    v_result.ok := coalesce(p_accept_extra, false);
  end if;

  return v_result;
end;
$function$;

-- 4. Client RPCs -------------------------------------------------------------------------------------------------------

-- Athlete: the terms status of my subscription, plus the current document when it is shown to me.
create or replace function public.get_my_subscription_terms()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sub_id uuid;
  v_status jsonb;
  v_doc public.legal_documents%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select s.id into v_sub_id
  from public.subscriptions s
  where s.payee_id = v_uid and s.payee_is_manual = false and s.deleted_at is null
  order by s.created_at desc
  limit 1;
  if v_sub_id is null then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  v_status := public._subscription_terms_status(v_sub_id);
  if v_status->>'status' in ('pending', 'legacy_pending', 'update_available') then
    select * into v_doc from public.legal_documents where consent_type = 'subscription_terms' and is_current limit 1;
  end if;

  return json_build_object(
    'ok', true,
    'has_subscription', true,
    'status', v_status->>'status',
    'blocking', (v_status->>'blocking')::boolean,
    'accepted_version', (v_status->>'accepted_version')::int,
    'accepted_at', v_status->>'accepted_at',
    'document', case when v_doc.id is null then null else json_build_object(
      'version', v_doc.version, 'title', v_doc.title, 'title_en', v_doc.title_en,
      'body_text', v_doc.body_text, 'body_text_en', v_doc.body_text_en, 'effective_at', v_doc.effective_at
    ) end
  );
end;
$$;
revoke execute on function public.get_my_subscription_terms() from public, anon;
grant execute on function public.get_my_subscription_terms() to authenticated;

-- Athlete: explicit acceptance of the CURRENT subscription terms version. The only path that records a
-- subscription_terms consent; the caller is always the athlete themself (auth.uid()), never a manager on their behalf.
create or replace function public.accept_subscription_terms(p_version integer, p_user_agent text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.legal_documents%rowtype;
  v_sub_id uuid;
  v_full_name text;
  v_id uuid;
  v_was_blocking boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not coalesce((select st.subscription_terms_enforced from public.app_settings st where st.id = 1), false) then
    return json_build_object('ok', false, 'error', 'not_enabled');
  end if;

  select * into v_doc from public.legal_documents where consent_type = 'subscription_terms' and is_current limit 1;
  if v_doc.id is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_version is null or p_version <> v_doc.version then
    return json_build_object('ok', false, 'error', 'version_mismatch', 'current_version', v_doc.version);
  end if;

  select s.id into v_sub_id
  from public.subscriptions s
  where s.payee_id = v_uid and s.payee_is_manual = false and s.deleted_at is null
  order by s.created_at desc
  limit 1;
  if v_sub_id is null then
    return json_build_object('ok', false, 'error', 'no_subscription');
  end if;

  v_was_blocking := public._subscription_awaiting_terms_consent(v_sub_id);
  select nullif(trim(p.full_name), '') into v_full_name from public.profiles p where p.user_id = v_uid;

  insert into public.user_consents (user_id, full_name, consent_type, consent_version, status, user_agent)
  values (v_uid, v_full_name, 'subscription_terms', v_doc.version, 'accepted', left(p_user_agent, 500))
  on conflict (user_id, consent_type, consent_version) where (status = 'accepted') do nothing
  returning id into v_id;

  if v_id is null then
    return json_build_object('ok', true, 'already_recorded', true, 'version', v_doc.version);
  end if;

  perform public._insert_activity_event(
    v_uid, 'subscription_terms_accepted', 'subscription', v_sub_id::text,
    jsonb_build_object('version', v_doc.version, 'released_hold', v_was_blocking)
  );

  return json_build_object('ok', true, 'version', v_doc.version, 'released_hold', v_was_blocking);
end;
$$;
revoke execute on function public.accept_subscription_terms(integer, text) from public, anon;
grant execute on function public.accept_subscription_terms(integer, text) to authenticated;

-- Manager: terms status for a set of subscriptions (list / detail screens).
create or replace function public.get_subscription_terms_status(p_subscription_ids uuid[])
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  return json_build_object('ok', true, 'items', coalesce((
    select json_agg(jsonb_build_object('subscription_id', s.id) || public._subscription_terms_status(s.id))
    from public.subscriptions s
    where s.id = any(coalesce(p_subscription_ids, '{}'::uuid[]))
  ), '[]'::json));
end;
$$;
revoke execute on function public.get_subscription_terms_status(uuid[]) from public, anon;
grant execute on function public.get_subscription_terms_status(uuid[]) to authenticated;

-- Manager: settings card (switch, current document, counts).
create or replace function public.get_subscription_terms_settings()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_doc public.legal_documents%rowtype;
  v_enforced boolean;
  v_counts json;
begin
  if auth.uid() is null or not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select coalesce(st.subscription_terms_enforced, false) into v_enforced from public.app_settings st where st.id = 1;
  select * into v_doc from public.legal_documents where consent_type = 'subscription_terms' and is_current limit 1;
  select json_object_agg(x.status, x.n) into v_counts
  from (
    select public._subscription_terms_status(s.id)->>'status' as status, count(*) as n
    from public.subscriptions s
    where s.deleted_at is null
    group by 1
  ) x;
  return json_build_object(
    'ok', true,
    'enforced', coalesce(v_enforced, false),
    'document', case when v_doc.id is null then null else json_build_object(
      'version', v_doc.version, 'title', v_doc.title, 'title_en', v_doc.title_en,
      'body_text', v_doc.body_text, 'body_text_en', v_doc.body_text_en, 'effective_at', v_doc.effective_at
    ) end,
    'counts', coalesce(v_counts, '{}'::json)
  );
end;
$$;
revoke execute on function public.get_subscription_terms_settings() from public, anon;
grant execute on function public.get_subscription_terms_settings() to authenticated;

-- Manager: turn enforcement on/off (on = only after business/legal approval of the current document).
create or replace function public.set_subscription_terms_enforced(p_enabled boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_enabled is null then
    return json_build_object('ok', false, 'error', 'invalid_value');
  end if;
  if p_enabled and not exists (select 1 from public.legal_documents where consent_type = 'subscription_terms' and is_current) then
    return json_build_object('ok', false, 'error', 'no_document');
  end if;
  update public.app_settings set subscription_terms_enforced = p_enabled, updated_at = now() where id = 1;
  perform public._insert_activity_event(
    v_uid, 'subscription_terms_enforcement_changed', 'app_settings', '1', jsonb_build_object('enabled', p_enabled)
  );
  return json_build_object('ok', true, 'enforced', p_enabled);
end;
$$;
revoke execute on function public.set_subscription_terms_enforced(boolean) from public, anon;
grant execute on function public.set_subscription_terms_enforced(boolean) to authenticated;

-- 5. Document v1 (draft for business/legal approval) --------------------------------------------------------------------
-- Canonical Hebrew draft supplied by the studio owner, aligned with the production rules where it conflicted (see the
-- release report): clause 4 uses the actual late-cancellation cutoff (12 hours, cancel_registration), clause 5 describes
-- the actual extra-session confirmation, clause 7 states the implemented freeze effects instead of an internal drafting
-- note. English is a faithful translation of the final Hebrew.
insert into public.legal_documents (consent_type, version, title, title_en, body_text, body_text_en, is_current)
select 'subscription_terms', 1, 'תקנון מנויים — Shira Fit', 'Subscription Terms — Shira Fit',
$he$1. כללי
מנוי Shira Fit מאפשר למתאמן להשתתף באימונים בהתאם לסוג המנוי, מכסת האימונים השבועית, תקופת המנוי ותנאי התשלום שנקבעו עבורו.
רכישת מנוי או הפעלתו כפופות לתנאים המפורטים בתקנון זה ולתנאים האישיים המוצגים למתאמן.

2. מכסת אימונים שבועית
כל מנוי כולל מספר אימונים שבועי מוגדר, בהתאם למסלול שנבחר.
שבוע אימונים מתחיל ביום ראשון ומסתיים ביום שבת.
מכסת האימונים מתחדשת בכל שבוע ואינה נצברת או מועברת לשבועות הבאים.
אימונים שלא נוצלו במהלך השבוע אינם מזכים בהחזר כספי, בצבירת אימונים או בהארכת תקופת המנוי, אלא אם הוסכם אחרת במפורש עם הנהלת הסטודיו.

3. הרשמה לאימונים
ההשתתפות באימונים מותנית בהרשמה מראש באמצעות האפליקציה ובכפוף לזמינות המקומות.
המנוי אינו מבטיח מקום באימון מסוים.
כאשר אימון מלא, ניתן להצטרף לרשימת המתנה בהתאם למנגנון הקיים באפליקציה.

4. ביטול הרשמה ואי־הגעה
ניתן לבטל הרשמה לאימון בהתאם למדיניות הביטולים של הסטודיו.
ביטול המתבצע יותר מ־12 שעות לפני תחילת האימון נחשב לביטול בזמן, בכפוף לכללים החלים על האימון.
ביטול מאוחר, המתבצע 12 שעות או פחות לפני תחילת האימון, עשוי להיחשב כאימון שנוצל מתוך המכסה השבועית.
אי־הגעה לאימון ללא ביטול בזמן עשויה להיחשב כאימון שנוצל.
במקרים חריגים רשאית הנהלת הסטודיו לאשר התאמות בהתאם לנסיבות ולמדיניות הנהוגה.

5. אימונים מעבר למכסה
הרשמה לאימונים מעבר למכסה השבועית הכלולה במנוי עשויה לגרור חיוב נוסף, בהתאם למחירון ולתנאים שנקבעו למתאמן.
לפני הרשמה הכרוכה בתשלום נוסף תוצג למתאמן הודעה ברורה שהאימון אינו מכוסה במנוי ויחויב כאימון רגיל, וההרשמה תתבצע רק לאחר אישורו.

6. תקופת המנוי וחיוב
המנוי תקף בהתאם לתאריך ההתחלה ותאריך הסיום שנקבעו עבורו, ככל שנקבע תאריך סיום.
החיוב מתבצע בהתאם למחיר, למחזור החיוב ולתנאי התשלום שהוגדרו במנוי.
מנוי ללא תאריך סיום מוגדר אינו בהכרח מנוי ששולם מראש לתקופה בלתי מוגבלת.
המשך החיוב, חידוש המנוי וסיום ההתקשרות כפופים לתנאי המסלול שנבחר ולהוראות הדין.

7. הקפאת מנוי
הקפאת מנוי תתאפשר בהתאם למדיניות הסטודיו ובכפוף לאישור הנהלת הסטודיו כאשר אישור כזה נדרש.
במהלך תקופת הקפאה מאושרת, זכאות האימונים והחיובים יטופלו בהתאם לתנאי ההקפאה שנקבעו ולמנגנון המנויים של הסטודיו.
אימונים במועדים המוקפאים אינם נכללים במנוי, מועד החיוב הבא ותאריך סיום המנוי נדחים במספר ימי ההקפאה, ומכסת האימונים השבועית מותאמת באופן יחסי לימים שאינם מוקפאים.

8. הפסקת מנוי
בקשה להפסקת מנוי תטופל בהתאם לתנאי המנוי, למדיניות הביטול ולהוראות הדין החל.
מועד סיום הזכאות לאימונים ומועד סיום החיובים ייקבעו בהתאם לתנאים החלים על המנוי.
אין בתקנון זה כדי לגרוע מזכויות ביטול המוקנות למתאמן על פי דין.

9. שינויים במערכת האימונים
הסטודיו רשאי לבצע שינויים בלוח האימונים, במאמנים ובמועדי הפעילות בהתאם לצרכים תפעוליים.
במקרה של ביטול אימון ביוזמת הסטודיו, הטיפול בזכאות המתאמן ייעשה בהתאם למדיניות הסטודיו ולהוראות הדין.

10. אחריות המתאמן
על המתאמן להירשם לאימונים באופן מסודר, לעמוד בכללי הסטודיו ולעדכן את הנהלת הסטודיו כאשר נדרש שינוי במנוי או בתנאי ההשתתפות.
ההשתתפות באימונים כפופה גם לתקנון הכללי ולהצהרת הבריאות הנדרשת.

11. עדכון התנאים
הסטודיו רשאי לעדכן את תנאי המנויים בכפוף להוראות הדין.
כאשר נדרש אישור מחודש לתנאים מעודכנים, תוצג למתאמן הגרסה החדשה לצורך עיון ואישור.

12. אישור והסכמה
אני מאשר/ת שקראתי והבנתי את תקנון המנויים של Shira Fit, לרבות תנאי מכסת האימונים, ההרשמה, הביטולים, החיובים, ההקפאות והפסקת המנוי, ואני מסכים/ה לתנאים החלים על המנוי שלי.$he$,
$en$1. General
A Shira Fit subscription allows the athlete to take part in training sessions according to the subscription type, the weekly session quota, the subscription period and the payment terms set for it.
Purchasing or activating a subscription is subject to the terms set out in these terms and to the personal terms shown to the athlete.

2. Weekly session quota
Each subscription includes a set number of sessions per week, according to the selected plan.
A training week starts on Sunday and ends on Saturday.
The session quota renews every week; it does not accumulate and is not carried over to the following weeks.
Sessions not used during the week do not entitle the athlete to a refund, to accumulated sessions or to an extension of the subscription period, unless explicitly agreed otherwise with the studio management.

3. Registering for sessions
Participation in sessions requires advance registration through the app and is subject to availability.
The subscription does not guarantee a place in any particular session.
When a session is full, the athlete may join the waitlist according to the mechanism available in the app.

4. Cancellation and no-shows
A registration may be cancelled in accordance with the studio's cancellation policy.
A cancellation made more than 12 hours before the session starts is an on-time cancellation, subject to the rules that apply to the session.
A late cancellation, made 12 hours or less before the session starts, may be counted as a session used from the weekly quota.
Not attending a session without cancelling on time may be counted as a session used.
In exceptional cases the studio management may approve adjustments according to the circumstances and its usual policy.

5. Sessions beyond the quota
Registering for sessions beyond the weekly quota included in the subscription may incur an additional charge, according to the price list and the terms set for the athlete.
Before a registration that involves an additional payment, the athlete is shown a clear notice that the session is not covered by the subscription and will be charged as a regular session, and the registration is made only after the athlete confirms.

6. Subscription period and billing
The subscription is valid according to the start date and, if one was set, the end date set for it.
Billing follows the price, the billing cycle and the payment terms defined in the subscription.
A subscription without a set end date is not necessarily a subscription paid in advance for an unlimited period.
Continued billing, renewal of the subscription and ending the engagement are subject to the terms of the selected plan and to the law.

7. Freezing a subscription
A subscription may be frozen according to the studio's policy and subject to the studio management's approval where such approval is required.
During an approved freeze period, session entitlement and charges are handled according to the freeze terms set and the studio's subscription mechanism.
Sessions on frozen dates are not covered by the subscription, the next billing date and the subscription end date are postponed by the number of frozen days, and the weekly session quota is adjusted in proportion to the days that are not frozen.

8. Stopping a subscription
A request to stop a subscription is handled according to the subscription terms, the cancellation policy and the applicable law.
The date on which session entitlement ends and the date on which charges end are determined according to the terms that apply to the subscription.
Nothing in these terms derogates from the cancellation rights granted to the athlete by law.

9. Changes to the training schedule
The studio may change the training schedule, the coaches and the activity times according to operational needs.
If a session is cancelled by the studio, the athlete's entitlement is handled according to the studio's policy and the law.

10. The athlete's responsibilities
The athlete must register for sessions properly, follow the studio's rules and inform the studio management when a change to the subscription or to the terms of participation is needed.
Participation in sessions is also subject to the general terms of use and to the required health declaration.

11. Updates to these terms
The studio may update the subscription terms, subject to the law.
When renewed acceptance of updated terms is required, the new version will be shown to the athlete for review and acceptance.

12. Confirmation and consent
I confirm that I have read and understood the Shira Fit subscription terms, including the terms on the session quota, registration, cancellations, billing, freezes and stopping the subscription, and I agree to the terms that apply to my subscription.$en$,
  true
where not exists (select 1 from public.legal_documents where consent_type = 'subscription_terms');

-- Self-check -----------------------------------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if coalesce((select subscription_terms_enforced from public.app_settings where id = 1), false) then
    raise exception 'self-check: enforcement must ship disabled';
  end if;
  if exists (select 1 from public.subscriptions where requires_terms_consent) then
    raise exception 'self-check: existing subscriptions must be grandfathered';
  end if;
  if (select count(*) from public.legal_documents where consent_type = 'subscription_terms' and is_current) <> 1 then
    raise exception 'self-check: exactly one current subscription_terms document expected';
  end if;
  if exists (select 1 from public.user_consents where consent_type = 'subscription_terms') then
    raise exception 'self-check: no subscription_terms consent may exist yet (never fabricated)';
  end if;
  foreach v_fn in array array[
    'public._subscriptions_stamp_terms_consent()', 'public._subscription_awaiting_terms_consent(uuid)',
    'public._subscription_terms_block(uuid,boolean,date)', 'public._subscription_terms_status(uuid)'
  ] loop
    if has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') or has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: internal % is client-executable', v_fn;
    end if;
  end loop;
  foreach v_fn in array array[
    'public.get_my_subscription_terms()', 'public.accept_subscription_terms(integer,text)',
    'public.get_subscription_terms_status(uuid[])', 'public.get_subscription_terms_settings()',
    'public.set_subscription_terms_enforced(boolean)'
  ] loop
    if has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') or not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: client RPC % has wrong EXECUTE privileges', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_proc where oid = 'public.subscription_reserve_or_reject(uuid,boolean,uuid,boolean)'::regprocedure and prosrc like '%subscription_terms_required%')
     or not exists (select 1 from pg_proc where oid = 'public.generate_due_subscription_charges()'::regprocedure and prosrc like '%_subscription_awaiting_terms_consent%') then
    raise exception 'self-check: engine patches missing';
  end if;
end $$;
