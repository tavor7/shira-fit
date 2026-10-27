-- Backup Management: make financial_backup_record_health_snapshot's System Issues reporting
-- automation-aware, matching the same fix just made client-side.
--
-- NOTE: this function is not currently invoked by anything in production (the GitHub Actions
-- write-path that would call it was never wired up -- see 20261027154941's own header comment,
-- and get-backup-health's header comment for why the mobile client reads R2 directly instead).
-- Fixing it now keeps it correct for whenever that write path (or any other caller) is added,
-- rather than leaving a known-wrong default in place.
--
-- A manager intentionally turning automatic backups off is not a missed scheduled run -- the
-- three staleness checks (backup/verification/restore-test) now only fire when the caller tells
-- this function automation is actually on. Genuine correctness problems (a manifest missing its
-- schema/data artifact, an actual failed restore-test) are reported unconditionally, same as
-- before -- those are never about scheduling.
--
-- A different argument count is a DIFFERENT function to Postgres, not a replacement for the
-- existing 2-arg one -- this adds the 3-arg overload alongside it rather than dropping anything.
-- The old 2-arg form is confirmed unused (no caller in production for either form) and is simply
-- left in place as harmless dead code; removing it is a separate, later cleanup if ever wanted,
-- not bundled into this fix.
create or replace function public.financial_backup_record_health_snapshot(
  p_health jsonb,
  p_runs jsonb,
  p_automation_enabled boolean default true -- conservative default: preserves this function's
                                             -- previous unconditional-staleness-check behavior
                                             -- for any caller that doesn't pass the new argument
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.financial_backup_health_snapshot (id, computed_at, health, runs)
  values (true, now(), p_health, p_runs)
  on conflict (id) do update set
    computed_at = excluded.computed_at,
    health = excluded.health,
    runs = excluded.runs;

  if p_automation_enabled and coalesce((p_health->>'backup_is_stale')::boolean, false) then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'financial_backup',
      p_operation := 'health_check',
      p_error_class := 'backup_stale',
      p_severity := 'error',
      p_message := format(
        'Last successful financial backup was %s hours ago (threshold %s).',
        p_health->>'hours_since_last_successful_backup', p_health->>'stale_threshold_hours'
      ),
      p_entities := jsonb_build_object('last_successful_backup', p_health->'last_successful_backup'),
      p_fingerprint_key := 'financial_backup_stale'
    );
  end if;

  if p_automation_enabled and coalesce((p_health->>'verification_is_stale')::boolean, false) then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'financial_backup',
      p_operation := 'health_check',
      p_error_class := 'verification_stale',
      p_severity := 'error',
      p_message := format(
        'Last remote backup verification was %s hours ago (threshold %s).',
        p_health->>'hours_since_last_verified_backup', p_health->>'stale_threshold_hours'
      ),
      p_entities := jsonb_build_object('last_verified_backup', p_health->'last_verified_backup'),
      p_fingerprint_key := 'financial_backup_verification_stale'
    );
  end if;

  if p_automation_enabled and coalesce((p_health->>'restore_test_is_stale')::boolean, false) then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'financial_backup',
      p_operation := 'health_check',
      p_error_class := 'restore_test_stale',
      p_severity := 'error',
      p_message := format(
        'Last restore test was %s hours ago (threshold %s).',
        p_health->>'hours_since_last_restore_test', p_health->>'restore_test_stale_threshold_hours'
      ),
      p_entities := jsonb_build_object('last_restore_test', p_health->'last_restore_test'),
      p_fingerprint_key := 'financial_backup_restore_test_stale'
    );
  end if;

  -- Genuine correctness problems -- never gated on automation state, since they're not about
  -- whether a scheduled run happened, only about whether backed-up data is actually sound.
  if coalesce((p_health->>'incomplete_backups')::integer, 0) > 0 then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'financial_backup',
      p_operation := 'health_check',
      p_error_class := 'backup_incomplete',
      p_severity := 'error',
      p_message := format('%s backup(s) have a manifest but a missing schema or data artifact.', p_health->>'incomplete_backups'),
      p_entities := jsonb_build_object('incomplete_backups', p_health->'incomplete_backups'),
      p_fingerprint_key := 'financial_backup_incomplete'
    );
  end if;

  if (p_health->>'last_restore_test' is not null) and (p_health->'last_restore_test'->>'result') = 'failed' then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'financial_backup',
      p_operation := 'restore_test',
      p_error_class := 'restore_test_failed',
      p_severity := 'error',
      p_message := format('Restore test failed for backup %s.', p_health->'last_restore_test'->>'backup_id'),
      p_entities := jsonb_build_object('last_restore_test', p_health->'last_restore_test'),
      -- Keyed by backup_id + tested_at (not just backup_id) so a later PASSING retest of the same
      -- backup doesn't get silently merged into this failure's occurrence count -- each distinct
      -- test run is its own fingerprint.
      p_fingerprint_key := 'financial_backup_restore_test_failed:' ||
        (p_health->'last_restore_test'->>'backup_id') || ':' || (p_health->'last_restore_test'->>'tested_at')
    );
  end if;
end;
$$;

comment on function public.financial_backup_record_health_snapshot(jsonb, jsonb, boolean) is
  'Service-role-only. Upserts the singleton financial_backup_health_snapshot row, then reports any '
  'stale/failed condition it finds to System Issues at severity=''error'' (never ''critical'' -- '
  'never triggers a push). Staleness (backup/verification/restore-test) is only reported when '
  'p_automation_enabled is true -- a manager-disabled schedule is not a missed run. Correctness '
  'problems (incomplete backups, a failed restore-test) are reported regardless. Not currently '
  'invoked by anything in production -- see this migration''s own header comment.';

revoke execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb, boolean) to service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.financial_backup_record_health_snapshot(jsonb,jsonb,boolean)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.financial_backup_record_health_snapshot(jsonb,jsonb,boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: financial_backup_record_health_snapshot must stay service_role-only';
  end if;
end $$;
