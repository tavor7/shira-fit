#!/usr/bin/env bash
# Bulk receipts are numbered by business payment date, earliest first, whatever order the rows are sent in and whenever
# each payment was recorded. Covers 20261108100000_bulk_receipts_chronological_order.sql: late attendance entry, mixed
# payment kinds, equal timestamps, input-order independence, a failing row leaving no gap, date-only account payments in
# any session time zone, the non-blocking warning for payments older than issued receipts, and that issued documents are
# never changed. Fixtures are dated ~400 days ahead so no other suite's receipt is later. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
SETTINGS=$(su -c "select digital_receipts_enabled || '|' || coalesce(business_id, '') from public.receipt_settings")
restore() { su -c "update public.receipt_settings set digital_receipts_enabled = $(echo "$SETTINGS" | cut -d'|' -f1), business_id = nullif('$(echo "$SETTINGS" | cut -d'|' -f2)', '')" >/dev/null; }
trap restore EXIT
su -c "update public.receipt_settings set digital_receipts_enabled = true, business_id = coalesce(nullif(business_id, ''), '515151515')" >/dev/null

# One set of five payments over three days (Israel time), named by their expected position:
#   P1 session reg   day+0 09:00, recorded LAST (late attendance entry)
#   P2 account       day+1, date only (00:00), recorded late too
#   P3 quick-add     day+1 07:00 }  same session, same timestamp:
#   P4 session reg   day+1 07:00 }  tie broken by kind, then row id (session_manual < session_reg)
#   P5 cancellation  day+2 10:00
fixture() { # day offset -> P1..P5 row ids
  local d0 d1 d2; d0=$(d "$1"); d1=$(d "$(( $1 + 1 ))"); d2=$(d "$(( $1 + 2 ))")
  mksession "$d0" 8 "09:00"; local x1=$SX; mksession "$d1" 8 "07:00"; local x2=$SX; mksession "$d2" 8 "18:00"; local x3=$SX
  mkuser athlete; local u1=$U; past_reg "$u1" "$x1" true; local r1=$REG
  mkuser athlete; local u2=$U; past_reg "$u2" "$x2" true; local r2=$REG
  mkmanual
  su -c "update public.session_registrations set amount_paid = 100, payment_method = 'cash', payment_recorded_by = '$M', payment_recorded_at = now() + interval '1 hour' where id = '$r1';
    update public.session_registrations set amount_paid = 80, payment_method = 'cash', payment_recorded_by = '$M', payment_recorded_at = now() - interval '30 days' where id = '$r2'" >/dev/null
  local m; m=$(su -c "insert into public.session_manual_participants (session_id, manual_participant_id, attended, amount_paid, payment_method, payment_recorded_by, payment_recorded_at)
    values ('$x2', '$MP', true, 50, 'cash', '$M', now() - interval '20 days') returning id" | head -1)
  local a; a=$(su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by, created_at)
    values ('$u2', false, 200, 'cash', '$d1', '$M', now() + interval '2 hours') returning id" | head -1)
  mkuser athlete; local u4=$U
  local c; c=$(su -c "insert into public.cancellations (session_id, user_id, reason, charged_full_price, penalty_collected_ils, payment_method, cancelled_at)
    values ('$x3', '$u4', 'late', true, 30, 'cash', ('$d2'::date + time '10:00') at time zone 'Asia/Jerusalem') returning id" | head -1)
  P1="session_reg:$r1"; P2="account:$a"; P3="session_manual:$m"; P4="session_reg:$r2"; P5="cancellation:$c"
}
arr() { local s=""; for x in "$@"; do s="$s${s:+,}\"$x\""; done; echo "[$s]"; }
issue() { api "${2:-$M}" "select public.create_documents_from_payments('$1'::jsonb)::text;"; }
preview() { api "${2:-$M}" "select public.bulk_receipt_issue_preview('$1'::jsonb)::text;"; }
num_of() { su -c "select coalesce((select document_number from public.documents where source_id = split_part('$1', ':', 2)::uuid and status <> 'CANCELLED'), 'none')"; }
# expected order -> "ok" when the numbers ascend in that order and leave no gap, otherwise the numbers
in_order() { local prev="" out="ok" all=""; for r in "$@"; do n=$(num_of "$r"); all="$all $n"; [ "$n" != none ] && n=${n//[!0-9]/}
    case "$n" in none) out="missing";; *) [ -n "$prev" ] && [ $((10#$n)) -ne $((10#$prev + 1)) ] && out="out of order";; esac; prev=$n; done
  [ "$out" = ok ] && echo ok || echo "$out:$all"; }
SNAP() { su -c "select coalesce(md5(string_agg(to_jsonb(d)::text, '' order by id)), '') from public.documents d where id::text not in ($1)"; }

echo "late attendance, mixed kinds and equal timestamps, sent in reverse with a bad row in the middle"
fixture 400; A1=$P1; A2=$P2; A3=$P3; A4=$P4; A5=$P5
R=$(preview "$(arr "$A5" "$A4" "$A3" "$A2" "$A1")")
expect "nothing issued is later, so no warning" "0" "$(jf "$R" predating_count)"
BEFORE=$(SNAP "'00000000-0000-0000-0000-000000000000'")
R=$(issue "$(arr "$A5" "$A4" "account:00000000-0000-0000-0000-000000000000" "$A3" "$A2" "$A1")")
expect "five created" "5" "$(jf "$R" created_count)"
expect "the bad row fails" "1" "$(jf "$R" failed_count)"
expect "numbered by business time, earliest first, contiguous (no gap from the failed row)" "ok" "$(in_order "$A1" "$A2" "$A3" "$A4" "$A5")"
expect "documents issued earlier are unchanged" "$BEFORE" "$(SNAP "$(su -c "select string_agg(quote_literal(id::text), ',') from public.documents where source_id in (select split_part(x, ':', 2)::uuid from unnest(array['$A1','$A2','$A3','$A4','$A5']) x)")")"

echo "the same shape sent in another order gets the same order"
fixture 410; R=$(issue "$(arr "$P3" "$P1" "$P5" "$P2" "$P4")")
expect "five created" "5" "$(jf "$R" created_count)"
expect "selection order does not matter" "ok" "$(in_order "$P1" "$P2" "$P3" "$P4" "$P5")"
LATEST=$(num_of "$P5")

echo "payments found after later receipts were issued"
ISSUED=$(su -c "select string_agg(document_number || status || gross_amount, ',' order by document_number) from public.documents where document_number <= '$LATEST'")
fixture 405
R=$(preview "$(arr "$P1" "$P2" "$P3" "$P4" "$P5")")
expect "all five predate the latest issued receipt" "5" "$(jf "$R" predating_count)"
expect "which is named" "$LATEST" "$(jf "$R" latest_issued_number)"
R=$(issue "$(arr "$P5" "$P1" "$P4" "$P2" "$P3")")
expect "they still get receipts (the warning does not block)" "5" "$(jf "$R" created_count)"
expect "in business order among themselves" "ok" "$(in_order "$P1" "$P2" "$P3" "$P4" "$P5")"
expect "numbered after the latest issued receipt" "1" "$(su -c "select (regexp_replace('$(num_of "$P1")', '\\D', '', 'g')::bigint = regexp_replace('$LATEST', '\\D', '', 'g')::bigint + 1)::int")"
expect "receipts issued before are untouched" "$ISSUED" "$(su -c "select string_agg(document_number || status || gross_amount, ',' order by document_number) from public.documents where document_number <= '$LATEST'")"

echo "date-only account payments stay on their date in any session time zone"
ACC=$(echo "$A2" | cut -d: -f2)
for tz in UTC Asia/Jerusalem America/Los_Angeles Pacific/Kiritimati; do
  expect "account payment at 00:00 on its own date ($tz)" "$(d 401) 00:00:00" "$(su -c "set timezone to '$tz'; select public._business_local_ts('account_payment', '$ACC')")"
done
expect "session payment at its scheduled start" "$(d 401) 07:00:00" "$(su -c "set timezone to 'America/Los_Angeles'; select public._payment_row_business_local_ts('$A4')")"
expect "a malformed row id has no date" "" "$(su -c "select public._payment_row_business_local_ts('account:not-a-uuid')")"

echo "access"
contains "a coach cannot preview" "forbidden" "$(preview "$(arr "$A1")" "$CO")"
contains "a coach cannot issue" "forbidden" "$(issue "$(arr "$A1")" "$CO")"
contains "anon cannot preview" "permission denied" "$(api_as anon "" "select public.bulk_receipt_issue_preview('[]'::jsonb)::text;")"
contains "clients cannot call the date helper" "permission denied" "$(api "$M" "select public._payment_row_business_local_ts('$A1');")"
finish
