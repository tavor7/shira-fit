-- Client error-reporting allowlist: the one new reviewed-technical outcome from the stop and delete flows, where the
-- resolver acted on fewer bookings than the checked list and the operation rolled back. Client ingestion stays as it is;
-- this keeps the server-side allowlist matching mobile's registry.ts, following the seeding pattern of 20261015100000.

insert into public.system_issue_rules
  (priority, match_source, match_operation, match_error_class, match_error_code, action, set_subsystem, set_title,
   severity_cap, authorizes_client, note)
select 100, 'client', v.op, v.cls, v.code, 'classify', v.subsys, v.title, 'warning', true,
       'Subscription remediation (20261104104000): reviewed technical failure approved for client reporting'
from (values
  ('rpc/stop_subscription_with_future_registrations', 'RpcOutcome', 'future_registrations_not_resolved', 'rpc', 'RPC technical outcome: stop_subscription_with_future_registrations|future_registrations_not_resolved'),
  ('rpc/stop_subscription', 'RpcOutcome', 'future_registrations_not_resolved', 'rpc', 'RPC technical outcome: stop_subscription|future_registrations_not_resolved'),
  ('rpc/delete_subscription_with_future_registrations', 'RpcOutcome', 'future_registrations_not_resolved', 'rpc', 'RPC technical outcome: delete_subscription_with_future_registrations|future_registrations_not_resolved'),
  ('rpc/delete_subscription', 'RpcOutcome', 'future_registrations_not_resolved', 'rpc', 'RPC technical outcome: delete_subscription|future_registrations_not_resolved')
) as v(op, cls, code, subsys, title)
on conflict (match_operation, match_error_class, match_error_code) where authorizes_client do nothing;

do $$
begin
  if (select count(*) from public.system_issue_rules
      where authorizes_client and enabled and match_error_class = 'RpcOutcome'
        and match_error_code = 'future_registrations_not_resolved') <> 4 then
    raise exception 'self-check: future_registrations_not_resolved allowlist seeds missing';
  end if;
end $$;
