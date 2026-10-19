-- System Issues monitoring completion, item 3: critical-issue push alerting via a durable outbox.
--
-- User's explicit decision: push only (no email), critical severity only, active managers only,
-- deduplicated by (fingerprint, lifecycle epoch), throttled, reusing the existing send-web-push +
-- web_push_subscriptions infrastructure. Delivery is at-least-once, not exactly-once - this is
-- stated plainly below and in the release report, not worked around with false guarantees.
--
-- pg_net is confirmed installed at 0.20.0 (read-only check against production during planning).
-- net.http_post(...) enqueues into pg_net's own internal queue *inside the calling transaction* and
-- returns a bigint request id; the actual outbound call and the net._http_response write happen
-- later, in pg_net's background worker, outside our transaction. Consequence: if our transaction
-- rolls back before commit, the enqueued request rolls back with it (never actually sent) - there is
-- no "crash before delivery" half-state. net._http_response rows are pruned by pg_net's own worker
-- after its retention window; our 1-minute processing cadence and ~90s ambiguous-outcome threshold
-- are chosen to read responses comfortably inside typical retention, which should be reconfirmed
-- against pg_net 0.20.0's exact default during implementation/local testing.
--
-- Dark-launched: critical_push_enabled defaults to false, the new cron job exists but both the
-- enqueue trigger and the processor no-op when it is false (same pattern as the Phase 2.1
-- observer_enabled gate) - nothing here sends a real push until a separate, approved config flip.

insert into public.system_monitoring_config (key, value)
values ('critical_push_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Durable outbox. lifecycle_epoch reuses system_issues.reopen_count directly - it already increments
-- on every reopen and never resets, so it is exactly the "has this issue's current critical episode
-- already been notified" epoch without a new column on system_issues.
-- ---------------------------------------------------------------------------------------------
create table public.system_issue_push_outbox (
  id bigint generated always as identity primary key,
  issue_id uuid not null references public.system_issues (id) on delete cascade,
  fingerprint text not null,
  lifecycle_epoch integer not null,
  manager_id uuid not null references public.profiles (user_id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  net_request_id bigint,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  attempt_log jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attempt_log) = 'array' and jsonb_array_length(attempt_log) <= 20),
  unique (fingerprint, lifecycle_epoch, manager_id)
);

comment on table public.system_issue_push_outbox is
  'Durable outbox for critical-issue manager push notifications. One row per (fingerprint, '
  'lifecycle_epoch, manager). Enqueue (cheap, synchronous, inside the system_issues trigger below) '
  'is fully decoupled from delivery (the async processor below) so a push failure can never affect '
  'issue ingestion. Delivery is at-least-once: see idempotency_key / system_push_idempotency_keys.';

create index system_issue_push_outbox_pending_idx on public.system_issue_push_outbox (next_attempt_at)
  where status in ('pending', 'processing');

alter table public.system_issue_push_outbox enable row level security;

create policy system_issue_push_outbox_manager_select on public.system_issue_push_outbox
  for select to authenticated
  using (public.system_monitoring_is_manager());

revoke all on public.system_issue_push_outbox from public, anon, authenticated;
grant select on public.system_issue_push_outbox to authenticated;
revoke all on sequence public.system_issue_push_outbox_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Idempotency ledger for send-web-push, as a recoverable state machine (not a permanent lock): a
-- send that crashed mid-flight must eventually be retried, never permanently suppressed. Written
-- only by the edge function (service_role), over its own connection - not by this migration's SQL
-- functions, which only read/derive idempotency_key values to pass through.
-- ---------------------------------------------------------------------------------------------
create table public.system_push_idempotency_keys (
  key text primary key,
  status text not null check (status in ('in_progress', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.system_push_idempotency_keys is
  'send-web-push dedup ledger. in_progress rows older than ~30s are reclaimable (the prior attempt '
  'almost certainly crashed mid-send); completed rows cause a replayed key to be served the cached '
  'outcome instead of a second push. Rows are deleted if a send attempt fails, releasing the key.';

alter table public.system_push_idempotency_keys enable row level security;
revoke all on public.system_push_idempotency_keys from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.system_push_idempotency_keys to service_role;

-- ---------------------------------------------------------------------------------------------
-- Enqueue trigger on system_issues. Fires on every write that leaves the row open+critical (a
-- brand new critical issue, an escalation to critical while open, a reopen (re)classified critical,
-- or a plain repeated occurrence) - see the trigger definition below for why re-firing on a plain
-- repeat is harmless: the enqueue function's ON CONFLICT on (fingerprint, lifecycle_epoch,
-- manager_id) means only the first occurrence of a given critical episode ever adds an outbox row,
-- so only one push per manager is ever sent per episode. High/medium/low severity never reach this
-- function at all - the WHEN clause below filters first.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_issues_critical_push_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_key text;
begin
  if not public._system_flag('critical_push_enabled', false) then
    return new;
  end if;

  for r in
    select user_id from public.profiles where role = 'manager' and disabled_at is null
  loop
    v_key := md5(new.fingerprint || ':' || new.reopen_count || ':' || r.user_id);
    insert into public.system_issue_push_outbox
      (issue_id, fingerprint, lifecycle_epoch, manager_id, idempotency_key)
    values (new.id, new.fingerprint, new.reopen_count, r.user_id, v_key)
    on conflict (fingerprint, lifecycle_epoch, manager_id) do nothing;
  end loop;

  return new;
exception when others then
  -- A notification-enqueue failure must never block the issue write that triggered it.
  raise warning 'system monitoring: critical-push enqueue failed (sqlstate %)', sqlstate;
  return new;
end;
$$;

revoke all on function public._system_issues_critical_push_enqueue() from public, anon, authenticated, service_role;

-- Fires on every write that leaves the row open+critical, not only on the transition into that
-- state (a WHEN clause cannot reference TG_OP, and OLD does not exist for an INSERT row, so
-- distinguishing "just became critical" from "still critical" would require moving the check into
-- the function body for little benefit). This is safe and still exactly-once-per-epoch in effect:
-- the function's `on conflict (fingerprint, lifecycle_epoch, manager_id) do nothing` means a
-- repeated occurrence that does not change reopen_count never adds a second outbox row, so a
-- repeated occurrence of the same unresolved critical issue still never produces a second push -
-- only the bounded per-occurrence INSERT attempt (cheap, conflict-absorbing) runs more than once.
create trigger system_issues_critical_push_enqueue
  after insert or update on public.system_issues
  for each row
  when (new.status = 'open' and new.severity = 'critical')
  execute function public._system_issues_critical_push_enqueue();

-- ---------------------------------------------------------------------------------------------
-- Processor: dispatch pass + collection pass, run every minute by a new, additive pg_cron job.
-- Both passes no-op when critical_push_enabled is false, so the cron job existing is inert.
-- ---------------------------------------------------------------------------------------------
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
          'title', 'System Issues',
          'body', 'A critical issue was detected. Open System Issues to view details.',
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

-- Additive cron job only - no existing schedule is touched. Payload-free, service-internal.
select cron.schedule('system-push-outbox-process', '* * * * *', $$select public._system_push_outbox_process();$$);

do $$
begin
  if not exists (select 1 from public.system_monitoring_config where key = 'critical_push_enabled' and value = 'false'::jsonb) then
    raise exception 'self-check: critical_push_enabled must default to false';
  end if;
  if (select count(*) from cron.job where jobname = 'system-push-outbox-process') <> 1 then
    raise exception 'self-check: expected exactly one system-push-outbox-process cron job';
  end if;
  if has_function_privilege('authenticated', 'public._system_push_outbox_process(integer)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public._system_issues_critical_push_enqueue()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: internal push functions must not be executable by authenticated';
  end if;
end $$;
