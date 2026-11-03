-- 90-day retention for web_push_delivery_log: only old rows of this one table go. Rolls back. LOCAL stack only.
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_user uuid := gen_random_uuid();
  v_sub uuid;
  v_removed integer;
  v_before_other bigint;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't210-' || v_user || '@t.local', now(), now());
  insert into public.web_push_subscriptions (user_id, endpoint, p256dh, auth) values (v_user, 'https://push.invalid/' || v_user, 'k', 'a') returning id into v_sub;
  insert into public.web_push_delivery_log (user_id, subscription_id, outcome, created_at) values
    (v_user, v_sub, 'sent', now() - interval '91 days'),
    (v_user, v_sub, 'failed', now() - interval '90 days 1 minute'),
    (v_user, v_sub, 'sent', now() - interval '89 days'),
    (v_user, v_sub, 'sent', now());
  insert into public.manager_direct_messages (sender_id, recipient_id, body, created_at)
  select v_user, (select user_id from public.profiles where user_id <> v_user limit 1), 'old', now() - interval '400 days'
  where exists (select 1 from public.profiles where user_id <> v_user);
  select count(*) into v_before_other from public.manager_direct_messages;

  v_removed := public._web_push_delivery_log_prune();
  if v_removed <> 2 then raise exception 'A FAILED: expected 2 removed, got %', v_removed; end if;
  if (select count(*) from public.web_push_delivery_log where user_id = v_user) <> 2 then raise exception 'B FAILED: recent rows must stay'; end if;
  if (select count(*) from public.web_push_subscriptions where id = v_sub) <> 1 then raise exception 'C FAILED: subscriptions must stay'; end if;
  if (select count(*) from public.manager_direct_messages) <> v_before_other then raise exception 'D FAILED: other history must stay'; end if;
  raise notice 'retention PASSED';

  if public._web_push_delivery_log_prune() <> 0 then raise exception 'E FAILED: a second run must remove nothing'; end if;
  raise notice 'idempotent PASSED';

  if has_function_privilege('authenticated', 'public._web_push_delivery_log_prune()', 'execute')
     or has_function_privilege('anon', 'public._web_push_delivery_log_prune()', 'execute') then
    raise exception 'F FAILED: not callable by clients';
  end if;
  if not exists (select 1 from cron.job where jobname = 'web-push-delivery-log-retention' and command = 'select public._web_push_delivery_log_prune();') then
    raise exception 'G FAILED: cron job missing';
  end if;
  raise notice 'privileges and schedule PASSED';
end $$;
rollback;
