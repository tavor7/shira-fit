#!/usr/bin/env bash
# Subscription records can only change through their RPCs, and legitimate workflows still work. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
mkuser athlete; A=$U; mkuser athlete; OTHER=$U; mksub "$A" "$TODAY" 2; CH=$(su -c "select id from public.subscription_charges where subscription_id='$SUB' limit 1")
denied() { contains "$1" "denied" "$2"; }

echo "== Managers cannot write subscription tables directly"
for t in subscriptions subscription_versions subscription_version_allowances subscription_billing_periods subscription_charges subscription_freezes subscription_registration_coverage subscription_impact_events subscription_impact_event_registrations; do
  col=$(su -c "select column_name from information_schema.columns where table_schema='public' and table_name='$t' order by ordinal_position limit 1")
  denied "manager update $t" "$(api "$M" "update public.$t set $col = $col where true;")"
  denied "manager delete $t" "$(api "$M" "delete from public.$t where true;")"
  denied "manager truncate $t" "$(api "$M" "truncate public.$t cascade;")"
  expect "manager still reads $t" "true" "$(api "$M" "select (select count(*) from public.$t) >= 0;" | sed 's/^t$/true/')"
done
denied "manager insert charge" "$(api "$M" "insert into public.subscription_charges(billing_period_id,subscription_id,payee_id,payee_is_manual,amount_ils,charge_type) select billing_period_id,subscription_id,payee_id,payee_is_manual,-1,'reversal' from public.subscription_charges where id='$CH';")"

echo "== The ledger is append-only even for an owner connection"
contains "owner update refused" "subscription_ledger_append_only" "$($PSQL -qAt -c "update public.subscription_charges set amount_ils=1 where id='$CH'" 2>&1)"
contains "owner delete refused" "subscription_record_immutable" "$($PSQL -qAt -c "delete from public.subscription_charges where id='$CH'" 2>&1)"
expect "created_by may be cleared (profile deletion path)" "UPDATE 1" "$($PSQL -c "update public.subscription_charges set created_by=null where id='$CH'" 2>&1 | tail -1)"

echo "== Athletes and coaches see nothing and can do nothing"
for who in "$A" "$CO"; do
  expect "reads no charges" "0" "$(api "$who" "select count(*) from public.subscription_charges;")"
  expect "reads no coverage" "0" "$(api "$who" "select count(*) from public.subscription_registration_coverage;")"
  denied "cannot write" "$(api "$who" "delete from public.subscription_registration_coverage where true;")"
  for call in "create_subscription('$OTHER',false,1,'$TODAY',null,null,'[]'::jsonb)" "edit_subscription_version('$SUB','$TODAY',1,null,false,null,true)" "freeze_subscription('$SUB','$(d 40)','$(d 41)',true)" "stop_subscription_with_future_registrations('$SUB','$(d 40)',true)" "reactivate_subscription('$SUB','$(d 40)',null)" "record_subscription_payment('$SUB',1,'cash',null,null,null,null)" "get_subscription_detail('$SUB')" "manager_subscription_overview_stats('$TODAY','$TODAY')" "manager_subscription_week_utilization('$TODAY')"; do
    contains "${call%%(*} forbidden" "forbidden" "$(api "$who" "select public.$call::text;")"
  done
done

echo "== Anonymous clients cannot execute anything"
for call in "get_my_subscription()" "list_active_subscriptions()" "manager_subscription_week_utilization('$TODAY')" "manager_weekly_stats('$TODAY','week')" "record_subscription_payment('$SUB',1,'cash',null,null,null,null)"; do
  denied "anon ${call%%(*}" "$(api_as anon "" "select public.$call;")"
done
denied "anon reads charges" "$(api_as anon "" "select count(*) from public.subscription_charges;")"
denied "anon reads payments" "$(api_as anon "" "select count(*) from public.athlete_account_payments;")"
expect "no TRUNCATE for client roles" "false false" "$(su -c "select has_table_privilege('anon','public.subscription_charges','TRUNCATE') || ' ' || has_table_privilege('authenticated','public.athlete_account_payments','TRUNCATE')" | sed 's/f/false/g;s/t/true/g' | sed 's/falsealse/false/g')"

echo "== Legitimate manager workflows still work"
expect "manager lists" "t" "$(api "$M" "select count(*) >= 1 from public.list_active_subscriptions();")"
R=$(api "$M" "select public.record_subscription_payment('$SUB',100,'cash',null,null,null,null)::text;"); PAY=$(jf "$R" payment_id); expect "payment recorded" "true" "$(jf "$R" ok)"
R=$(api "$M" "select public.edit_subscription_version('$SUB','$(d 5)',400,null,false,null,true)::text;"); expect "edit works" "applied" "$(jf "$R" action)"

echo "== A subscription payment cannot be deleted or relinked, only reversed"
contains "delete refused" "subscription_payment_use_reversal" "$(api "$M" "delete from public.athlete_account_payments where id='$PAY';")"
contains "relink refused" "subscription_payment_link_immutable" "$(api "$M" "update public.athlete_account_payments set source_subscription_id=null where id='$PAY';")"
contains "wrong payee refused" "subscription_payment_wrong_payee" "$(api "$M" "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at,source_subscription_id) values ('$OTHER',false,5,'cash','$TODAY','$SUB');")"
R=$(api "$M" "select public.manager_reverse_account_payment('$PAY','wrong amount')::text;"); expect "reversal works" "true" "$(jf "$R" ok)"
expect "balance reflects it" "0" "$(su -c "select coalesce(sum(amount_ils),0) from public.athlete_account_payments where source_subscription_id='$SUB' and reversed_at is null")"
expect "history kept" "1" "$(su -c "select count(*) from public.athlete_account_payments where id='$PAY' and reversed_at is not null and reversed_by='$M'")"

echo "== Add Payment asks the same eligibility rule as the RPC"
expect "target found" "$SUB" "$(api "$M" "select public.subscription_payment_target('$A',false,'$TODAY');")"
expect "not for a non-manager" "" "$(api "$A" "select public.subscription_payment_target('$A',false,'$TODAY');")"

echo "== Monitoring"
contains "integrity check reports its two counters" "over_allocated_sessions" "$(su -c "select public._subscription_integrity_check()::text")"
finish
