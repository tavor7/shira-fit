-- Security: coach compensation is manager-only (coaches can no longer set their own pay).
--
-- Before this migration (verified read-only on production and on an isolated copy):
--   * coach_capacity_pricing (the per-coach pay rate by registered headcount, i.e. the coach's salary table) let a
--     coach INSERT, UPDATE and DELETE their OWN rows (RLS: coach_id = auth.uid() and role = 'coach'). The coach app's
--     "My pay rates" tab wrote those rows directly through the REST API. This was the remaining "coach pay-rate
--     self-service" item that 20261013130000_restrict_coach_financial_access.sql left open as an owner decision; the
--     owner has now decided coaches must not edit compensation. A coach could not touch ANOTHER coach's rows.
--   * staff_update_session_series_scope admitted any coach for any session and accepted p_coach_id. Coach pay for a
--     session goes to the session's coach_id (manager_coach_sessions_report), so any coach could reassign another coach's
--     session - and its pay - to themselves through a direct RPC call. The coach app itself only ever edits the coach's
--     own sessions and never changes the coach (app/(app)/coach/session/manage/[id].tsx).
--   * training_sessions writes are manager-only in production, but 20250329100000_coach_own_sessions.sql still creates
--     sessions_coach_insert_self / _update_self / _delete_self and no later migration drops them (production lost them
--     outside the migration history). Any database built from this repository therefore let a coach UPDATE their own
--     sessions directly - including custom_coach_rate_ils, the one-off per-session coach payout.
--   * Already manager-only and unchanged: staff_set_session_custom_coach_rate (the RPC for that payout),
--     manager_coach_sessions_report, the activity-log revert RPCs.
--
-- Changes (least privilege, no data touched; existing compensation rows are preserved as-is):
--   1. coach_capacity_pricing: INSERT / UPDATE / DELETE become manager-only. SELECT is unchanged (managers, and a coach
--      reading their own rates - viewing is not editing). anon loses all table privileges; authenticated loses TRUNCATE,
--      REFERENCES and TRIGGER, which RLS does not govern and no client path needs.
--   2. staff_update_session_series_scope: a non-manager may only edit a session they coach, and may not change its coach.
--      Managers are unaffected. The body is changed by exactly one inserted guard; the migration aborts unless the
--      deployed source is byte-identical to the reviewed one (md5 precondition), so a drifted function is never overwritten.
--   3. Drop the three coach self-service training_sessions policies (no-op in production, where they no longer exist),
--      so every environment matches production: session writes are manager-only RLS, coaches use the guarded RPCs.

-- 1. coach_capacity_pricing --------------------------------------------------------------------------------------------
drop policy if exists coach_capacity_pricing_insert on public.coach_capacity_pricing;
drop policy if exists coach_capacity_pricing_update on public.coach_capacity_pricing;
drop policy if exists coach_capacity_pricing_delete on public.coach_capacity_pricing;

create policy coach_capacity_pricing_manager_insert on public.coach_capacity_pricing
  for insert with check (public.is_manager(auth.uid()));
create policy coach_capacity_pricing_manager_update on public.coach_capacity_pricing
  for update using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()));
create policy coach_capacity_pricing_manager_delete on public.coach_capacity_pricing
  for delete using (public.is_manager(auth.uid()));

revoke all on table public.coach_capacity_pricing from anon;
revoke truncate, references, trigger on table public.coach_capacity_pricing from authenticated;

-- 2. staff_update_session_series_scope ---------------------------------------------------------------------------------
do $$
declare
  v_fn regprocedure := 'public.staff_update_session_series_scope(uuid,text,date,time without time zone,uuid,integer,integer,boolean,boolean,boolean,numeric)'::regprocedure;
  v_anchor text := E'  if not found then return json_build_object(''ok'', false, ''error'', ''session_not_found''); end if;\n';
  v_guard text := E'  -- Coaches edit only sessions they coach and never reassign them: a session''s pay goes to its coach_id.\n'
    || E'  if not public.is_manager(v_uid) then\n'
    || E'    if v_sess.coach_id is distinct from v_uid then\n'
    || E'      return json_build_object(''ok'', false, ''error'', ''forbidden'');\n'
    || E'    end if;\n'
    || E'    if p_coach_id is not null and p_coach_id is distinct from v_sess.coach_id then\n'
    || E'      return json_build_object(''ok'', false, ''error'', ''forbidden'');\n'
    || E'    end if;\n'
    || E'  end if;\n';
  v_src text;
  v_def text;
begin
  select prosrc into v_src from pg_proc where oid = v_fn;
  if md5(v_src) <> '7fa708545af4c72ce875e577d9a74dc8' then
    raise exception 'precondition: staff_update_session_series_scope differs from the reviewed version; refusing to change it';
  end if;
  if (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'precondition: guard anchor must occur exactly once in staff_update_session_series_scope';
  end if;
  v_def := pg_get_functiondef(v_fn);
  -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
  execute replace(v_def, v_anchor, v_anchor || v_guard);
end $$;

-- 3. training_sessions coach self-service policies ---------------------------------------------------------------------
drop policy if exists "sessions_coach_insert_self" on public.training_sessions;
drop policy if exists "sessions_coach_update_self" on public.training_sessions;
drop policy if exists "sessions_coach_delete_self" on public.training_sessions;

-- Self-check -----------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'training_sessions' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (coalesce(qual, '') || coalesce(with_check, '')) not like '%is_manager(auth.uid())%'
  ) then
    raise exception 'self-check: a training_sessions write policy admits non-managers';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'coach_capacity_pricing' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%coach_id = auth.uid()%'
  ) then
    raise exception 'self-check: a coach_capacity_pricing write policy still admits the coach';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'coach_capacity_pricing' and cmd = 'SELECT') then
    raise exception 'self-check: coach_capacity_pricing lost its read policy';
  end if;
  if has_table_privilege('anon', 'public.coach_capacity_pricing', 'SELECT')
     or has_table_privilege('authenticated', 'public.coach_capacity_pricing', 'TRUNCATE') then
    raise exception 'self-check: coach_capacity_pricing privileges not reduced';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.staff_update_session_series_scope(uuid,text,date,time without time zone,uuid,integer,integer,boolean,boolean,boolean,numeric)'::regprocedure
      and prosecdef and prosrc like '%v_sess.coach_id is distinct from v_uid%'
  ) then
    raise exception 'self-check: staff_update_session_series_scope guard missing';
  end if;
end $$;
