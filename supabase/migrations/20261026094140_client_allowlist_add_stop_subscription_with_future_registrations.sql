-- Client error-reporting allowlist: add the one new reviewed-technical outcome introduced by
-- 20261026180000 (stop_subscription_with_future_registrations's no_current_version, same invariant-
-- violation meaning as the pre-existing stop_subscription seed entry it sits beside). Client ingestion
-- stays disabled (client_ingest_enabled is not touched) -- this only keeps the server-side allowlist
-- exhaustive for when it is eventually turned on, matching mobile's registry.ts classification.
-- Follows the exact seeding pattern established by 20261015100000 (same columns, same ON CONFLICT
-- idempotency guard); nothing else in that migration is touched.

insert into public.system_issue_rules
  (priority, match_source, match_operation, match_error_class, match_error_code, action, set_subsystem, set_title,
   severity_cap, authorizes_client, note)
select 100, 'client', v.op, v.cls, v.code, 'classify', v.subsys, v.title, 'warning', true,
       'Phase 3E.2 seed follow-up (20261026094140): reviewed technical failure approved for client reporting'
from (values
  ('rpc/stop_subscription_with_future_registrations', 'RpcOutcome', 'no_current_version', 'rpc', 'RPC technical outcome: stop_subscription_with_future_registrations (no_current_version)')
) as v(op, cls, code, subsys, title)
on conflict (match_operation, match_error_class, match_error_code) where authorizes_client do nothing;

do $$
begin
  if not exists (
    select 1 from public.system_issue_rules
    where authorizes_client and enabled
      and match_operation = 'rpc/stop_subscription_with_future_registrations'
      and match_error_class = 'RpcOutcome' and match_error_code = 'no_current_version'
  ) then
    raise exception 'self-check: stop_subscription_with_future_registrations|no_current_version allowlist seed missing';
  end if;
end $$;
