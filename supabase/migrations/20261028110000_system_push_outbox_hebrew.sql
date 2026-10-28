-- Task 1 (notification language audit): _system_push_outbox_process (the critical System Issues
-- push processor, 20261020140000_system_monitoring_critical_push.sql) was the last remaining push
-- notification template in the codebase still hard-coded in English ('System Issues' / 'A critical
-- issue was detected...') -- every other push/local-notification template is Hebrew. This feature
-- is still dark-launched (critical_push_enabled defaults to false; see that migration), so nothing
-- has actually sent this text in production, but the template itself must still read Hebrew before
-- the flag is ever flipped on. Changes ONLY the 'title'/'body' literal strings passed to
-- net.http_post; the dispatch/collection/retry state machine, idempotency-key construction, vault
-- secret lookups and all cron/trigger wiring are byte-for-byte unchanged.
--
-- Title/body wording matches this codebase's existing "System issues" screen terminology
-- (mobile/src/i18n/systemIssues.ts: "sysIssues.title" => 'תקלות מערכת'), not invented here.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_system_push_outbox_process') <> 1 then
    raise exception 'precondition: _system_push_outbox_process must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_system_push_outbox_process')
     <> '187202c1b33dc050fc6210ab5a485246' then
    raise exception 'precondition: source of _system_push_outbox_process differs from the reviewed version; refusing to change it';
  end if;
end $$;

create or replace function public._system_push_outbox_process(p_batch_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_secret text;
  v_ambiguous_after interval := interval '90 seconds';
  v_dispatched integer := 0;
  v_sent integer := 0;
  v_failed integer := 0;
  v_requeued integer := 0;
  r record;
  v_status_code integer;
  v_found boolean;
  v_request_id bigint;
begin
  if not public._system_flag('critical_push_enabled', false) then
    return jsonb_build_object('enabled', false);
  end if;

  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'send_web_push_url' limit 1;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'send_web_push_secret' limit 1;
  if v_url is null or v_secret is null or length(trim(v_url)) < 10 or length(trim(v_secret)) < 4 then
    return jsonb_build_object('enabled', true, 'error', 'missing_vault_secrets');
  end if;

  -- Collection pass first, so a row dispatched in a previous cycle gets resolved before this
  -- cycle's dispatch pass claims new ones (keeps the processing-row count bounded).
  for r in
    select * from public.system_issue_push_outbox
    where status = 'processing'
    order by locked_at
    limit p_batch_limit
    for update skip locked
  loop
    select d.status_code into v_status_code
    from net._http_response d
    where d.id = r.net_request_id;
    v_found := found;

    if v_found and v_status_code = 200 then
      update public.system_issue_push_outbox
      set status = 'sent', sent_at = now()
      where id = r.id;
      v_sent := v_sent + 1;
    elsif v_found and v_status_code = 202 then
      -- send-web-push's idempotency layer reports "in flight elsewhere" / "lost the insert race" -
      -- retryable, not a failure and not yet a confirmed send.
      update public.system_issue_push_outbox
      set attempts = attempts + 1,
          attempt_log = (attempt_log || jsonb_build_object('at', now(), 'outcome', 'in_flight'))::jsonb,
          status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
          next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second')
      where id = r.id;
      v_requeued := v_requeued + 1;
    elsif v_found then
      update public.system_issue_push_outbox
      set attempts = attempts + 1,
          attempt_log = (attempt_log || jsonb_build_object('at', now(), 'outcome', 'http_error', 'status_code', v_status_code))::jsonb,
          status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
          next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second'),
          last_error = 'http_status_' || v_status_code
      where id = r.id;
      v_failed := v_failed + 1;
    elsif r.locked_at < now() - v_ambiguous_after then
      -- Ambiguous: no response seen within the bounded wait. Retryable, not success - this is the
      -- at-least-once edge: a retry here can in rare cases result in a manager seeing a duplicate
      -- push if the original request actually succeeded but its response was lost/pruned before we
      -- read it. The idempotency key on the edge-function side is the mitigation.
      update public.system_issue_push_outbox
      set attempts = attempts + 1,
          attempt_log = (attempt_log || jsonb_build_object('at', now(), 'outcome', 'ambiguous_timeout'))::jsonb,
          status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
          next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second')
      where id = r.id;
      v_requeued := v_requeued + 1;
    end if;
  end loop;

  -- Dispatch pass: claim a bounded batch of pending/retryable rows.
  for r in
    select * from public.system_issue_push_outbox
    where status = 'pending' and next_attempt_at <= now()
    order by created_at
    limit p_batch_limit
    for update skip locked
  loop
    begin
      select net.http_post(
        url := trim(v_url),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || trim(v_secret),
          'Idempotency-Key', r.idempotency_key
        ),
        body := jsonb_build_object(
          'user_id', r.manager_id::text,
          'title', 'תקלות מערכת',
          'body', 'זוהתה תקלה קריטית. פתחו את תקלות מערכת לצפייה בפרטים.',
          'data', jsonb_build_object('idempotency_key', r.idempotency_key, 'issue_id', r.issue_id)
        )
      ) into v_request_id;

      update public.system_issue_push_outbox
      set status = 'processing', locked_at = now(), net_request_id = v_request_id
      where id = r.id;
      v_dispatched := v_dispatched + 1;
    exception when others then
      update public.system_issue_push_outbox
      set attempts = attempts + 1,
          attempt_log = (attempt_log || jsonb_build_object('at', now(), 'outcome', 'dispatch_exception', 'sqlstate', sqlstate))::jsonb,
          status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end,
          next_attempt_at = now() + (least(power(2, attempts + 1), 60) * interval '1 second')
      where id = r.id;
    end;
  end loop;

  return jsonb_build_object(
    'enabled', true, 'dispatched', v_dispatched, 'sent', v_sent, 'failed', v_failed, 'requeued', v_requeued);
exception when others then
  raise warning 'system monitoring: push outbox processing failed (sqlstate %)', sqlstate;
  return jsonb_build_object('enabled', true, 'error', 'internal');
end;
$$;

revoke all on function public._system_push_outbox_process(integer) from public, anon, authenticated, service_role;

comment on function public._system_push_outbox_process(integer) is
  'Critical-issue manager push outbox processor (dispatch + collection passes). Notification copy '
  'is Hebrew (as of 20261028110000), matching every other notification template in this codebase. '
  'Still dark-launched behind critical_push_enabled.';

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_system_push_outbox_process') <> 1 then
    raise exception 'self-check: _system_push_outbox_process must exist exactly once';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_system_push_outbox_process')
     = '187202c1b33dc050fc6210ab5a485246' then
    raise exception 'self-check: _system_push_outbox_process source is unchanged -- replace did not take effect';
  end if;
  if has_function_privilege('authenticated', 'public._system_push_outbox_process(integer)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _system_push_outbox_process must not be executable by authenticated';
  end if;
end $$;
