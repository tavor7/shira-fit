-- Backup Management Phase 8: wire financial-backup health problems into System Issues.
--
-- Receipt archive integrity problems are already wired into System Issues
-- (archive.record_verification_result -> _report_system_error, 20261025130000) -- that existing
-- path, including its severity, is left completely untouched here; this migration only adds
-- reporting for the financial-backup side (which had none).
--
-- No push notifications: _report_system_error's own severity default is 'error', and the
-- existing critical-push trigger (system_issues_critical_push_enqueue, 20261020140000) only
-- enqueues a push for severity='critical'. This migration explicitly passes p_severity:='error'
-- for every call below -- never 'critical' -- so none of these new issue types can ever reach
-- the push outbox. No email notification exists in this codebase for system_issues at all. This
-- migration does not touch system_issue_push_outbox, its trigger, the cron processor, or any
-- global push/email configuration.
create or replace function public.financial_backup_record_health_snapshot(p_health jsonb, p_runs jsonb)
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

  if coalesce((p_health->>'backup_is_stale')::boolean, false) then
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

  if coalesce((p_health->>'verification_is_stale')::boolean, false) then
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

  if coalesce((p_health->>'restore_test_is_stale')::boolean, false) then
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

comment on function public.financial_backup_record_health_snapshot(jsonb, jsonb) is
  'Service-role-only. Upserts the singleton financial_backup_health_snapshot row, then reports any '
  'stale/failed condition it finds (backup/verification/restore-test staleness, restore-test '
  'failure) to System Issues at severity=''error'' (never ''critical'' -- never triggers a push). '
  'Called by the financial-backup GitHub Actions workflow right after it computes health.js''s own '
  'output -- not callable by any client role.';

revoke execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.financial_backup_record_health_snapshot(jsonb, jsonb) to service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.financial_backup_record_health_snapshot(jsonb,jsonb)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.financial_backup_record_health_snapshot(jsonb,jsonb)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: financial_backup_record_health_snapshot must stay service_role-only';
  end if;
end $$;
