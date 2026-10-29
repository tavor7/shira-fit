#!/usr/bin/env bash
# Regression test for 20261029100000_subscription_overview_period_reversal_fix.sql.
#
# Bug: manager_subscription_overview_stats's period-scoped charges_total_ils, and
# manager_subscription_overview_breakdown's per-subscription charges_total_ils, summed only
# charge_type in ('recurring', 'proration') -- silently dropping 'reversal' rows (and
# 'freeze_credit' / 'stop_proration' / 'edit_correction') entirely. A subscription charged and
# then cancelled (reversed) within the SAME reporting window therefore overstated that
# period's/that subscription's charges by the full gross original amount instead of netting
# to zero (or to whatever the true remaining effect is).
#
# Real `authenticator` connections. Fixture: manager M, athlete A with a subscription that is
# created and then immediately deleted (tombstoned) -- delete_subscription reverses every
# un-superseded charge, inserting a 'reversal' row with the SAME billing_period_id as the
# charge it reverses (not a different one -- see delete_subscription), so a correct
# period-scoped report of "today" must show 0 for this subscription, not the gross charge.
#
#   1  charge + reversal within the same reporting window nets to 0 in
#      manager_subscription_overview_stats's period-scoped charges_total_ils (not the gross
#      charge amount)
#   2  the SAME charge + reversal nets to 0 in manager_subscription_overview_breakdown's
#      per-subscription charges_total_ils row
#   3  a reporting window that does NOT include the billing period's start date sees neither
#      the charge nor the reversal (both attributed to the billing period they were posted
#      for, not to "today")
#   4  an ordinary, never-reversed charge is still counted in full (no regression for the
#      common case)
#   5  lifetime outstanding_ils (unbounded range) still nets a cancelled subscription to 0
#
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/197_subscription_overview_period_reversal_tests.sh   (SCRATCH/LOCAL ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()"); A=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'f197-$n-m@t.local', '091$n'), ('$A'::uuid, 'f197-$n-a@t.local', '092$n')) u(id, e, p);
  update public.profiles set approval_status='approved' where user_id in ('$M','$A');
  update public.profiles set role='manager' where user_id='$M'" >/dev/null

echo "== 1/2/3/4: charge + same-period reversal nets to 0 in both the aggregate and the per-subscription breakdown"
R=$(api "$M" "select public.create_subscription('$A', false, 360, current_date, null, null, '[{\"tier\":\"personal\",\"weekly_limit\":1}]'::jsonb)::text;")
case "$R" in *'"ok" : true'*) ok "1 subscription created (charge posted)";; *) fail "1 create_subscription: $R";; esac
SUB=$(echo "$R" | grep -o '"subscription_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
BP_START=$(su -c "select bp.period_start::text from public.subscription_billing_periods bp join public.subscription_charges c on c.billing_period_id = bp.id where c.subscription_id = '$SUB' and c.charge_type = 'recurring' limit 1")
[ -n "$BP_START" ] && ok "1 billing period start resolved ($BP_START)" || fail "1 could not resolve billing period start"

# Baseline: before the reversal, this subscription's full 360 is counted in a window spanning its billing period start.
R_BEFORE=$(api "$M" "select public.manager_subscription_overview_stats('$BP_START'::date, '$BP_START'::date)::text;")
CHARGES_BEFORE=$(echo "$R_BEFORE" | grep -o '"charges_total_ils" : [0-9.-]*' | head -1 | grep -o '[0-9.-]*$')

R=$(api "$M" "select public.delete_subscription('$SUB')::text;")
case "$R" in *'"ok" : true'*'"action" : "tombstoned"'*) ok "1 delete_subscription tombstoned the subscription and reversed its charge";; *) fail "1 delete_subscription: $R";; esac
REV_BP=$(su -c "select billing_period_id::text from public.subscription_charges where subscription_id = '$SUB' and charge_type = 'reversal'")
ORIG_BP=$(su -c "select billing_period_id::text from public.subscription_charges where subscription_id = '$SUB' and charge_type = 'recurring'")
expect "1 the reversal shares the SAME billing_period_id as the charge it reverses" "$ORIG_BP" "$REV_BP"

R_AFTER=$(api "$M" "select public.manager_subscription_overview_stats('$BP_START'::date, '$BP_START'::date)::text;")
CHARGES_AFTER=$(echo "$R_AFTER" | grep -o '"charges_total_ils" : [0-9.-]*' | head -1 | grep -o '[0-9.-]*$')
DELTA=$(su -c "select ($CHARGES_AFTER - $CHARGES_BEFORE)::text")
expect "1 charges_total_ils for the billing-period window drops by exactly 360 (nets to 0 for this subscription), not 0 (the pre-fix bug)" "-360.00" "$DELTA"

# manager_subscription_overview_breakdown() returns SETOF, not JSON -- select a single
# scalar column filtered to this subscription instead of parsing composite-row text.
# A cancelled subscription with charges and payments that both net to exactly 0 is hidden
# entirely by this function's own WHERE clause (20261027195000_subscription_overview_
# breakdown_hide_empty_deleted.sql: "s.deleted_at is null or charges<>0 or payments<>0") --
# nothing left to show, by design -- so the correct assertion is that it does NOT appear,
# not that it appears showing a literal 0. (Before the fix, it WOULD have appeared, showing
# the stale gross 360 instead of being correctly hidden.)
BREAKDOWN_ROW_COUNT=$(api "$M" "select count(*)::text from public.manager_subscription_overview_breakdown() where subscription_id = '$SUB';")
expect "2 manager_subscription_overview_breakdown hides the cancelled subscription once charges net to 0 (nothing left to show)" "0" "$BREAKDOWN_ROW_COUNT"

echo "== 3: a window that does not include the billing period start sees neither the charge nor its reversal"
R_OUTSIDE=$(api "$M" "select public.manager_subscription_overview_stats('$BP_START'::date + 90, '$BP_START'::date + 120)::text;")
CHARGES_OUTSIDE=$(echo "$R_OUTSIDE" | grep -o '"charges_total_ils" : [0-9.-]*' | head -1 | grep -o '[0-9.-]*$')
DIRECT_OUTSIDE=$(su -c "select coalesce(sum(c.amount_ils),0)::text from public.subscription_charges c join public.subscription_billing_periods bp on bp.id = c.billing_period_id where bp.period_start between ('$BP_START'::date + 90) and ('$BP_START'::date + 120)")
expect "3 a window after the billing period start independently matches a direct sum (no leakage into a later window)" "$DIRECT_OUTSIDE" "$CHARGES_OUTSIDE"

echo "== 4: an ordinary never-reversed charge is still counted in full (no regression)"
A2=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$A2'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f197-$n-a2@t.local',
    jsonb_build_object('full_name', 'A2-197', 'phone', '093$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status='approved', role='athlete' where user_id='$A2'" >/dev/null
R2=$(api "$M" "select public.create_subscription('$A2', false, 250, current_date, null, null, '[]'::jsonb)::text;")
SUB2=$(echo "$R2" | grep -o '"subscription_id" : "[^"]*"' | head -1 | sed 's/.*"\([0-9a-f-]*\)"$/\1/')
BP2_START=$(su -c "select bp.period_start::text from public.subscription_billing_periods bp join public.subscription_charges c on c.billing_period_id = bp.id where c.subscription_id = '$SUB2'")
R2_STATS=$(api "$M" "select public.manager_subscription_overview_stats('$BP2_START'::date, '$BP2_START'::date)::text;")
C2=$(echo "$R2_STATS" | grep -o '"charges_total_ils" : [0-9.-]*' | head -1 | grep -o '[0-9.-]*$')
DIRECT2=$(su -c "select coalesce(sum(c.amount_ils),0)::text from public.subscription_charges c join public.subscription_billing_periods bp on bp.id = c.billing_period_id where bp.period_start = '$BP2_START'::date")
expect "4 an un-reversed charge's window matches a direct sum exactly (still counted in full)" "$DIRECT2" "$C2"
BREAKDOWN2=$(api "$M" "select charges_total_ils::text from public.manager_subscription_overview_breakdown() where subscription_id = '$SUB2';")
expect "4 manager_subscription_overview_breakdown's own charges_total_ils for a visible, un-reversed subscription matches its lifetime charge exactly" "250.00" "$BREAKDOWN2"

echo "== 5: lifetime outstanding_ils still nets the cancelled subscription to 0"
R5=$(api "$M" "select public.manager_subscription_overview_stats('2000-01-01'::date, '2100-01-01'::date)::text;")
OUT5=$(echo "$R5" | grep -o '"outstanding_ils" : [0-9.-]*' | head -1 | grep -o '[0-9.-]*$')
DIRECT5=$(su -c "select (coalesce((select sum(amount_ils) from public.subscription_charges),0) - coalesce((select sum(amount_ils) from public.athlete_account_payments where source_subscription_id is not null and reversed_at is null),0))::text")
expect "5 lifetime outstanding_ils matches a direct independent computation" "$DIRECT5" "$OUT5"

echo
echo "197 subscription overview period reversal: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
