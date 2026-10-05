-- Fix: "delete this and future sessions" (staff_delete_session_series_scope, scope 'future') fails
-- for any series that has a session linked to a ledger occurrence.
--
-- 20261001150000 added session_series_occurrences with the check
-- session_series_occurrences_materialized_requires_session (state generated/edited requires a
-- non-null training_session_id) and a training_sessions.series_occurrence_id FK that is
-- ON DELETE SET NULL. Scope 'this' was updated to tombstone the occurrence first, but scope 'future'
-- was left unchanged: its bulk DELETE nulls training_session_id on generated/edited occurrences,
-- the check fails, and the whole RPC (including the series 'ended' update) rolls back with
-- "violates check constraint ...materialized_requires_session". Production currently has 8 sessions
-- linked to generated/edited occurrences, so this scope errors for those series.
--
-- Fix: before the bulk delete, tombstone the occurrences of exactly the sessions being deleted
-- (state = 'deleted', training_session_id = null) -- the same end state scope 'this' produces. The
-- series is also marked ended from this date, so nothing regenerates. Everything else in the
-- function is unchanged. Function body only; no schema or data change.
CREATE OR REPLACE FUNCTION public.staff_delete_session_series_scope(p_session_id uuid, p_scope text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_scope text;
  v_occurrence_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  v_scope := lower(trim(coalesce(p_scope, 'this')));
  if v_scope not in ('this', 'future') then
    return json_build_object('ok', false, 'error', 'invalid_scope');
  end if;

  if v_sess.series_id is null then
    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'single');
  end if;

  if v_scope = 'this' then
    -- Forward-only fix: atomically establish-or-retrieve a durable tombstone for this
    -- occurrence, using pre-delete values, before the physical delete. Protects both this
    -- series (never regenerates) and blocks a sibling series from claiming the vacated slot.
    if v_sess.series_occurrence_id is not null then
      update public.session_series_occurrences
      set state = 'deleted', training_session_id = null
      where id = v_sess.series_occurrence_id;
    else
      begin
        insert into public.session_series_occurrences (
          series_id, template_occurrence_date, template_coach_id, template_start_time, state
        )
        values (v_sess.series_id, v_sess.session_date, v_sess.coach_id, v_sess.start_time, 'deleted')
        on conflict (series_id, template_occurrence_date) do nothing
        returning id into v_occurrence_id;
      exception when unique_violation then
        -- A sibling series already owns this exact original slot -- it's already protected;
        -- the delete proceeds regardless.
        null;
      end;
    end if;

    -- Pre-existing skip_dates protection, unchanged.
    perform public._series_add_skip_date(v_sess.series_id, v_sess.session_date);

    delete from public.training_sessions where id = p_session_id;
    return json_build_object('ok', true, 'scope', 'this');
  end if;

  -- 'future' scope: end the series from this date, tombstone linked occurrences, delete the sessions.
  update public.session_series
  set
    status = 'ended',
    ended_from_date = v_sess.session_date,
    updated_at = now()
  where id = v_sess.series_id;

  -- Tombstone the ledger rows of the sessions about to be deleted so the ON DELETE SET NULL on
  -- training_sessions.series_occurrence_id does not violate the materialized-requires-session check.
  update public.session_series_occurrences o
  set state = 'deleted', training_session_id = null
  where o.training_session_id in (
    select t.id from public.training_sessions t
    where t.series_id = v_sess.series_id
      and t.session_date >= v_sess.session_date
      and t.series_detached = false
  );

  delete from public.training_sessions t
  where t.series_id = v_sess.series_id
    and t.session_date >= v_sess.session_date
    and t.series_detached = false;

  return json_build_object('ok', true, 'scope', 'future');
end;
$function$

;
