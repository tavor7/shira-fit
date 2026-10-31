-- Client error-reporting allowlist: add the one reviewed-technical outcome introduced by
-- correct_subscription_start_date_with_future_registrations (20261031170919) -- no_current_version,
-- same invariant-violation meaning as every other seed entry for that code. Client ingestion stays
-- disabled -- this only keeps the server-side allowlist exhaustive for when it is eventually turned
-- on, matching mobile's registry.ts classification. Follows the exact seeding pattern established
-- by 20261015100000 / 20261026094140 / 20261031163000. has_history is classified "business"
-- (expected rejection), not technical, so it needs no seed row here.

insert into public.system_issue_rules
  (priority, match_source, match_operation, match_error_class, match_error_code, action, set_subsystem, set_title,
   severity_cap, authorizes_client, note)
select 100, 'client', v.op, v.cls, v.code, 'classify', v.subsys, v.title, 'warning', true,
       'Phase 3E.2 seed follow-up (20261031171500): reviewed technical failure approved for client reporting'
from (values
  ('rpc/correct_subscription_start_date_with_future_registrations', 'RpcOutcome', 'no_current_version', 'rpc', 'RPC technical outcome: correct_subscription_start_date_with_future_registrations (no_current_version)')
) as v(op, cls, code, subsys, title)
on conflict (match_operation, match_error_class, match_error_code) where authorizes_client do nothing;

do $$
begin
  if not exists (
    select 1 from public.system_issue_rules
    where authorizes_client and enabled
      and match_operation = 'rpc/correct_subscription_start_date_with_future_registrations'
      and match_error_class = 'RpcOutcome' and match_error_code = 'no_current_version'
  ) then
    raise exception 'self-check: correct_subscription_start_date_with_future_registrations|no_current_version allowlist seed missing';
  end if;
end $$;
