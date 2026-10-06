-- One-time cleanup of the historical series_unresolved_ownership diagnostic flood (2026-10-01 .. 2026-10-05).
--
-- Context: while ten duplicate recurring-series families existed, every horizon run (cron + every manager/coach
-- Sessions-screen mount) re-logged the same 54 logical ownership conflicts, flooding public.user_activity_events
-- with 38,132 identical machine diagnostics (~97% of the table). The condition was repaired by
-- 20261005190000_recover_duplicate_series_and_s39_roster (committed 2026-10-05 19:53:26.176934 UTC); no such
-- event has been written since. The rows carry no actor, no target id and no business data -- only coach/series
-- ids, a time and a date -- and nothing reads them as logic.
--
-- This is ONE atomic statement (a single DO block): any failed assertion raises and rolls back everything,
-- including the archive schema, the archive copy and the summary. It:
--   A. locks public.user_activity_events against writers (SHARE ROW EXCLUSIVE; readers are not blocked), so the
--      deletion set cannot change between fingerprinting and deletion;
--   B. verifies the reviewed preconditions: recovery applied, exact row count, both reviewed fingerprints, the
--      recovery boundary, the structural shape of every row of this event type, the recurring-series
--      invariants, and that the logical-conflict grouping yields exactly 54 rows;
--   C. creates the restricted, non-API schema ops_archive with
--        ops_archive.user_activity_events_ownership_incident_20261005  (exact row copy; TEMPORARY, ~30 days --
--                                                                     dropped later by a separate reviewed change)
--        ops_archive.series_ownership_incident_summary                (one row per logical conflict; PERMANENT)
--   D. archives the exact rows, verifies the archive is a byte-exact copy, writes the 54-row summary, deletes
--      only rows that are in the archive AND still satisfy the full predicate, then re-verifies everything
--      (zero targets left, every other row unchanged, invariants unchanged, no other table touched).
--
-- Fresh replay: a database with neither any series_unresolved_ownership row nor any of the reviewed production
-- series is not production; only the (empty) restricted archive objects are created and no data is read, copied
-- or deleted. Any other state -- e.g. production with a partial, pruned or changed incident dataset -- takes the
-- guarded path and fails closed.
--
-- Restore (if ever needed, before the archive is dropped):
--   insert into public.user_activity_events (id, created_at, actor_user_id, event_type, target_type, target_id,
--                                            metadata, reverted_at, reverted_by)
--   select id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by
--   from ops_archive.user_activity_events_ownership_incident_20261005;
--
-- Out of scope (unchanged here): activity-log retention/pruning, activity-log grants, recurring-series behaviour,
-- cron, monitoring. The "-- @inject:" comments are inert markers used only by the test harness.
do $cleanup$
declare
  c_incident        constant text        := 'series_unresolved_ownership_20261001';
  c_recovery        constant text        := '20261005190000';
  c_cleanup         constant text        := '20261008100000';
  c_expected_rows   constant bigint      := 38132;
  c_expected_ids    constant text        := 'a2438e2ba6dc665e3d135fc7fdd4e16b';  -- md5 of ids ordered by id
  c_expected_full   constant text        := '0a239bf9bba0fe8a01f2c617f5e9a73a';  -- md5 of id|created_at|metadata (TimeZone=UTC)
  c_expected_min    constant timestamptz := '2026-10-01 11:50:05.054777+00';
  c_expected_max    constant timestamptz := '2026-10-05 19:42:13.157028+00';
  c_expected_groups constant int         := 54;
  c_recovery_at     constant timestamptz := '2026-10-05 19:53:26.176934+00';
  -- the 21 series of the 11 reviewed duplicate pairs: 11 retired by the recovery + 10 survivors
  c_retired constant uuid[] := array['df74284d-add2-4c46-913b-4ad6cbfd1c48','194db8c6-9733-43a3-b944-d6d504ec610a','8a6c9d3f-9adb-44a6-bbf3-1454d24e7838','f5c2c55a-4da4-411c-9541-e0d8155d1e29','d889634f-5d05-488c-8f42-1ce703104a44','37ea7bce-01e7-4a07-825c-1bfa63f86c2f','30208b0d-a870-48e8-a3a4-d435de13f03b','55d291e1-4f1c-492b-aa60-699ea42b408e','c6a208b5-7f22-4757-8ec9-fdbe36b6ee40','b52db63b-93f7-491d-953e-97e907270980','f87738b8-dd0d-4be0-a765-aceaa35121b3']::uuid[];
  c_survivors constant uuid[] := array['bf756f0b-b4e7-435d-8a05-3cda60d3e021','a8928386-7b0d-48c9-be77-2af3e0355f0e','ead14374-a7ea-4ac0-b874-f84f1f6f51ba','00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2','bd535cac-0b53-495b-b3a1-33005d6d00ba','d9d19473-29f1-4501-9edb-f57b3ea890a8','afc49504-e2d0-4e53-8b03-555763974b70','18b50099-f164-4003-a98a-9ce70e9c634f','34eb4cae-3b61-4607-a55f-8a8bc21ac938','8714c05d-bf0f-44f6-ad42-2454b6cad92b']::uuid[];
  -- THE deletion predicate (alias e). Every clause is required; it is the only definition used below. It never
  -- yields NULL and never raises on unrelated rows (JSON access is CASE-guarded; candidate ids compared as text).
  c_pred constant text := $p$ coalesce((
        e.event_type = 'series_unresolved_ownership'
    and e.actor_user_id is null
    and e.target_type = 'session_series'
    and e.target_id is null
    and e.reverted_at is null
    and e.reverted_by is null
    and e.created_at >= timestamptz '2026-10-01 11:50:05+00'
    and e.created_at <  timestamptz '2026-10-05 19:53:26.176934+00'
    and case when jsonb_typeof(e.metadata) = 'object' and jsonb_typeof(e.metadata -> 'candidate_series_ids') = 'array' then
          (select array_agg(k order by k) from jsonb_object_keys(e.metadata) k)
            = array['candidate_series_ids','template_coach_id','template_occurrence_date','template_start_time']
      and jsonb_array_length(e.metadata -> 'candidate_series_ids') between 2 and 3
      and (select bool_and(jsonb_typeof(v) = 'string') from jsonb_array_elements(e.metadata -> 'candidate_series_ids') v)
      and (select array_agg(x) from jsonb_array_elements_text(e.metadata -> 'candidate_series_ids') x)
        <@ array['df74284d-add2-4c46-913b-4ad6cbfd1c48','bf756f0b-b4e7-435d-8a05-3cda60d3e021','194db8c6-9733-43a3-b944-d6d504ec610a','a8928386-7b0d-48c9-be77-2af3e0355f0e','8a6c9d3f-9adb-44a6-bbf3-1454d24e7838','ead14374-a7ea-4ac0-b874-f84f1f6f51ba','f5c2c55a-4da4-411c-9541-e0d8155d1e29','00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2','d889634f-5d05-488c-8f42-1ce703104a44','bd535cac-0b53-495b-b3a1-33005d6d00ba','37ea7bce-01e7-4a07-825c-1bfa63f86c2f','d9d19473-29f1-4501-9edb-f57b3ea890a8','30208b0d-a870-48e8-a3a4-d435de13f03b','afc49504-e2d0-4e53-8b03-555763974b70','55d291e1-4f1c-492b-aa60-699ea42b408e','c6a208b5-7f22-4757-8ec9-fdbe36b6ee40','18b50099-f164-4003-a98a-9ce70e9c634f','b52db63b-93f7-491d-953e-97e907270980','34eb4cae-3b61-4607-a55f-8a8bc21ac938','f87738b8-dd0d-4be0-a765-aceaa35121b3','8714c05d-bf0f-44f6-ad42-2454b6cad92b']::text[]
      and (select array_agg(x) from jsonb_array_elements_text(e.metadata -> 'candidate_series_ids') x)
        && array['df74284d-add2-4c46-913b-4ad6cbfd1c48','194db8c6-9733-43a3-b944-d6d504ec610a','8a6c9d3f-9adb-44a6-bbf3-1454d24e7838','f5c2c55a-4da4-411c-9541-e0d8155d1e29','d889634f-5d05-488c-8f42-1ce703104a44','37ea7bce-01e7-4a07-825c-1bfa63f86c2f','30208b0d-a870-48e8-a3a4-d435de13f03b','55d291e1-4f1c-492b-aa60-699ea42b408e','c6a208b5-7f22-4757-8ec9-fdbe36b6ee40','b52db63b-93f7-491d-953e-97e907270980','f87738b8-dd0d-4be0-a765-aceaa35121b3']::text[]
        else false end
  ), false) $p$;
  -- recurring-series invariants (all must be 0); evaluated before and after the cleanup
  c_inv constant text := $q$
    with d as (select public._studio_today_date() d0, public._series_horizon_end() d1)
    select jsonb_build_object(
      'unresolved', (select count(*) from (select 1 from (select distinct coach_id, start_time from public.session_series where status = 'active' and repeat_mode = 'ongoing') f
          cross join d cross join generate_series(d.d0, d.d1, interval '1 day') g
          where (select count(*) from public.session_series s where s.coach_id = f.coach_id and s.start_time = f.start_time and s.status = 'active' and s.repeat_mode = 'ongoing'
                   and g::date >= s.anchor_date and mod(g::date - s.anchor_date, 7) = 0 and not (g::date = any (coalesce(s.skip_dates, '{}')))
                   and (s.ended_from_date is null or g::date < s.ended_from_date)) >= 2
            and not exists (select 1 from public.session_series_occurrences o where o.template_coach_id = f.coach_id and o.template_start_time = f.start_time and o.template_occurrence_date = g::date)) x),
      'dup_active_series', (select count(*) from (select 1 from public.session_series where status = 'active' and repeat_mode = 'ongoing'
          group by coach_id, start_time, extract(dow from anchor_date) having count(*) > 1) x),
      'dup_future_sessions', (select count(*) from (select 1 from public.training_sessions, d where session_date >= d.d0
          group by coach_id, session_date, start_time having count(*) > 1) x),
      'future_on_ended_series', (select count(*) from public.training_sessions ts join public.session_series s on s.id = ts.series_id, d
          where s.status = 'ended' and not ts.series_detached and ts.session_date >= d.d0 and ts.session_date >= s.ended_from_date),
      'missing', (select count(*) from public.session_series s cross join d cross join generate_series(d.d0, d.d1, interval '1 day') g
          where s.status = 'active' and s.repeat_mode = 'ongoing' and g::date >= s.anchor_date and mod(g::date - s.anchor_date, 7) = 0
            and not (g::date = any (coalesce(s.skip_dates, '{}'))) and (s.ended_from_date is null or g::date < s.ended_from_date)
            and not exists (select 1 from public.training_sessions ts where ts.coach_id = s.coach_id and ts.start_time = s.start_time and ts.session_date = g::date)
            and not exists (select 1 from public.session_series_occurrences o where o.series_id = s.id and o.template_occurrence_date = g::date)),
      'ledger_dup', (select count(*) from (select 1 from public.session_series_occurrences
          group by template_coach_id, template_start_time, template_occurrence_date having count(*) > 1) x),
      'ledger_multi_session', (select count(*) from (select 1 from public.training_sessions where series_occurrence_id is not null
          group by series_occurrence_id having count(*) > 1) x),
      'ledger_series_mismatch', (select count(*) from public.training_sessions ts join public.session_series_occurrences o on o.id = ts.series_occurrence_id
          where o.series_id is distinct from ts.series_id))
  $q$;
  c_inv_ok constant jsonb := '{"unresolved":0,"dup_active_series":0,"dup_future_sessions":0,"future_on_ended_series":0,"missing":0,"ledger_dup":0,"ledger_multi_session":0,"ledger_series_mismatch":0}';
  v_type_rows bigint; v_series_present int; v_n bigint; v_m bigint;
  v_ids text; v_full text; v_min timestamptz; v_max timestamptz;
  v_total_before bigint; v_total_after bigint;
  v_other_before text; v_other_after text; v_other_n_before bigint; v_other_n_after bigint;
  v_inv jsonb; v_groups int; v_multi int;
  v_stats_before jsonb; v_bad text;
begin
  -- ===== fresh-replay detection (no production incident data and none of the reviewed series) =====
  select count(*) into v_type_rows from public.user_activity_events where event_type = 'series_unresolved_ownership';
  select count(*) into v_series_present from public.session_series where id = any (c_retired || c_survivors);

  if v_type_rows = 0 and v_series_present = 0 then
    raise notice 'ownership-noise cleanup: no incident data and no reviewed series in this database (fresh replay); creating the empty restricted archive objects only';
  else
    -- ===== A. serialize: no writer can enter or leave the deletion set from here on =====
    perform set_config('lock_timeout', '10s', true);
    perform set_config('TimeZone', 'UTC', true);   -- created_at::text in the reviewed fingerprint is rendered in UTC
    lock table public.user_activity_events in share row exclusive mode;
    select coalesce(jsonb_object_agg(relid::text, jsonb_build_array(n_tup_ins, n_tup_upd, n_tup_del)), '{}')
      into v_stats_before from pg_stat_xact_user_tables where schemaname not like 'pg\_temp%';

    -- ===== B. preconditions =====
    if to_regclass('supabase_migrations.schema_migrations') is null
       or not exists (select 1 from supabase_migrations.schema_migrations where version = c_recovery) then
      raise exception 'CLEANUP STOP B1: recovery migration % is not recorded as applied', c_recovery;
    end if;

    execute 'select count(*), md5(string_agg(e.id::text, '','' order by e.id)),
                    md5(string_agg(e.id::text || ''|'' || e.created_at::text || ''|'' || e.metadata::text, '','' order by e.id)),
                    min(e.created_at), max(e.created_at)
             from public.user_activity_events e where ' || c_pred
      into v_n, v_ids, v_full, v_min, v_max;
    if v_n <> c_expected_rows then
      raise exception 'CLEANUP STOP B2: % rows match the reviewed predicate, expected %', v_n, c_expected_rows;
    end if;
    if v_ids is distinct from c_expected_ids then
      raise exception 'CLEANUP STOP B3: id fingerprint % <> reviewed %', v_ids, c_expected_ids;
    end if;
    if v_full is distinct from c_expected_full then
      raise exception 'CLEANUP STOP B4: id/created_at/metadata fingerprint % <> reviewed %', v_full, c_expected_full;
    end if;
    if v_min is distinct from c_expected_min or v_max is distinct from c_expected_max then
      raise exception 'CLEANUP STOP B5: matching window %..% <> reviewed %..%', v_min, v_max, c_expected_min, c_expected_max;
    end if;

    select count(*) into v_n from public.user_activity_events where event_type = 'series_unresolved_ownership' and created_at >= c_recovery_at;
    if v_n <> 0 then
      raise exception 'CLEANUP STOP B6: % series_unresolved_ownership row(s) at or after the recovery boundary %', v_n, c_recovery_at;
    end if;
    select count(*) into v_n from public.user_activity_events where event_type = 'series_unresolved_ownership';
    if v_n <> c_expected_rows then
      raise exception 'CLEANUP STOP B7: % series_unresolved_ownership rows exist but only % have the reviewed shape', v_n, c_expected_rows;
    end if;

    execute c_inv into v_inv;
    if v_inv is distinct from c_inv_ok then
      raise exception 'CLEANUP STOP B8: recurring-series invariants failed: %', v_inv;
    end if;
    if (select count(*) from public.session_series where id = any (c_retired) and status = 'ended') <> 11
       or (select count(*) from public.session_series where id = any (c_survivors) and status = 'active' and repeat_mode = 'ongoing') <> 10 then
      raise exception 'CLEANUP STOP B9: the reviewed series are no longer 11 retired (ended) + 10 survivors (active, ongoing)';
    end if;

    execute 'select count(*), count(*) filter (where n_sets > 1) from (
               select count(distinct (select array_agg(x::uuid order by x::uuid) from jsonb_array_elements_text(e.metadata -> ''candidate_series_ids'') x)) n_sets
               from public.user_activity_events e where ' || c_pred || '
               group by e.metadata ->> ''template_coach_id'', e.metadata ->> ''template_start_time'', e.metadata ->> ''template_occurrence_date'') g'
      into v_groups, v_multi;
    if v_groups <> c_expected_groups or v_multi <> 0 then
      raise exception 'CLEANUP STOP B10: logical-conflict grouping gives % groups (% with more than one candidate set), expected % and 0',
        v_groups, v_multi, c_expected_groups;
    end if;

    select count(*) into v_total_before from public.user_activity_events;
    execute 'select count(*), md5(coalesce(string_agg(e::text, '','' order by e.id), '''')) from public.user_activity_events e where not (' || c_pred || ')'
      into v_other_n_before, v_other_before;
    if v_other_n_before <> v_total_before - c_expected_rows then
      raise exception 'CLEANUP STOP B11: non-target rows % <> total % - %', v_other_n_before, v_total_before, c_expected_rows;
    end if;
    -- @inject:after_guards
  end if;

  -- ===== C. restricted archive objects (not exposed through the API: no grants to any API role) =====
  create schema ops_archive authorization postgres;
  revoke all on schema ops_archive from public, anon, authenticated, service_role;
  comment on schema ops_archive is
    'Restricted operational archive. Not exposed through the API; no privileges for public/anon/authenticated/service_role.';

  create table ops_archive.user_activity_events_ownership_incident_20261005 (
    like public.user_activity_events,
    primary key (id)
  );
  alter table ops_archive.user_activity_events_ownership_incident_20261005 owner to postgres;
  revoke all on table ops_archive.user_activity_events_ownership_incident_20261005 from public, anon, authenticated, service_role;
  alter table ops_archive.user_activity_events_ownership_incident_20261005 enable row level security;
  comment on table ops_archive.user_activity_events_ownership_incident_20261005 is
    'TEMPORARY exact copy of the 38,132 series_unresolved_ownership rows removed by migration 20261008100000 '
    '(incident series_unresolved_ownership_20261001). Restore source; intended retention 30 days; '
    'to be dropped by a separate reviewed migration.';

  create table ops_archive.series_ownership_incident_summary (
    incident_id              text        not null,
    template_coach_id        uuid        not null,
    template_start_time      time        not null,
    template_occurrence_date date        not null,
    candidate_series_ids     uuid[]      not null,
    first_seen_at            timestamptz not null,
    last_seen_at             timestamptz not null,
    event_count              integer     not null check (event_count > 0),
    recovery_migration       text        not null,
    cleanup_migration        text        not null,
    primary key (incident_id, template_coach_id, template_start_time, template_occurrence_date)
  );
  alter table ops_archive.series_ownership_incident_summary owner to postgres;
  revoke all on table ops_archive.series_ownership_incident_summary from public, anon, authenticated, service_role;
  alter table ops_archive.series_ownership_incident_summary enable row level security;
  comment on table ops_archive.series_ownership_incident_summary is
    'PERMANENT forensic summary: one row per logical recurring-series ownership conflict (coach, start time, '
    'occurrence date, sorted candidate series) with first/last seen and the number of duplicate diagnostics. '
    'Technical identifiers only; no personal data.';

  if v_type_rows = 0 and v_series_present = 0 then
    return;   -- fresh replay: nothing else to do
  end if;

  -- ===== D1. archive the exact rows =====
  execute 'insert into ops_archive.user_activity_events_ownership_incident_20261005
             (id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by)
           select e.id, e.created_at, e.actor_user_id, e.event_type, e.target_type, e.target_id, e.metadata, e.reverted_at, e.reverted_by
           from public.user_activity_events e where ' || c_pred;
  get diagnostics v_n = row_count;
  if v_n <> c_expected_rows then
    raise exception 'CLEANUP STOP D1: archived % rows, expected %', v_n, c_expected_rows;
  end if;
  -- @inject:after_archive
  select count(*), md5(string_agg(a.id::text, ',' order by a.id)),
         md5(string_agg(a.id::text || '|' || a.created_at::text || '|' || a.metadata::text, ',' order by a.id))
    into v_n, v_ids, v_full
  from ops_archive.user_activity_events_ownership_incident_20261005 a;
  if v_n <> c_expected_rows or v_ids is distinct from c_expected_ids or v_full is distinct from c_expected_full then
    raise exception 'CLEANUP STOP D2: archive integrity failed (rows %, ids %, full %)', v_n, v_ids, v_full;
  end if;
  select count(*) into v_n from (
    select id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by
      from ops_archive.user_activity_events_ownership_incident_20261005
    except
    select id, created_at, actor_user_id, event_type, target_type, target_id, metadata, reverted_at, reverted_by
      from public.user_activity_events) x;
  if v_n <> 0 then
    raise exception 'CLEANUP STOP D3: % archived row(s) are not byte-identical to the live rows', v_n;
  end if;

  -- ===== D2. permanent summary: one row per logical conflict =====
  insert into ops_archive.series_ownership_incident_summary
    (incident_id, template_coach_id, template_start_time, template_occurrence_date, candidate_series_ids,
     first_seen_at, last_seen_at, event_count, recovery_migration, cleanup_migration)
  select c_incident, (a.metadata ->> 'template_coach_id')::uuid, (a.metadata ->> 'template_start_time')::time,
         (a.metadata ->> 'template_occurrence_date')::date, min(c.cand), min(a.created_at), max(a.created_at), count(*),
         c_recovery, c_cleanup
  from ops_archive.user_activity_events_ownership_incident_20261005 a
  cross join lateral (select array_agg(x::uuid order by x::uuid) cand
                      from jsonb_array_elements_text(a.metadata -> 'candidate_series_ids') x) c
  group by 2, 3, 4
  having min(c.cand) = max(c.cand);
  get diagnostics v_n = row_count;
  if v_n <> c_expected_groups then
    raise exception 'CLEANUP STOP D4: summary has % rows, expected %', v_n, c_expected_groups;
  end if;
  -- @inject:after_summary
  select coalesce(sum(event_count), 0) into v_n from ops_archive.series_ownership_incident_summary where incident_id = c_incident;
  if v_n <> c_expected_rows then
    raise exception 'CLEANUP STOP D5: summary event_count total % <> %', v_n, c_expected_rows;
  end if;

  -- ===== D3. delete: only archived ids that still satisfy the full predicate =====
  execute 'delete from public.user_activity_events e
           using ops_archive.user_activity_events_ownership_incident_20261005 a
           where a.id = e.id and ' || c_pred;
  get diagnostics v_n = row_count;
  if v_n <> c_expected_rows then
    raise exception 'CLEANUP STOP D6: deleted % rows, expected %', v_n, c_expected_rows;
  end if;
  -- @inject:after_delete

  -- ===== D4. post-checks =====
  execute 'select count(*) from public.user_activity_events e where ' || c_pred into v_n;
  select count(*) into v_m from public.user_activity_events where event_type = 'series_unresolved_ownership';
  if v_n <> 0 or v_m <> 0 then
    raise exception 'CLEANUP STOP E1: % predicate / % event-type rows remain', v_n, v_m;
  end if;
  select count(*) into v_total_after from public.user_activity_events;
  select count(*), md5(coalesce(string_agg(e::text, ',' order by e.id), '')) into v_other_n_after, v_other_after
  from public.user_activity_events e;
  if v_total_after <> v_total_before - c_expected_rows or v_other_n_after <> v_other_n_before or v_other_after is distinct from v_other_before then
    raise exception 'CLEANUP STOP E2: non-target rows changed (before % rows %, after % rows %)',
      v_other_n_before, v_other_before, v_other_n_after, v_other_after;
  end if;
  if exists (select 1 from public.user_activity_events e join ops_archive.user_activity_events_ownership_incident_20261005 a on a.id = e.id) then
    raise exception 'CLEANUP STOP E3: an archived id is still live';
  end if;
  execute c_inv into v_inv;
  if v_inv is distinct from c_inv_ok then
    raise exception 'CLEANUP STOP E4: recurring-series invariants failed after cleanup: %', v_inv;
  end if;
  -- no table other than the live log (deletes only) and the two archive tables (inserts only) was written
  select string_agg(format('%s ins=%s upd=%s del=%s', s.relid::regclass,
                           s.n_tup_ins - coalesce((v_stats_before -> s.relid::text ->> 0)::bigint, 0),
                           s.n_tup_upd - coalesce((v_stats_before -> s.relid::text ->> 1)::bigint, 0),
                           s.n_tup_del - coalesce((v_stats_before -> s.relid::text ->> 2)::bigint, 0)), '; ')
    into v_bad
  from pg_stat_xact_user_tables s
  where s.schemaname not like 'pg\_temp%'
    and array[s.n_tup_ins - coalesce((v_stats_before -> s.relid::text ->> 0)::bigint, 0),
              s.n_tup_upd - coalesce((v_stats_before -> s.relid::text ->> 1)::bigint, 0),
              s.n_tup_del - coalesce((v_stats_before -> s.relid::text ->> 2)::bigint, 0)]
        is distinct from
        case s.relid::regclass
          when 'public.user_activity_events'::regclass then array[0, 0, c_expected_rows]::bigint[]
          when 'ops_archive.user_activity_events_ownership_incident_20261005'::regclass then array[c_expected_rows, 0, 0]::bigint[]
          when 'ops_archive.series_ownership_incident_summary'::regclass then array[c_expected_groups, 0, 0]::bigint[]
          else array[0, 0, 0]::bigint[]
        end;
  if v_bad is not null then
    raise exception 'CLEANUP STOP E5: unexpected table writes in this transaction: %', v_bad;
  end if;

  raise notice 'OWNERSHIP-NOISE CLEANUP OK: archived % rows, summary % logical conflicts, deleted % rows; activity log % -> % rows; invariants %',
    c_expected_rows, c_expected_groups, c_expected_rows, v_total_before, v_total_after, v_inv;
end
$cleanup$;
