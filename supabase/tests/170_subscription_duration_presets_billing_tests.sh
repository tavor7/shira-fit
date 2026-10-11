#!/usr/bin/env bash
# The manager form's duration presets (mobile/src/lib/subscriptionDuration.ts) must line up with the billing engine: a
# subscription created with a preset's end date bills exactly N full monthly cycles - no stray prorated cycle after the
# last one, no missing cycle - with calendar-month arithmetic (Jan 31, leap days, month/year boundaries).
# The expected end dates below are endDateForDuration() outputs (the same values the form fills in); the subscriptions are
# created through create_subscription as a manager and billed by the real daily job, run as postgres.
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/170_subscription_duration_presets_billing_tests.sh   (SCRATCH/LOCAL DATABASES ONLY)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
api() { local uid=$1; shift
  { echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}';"; printf '%s\n' "$1"; echo "commit;"; } \
    | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }

n=$(date +%s%N | tail -c 9)
M=$(su -c "select gen_random_uuid()")
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
  ('$M','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f170-$n-m@t.local', jsonb_build_object('full_name','m170','phone','0911$n','gender','female','address','A','zip_code','1'), now(), now());
  update public.profiles set approval_status='approved', role='manager' where user_id='$M'" >/dev/null

i=0
# start | months | preset end date (endDateForDuration)
while read -r START MONTHS END <&3; do
  i=$((i+1))
  A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f170-$n-a$i@t.local', jsonb_build_object('full_name','a170 $i','phone','092$i$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  R=$(api "$M" "select public.create_subscription('$A', false, 300, '$START', '$END', null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;" | grep '^{')
  SUB=$(su -c "select ('$R'::jsonb)->>'subscription_id'")
  su -c "select public.generate_due_subscription_charges()" >/dev/null
  su -c "select public.generate_due_subscription_charges()" >/dev/null
  expect "$START + $MONTHS month(s) -> $END bills exactly $MONTHS full cycles" "$MONTHS|$MONTHS|0|$(( MONTHS * 300 )).00" \
    "$(su -c "select (select count(*) from public.subscription_billing_periods where subscription_id = '$SUB') || '|' ||
                     (select count(*) from public.subscription_charges where subscription_id = '$SUB' and charge_type = 'recurring') || '|' ||
                     (select count(*) from public.subscription_charges where subscription_id = '$SUB' and charge_type <> 'recurring') || '|' ||
                     (select coalesce(sum(amount_ils), 0) from public.subscription_charges where subscription_id = '$SUB')")"
  expect "$START + $MONTHS: last cycle ends the day after the end date (no stub cycle)" "$(su -c "select date '$END' + 1")" \
    "$(su -c "select max(raw_period_end) from public.subscription_billing_periods where subscription_id = '$SUB'")"
done 3<<'EOF'
2025-01-31 1 2025-02-27
2025-01-31 3 2025-04-29
2025-01-31 6 2025-07-30
2025-01-31 12 2026-01-30
2024-02-29 12 2025-02-27
2024-01-31 1 2024-02-28
2025-12-15 1 2026-01-14
2025-12-31 1 2026-01-30
2025-11-30 3 2026-02-27
2025-08-31 6 2026-02-27
2025-03-01 6 2025-08-31
EOF

echo
echo "170 subscription duration presets vs billing: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
