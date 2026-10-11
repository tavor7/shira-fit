-- Athletes see a session's participants whenever they may see the session itself, independent of their own
-- registration.
--
-- Root cause: 20260430124500_list_session_participants_allow_browse.sql deliberately let approved athletes see
-- participant names on a session they have NOT registered for ("Athletes should be able to see participant names on
-- session detail even if not registered"). 20260829130000_list_session_participants_hide_filter.sql was then written on
-- top of an older body (20260409120000_security_hardening.sql) and silently re-introduced that migration's
--   if not v_is_staff and not v_is_participant then return;
-- so since 2026-08-29 an athlete who is neither registered nor waitlisted gets an empty list (the session screen shows
-- "no participants yet" / a bare count) while a waitlisted athlete sees the names.
--
-- Fix: replace that single participant-only early return with the same visibility rule the training_sessions SELECT
-- policy (sessions_select) applies to athletes, so the list is visible exactly when the session is:
--   * the athlete is registered or waitlisted (unchanged), or
--   * the athlete is approved and not disabled, the session is not hidden, and it is inside the athlete browse window
--     (session_date <= athlete_browse_week_end()).
-- Unchanged: what is returned (full_name + source only), per-audience hide filtering (a hidden athlete's name is never
-- shown to non-staff callers), staff behaviour, manual participants staff-only, hidden sessions staff-only, the
-- approved-athlete-or-staff requirement, anon gets nothing. The body is changed by exactly this one replacement; the
-- migration aborts unless the deployed source is byte-identical to the reviewed one (md5 precondition).

do $$
declare
  v_fn regprocedure := 'public.list_session_participants(uuid)'::regprocedure;
  v_old text := E'  if not v_is_staff and not v_is_participant then\n    return;\n  end if;\n';
  v_new text := E'  -- Athletes see the list whenever they may see the session (same rule as the sessions_select policy),\n'
    || E'  -- independent of their own registration.\n'
    || E'  if not v_is_staff and not v_is_participant and not (\n'
    || E'    v_is_approved_athlete\n'
    || E'    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.disabled_at is null)\n'
    || E'    and v_sess.session_date <= public.athlete_browse_week_end()\n'
    || E'  ) then\n'
    || E'    return;\n'
    || E'  end if;\n';
  v_src text;
begin
  select prosrc into v_src from pg_proc where oid = v_fn;
  if md5(v_src) <> 'a9ab63cd0c56283f55fab9ba420ff901' then
    raise exception 'precondition: list_session_participants differs from the reviewed version; refusing to change it';
  end if;
  if (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'precondition: participant-only gate must occur exactly once';
  end if;
  -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
  execute replace(pg_get_functiondef(v_fn), v_old, v_new);
end $$;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where oid = 'public.list_session_participants(uuid)'::regprocedure
      and prosecdef
      and prosrc like '%athlete_browse_week_end()%'
      and prosrc like '%not public.is_registration_hidden(r.session_id, r.user_id)%'
      and prosrc like '%if coalesce(v_sess.is_hidden, false) and not v_is_staff then%'
  ) then
    raise exception 'self-check: list_session_participants not patched as reviewed';
  end if;
  if not has_function_privilege('authenticated', 'public.list_session_participants(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: list_session_participants lost EXECUTE for authenticated';
  end if;
end $$;
