#!/usr/bin/env bash
# Cancelling the same session twice leaves two cancellation rows, which is valid history. Reconcile, and so attendance, cancelling
# and subscription changes, must keep working for that person in every week, with coverage and money unchanged. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
OLD=$(lastsun 8)
# Two cancellations of one old session, the shape found in production. The session is not in any week under test.
repeat_cancel() { mksession "$OLD"; su -c "insert into public.session_registrations (session_id,user_id,status) values ('$SX','$1','cancelled');
  insert into public.cancellations (session_id,user_id,reason,charged_full_price,penalty_collected_ils) values ('$SX','$1','a',false,0),('$SX','$1','b',false,0)" >/dev/null; }
newsub() { mkuser athlete; A=$U; mksub "$A" "$(lastsun 1)" "$1"; repeat_cancel "$A"; }
book() { mksession "$1"; S=$SX; register "$A" "$S"; }
att() { api "$1" "select public.set_registration_attendance('$2','$3','$4',null,null,${5:-false})::text;"; }
attended() { su -c "select coalesce(attended::text,'null') from public.session_registrations where session_id='$1' and user_id='$2'"; }
money() { su -c "select (select coalesce(sum(amount_ils),0) from public.subscription_charges c join public.subscriptions s on s.id=c.subscription_id where s.payee_id='$1')
  ||'|'||(select coalesce(sum(amount_ils),0) from public.athlete_account_payments where payee_id='$1')
  ||'|'||(select coalesce(sum(amount_paid),0) from public.session_registrations where user_id='$1')
  ||'|'||(select coalesce(sum(penalty_collected_ils),0) from public.cancellations where user_id='$1')"; }
same_money() { local now; now=$(money "$A"); case "$M0" in *\|*\|*\|*) expect "$1" "$M0" "$now";; *) fail "$1: no balance could be read: [$M0]";; esac; }
# role session status expected-attended expected-coverage [charge]
step() { R=$(att "$1" "$S" "$A" "$2" "${5:-false}"); contains "$2: accepted" '"ok" : true' "$R"; expect "$2: attendance" "$3" "$(attended "$S" "$A")"; expect "$2: coverage" "$4" "$(cov "$REG")"; }

echo "the reported failure: an athlete with a repeat cancellation in another week"
newsub 2; book "$(wk 0 1)"; M0=$(money "$A")
expect "booked as covered" "true:" "$(cov "$REG")"
step "$M" arrived true "true:"
E0=$(su -c "select count(*) from public.user_activity_events where target_id='$REG'")
step "$M" arrived true "true:"
expect "a repeated update logs nothing new" "$E0" "$(su -c "select count(*) from public.user_activity_events where target_id='$REG'")"
step "$M" absent false "false:no_show_released"
step "$M" absent false "true:" true
step "$M" unset null "true:"
same_money "no money moved"

echo "coach"
step "$CO" arrived true "true:"
step "$CO" absent false "false:no_show_released"
step "$CO" unset null "true:"
same_money "no money moved"
mkuser coach; R=$(att "$U" "$S" "$A" arrived); contains "another coach is refused" 'forbidden' "$R"
expect "and nothing changed" "null" "$(attended "$S" "$A")"
mkuser athlete; R=$(att "$U" "$S" "$A" arrived); contains "an athlete is refused" 'forbidden' "$R"

echo "no subscription"
mkuser athlete; A=$U; repeat_cancel "$A"; mksession "$(wk 0 1)"; S=$SX; past_reg "$A" "$S"
step "$M" arrived true "none"; step "$M" unset null "none"

echo "several versions of one subscription"
newsub 2; book "$(wk 1 1)"
R=$(api "$M" "select public.edit_subscription_version('$SUB','$(wk 1 0)',null,null,false,jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',3)),true)::text;")
expect "the edit is accepted for this athlete" "true" "$(jf "$R" ok)"
expect "two versions" "2" "$(su -c "select count(*) from public.subscription_versions where subscription_id='$SUB'")"
step "$M" arrived true "true:"; step "$M" unset null "true:"
expect "the session is on the newer version" "1" "$(su -c "select count(*) from public.subscription_registration_coverage c join public.subscription_versions v on v.id=c.version_id where c.registration_id='$REG' and v.version_no=2")"

echo "several subscriptions of one person, and an overlapping one"
newsub 2; FIRST=$SUB
R=$(api "$M" "select public.create_subscription('$A', false, 360, '$(wk 0 0)', null, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
expect "an overlapping subscription is refused, so entitlement is not ambiguous" "false" "$(su -c "select coalesce(('$R'::jsonb)->>'ok','false')")"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$FIRST','$(wk 0 6)',true,null)::text;"); expect "the first is stopped" "true" "$(jf "$R" ok)"
mksub "$A" "$(wk 1 0)" 2; expect "a second one follows it" "2" "$(su -c "select count(*) from public.subscriptions where payee_id='$A' and deleted_at is null")"
book "$(wk 1 1)"; expect "covered by the second" "$SUB" "$(su -c "select subscription_id from public.subscription_registration_coverage where registration_id='$REG'")"
step "$M" arrived true "true:"; step "$M" absent false "false:no_show_released"; step "$M" unset null "true:"
expect "still the second" "$SUB" "$(su -c "select subscription_id from public.subscription_registration_coverage where registration_id='$REG'")"

echo "over the allowance"
newsub 1; book "$(wk 0 1)"; S1=$S; R1=$REG; book "$(wk 0 2)"; S2=$S; R2=$REG
expect "the first is covered" "true:" "$(cov "$R1")"; expect "the second is over" "false:allowance_exceeded" "$(cov "$R2")"; M0=$(money "$A")
step "$M" arrived true "false:allowance_exceeded"; step "$M" arrived true "false:allowance_exceeded"
S=$S1; REG=$R1; step "$M" arrived true "true:"
expect "the allowance is not exceeded" "1" "$(su -c "select count(*) from public.subscription_registration_coverage where registration_id in ('$R1','$R2') and covered")"
same_money "no money moved"

echo "freeze and stop"
newsub 2; book "$(wk 2 1)"; M0=$(money "$A")
R=$(api "$M" "select public.freeze_subscription('$SUB','$(wk 2 0)','$(wk 2 6)',true)::text;"); expect "the freeze is accepted for this athlete" "true" "$(jf "$R" ok)"
expect "frozen" "false:frozen" "$(cov "$REG")"
step "$M" arrived true "false:frozen"; step "$M" unset null "false:frozen"
same_money "no money moved by attendance"
newsub 2; book "$(wk 2 1)"
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$(wk 1 6)',true,'charge_regular_price',ARRAY['$REG']::uuid[],ARRAY[]::uuid[])::text;"); expect "the stop is accepted for this athlete" "true" "$(jf "$R" ok)"
AFTER=$(cov "$REG"); case "$AFTER" in false:*) ok "uncovered by the stop";; *) fail "uncovered by the stop: got $AFTER";; esac
step "$M" arrived true "$AFTER"; step "$M" unset null "$AFTER"

echo "a completed session keeps its coverage"
newsub 2; D=$(su -c "select (date '$TODAY' - 2)::date"); mksession "$D"; S=$SX; past_reg "$A" "$S" true
su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$REG','$D',(date '$D' - extract(dow from date '$D')::int)::date,'group',true,'registration')" >/dev/null
R=$(api "$M" "select public.stop_subscription_with_future_registrations('$SUB','$TODAY',true,null)::text;"); expect "stopped afterwards" "true" "$(jf "$R" ok)"
expect "still covered" "true:" "$(cov "$REG")"
step "$M" arrived true "true:"

echo "cancel, rebook and cancel again, through the real calls"
mkuser athlete; A=$U; mksub "$A" "$(lastsun 1)" 2; book "$(wk 3 1)"
for n in 1 2; do
  R=$(api "$A" "select public.cancel_registration('$S','reason $n')::text;"); contains "cancel $n accepted" '"ok" : true' "$R"
  [ "$n" = 1 ] && { register "$A" "$S"; contains "rebooked" '"ok" : true' "$R"; }
done
expect "both cancellations are kept" "2" "$(su -c "select count(*) from public.cancellations where session_id='$S' and user_id='$A'")"
book "$(wk 3 2)"; step "$M" arrived true "true:"

echo "money collected on any of the cancellations still blocks a silent credit"
for pair in "20 30:false:paid_at_regular_price" "0 0:true:"; do
  amounts=${pair%%:*}; want=${pair#*:}; set -- $amounts
  newsub 1; book "$(wk 0 1)"; S1=$S; R1=$REG; book "$(wk 0 2)"; S2=$S; R2=$REG
  su -c "insert into public.cancellations (session_id,user_id,reason,charged_full_price,penalty_collected_ils) values ('$S2','$A','a',false,$1),('$S2','$A','b',false,$2)" >/dev/null
  S=$S1; REG=$R1; step "$M" absent false "false:no_show_released"
  expect "penalties $amounts: the session that was over the allowance" "$want" "$(cov "$R2")"
  expect "penalties stay as recorded" "$(( $1 + $2 ))" "$(su -c "select sum(penalty_collected_ils)::int from public.cancellations where session_id='$S2' and user_id='$A'")"
done

finish
