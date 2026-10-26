#!/usr/bin/env bash
# Regression suite for 20261026080552_edit_subscription_version_no_op_guard.sql (the migration file's
# local name reflects when it was authored; its recorded/applied version in production is
# 20261026080552, the timestamp the deploy tool actually assigned -- see supabase/migrations/ for the
# current filename).
#
# Bug: edit_subscription_version always closed the current subscription_versions row and inserted a
# new one once p_effective_from reached/passed the current version's effective_from, even when price,
# plan_end_date and allowances were all unchanged -- e.g. a manager opens Edit right after Create and
# saves without changing anything. "Plan changes" then showed two back-to-back entries at the
# identical price. Reproduced in production on subscription 249e2df8-1a70-4e3d-b74a-44578e9badb2.
#
# Drives the REAL edit_subscription_version RPC over an `authenticator` connection as `authenticated`
# with JWT claims (one transaction per call), exactly like PostgREST -- same harness as 159.
#
# Scenarios
#   A  no-op edit (same price, same plan_end_date, allowances omitted) -> no new version, no charge
#      rows touched, billing invariants and ledger fingerprint unchanged
#   A2 no-op edit resubmitting the identical price explicitly and a full 7-tier allowances array
#      that only spells out the same nonzero tier plus explicit zeros for the rest -> no new version
#      (zero-weight tiers must be normalized out of the comparison on both sides)
#   B  genuine price change at the same effective_from as A/A2 -> DOES create a new version, with the
#      correct billing correction (unchanged from pre-fix behavior)
#   C  genuine allowances change (add a tier) -> DOES create a new version
#   D  idempotency preserved: the exact same no-op edit called twice converges to 'already_applied'
#      the second time, same as a genuine edit retry already does
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/190_subscription_edit_no_op_vs_real_change_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users and subscriptions. Never run it against production.
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
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
cron() { su -c "select public.generate_due_subscription_charges()::text" >/dev/null; }

inv() { su -c "
with bp as (select * from public.subscription_billing_periods where subscription_id = '$1'),
ch as (select c.* from public.subscription_charges c join bp on bp.id = c.billing_period_id),
active as (select c.* from ch c where c.charge_type <> 'reversal' and not exists (select 1 from ch r where r.charge_type='reversal' and r.reverses=c.id)),
v as (
  select 'I1 raw overlap ' || a.raw_period_start || '/' || b.raw_period_start as msg from bp a join bp b on a.id < b.id
    and daterange(a.raw_period_start, a.raw_period_end) && daterange(b.raw_period_start, b.raw_period_end)
  union all
  select 'I1 effective overlap ' || a.period_start || '/' || b.period_start from bp a join bp b on a.id < b.id
    and daterange(a.period_start, a.period_end) && daterange(b.period_start, b.period_end)
  union all
  select 'I2 active charges=' || count(a.id) || ' period ' || bp.raw_period_start from bp left join active a on a.billing_period_id = bp.id
    group by bp.id, bp.raw_period_start having count(a.id) <> 1
  union all
  select 'I3 bad reversal ' || r.id from ch r left join ch o on o.id = r.reverses
    where r.charge_type = 'reversal' and (o.id is null or o.billing_period_id <> r.billing_period_id or r.amount_ils <> -o.amount_ils)
  union all
  select 'I3 reversed twice ' || reverses from ch where charge_type = 'reversal' group by reverses having count(*) > 1
  union all
  select 'I4 net ' || bp.raw_period_start || ' ledger=' || coalesce(sum(c.amount_ils), 0) || ' engine=' || e.amount_ils
    from bp left join ch c on c.billing_period_id = bp.id
    cross join lateral public.subscription_billing_period_amount('$1', bp.period_start, bp.period_end) e
    group by bp.id, bp.raw_period_start, e.amount_ils having coalesce(sum(c.amount_ils), 0) <> e.amount_ils
)
select coalesce(string_agg(msg, '; ' order by msg), 'OK') from v"; }
check() { expect "$1 invariants" "OK" "$(inv "$2")"; }
versions() { su -c "select count(*) from public.subscription_versions where subscription_id='$1'"; }
current_version_id() { su -c "select id from public.subscription_versions where subscription_id='$1' and effective_to is null"; }
ledger_fp() { su -c "select count(*) || ':' || coalesce(sum(amount_ils),0) from public.subscription_charges where subscription_id='$1'"; }
allowances_of() { su -c "select coalesce(jsonb_object_agg(tier, weekly_limit) filter (where weekly_limit <> 0), '{}'::jsonb)::text from public.subscription_version_allowances where version_id = (select id from public.subscription_versions where subscription_id='$1' and effective_to is null)"; }
FIN_FP="select md5(coalesce((select string_agg(x::text,'|' order by x::text) from public.athlete_account_payments x),'') ||
  coalesce((select string_agg(x::text,'|' order by x::text) from public.documents x),'') ||
  coalesce((select string_agg(x::text,'|' order by x::text) from public.monthly_summaries x),''))"

TODAY=$(su -c "select public._studio_today_date()")
START=$(su -c "select (date_trunc('month', date '$TODAY') - interval '3 months' + interval '9 days')::date")
d() { su -c "select (date '$START' + $1)::date"; }
anc() { su -c "select (date '$START' + interval '$1 month')::date"; }

M=""
users() { local n; n=$(date +%s%N | tail -c 9)
  M=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$M','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f190-$n-m@t.local', jsonb_build_object('full_name','m190','phone','054$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$M';
    update public.profiles set role='manager' where user_id='$M'" >/dev/null; }
sub() { local price=$1 n; n=$(date +%s%N | tail -c 9); A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f190-$n-a@t.local', jsonb_build_object('full_name','a190','phone','055$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  r=$(api "$M" "select public.create_subscription('$A', false, $price, '$START', null, 10::smallint, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
  SUB=$(jf "$(echo "$r" | grep '^{')" subscription_id)
  cron
}
rpc() { api "$M" "select ($1)::text;" | grep '^{' | head -1; }
act() { jf "$1" action; }
vid() { jf "$1" version_id; }

users
echo "today=$TODAY start=$START"

echo "== A: no-op edit (same price, plan_end_date unchanged, allowances omitted) must not create a new version"
sub 300
V0=$(current_version_id "$SUB"); N0=$(versions "$SUB"); FP0=$(ledger_fp "$SUB"); check "A baseline" "$SUB"
R=$(rpc "public.edit_subscription_version('$SUB', '$(d 50)', 300, null, false, null, true)")
expect "A no-op applied" "applied" "$(act "$R")"
expect "A no-op returns the SAME version id" "$V0" "$(vid "$R")"
expect "A no-op does not create a new version row" "$N0" "$(versions "$SUB")"
expect "A no-op does not touch the ledger" "$FP0" "$(ledger_fp "$SUB")"
check "A after no-op" "$SUB"

echo "== A2: no-op edit resubmitting a full 7-tier allowances array equal (after normalizing zeros) to the current one"
ALLOW_SAME='[{"tier":"group","weekly_limit":2},{"tier":"personal","weekly_limit":0},{"tier":"pair","weekly_limit":0},{"tier":"trio","weekly_limit":0},{"tier":"quartet","weekly_limit":0},{"tier":"quintet","weekly_limit":0},{"tier":"sextet","weekly_limit":0}]'
V0=$(current_version_id "$SUB"); N0=$(versions "$SUB")
R=$(rpc "public.edit_subscription_version('$SUB', '$(d 51)', null, null, false, '$ALLOW_SAME'::jsonb, true)")
expect "A2 no-op applied" "applied" "$(act "$R")"
expect "A2 no-op returns the SAME version id" "$V0" "$(vid "$R")"
expect "A2 no-op does not create a new version row" "$N0" "$(versions "$SUB")"
check "A2 after no-op" "$SUB"

echo "== B: a genuine price change at a similar effective_from DOES create a new version"
V0=$(current_version_id "$SUB"); N0=$(versions "$SUB")
R=$(rpc "public.edit_subscription_version('$SUB', '$(d 52)', 350, null, false, null, true)")
expect "B real edit applied" "applied" "$(act "$R")"
V1=$(vid "$R")
if [ "$V1" != "$V0" ]; then ok "B real edit creates a NEW version id"; else fail "B real edit did not create a new version id"; fi
expect "B real edit adds exactly one version row" "$((N0+1))" "$(versions "$SUB")"
expect "B new current version has the new price" "350.00" "$(su -c "select monthly_price_ils from public.subscription_versions where id='$V1'")"
check "B after real edit" "$SUB"

echo "== C: a genuine allowances change DOES create a new version"
sub 300
V0=$(current_version_id "$SUB"); N0=$(versions "$SUB")
ALLOW_MORE='[{"tier":"group","weekly_limit":3}]'
R=$(rpc "public.edit_subscription_version('$SUB', '$(d 50)', null, null, false, '$ALLOW_MORE'::jsonb, true)")
expect "C real allowances edit applied" "applied" "$(act "$R")"
V1=$(vid "$R")
if [ "$V1" != "$V0" ]; then ok "C allowances edit creates a NEW version id"; else fail "C allowances edit did not create a new version id"; fi
expect "C allowances edit adds exactly one version row" "$((N0+1))" "$(versions "$SUB")"
expect "C new version has the new allowances" '{"group": 3}' "$(allowances_of "$SUB")"
check "C after allowances edit" "$SUB"

echo "== D: idempotency — the exact same no-op edit called twice converges to already_applied"
sub 300
N0=$(versions "$SUB"); FP0=$(ledger_fp "$SUB")
R1=$(rpc "public.edit_subscription_version('$SUB', '$(d 50)', 300, null, false, null, true)")
expect "D first no-op applied" "applied" "$(act "$R1")"
R2=$(rpc "public.edit_subscription_version('$SUB', '$(d 50)', 300, null, false, null, true)")
expect "D identical retry is already_applied" "already_applied" "$(act "$R2")"
expect "D no version rows added by either call" "$N0" "$(versions "$SUB")"
expect "D ledger untouched by either call" "$FP0" "$(ledger_fp "$SUB")"
check "D" "$SUB"

echo "== E: billing correction amounts for a genuine edit are unchanged from pre-fix behavior"
sub 300; E=$(d 35); P2=$(anc 1); P3=$(anc 2)
expect "E edit applied" "applied" "$(act "$(rpc "public.edit_subscription_version('$SUB', '$E', 400, null, false, null, true)")")"
EXP2=$(su -c "select round((300 * (date '$E' - date '$P2') + 400 * (date '$P3' - date '$E'))::numeric / (date '$P3' - date '$P2'), 2)")
NET2=$(su -c "select coalesce(sum(c.amount_ils),0) from public.subscription_charges c join public.subscription_billing_periods bp on bp.id=c.billing_period_id where bp.subscription_id='$SUB' and bp.raw_period_start='$P2'")
expect "E period containing the change is still blended correctly" "$EXP2" "$NET2"
check "E" "$SUB"

echo
echo "190 subscription edit no-op vs real change: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
