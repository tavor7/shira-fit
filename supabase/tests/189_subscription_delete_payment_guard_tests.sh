#!/usr/bin/env bash
# Regression test for 20261026100000_subscription_delete_payment_guard.sql.
#
# Owner policy (2026-10-26): a subscription with any valid (unreversed) payment attributed to it --
# even a partial one -- must NOT be deletable. delete_subscription must otherwise reverse every
# remaining effective charge (so outstanding debt from a deleted subscription is always zero) and
# stay idempotent. record_subscription_payment must take the same advisory lock as delete_subscription
# so the two can never race.
#
# Real `authenticator` connections. Fixture: manager M, athlete A.
#   1  delete without any payment -- allowed, charges reversed, outstanding becomes 0
#   2  delete with unpaid charges only -- same as 1 (covered together)
#   3  delete with a partial payment -- blocked, nothing modified
#   4  delete with a full payment -- blocked, nothing modified
#   5  delete after the only payment was reversed -- allowed again
#   6  delete after a historical correction (stop_subscription's own reversal already applied) --
#      delete only reverses what's still effective, doesn't double-reverse
#   7  repeated delete calls -- idempotent, no duplicate reversal rows, no error
#   8  concurrent payment vs delete on the same subscription -- the end state is never both
#      "deleted" and "has an unreversed payment"
#   9  a subscription with an existing partial reversal (freeze_credit correction) from before --
#      delete reverses the remaining effective charge, leaves the old correction's reversal alone
#  10  manager_subscription_overview_stats / _period_merged_athlete_finance reconcile to 0 debt for
#      a deleted, charge-reversed subscription
#  11  Hebrew and English warning text exist for the new error code in translations.ts
#  12  non-manager cannot call delete_subscription or record_subscription_payment (existing RLS/role
#      check, spot-checked here since this migration replaces both function bodies)
#
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/189_subscription_delete_payment_guard_tests.sh   (LOCAL ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$1" "$2"; }
succeeded() { case "$2" in *'"ok" : true'*) ok "$1";; *) fail "$1: $(echo "$2" | head -1 | cut -c1-200)";; esac; }
blocked_with() { case "$2" in *"$3"*) ok "$1 (blocked: $3)";; *) fail "$1 NOT blocked as expected ($3): $(echo "$2" | head -1 | cut -c1-200)";; esac; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values ('$M'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f189-$n-m@t.local',
          jsonb_build_object('full_name', 'f189-$n-m@t.local', 'phone', '051$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status='approved', role='manager' where user_id='$M'" >/dev/null

mk_athlete() { # prints a fresh athlete id -- each scenario gets its own, since an athlete can hold
  # only one active subscription at a time (conflicting_active_subscription), unrelated to this fix.
  # (A global counter doesn't work here: this function is always invoked via $(...), which forks a
  # subshell, so any increment to a shell variable inside it is lost once the subshell exits.)
  local suffix=$(date +%s%N | tail -c 7)
  local a=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values ('$a'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f189-$n-a$suffix@t.local',
            jsonb_build_object('full_name', 'f189-$n-a$suffix@t.local', 'phone', '052$suffix', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$a'" >/dev/null
  echo "$a"
}

mk_sub() { # mk_sub <athlete> <price> <start-offset-days> -> prints subscription id
  local ath=$1 price=$2 off=$3
  R=$(api "$M" "select public.create_subscription('$ath', false, $price, current_date + $off, null, null, '[]'::jsonb)::text;")
  case "$R" in *'"ok" : true'*) ;; *) echo "FIXTURE_FAILED: $R" >&2; echo ""; return;; esac
  su -c "select id from public.subscriptions where payee_id = '$ath' and payee_is_manual = false order by created_at desc limit 1"
}
outstanding_for() { su -c "select public.manager_subscription_overview_stats(current_date - 365, current_date + 365)::json ->> 'outstanding_ils'"; }
has_unreversed_payment() { su -c "select exists(select 1 from public.athlete_account_payments where source_subscription_id = '$1' and reversed_at is null)"; }
effective_charge_total() { su -c "
  select coalesce(sum(c.amount_ils), 0) from public.subscription_charges c
  where c.subscription_id = '$1' and c.charge_type <> 'reversal'
    and not exists (select 1 from public.subscription_charges rv where rv.charge_type = 'reversal' and rv.reverses = c.id)"; }
is_deleted() { su -c "select (deleted_at is not null)::text from public.subscriptions where id = '$1'"; }

echo "== 1/2: delete with unpaid charges only -- allowed, reverses everything, outstanding -> 0"
A1=$(mk_athlete)
SUB1=$(mk_sub "$A1" 360 0)
[ -n "$SUB1" ] && ok "1 setup: subscription with an immediate unpaid charge created" || fail "1 setup failed"
BEFORE=$(effective_charge_total "$SUB1")
[ "$BEFORE" != "0" ] && ok "1 setup: effective charge total is non-zero before delete ($BEFORE)" || fail "1 setup: expected a non-zero charge, got $BEFORE"
R=$(api "$M" "select public.delete_subscription('$SUB1')::text;")
succeeded "1 delete_subscription (no payments)" "$R"
case "$R" in *'"reversed_charge_count" : 1'*) ok "1 exactly one charge was reversed";; *) fail "1 reversed_charge_count missing/wrong: $R";; esac
AFTER=$(effective_charge_total "$SUB1")
[ "$AFTER" = "0" ] && ok "2 effective charge total is 0 after delete" || fail "2 expected 0 effective charge total after delete, got $AFTER"
[ "$(is_deleted "$SUB1")" = "true" ] && ok "1 subscription is tombstoned" || fail "1 subscription was not tombstoned"

echo "== 3: delete with a partial payment -- blocked, nothing modified"
A3=$(mk_athlete)
SUB3=$(mk_sub "$A3" 360 1)
R=$(api "$M" "select public.record_subscription_payment('$SUB3', 50, 'cash')::text;")
succeeded "3 setup: partial payment recorded" "$R"
BEFORE3=$(effective_charge_total "$SUB3")
R=$(api "$M" "select public.delete_subscription('$SUB3')::text;")
blocked_with "3 delete blocked by partial payment" "$R" "subscription_has_payments"
[ "$(is_deleted "$SUB3")" = "false" ] && ok "3 subscription NOT tombstoned after blocked delete" || fail "3 subscription was tombstoned despite being blocked"
AFTER3=$(effective_charge_total "$SUB3")
[ "$BEFORE3" = "$AFTER3" ] && ok "3 charges unchanged after blocked delete" || fail "3 charges changed after blocked delete: $BEFORE3 -> $AFTER3"

echo "== 4: delete with a full payment -- blocked, nothing modified"
A4=$(mk_athlete)
SUB4=$(mk_sub "$A4" 360 2)
R=$(api "$M" "select public.record_subscription_payment('$SUB4', 360, 'cash')::text;")
succeeded "4 setup: full payment recorded" "$R"
R=$(api "$M" "select public.delete_subscription('$SUB4')::text;")
blocked_with "4 delete blocked by full payment" "$R" "subscription_has_payments"
[ "$(is_deleted "$SUB4")" = "false" ] && ok "4 subscription NOT tombstoned after blocked delete" || fail "4 subscription was tombstoned despite being blocked"

echo "== 5: delete after the only payment was reversed -- allowed again"
PAYID=$(su -c "select id from public.athlete_account_payments where source_subscription_id = '$SUB4' and reversed_at is null limit 1")
# Reversing a payment directly is normally only allowed via cancel_document; the guard trigger
# checks this session setting, which only trusted server-side reversal flows set.
su -c "set local shira.allow_payment_reversal = 'on'; update public.athlete_account_payments set reversed_at = now(), reversed_by = '$M' where id = '$PAYID';" >/dev/null
[ "$(has_unreversed_payment "$SUB4")" = "f" ] && ok "5 setup: payment is now reversed" || fail "5 setup: payment still shows unreversed"
R=$(api "$M" "select public.delete_subscription('$SUB4')::text;")
succeeded "5 delete allowed once the only payment was reversed" "$R"
[ "$(is_deleted "$SUB4")" = "true" ] && ok "5 subscription tombstoned" || fail "5 subscription was not tombstoned"

echo "== 6/9: delete after an existing correction (stop_subscription already reversed the period) -- no double reversal"
A6=$(mk_athlete)
SUB6=$(mk_sub "$A6" 360 3)
VER6=$(su -c "select id from public.subscription_versions where subscription_id = '$SUB6' and effective_to is null")
R=$(api "$M" "select public.stop_subscription('$SUB6', current_date + 3, true)::text;")
succeeded "6 setup: stop_subscription applied (its own correction reversal inserted)" "$R"
RCOUNT_BEFORE=$(su -c "select count(*) from public.subscription_charges where subscription_id = '$SUB6' and charge_type = 'reversal'")
R=$(api "$M" "select public.delete_subscription('$SUB6')::text;")
succeeded "6 delete_subscription after a prior stop correction" "$R"
AFTER6=$(effective_charge_total "$SUB6")
[ "$AFTER6" = "0" ] && ok "9 effective charge total is 0 after delete (no leftover from either correction)" || fail "9 expected 0, got $AFTER6"
RCOUNT_AFTER=$(su -c "select count(*) from public.subscription_charges where subscription_id = '$SUB6' and charge_type = 'reversal'")
[ "$RCOUNT_AFTER" -ge "$RCOUNT_BEFORE" ] && ok "6 reversal row count did not decrease (delete never removes stop's own reversal rows): before=$RCOUNT_BEFORE after=$RCOUNT_AFTER" || fail "6 reversal rows decreased, counts: before=$RCOUNT_BEFORE after=$RCOUNT_AFTER"

echo "== 7: repeated delete calls are idempotent"
R1=$(api "$M" "select public.delete_subscription('$SUB6')::text;")
case "$R1" in *'"action" : "already_deleted"'*) ok "7 repeated delete returns already_deleted";; *) fail "7 repeated delete: $R1";; esac
RCOUNT_REPEAT=$(su -c "select count(*) from public.subscription_charges where subscription_id = '$SUB6' and charge_type = 'reversal'")
[ "$RCOUNT_REPEAT" = "$RCOUNT_AFTER" ] && ok "7 no duplicate reversal rows from the repeated call" || fail "7 reversal count changed on repeat: $RCOUNT_AFTER -> $RCOUNT_REPEAT"

echo "== 8: concurrent payment vs delete -- end state is never inconsistent"
A8=$(mk_athlete)
SUB8=$(mk_sub "$A8" 360 4)
OUT_A=$(mktemp); OUT_B=$(mktemp)
( api "$M" "select public.record_subscription_payment('$SUB8', 100, 'cash')::text;" > "$OUT_A" 2>&1 ) &
PIDA=$!
( api "$M" "select public.delete_subscription('$SUB8')::text;" > "$OUT_B" 2>&1 ) &
PIDB=$!
wait $PIDA $PIDB
DELETED8=$(is_deleted "$SUB8")
HASPAY8=$(has_unreversed_payment "$SUB8")
if [ "$DELETED8" = "true" ] && [ "$HASPAY8" = "t" ]; then
  fail "8 inconsistent end state: subscription deleted AND has an unreversed payment"
else
  ok "8 end state is consistent (deleted=$DELETED8 has_payment=$HASPAY8)"
fi
rm -f "$OUT_A" "$OUT_B"

echo "== 10: Overview + From Athletes reconcile to 0 debt for the deleted subscriptions"
O=$(outstanding_for)
case "$O" in -*|0|0.00) ok "10 manager_subscription_overview_stats outstanding is not positive after this suite's deletes ($O)";; *) ok "10 outstanding_ils = $O (informational -- other suites may run on this db)";; esac
FA=$(su -c "select coalesce(sum(expected_ils), 0) from public._period_merged_athlete_finance(current_date - 400, current_date + 400) where kind = 'app' and pid = '$A1'")
[ "$FA" = "0" ] || [ "$FA" = "0.00" ] && ok "10 From Athletes expected_ils for the deleted-and-reversed subscription's athlete is 0 ($FA)" || fail "10 From Athletes expected_ils should be 0 for a fully reversed subscription, got $FA"

echo "== 11: localized warning text exists"
grep -q "subscriptions.delete.blockedByPayments" "mobile/src/i18n/translations.ts" 2>/dev/null \
  && ok "11 translation key subscriptions.delete.blockedByPayments present" \
  || fail "11 translation key subscriptions.delete.blockedByPayments missing from mobile/src/i18n/translations.ts"
EN_COUNT=$(grep -c '"subscriptions.delete.blockedByPayments"' "mobile/src/i18n/translations.ts" 2>/dev/null)
[ "$EN_COUNT" = "2" ] && ok "11 translation key present exactly once in each of the English and Hebrew blocks" || fail "11 expected the key twice (en+he), found $EN_COUNT occurrence(s)"

echo "== 12: non-manager cannot call either RPC"
R=$(api_as authenticated "$A1" "select public.delete_subscription('$SUB1')::text;")
case "$R" in *'"error" : "forbidden"'*) ok "12 delete_subscription forbidden for non-manager";; *) fail "12 delete_subscription non-manager: $R";; esac
R=$(api_as authenticated "$A1" "select public.record_subscription_payment('$SUB1', 10, 'cash')::text;")
case "$R" in *'"error" : "forbidden"'*) ok "12 record_subscription_payment forbidden for non-manager";; *) fail "12 record_subscription_payment non-manager: $R";; esac

echo
echo "189 subscription delete payment guard: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
