-- Subscription terms consent (step 2 of 2): the athlete - never the manager who creates a subscription - explicitly
-- accepts the subscription terms. Acceptance controls ACCESS TO THE APP; it never affects the subscription's financial
-- lifecycle (billing starts on the configured start date and coverage works exactly as before - no billing or coverage
-- function is changed here).
--
-- Reuses the existing versioned legal-document / consent infrastructure: the terms are a legal_documents row
-- (consent_type 'subscription_terms', bilingual, versioned with is_current) and an acceptance is a user_consents row
-- (user, full name, version, accepted_at, user agent), one per (athlete, version) by the existing
-- user_consents_one_accepted_per_version_idx. No parallel consent system.
--
-- Rules (all server-side):
--   * Consent belongs to the ATHLETE and the DOCUMENT VERSION, not to a subscription: an athlete who accepted version N
--     is never asked again for N, whatever subscriptions come and go.
--   * Required version = the newest subscription_terms version published with requires_reconsent = true, else the first
--     version. A later version WITHOUT that flag does not ask anyone to accept again; publish it with the flag set when
--     renewed acceptance is needed.
--   * An athlete must accept (status 'pending') when: enforcement is on (app_settings.subscription_terms_enforced), they
--     have at least one applicable subscription (not tombstoned, current version not 'stopped'/'completed' - so active,
--     frozen and future-dated ones count; stopped, expired and deleted ones do not), and they have not accepted a version
--     >= the required version. Cancelling (stopping/deleting) their only applicable subscription therefore lifts the
--     requirement even if they never accepted; history and billing records are untouched.
--   * Manual participants (no login) never need to accept.
--   * While 'pending' the app shows a mandatory, non-dismissible terms screen, and the athlete's own registrations are
--     refused server-side ('subscription_terms_required') so the screen cannot be bypassed through the API. Staff actions,
--     cron jobs, coverage and billing are not affected. The screen being unclosable is never treated as consent: only
--     accept_subscription_terms, called by the athlete themself, records it.
--
-- Rollout safety: app_settings.subscription_terms_enforced ships FALSE (mirrors legal_consent_gate_enabled). The seeded
-- document is a draft for business/legal approval; while the switch is off nobody is asked and acceptance is refused.
-- No consent row is ever created by this migration. When the switch is turned on, every athlete with an applicable
-- subscription is asked once.
--
-- Function changes to existing code: record_user_consent refuses 'subscription_terms' (must go through
-- accept_subscription_terms, which validates the version server-side) - a reviewed text patch with an md5 precondition;
-- subscription_reserve_or_reject is replaced by its full reviewed definition (md5 precondition) with the one
-- self-registration guard above.

-- 1. Settings ----------------------------------------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists subscription_terms_enforced boolean not null default false;
comment on column public.app_settings.subscription_terms_enforced is
  'Subscription terms switch. FALSE: dormant (nobody is asked). TRUE: athletes with an applicable subscription must '
  'accept the required subscription_terms version (mandatory screen). Never affects billing or coverage.';

alter table public.legal_documents
  add column if not exists requires_reconsent boolean not null default false;
comment on column public.legal_documents.requires_reconsent is
  'subscription_terms: TRUE when this version requires athletes who accepted an earlier version to accept again.';

-- 2. Status helpers (internal) -----------------------------------------------------------------------------------------
-- Athlete-level subscription-terms status:
--   accepted     has an accepted consent for a version >= the required version (acceptance version/date returned)
--   pending      must accept: enforcement on + an applicable subscription + no sufficient acceptance
--   not_required otherwise (no applicable subscription, switch off, or no document)
create or replace function public._subscription_terms_status_for_user(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_enforced boolean;
  v_current int;
  v_required int;
  v_ok_version int;
  v_ok_at timestamptz;
  v_latest_version int;
  v_latest_at timestamptz;
  v_applicable boolean;
  v_status text;
begin
  select coalesce(st.subscription_terms_enforced, false) into v_enforced from public.app_settings st where st.id = 1;
  v_enforced := coalesce(v_enforced, false);
  select max(ld.version) filter (where ld.is_current),
         coalesce(max(ld.version) filter (where ld.requires_reconsent), min(ld.version))
  into v_current, v_required
  from public.legal_documents ld
  where ld.consent_type = 'subscription_terms';

  select uc.consent_version, uc.accepted_at into v_latest_version, v_latest_at
  from public.user_consents uc
  where uc.user_id = p_user_id and uc.consent_type = 'subscription_terms' and uc.status = 'accepted'
  order by uc.consent_version desc, uc.accepted_at desc
  limit 1;

  v_applicable := exists (
    select 1
    from public.subscriptions s
    join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
    where s.payee_id = p_user_id
      and s.payee_is_manual = false
      and s.deleted_at is null
      and public.subscription_version_display_status(v.id, public._studio_today_date()) not in ('stopped', 'completed')
  );

  if v_required is not null and v_latest_version is not null and v_latest_version >= v_required then
    v_status := 'accepted';
    v_ok_version := v_latest_version;
    v_ok_at := v_latest_at;
  elsif v_enforced and v_required is not null and v_applicable then
    v_status := 'pending';
  else
    v_status := 'not_required';
  end if;

  return jsonb_build_object(
    'status', v_status,
    'enforced', v_enforced,
    'has_applicable_subscription', v_applicable,
    'current_version', v_current,
    'required_version', v_required,
    'accepted_version', v_ok_version,
    'accepted_at', v_ok_at,
    'latest_accepted_version', v_latest_version
  );
end;
$$;
revoke execute on function public._subscription_terms_status_for_user(uuid) from public, anon, authenticated;

create or replace function public._subscription_terms_required_for_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select st.subscription_terms_enforced from public.app_settings st where st.id = 1), false)
     and public._subscription_terms_status_for_user(p_user_id)->>'status' = 'pending';
$$;
revoke execute on function public._subscription_terms_required_for_user(uuid) from public, anon, authenticated;

-- 3. Existing functions ------------------------------------------------------------------------------------------------
do $$
declare
  v_fn regprocedure := 'public.record_user_consent(public.legal_consent_type,public.consent_status,integer,text,text)'::regprocedure;
  v_old text := E'  if v_uid is null then\n    return json_build_object(''ok'', false, ''error'', ''not_authenticated'');\n  end if;\n';
  v_new text := v_old
    || E'\n  -- Subscription terms are accepted only through accept_subscription_terms (server-side version validation).\n'
    || E'  if p_consent_type = ''subscription_terms'' then\n'
    || E'    return json_build_object(''ok'', false, ''error'', ''use_accept_subscription_terms'');\n'
    || E'  end if;\n';
  v_src text;
begin
  select prosrc into v_src from pg_proc where oid = v_fn;
  if md5(v_src) <> 'dec86dbdb62230573ddbcf3ba2fee92d' then
    raise exception 'precondition: record_user_consent differs from the reviewed version; refusing to change it';
  end if;
  if (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'precondition: patch anchor must occur exactly once in record_user_consent';
  end if;
  -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
  execute replace(pg_get_functiondef(v_fn), v_old, v_new);
end $$;

-- subscription_reserve_or_reject: full reviewed definition (not a text patch) so the new RAISE token is visible to the
-- RPC-outcome registry extractor (mobile/src/lib/rpcOutcomes). Identical to the deployed body plus the one guard.
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

  -- Server side of the mandatory subscription-terms screen: an athlete who must accept the terms cannot register
  -- THEMSELVES (bypassing the screen through the API). Staff additions, cron roster copies, coverage and billing are
  -- unaffected - terms acceptance controls app access, never the subscription's financial lifecycle.
  if not p_payee_is_manual and auth.uid() is not null and auth.uid() = p_payee_id
     and public._subscription_terms_required_for_user(p_payee_id) then
    raise exception 'subscription_terms_required'
      using errcode = 'P0001', hint = 'Accept the subscription terms in the app first.';
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

-- Athlete: my subscription-terms status, plus the current document when I must accept it (mandatory screen).
create or replace function public.get_my_subscription_terms()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status jsonb;
  v_doc public.legal_documents%rowtype;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  v_status := public._subscription_terms_status_for_user(v_uid);
  if v_status->>'status' = 'pending' then
    select * into v_doc from public.legal_documents where consent_type = 'subscription_terms' and is_current limit 1;
  end if;
  return json_build_object(
    'ok', true,
    'status', v_status->>'status',
    'blocking', v_status->>'status' = 'pending',
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

-- Athlete: explicit acceptance of the CURRENT subscription terms version. The only path that records a subscription_terms
-- consent; the caller is always the athlete themself (auth.uid()), never a manager on their behalf. One row per
-- (athlete, version): accepting the same version again records nothing new.
create or replace function public.accept_subscription_terms(p_version integer, p_user_agent text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.legal_documents%rowtype;
  v_full_name text;
  v_id uuid;
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

  -- Only subscribers (any subscription on record) accept subscription terms; staff never accept on anyone's behalf.
  if not exists (select 1 from public.subscriptions s where s.payee_id = v_uid and s.payee_is_manual = false and s.deleted_at is null) then
    return json_build_object('ok', false, 'error', 'no_subscription');
  end if;

  select nullif(trim(p.full_name), '') into v_full_name from public.profiles p where p.user_id = v_uid;

  insert into public.user_consents (user_id, full_name, consent_type, consent_version, status, user_agent)
  values (v_uid, v_full_name, 'subscription_terms', v_doc.version, 'accepted', left(p_user_agent, 500))
  on conflict (user_id, consent_type, consent_version) where (status = 'accepted') do nothing
  returning id into v_id;

  if v_id is null then
    return json_build_object('ok', true, 'already_recorded', true, 'version', v_doc.version);
  end if;

  perform public._insert_activity_event(
    v_uid, 'subscription_terms_accepted', 'user_consent', v_id::text, jsonb_build_object('version', v_doc.version)
  );
  return json_build_object('ok', true, 'version', v_doc.version);
end;
$$;
revoke execute on function public.accept_subscription_terms(integer, text) from public, anon;
grant execute on function public.accept_subscription_terms(integer, text) to authenticated;

-- Manager: the payee athlete's terms status for a set of subscriptions (list / detail screens). Read-only: managers
-- cannot record acceptance.
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
    select json_agg(
      jsonb_build_object('subscription_id', s.id, 'payee_is_manual', s.payee_is_manual)
      || case when s.payee_is_manual
           then jsonb_build_object('status', 'not_required', 'accepted_version', null, 'accepted_at', null)
           else public._subscription_terms_status_for_user(s.payee_id) end
    )
    from public.subscriptions s
    where s.id = any(coalesce(p_subscription_ids, '{}'::uuid[]))
  ), '[]'::json));
end;
$$;
revoke execute on function public.get_subscription_terms_status(uuid[]) from public, anon;
grant execute on function public.get_subscription_terms_status(uuid[]) to authenticated;

-- Manager: settings card (switch, current document, athlete counts).
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
    select public._subscription_terms_status_for_user(a.payee_id)->>'status' as status, count(*) as n
    from (select distinct s.payee_id from public.subscriptions s where s.deleted_at is null and not s.payee_is_manual) a
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

-- Manager: turn the mandatory screen on/off (on = only after business/legal approval of the current document).
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
insert into public.legal_documents (consent_type, version, title, title_en, body_text, body_text_en, is_current, requires_reconsent)
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
  true,
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
  if (select count(*) from public.legal_documents where consent_type = 'subscription_terms' and is_current) <> 1 then
    raise exception 'self-check: exactly one current subscription_terms document expected';
  end if;
  if exists (select 1 from public.user_consents where consent_type = 'subscription_terms') then
    raise exception 'self-check: no subscription_terms consent may exist yet (never fabricated)';
  end if;
  foreach v_fn in array array['public._subscription_terms_status_for_user(uuid)', 'public._subscription_terms_required_for_user(uuid)'] loop
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
  -- Billing and coverage are untouched by this migration.
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
             and proname in ('generate_due_subscription_charges', 'subscription_effective_context', 'create_subscription', 'reactivate_subscription')
             and prosrc like '%terms%') then
    raise exception 'self-check: billing/coverage functions must not depend on terms';
  end if;
end $$;
