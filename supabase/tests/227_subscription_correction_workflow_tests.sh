#!/usr/bin/env bash
# Decision B: receipt-locked sessions after a deletion wait for a manager's decision. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
docs() { su -c "select md5(coalesce(string_agg(d::text,'|' order by d.id),'')) from public.documents d where d.source_id='$1'"; }
owes() { su -c "select coalesce(sum(case when c.covered then 0 else public.session_billing_price_ils(r.session_id,r.user_id,null) end),0) from public.session_registrations r left join public.subscription_registration_coverage c on c.registration_id=r.id where r.id='$1' and r.attended"; }
setup() { # a subscription with one plain covered session and one covered, paid, receipted session
  mkuser athlete; A=$U; mksub "$A" "$(d -30)" 2
  W=$(lastsun 1); D1=$(su -c "select (date '$W'+1)::date"); D2=$(su -c "select (date '$W'+2)::date")
  mksession "$D1"; S1=$SX; past_reg "$A" "$S1"; R1=$REG
  mksession "$D2"; S2=$SX; past_reg "$A" "$S2"; R2=$REG
  su -c "update public.training_sessions set custom_slot_price_ils=80 where id in ('$S1','$S2');
    insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$R1','$D1','$W','group',true,'registration'),('$SUB','$VER','$R2','$D2','$W','group',true,'registration');
    update public.session_registrations set attended=true where id in ('$R1','$R2');
    update public.session_registrations set amount_paid=50, payment_method='cash' where id='$R2';
    insert into public.external_manual_receipts (row_kind, record_id, note) values ('session_reg','$R2','test')" >/dev/null
}
delete_sub() { R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;"); FP=$(jf "$R" fingerprint); R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$FP')::text;"); }
cid() { su -c "select id from public.subscription_deletion_corrections where subscription_id='$SUB'"; }

echo "== The preview separates what is repriced from what waits"
setup
R=$(api "$M" "select public.subscription_delete_impact('$SUB')::text;")
expect "one repriced" "1" "$(jf "$R" repriced_count)"; expect "one locked" "1" "$(jf "$R" receipt_locked_count)"
expect "debt from the repriced one only" "80.00" "$(jf "$R" new_debt_ils)"
expect "what the locked one would add" "80.00" "$(jf "$R" correction_debt_if_applied_ils)"
expect "the locked one shows its payment" "50.00" "$(su -c "select e->>'amount_paid_ils' from jsonb_array_elements(('$R'::jsonb)->'history_sessions') e where (e->>'has_receipt')::boolean")"
expect "and its receipt" "external" "$(su -c "select e#>>'{receipts,0,status}' from jsonb_array_elements(('$R'::jsonb)->'history_sessions') e where (e->>'has_receipt')::boolean")"
expect "preview wrote nothing" "0" "$(su -c "select count(*) from public.subscription_deletion_corrections where subscription_id='$SUB'")"

echo "== Deleting records the correction and leaves receipts and payments alone"
RECEIPT_BEFORE=$(su -c "select md5(e::text) from public.external_manual_receipts e where record_id='$R2'")
delete_sub
expect "repriced" "1" "$(jf "$R" sessions_repriced)"; expect "kept" "1" "$(jf "$R" sessions_receipt_locked)"
expect "plain session at regular price" "false:subscription_deleted" "$(cov "$R1")"
expect "locked session stays covered" "true:" "$(cov "$R2")"
expect "it is pending" "pending" "$(su -c "select status from public.subscription_deletion_corrections where subscription_id='$SUB'")"
expect "visible on the Overview" "t" "$(su -c "select ((api->>'pending_corrections_count')::int) >= 1 from (select '$(api "$M" "select public.manager_subscription_overview_stats('$TODAY','$TODAY')::text;")'::jsonb api) x")"
expect "listed for managers" "t" "$(api "$M" "select (public.manager_list_subscription_corrections(true)::jsonb->'corrections')::text like '%$(cid)%';")"
expect "owes nothing yet" "0" "$(owes "$R2")"

echo "== An attendance edit does not decide it"
mark "$R2" false; mark "$R2" true
expect "still covered" "true:" "$(cov "$R2")"
expect "still pending" "pending" "$(su -c "select status from public.subscription_deletion_corrections where subscription_id='$SUB'")"

echo "== Validation: nothing changes on a refused request"
C=$(cid)
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price',' ',80)::text;"); expect "reason needed" "reason_required" "$(jf "$R" error)"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','something','a reason',80)::text;"); expect "decision checked" "invalid_decision" "$(jf "$R" error)"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','a reason',70)::text;"); expect "stale price refused" "correction_changed" "$(jf "$R" error)"
R=$(api "$M" "select public.manager_resolve_subscription_correction(gen_random_uuid(),'applied_regular_price','a reason',80)::text;"); expect "unknown" "correction_not_found" "$(jf "$R" error)"
expect "still pending" "pending" "$(su -c "select status from public.subscription_deletion_corrections where id='$C'")"

echo "== Permissions"
for who in "$A" "$CO"; do
  contains "list refused" "forbidden" "$(api "$who" "select public.manager_list_subscription_corrections(true)::text;")"
  contains "decide refused" "forbidden" "$(api "$who" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','a reason',80)::text;")"
  expect "table unreadable" "0" "$(api "$who" "select count(*) from public.subscription_deletion_corrections;")"
done
contains "anon refused" "permission denied" "$(api_as anon "" "select public.manager_list_subscription_corrections(true)::text;")"
for stmt in "update public.subscription_deletion_corrections set status='kept_covered' where true" "delete from public.subscription_deletion_corrections where true" "insert into public.subscription_deletion_corrections(subscription_id,session_date,slot_state,regular_price_ils,amount_paid_ils) values ('$SUB','$TODAY','attended',1,1)"; do
  contains "manager cannot write directly" "denied" "$(api "$M" "$stmt;")"
done

echo "== Applying moves it to regular price, once, with an audit trail"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','agreed with the athlete',80)::text;")
expect "decided" "decided" "$(jf "$R" action)"
expect "regular price" "false:subscription_deleted" "$(cov "$R2")"
expect "balance now includes it" "80.00" "$(owes "$R2")"
expect "payment untouched" "50.00" "$(su -c "select amount_paid from public.session_registrations where id='$R2'")"
expect "receipt untouched" "$RECEIPT_BEFORE" "$(su -c "select md5(e::text) from public.external_manual_receipts e where record_id='$R2'")"
expect "who, when, why" "agreed with the athlete|true" "$(su -c "select decision_reason||'|'||(decided_by='$M' and decided_at is not null) from public.subscription_deletion_corrections where id='$C'")"
expect "activity event" "1" "$(su -c "select count(*) from public.user_activity_events where event_type='subscription_correction_decided' and metadata->>'correction_id'='$C'")"
expect "per-session impact row" "1" "$(su -c "select count(*) from public.subscription_impact_event_registrations er where er.registration_id='$R2' and not er.new_covered")"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','again',80)::text;"); expect "repeat changes nothing" "already_decided" "$(jf "$R" action)"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','kept_covered','changed my mind',80)::text;"); expect "cannot flip" "already_decided_differently" "$(jf "$R" error)"
expect "one impact row still" "1" "$(su -c "select count(*) from public.subscription_impact_event_registrations er where er.registration_id='$R2' and not er.new_covered")"
contains "an owner edit of a decided row is refused" "subscription_correction_already_decided" "$($PSQL -qAt -c "update public.subscription_deletion_corrections set status='kept_covered' where id='$C'" 2>&1)"
mark "$R2" false; mark "$R2" true
expect "later attendance edit keeps it" "false:subscription_deleted" "$(cov "$R2")"

echo "== Keeping it covered changes no amount, and stays that way"
setup; delete_sub; C=$(cid)
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','kept_covered','the session was prepaid',80)::text;")
expect "decided" "kept_covered" "$(jf "$R" status)"; expect "no debt" "0" "$(owes "$R2")"
mark "$R2" false; mark "$R2" true
expect "attendance edit keeps it" "true:" "$(cov "$R2")"

echo "== Two managers at once: one decision"
setup; delete_sub; C=$(cid); T=$(mktemp -d)
api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','first',80)::text;" > "$T/a" &
api "$M" "select public.manager_resolve_subscription_correction('$C','kept_covered','second',80)::text;" > "$T/b" &
wait
expect "one decided" "1" "$(cat "$T"/a "$T"/b | grep -c '"action" : "decided"')"
expect "one told it was already decided" "1" "$(cat "$T"/a "$T"/b | grep -c 'already_decided_differently')"
expect "the ledger has one decision" "1" "$(su -c "select count(*) from public.user_activity_events where event_type='subscription_correction_decided' and metadata->>'correction_id'='$C'")"
rm -rf "$T"

echo "== A failure part-way leaves nothing behind"
setup; delete_sub; C=$(cid)
OUT=$($PSQL -qAt -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
select set_config('request.jwt.claims','{"sub":"$M","role":"authenticated"}',true);
select public.manager_resolve_subscription_correction('$C','applied_regular_price','interrupted',80);
rollback;
SQL
)
expect "interrupted: still pending" "pending" "$(su -c "select status from public.subscription_deletion_corrections where id='$C'")"
expect "interrupted: still covered" "true:" "$(cov "$R2")"
R=$(api "$M" "select public.manager_resolve_subscription_correction('$C','applied_regular_price','retry',80)::text;"); expect "retry works" "decided" "$(jf "$R" action)"

echo "== Reports show the result"
W=$(lastsun 1); J=$(api "$M" "select public.manager_weekly_stats_core('$W','week')::text;")
expect "both sessions priced for this athlete" "160.00" "$(su -c "select a->>'expected_ils' from jsonb_array_elements(('$J'::jsonb)#>'{finance,athletes}') a where a->>'id'='$A'")"
expect "the ₪50 still counts as collected" "50.00" "$(su -c "select a->>'collected_sessions_ils' from jsonb_array_elements(('$J'::jsonb)#>'{finance,athletes}') a where a->>'id'='$A'")"
finish
