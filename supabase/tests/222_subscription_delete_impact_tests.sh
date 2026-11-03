#!/usr/bin/env bash
# Deleting a subscription moves covered sessions to regular price, with a reviewed impact. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
owed() { su -c "select coalesce(sum(case when c.covered then 0 else public.session_billing_price_ils(r.session_id,r.user_id,null) end),0) from public.session_registrations r left join public.subscription_registration_coverage c on c.registration_id=r.id where r.id='$1' and r.attended"; }

setup() { # attended covered history and one future booking
  mkuser athlete; A=$U; mksub "$A" "$(d -30)" 2
  mksession "$(d -3)"; SP=$SX; past_reg "$A" "$SP" null; RP=$REG
  W=$(su -c "select date '$(d -3)' - extract(dow from date '$(d -3)')::int")
  su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$RP','$(d -3)','$W','group',true,'registration')" >/dev/null
  mark "$RP" true
}

echo "== Preview shows the sessions, prices, charges; nothing changes"
setup
su -c "insert into public.session_roster_slot_prices(session_id,user_id,price_ils) values ('$SP','$A',70)" >/dev/null 2>&1
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;")
expect "preview" "preview" "$(jf "$R" action)"
expect "one historical session" "1" "$(su -c "select jsonb_array_length(('$R'::jsonb)->'history_sessions')")"
expect "its price" "70.00" "$(jf "$R" history_sessions,0,regular_price_ils)"
expect "new debt" "70.00" "$(jf "$R" new_debt_ils)"
expect "charges to reverse" "360.00" "$(jf "$R" charges_to_reverse_ils)"
expect "nothing changed: still covered" "true:" "$(cov "$RP")"
expect "nothing changed: not deleted" "" "$(su -c "select deleted_at from public.subscriptions where id='$SUB'")"
FP=$(jf "$R" fingerprint)

echo "== Confirming needs the fingerprint of what the manager saw"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true)::text;")
expect "refused without it" "delete_impact_changed" "$(jf "$R" error)"
su -c "update public.session_roster_slot_prices set price_ils=80 where session_id='$SP' and user_id='$A'" >/dev/null
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$FP')::text;")
expect "refused when the price changed" "delete_impact_changed" "$(jf "$R" error)"
FP=$(jf "$R" fingerprint)
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$FP')::text;")
expect "tombstoned" "tombstoned" "$(jf "$R" action)"; expect "repriced" "1" "$(jf "$R" sessions_repriced)"
expect "session is regular price" "false:subscription_deleted" "$(cov "$RP")"
expect "Reports now price it" "80.00" "$(owed "$RP")"
expect "charges net to zero" "0.00" "$(charges "$SUB")"
expect "audit: per-session record" "1" "$(su -c "select count(*) from public.subscription_impact_event_registrations er join public.subscription_impact_events e on e.id=er.event_id where e.subscription_id='$SUB' and e.action_type='delete' and er.registration_id='$RP'")"
expect "audit: activity event" "1" "$(su -c "select count(*) from public.user_activity_events where event_type='subscription_deleted' and target_id='$SUB'")"

echo "== Repeating and later attendance edits change nothing"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$FP')::text;")
expect "repeat" "already_deleted" "$(jf "$R" action)"; expect "no second reversal" "0.00" "$(charges "$SUB")"
mark "$RP" false; mark "$RP" true
expect "attendance edit keeps the result" "false:subscription_deleted" "$(cov "$RP")"

echo "== A session with a receipt is not repriced"
setup
su -c "update public.session_registrations set amount_paid=50, payment_method='cash' where id='$RP'" >/dev/null
su -c "insert into public.external_manual_receipts (row_kind, record_id, note) values ('session_reg','$RP','test')" >/dev/null
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;")
expect "flagged" "true" "$(jf "$R" history_sessions,0,has_receipt)"; expect "counted" "1" "$(jf "$R" receipt_locked_count)"; expect "no new debt" "0" "$(jf "$R" new_debt_ils)"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$(jf "$R" fingerprint)')::text;")
expect "kept and reported" "1" "$(jf "$R" sessions_receipt_locked)"
expect "stays covered" "true:" "$(cov "$RP")"

echo "== A recorded payment still blocks deletion"
setup
api "$M" "select public.record_subscription_payment('$SUB',100,'cash',null,null,null,null);" >/dev/null
R=$(api "$M" "select public.subscription_delete_impact('$SUB')::text;"); expect "impact warns first" "1" "$(jf "$R" blocking_payments_count)"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;"); expect "blocked" "subscription_has_payments" "$(jf "$R" error)"

echo "== The old entry point cannot skip the review"
setup
R=$(api "$M" "select public.delete_subscription('$SUB')::text;"); expect "previews" "preview" "$(jf "$R" action)"
expect "not deleted" "" "$(su -c "select deleted_at from public.subscriptions where id='$SUB'")"

echo "== Future bookings use the manager's choice, on top of the history"
setup
mksession "$(wk 1 1)"; SF=$SX; register "$A" "$SF"; RF=$REG
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;")
expect "both listed" "1|1" "$(jf "$R" history_sessions | wc -l | tr -d ' ')|$(jf "$R" future_registrations_count)"
R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB','remove',true,ARRAY['$RF']::uuid[],ARRAY[]::uuid[],'$(jf "$R" fingerprint)')::text;")
expect "tombstoned" "tombstoned" "$(jf "$R" action)"; expect "removed" "cancelled" "$(su -c "select status from public.session_registrations where id='$RF'")"

echo "== Permissions"
setup
for who in "$A" "$CO"; do
  contains "impact refused" "forbidden" "$(api "$who" "select public.subscription_delete_impact('$SUB')::text;")"
  contains "delete refused" "forbidden" "$(api "$who" "select public.delete_subscription_with_future_registrations('$SUB',null,true)::text;")"
done
contains "anon cannot execute" "permission denied" "$(api_as anon "" "select public.subscription_delete_impact('$SUB')::text;")"

finish
