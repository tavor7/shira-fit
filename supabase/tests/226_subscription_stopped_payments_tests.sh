#!/usr/bin/env bash
# Decision A: a stopped subscription can receive money it still owes, and nothing else changes. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
pay() { api "$M" "select public.record_subscription_payment('$1',$2,'cash',null,null,${3:-null},${4:-null})::text;"; }
owed() { su -c "select public._subscription_outstanding('$1')"; }
stopped() { # -> A, SUB, VER with a ₪360 charge, stopped yesterday
  mkuser athlete; A=$U; mksub "$A" "$(d -20)" 2
  api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$TODAY',true,null);" >/dev/null
}
state() { su -c "select (select count(*) from public.subscription_billing_periods where subscription_id='$1') || '|' || (select count(*) from public.subscription_charges where subscription_id='$1') || '|' || public.subscription_version_display_status((select id from public.subscription_versions where subscription_id='$1' and effective_to is null),'$TODAY') || '|' || coalesce(public.subscription_effective_next_billing_date('$1')::text,'none')"; }

echo "== Full payment"
stopped; OWED=$(owed "$SUB"); BEFORE=$(state "$SUB")
contains "owes something" "." "$OWED"
R=$(pay "$SUB" "$OWED"); expect "accepted" "true" "$(jf "$R" ok)"
expect "linked to the subscription" "$SUB" "$(su -c "select source_subscription_id from public.athlete_account_payments where id='$(jf "$R" payment_id)'")"
expect "settled" "0.00" "$(owed "$SUB")"
expect "no new period, charge or status change" "$BEFORE" "$(state "$SUB")"
expect "still stopped" "stopped" "$(su -c "select public.subscription_version_display_status(id,'$TODAY') from public.subscription_versions where subscription_id='$SUB' and effective_to is null")"
expect "not in the active list" "0" "$(api "$M" "select count(*) from public.list_active_subscriptions() where subscription_id='$SUB';")"
R=$(pay "$SUB" 1); expect "nothing left to pay" "no_outstanding_balance" "$(jf "$R" error)"

echo "== Coverage and allowance stay gone"
mksession "$(wk 2 0)"; SX2=$SX; register "$A" "$SX2"; REGX=$REG
expect "new booking is not covered" "none" "$(cov "$REGX")"

echo "== Partial payments up to the balance"
stopped; OWED=$(owed "$SUB")
R=$(pay "$SUB" 100); expect "partial accepted" "true" "$(jf "$R" ok)"
LEFT=$(su -c "select $OWED - 100")
expect "balance reduced" "$LEFT" "$(owed "$SUB")"
R=$(pay "$SUB" "$(su -c "select $LEFT + 1")"); expect "overpayment refused" "amount_exceeds_outstanding" "$(jf "$R" error)"
expect "refusal says what is owed" "$LEFT" "$(jf "$R" outstanding_ils)"
R=$(pay "$SUB" "$LEFT"); expect "rest accepted" "true" "$(jf "$R" ok)"

echo "== No debt, or an existing credit"
mkuser athlete; A=$U; mksub "$A" "$(d -20)" 2; api "$M" "select public.record_subscription_payment('$SUB',500,'cash',null,null,'$(d -10)',null);" >/dev/null
api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$TODAY',true,null);" >/dev/null
R=$(pay "$SUB" 10); expect "credit: refused" "no_outstanding_balance" "$(jf "$R" error)"
expect "credit left alone" "t" "$(su -c "select public._subscription_outstanding('$SUB') < 0")"
expect "Add Payment does not offer it" "" "$(api "$M" "select public.subscription_payment_target('$A',false,'$TODAY');")"

echo "== Add Payment offers a stopped subscription that owes"
stopped; BASE=$(owed "$SUB"); expect "offered" "$SUB" "$(api "$M" "select public.subscription_payment_target('$A',false,'$TODAY');")"
expect "not for a future date" "" "$(api "$M" "select public.subscription_payment_target('$A',false,'$(d 3)');")"
R=$(pay "$SUB" 10 "'$(d 3)'"); expect "future-dated refused" "subscription_not_eligible_for_date" "$(jf "$R" error)"

echo "== General account payments are not limited"
R=$(api "$M" "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at) values ('$A',false,9999,'cash','$TODAY') returning amount_ils;")
expect "allowed" "9999.00" "$R"
expect "does not touch the subscription balance" "$BASE" "$(owed "$SUB")"

echo "== A direct write cannot exceed it"
contains "direct insert over the balance" "amount_exceeds_outstanding" "$(api "$M" "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at,source_subscription_id) values ('$A',false,$(su -c "select $BASE + 1"),'cash','$TODAY','$SUB');")"
R=$(pay "$SUB" 100); P=$(jf "$R" payment_id)
contains "editing past the balance" "amount_exceeds_outstanding" "$(api "$M" "update public.athlete_account_payments set amount_ils=$(su -c "select $BASE + 1") where id='$P';")"
api "$M" "update public.athlete_account_payments set amount_ils=200 where id='$P';" >/dev/null
expect "edit within it works" "$(su -c "select $BASE - 200")" "$(owed "$SUB")"

echo "== Duplicate submission and concurrent payments"
stopped; TOK=$(su -c "select gen_random_uuid()"); OWED=$(owed "$SUB")
R1=$(pay "$SUB" 100 null "'$TOK'"); R2=$(pay "$SUB" 100 null "'$TOK'")
expect "retry reports the duplicate" "true" "$(jf "$R2" duplicate)"; expect "same payment" "$(jf "$R1" payment_id)" "$(jf "$R2" payment_id)"
expect "counted once" "$(su -c "select $OWED - 100")" "$(owed "$SUB")"
stopped; OWED=$(owed "$SUB"); T=$(mktemp -d)
for i in 1 2 3; do pay "$SUB" "$OWED" > "$T/$i" & done; wait
expect "exactly one accepted" "1" "$(cat "$T"/* | grep -cE '"payment_id"')"
expect "exactly one recorded" "1" "$(su -c "select count(*) from public.athlete_account_payments where source_subscription_id='$SUB' and reversed_at is null")"
expect "not overpaid" "0.00" "$(owed "$SUB")"
rm -rf "$T"

echo "== Reversal restores the balance, and the money can be paid again"
stopped; OWED=$(owed "$SUB"); R=$(pay "$SUB" "$OWED"); P=$(jf "$R" payment_id)
contains "cannot hard-delete" "subscription_payment_use_reversal" "$(api "$M" "delete from public.athlete_account_payments where id='$P';")"
R=$(api "$M" "select public.manager_reverse_account_payment('$P','wrong person')::text;"); expect "reversed" "true" "$(jf "$R" ok)"
expect "owed again" "$OWED" "$(owed "$SUB")"
expect "audit event" "1" "$(su -c "select count(*) from public.user_activity_events where event_type='account_payment_reversed' and target_id='$P'")"
R=$(pay "$SUB" "$OWED"); expect "payable again" "true" "$(jf "$R" ok)"

echo "== Reports and detail agree"
J=$(api "$M" "select public.manager_subscription_overview_stats('$TODAY','$TODAY')::text;")
expect "paid today counted in period" "t" "$(su -c "select (('$J'::jsonb)->>'payments_total_ils')::numeric >= $OWED")"
expect "breakdown shows it settled" "0.00" "$(api "$M" "select outstanding_ils from public.manager_subscription_overview_breakdown() where subscription_id='$SUB';")"

echo "== Ended subscriptions: same safeguards, nothing reactivated"
ended() { mkuser athlete; A=$U; mksub "$A" "$(d -40)" 2 360 "$(d -3)"; }
ended; OWED=$(owed "$SUB"); BEFORE=$(state "$SUB")
expect "it owes" "t" "$(su -c "select $OWED > 0")"
contains "it reads as completed" "completed" "$BEFORE"
expect "offered by Add Payment" "$SUB" "$(api "$M" "select public.subscription_payment_target('$A',false,'$TODAY');")"
expect "not for a future date" "" "$(api "$M" "select public.subscription_payment_target('$A',false,'$(d 3)');")"
R=$(pay "$SUB" 10 "'$(d 3)'"); expect "future-dated refused" "subscription_not_eligible_for_date" "$(jf "$R" error)"
R=$(pay "$SUB" "$(su -c "select $OWED + 1")"); expect "overpayment refused" "amount_exceeds_outstanding" "$(jf "$R" error)"
expect "refusal says what is owed" "$OWED" "$(jf "$R" outstanding_ils)"
TOK=$(su -c "select gen_random_uuid()"); R1=$(pay "$SUB" 50 null "'$TOK'"); R2=$(pay "$SUB" 50 null "'$TOK'")
expect "partial accepted" "true" "$(jf "$R1" ok)"; expect "retry is the same payment" "$(jf "$R1" payment_id)" "$(jf "$R2" payment_id)"
expect "counted once" "$(su -c "select $OWED - 50")" "$(owed "$SUB")"
P=$(jf "$R1" payment_id); R=$(api "$M" "select public.manager_reverse_account_payment('$P','wrong person')::text;"); expect "reversible" "true" "$(jf "$R" ok)"
expect "balance restored" "$OWED" "$(owed "$SUB")"
contains "direct insert over the balance" "amount_exceeds_outstanding" "$(api "$M" "insert into public.athlete_account_payments(payee_id,payee_is_manual,amount_ils,payment_method,paid_at,source_subscription_id) values ('$A',false,$(su -c "select $OWED + 1"),'cash','$TODAY','$SUB');")"
R=$(pay "$SUB" "$OWED"); expect "full payment accepted" "true" "$(jf "$R" ok)"; P=$(jf "$R" payment_id)
expect "settled" "0.00" "$(owed "$SUB")"
R=$(pay "$SUB" 1); expect "nothing left to pay" "no_outstanding_balance" "$(jf "$R" error)"
expect "no longer offered" "" "$(api "$M" "select public.subscription_payment_target('$A',false,'$TODAY');")"
expect "no new period, charge, status change or billing date" "$BEFORE" "$(state "$SUB")"
expect "not in the active list" "0" "$(api "$M" "select count(*) from public.list_active_subscriptions() where subscription_id='$SUB';")"
mksession "$(wk 2 0)"; register "$A" "$SX"; expect "a new booking is not covered" "none" "$(cov "$REG")"
for who in "$A" "$CO"; do contains "refused" "forbidden" "$(api "$who" "select public.record_subscription_payment('$SUB',1,'cash',null,null,null,null)::text;")"; done

echo "== Ended: concurrent payments cannot overpay"
ended; OWED=$(owed "$SUB"); T=$(mktemp -d)
for i in 1 2 3; do pay "$SUB" "$OWED" > "$T/$i" & done; wait
expect "exactly one accepted" "1" "$(cat "$T"/* | grep -cE '"payment_id"')"
expect "not overpaid" "0.00" "$(owed "$SUB")"
rm -rf "$T"

echo "== Ended: a credit is left alone, and lowering an old payment still works"
mkuser athlete; A=$U; mksub "$A" "$(d -40)" 2 360; R=$(pay "$SUB" 9000 "'$(d -35)'"); P=$(jf "$R" payment_id)
su -c "update public.subscription_versions set plan_end_date='$(d -3)' where id='$VER'" >/dev/null
R=$(pay "$SUB" 10); expect "credit: refused" "no_outstanding_balance" "$(jf "$R" error)"
expect "lowering a recorded amount works" "8000.00" "$(api "$M" "update public.athlete_account_payments set amount_ils=8000 where id='$P' returning amount_ils;")"

echo "== An end date moved by a freeze has not passed yet"
mkuser athlete; A=$U; mksub "$A" "$(d -40)" 2 360 "$(d -1)"
api "$M" "select public.freeze_subscription('$SUB','$(d -5)','$(d 5)',true);" >/dev/null
expect "the freeze moved the end" "t" "$(su -c "select public.subscription_shifted_date('$SUB','$(d -1)') >= '$TODAY'")"
R=$(pay "$SUB" "$(su -c "select greatest(public._subscription_outstanding('$SUB'),0) + 100")"); expect "still an ordinary payment, not capped" "true" "$(jf "$R" ok)"

echo "== Before the end date, nothing changes"
mkuser athlete; A=$U; mksub "$A" "$(d -10)" 2 360 "$(d 5)"
R=$(pay "$SUB" 5000); expect "advance payment still allowed" "true" "$(jf "$R" ok)"
R=$(pay "$SUB" 10 "'$(d 7)'"); expect "dated after the end: refused" "subscription_not_eligible_for_date" "$(jf "$R" error)"

echo "== Only managers"
stopped
for who in "$A" "$CO"; do contains "refused" "forbidden" "$(api "$who" "select public.record_subscription_payment('$SUB',1,'cash',null,null,null,null)::text;")"; done
contains "anon refused" "permission denied" "$(api_as anon "" "select public.record_subscription_payment('$SUB',1,'cash',null,null,null,null)::text;")"
finish
