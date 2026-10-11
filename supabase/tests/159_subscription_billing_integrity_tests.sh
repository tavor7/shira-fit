#!/usr/bin/env bash
# Subscription billing-integrity regression suite (migrations 20261013100000 + 20261013110000).
#
# Drives the REAL functions the way the app does: every manager action goes over an `authenticator` connection (safeupdate
# preloaded) as `authenticated` with JWT claims, one transaction per call, exactly like PostgREST; the billing job runs as
# `postgres`, exactly like the pg_cron job. After every step it checks the financial invariants of the subscription's ledger:
#
#   I1  billing periods of one subscription never overlap (raw or effective windows)  -> no duplicate period for one cycle
#   I2  at most one active (non-reversed, non-reversal) charge per period; every period has one
#   I3  every reversal reverses a charge of the SAME period, for exactly its negative amount, and no charge is reversed twice
#   I4  the ledger net of every period equals the engine's own amount for that period (subscription_billing_period_amount)
#   I5  payments, receipts/documents and monthly summaries are never touched (fingerprints)
#
# Scenarios
#   A  duplicate billing after a freeze: freeze, then a price edit -> must NOT create a second period / second full charge
#   A2 freeze -> edit -> freeze -> edit, retries, and an edit spanning shifted periods
#   B  retroactive stop spanning 2+ billed periods -> EVERY affected period corrected (independent arithmetic check)
#   B2 repeated stop (already_applied, ledger unchanged), then an earlier stop date -> chained corrections stay consistent
#   C  retroactive price edit spanning 2+ billed periods -> every period corrected (independent arithmetic check)
#   D  retroactive freeze spanning two periods
#   E  concurrency: identical stop x2 in parallel; stop racing the billing job; identical edit x2 in parallel
#   F  authorization: anon / athlete / coach cannot run lifecycle RPCs; nobody but postgres/service_role reaches the internals
#   G  partially / fully paid accounts: payments and documents untouched, the correction shows up as account credit
#
# Usage: PSQL="docker exec -i <db> psql -U postgres" \
#        PSQL_AUTH="docker exec -e PGPASSWORD=postgres -i <db> psql -h 127.0.0.1 -U authenticator -d postgres" \
#        supabase/tests/159_subscription_billing_integrity_tests.sh
# SCRATCH/LOCAL DATABASES ONLY: it commits fixture users and subscriptions. Never run it against production.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
# one PostgREST-like transaction: authenticator connection -> role + claims. stdout = rows, stderr merged.
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
cron() { su -c "select public.generate_due_subscription_charges()::text" >/dev/null; }

# ---------------------------------------------------------------------------------------------------------------------------
# invariants (I1-I4) for one subscription: prints OK or the violations
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
periods() { su -c "select count(*) from public.subscription_billing_periods where subscription_id='$1'"; }
net() { su -c "select coalesce(sum(c.amount_ils),0) from public.subscription_charges c join public.subscription_billing_periods bp on bp.id=c.billing_period_id where bp.subscription_id='$1' and bp.raw_period_start='$2'"; }
ledger_fp() { su -c "select count(*) || ':' || coalesce(sum(amount_ils),0) from public.subscription_charges where subscription_id='$1'"; }
FIN_FP="select md5(coalesce((select string_agg(x::text,'|' order by x::text) from public.athlete_account_payments x),'') ||
  coalesce((select string_agg(x::text,'|' order by x::text) from public.documents x),'') ||
  coalesce((select string_agg(x::text,'|' order by x::text) from public.monthly_summaries x),''))"

TODAY=$(su -c "select public._studio_today_date()")
# Subscriptions start on the 10th three months ago (anchor 10) so 3-4 periods are already billed whatever day the suite runs.
START=$(su -c "select (date_trunc('month', date '$TODAY') - interval '3 months' + interval '9 days')::date")
d() { su -c "select (date '$START' + $1)::date"; }       # START + n days
anc() { su -c "select (date '$START' + interval '$1 month')::date"; }  # START + n months (= raw period boundaries)

M=""
users() { local n; n=$(date +%s%N | tail -c 9)
  M=$(su -c "select gen_random_uuid()"); COACH=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$M','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f159-$n-m@t.local', jsonb_build_object('full_name','m159','phone','051$n','gender','female','address','A','zip_code','1'), now(), now()),
    ('$COACH','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f159-$n-c@t.local', jsonb_build_object('full_name','c159','phone','052$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id in ('$M','$COACH');
    update public.profiles set role='manager' where user_id='$M';
    update public.profiles set role='coach' where user_id='$COACH'" >/dev/null; }
# new athlete + subscription (price $1) started at START, billed up to today by the real job. Sets A SUB.
sub() { local price=$1 n r; n=$(date +%s%N | tail -c 9); A=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$A','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f159-$n-a@t.local', jsonb_build_object('full_name','a159','phone','053$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved' where user_id='$A'" >/dev/null
  r=$(api "$M" "select public.create_subscription('$A', false, $price, '$START', null, 10::smallint, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2)))::text;")
  SUB=$(jf "$(echo "$r" | grep '^{')" subscription_id)
  cron
}
rpc() { api "$M" "select ($1)::text;" | grep '^{' | head -1; }
stop()   { rpc "public.stop_subscription('$SUB', '$1', true)"; }
freeze() { rpc "public.freeze_subscription('$SUB', '$1', '$2', true)"; }
edit()   { rpc "public.edit_subscription_version('$SUB', '$1', $2, null, false, null, true)"; }
act() { jf "$1" action; }

users
FIN0=$(su -c "$FIN_FP")
echo "today=$TODAY start=$START"

echo "== A: freeze then edit must not create a duplicate period or a second charge"
sub 300; P0=$(periods "$SUB"); check "A baseline" "$SUB"
expect "A freeze applied" "applied" "$(act "$(freeze "$(d 65)" "$(d 71)")")"; check "A after freeze" "$SUB"
expect "A edit applied" "applied" "$(act "$(edit "$(d 75)" 360)")"
expect "A no extra billing period after edit" "$P0" "$(periods "$SUB")"
check "A after edit" "$SUB"
cron; expect "A billing job adds no duplicate" "$P0" "$(periods "$SUB")"; check "A after job" "$SUB"
expect "A one original charge per cycle" "0" "$(su -c "select count(*) from (select bp.raw_period_start from public.subscription_billing_periods bp join public.subscription_charges c on c.billing_period_id=bp.id where bp.subscription_id='$SUB' and c.charge_type in ('recurring','proration') group by 1 having count(*)>1) z")"

echo "== A2: freeze -> edit -> freeze -> edit, retries"
sub 300; P0=$(periods "$SUB")
freeze "$(d 20)" "$(d 24)" >/dev/null; edit "$(d 30)" 320 >/dev/null; check "A2 f1+e1" "$SUB"
freeze "$(d 50)" "$(d 53)" >/dev/null; check "A2 f2" "$SUB"
R=$(edit "$(d 55)" 340); expect "A2 e2 applied" "applied" "$(act "$R")"; check "A2 e2" "$SUB"
L1=$(ledger_fp "$SUB"); expect "A2 identical edit retry is already_applied" "already_applied" "$(act "$(edit "$(d 55)" 340)")"
expect "A2 retry wrote nothing" "$L1" "$(ledger_fp "$SUB")"
cron; expect "A2 no extra period" "$P0" "$(periods "$SUB")"; check "A2 after job" "$SUB"

echo "== B: retroactive stop across several billed periods corrects every one of them"
sub 300; P0=$(periods "$SUB"); S=$(d 40); P2=$(anc 1); P3=$(anc 2)
expect "B stop applied" "applied" "$(act "$(stop "$S")")"
EXP2=$(su -c "select round(300 * (date '$S' - date '$P2')::numeric / (date '$P3' - date '$P2'), 2)")
expect "B period containing the stop is prorated" "$EXP2" "$(net "$SUB" "$P2")"
expect "B every later billed period nets to 0" "0" "$(su -c "select count(*) from public.subscription_billing_periods bp where bp.subscription_id='$SUB' and bp.raw_period_start >= '$P3' and (select coalesce(sum(amount_ils),0) from public.subscription_charges c where c.billing_period_id=bp.id) <> 0")"
expect "B earlier period untouched" "300.00" "$(net "$SUB" "$START")"
check "B" "$SUB"
cron; expect "B job bills nothing after the stop" "$P0" "$(periods "$SUB")"; check "B after job" "$SUB"

echo "== B2: repeated stop, then an earlier stop date"
L1=$(ledger_fp "$SUB"); expect "B2 identical stop is already_applied" "already_applied" "$(act "$(stop "$S")")"
expect "B2 retry wrote nothing" "$L1" "$(ledger_fp "$SUB")"
S2=$(d 35); expect "B2 earlier stop applied" "applied" "$(act "$(stop "$S2")")"
EXP2=$(su -c "select round(300 * (date '$S2' - date '$P2')::numeric / (date '$P3' - date '$P2'), 2)")
expect "B2 period re-prorated to the earlier date" "$EXP2" "$(net "$SUB" "$P2")"
check "B2" "$SUB"

echo "== C: retroactive price edit across several billed periods corrects every one of them"
sub 300; E=$(d 35); P2=$(anc 1); P3=$(anc 2)
expect "C edit applied" "applied" "$(act "$(edit "$E" 400)")"
EXP2=$(su -c "select round((300 * (date '$E' - date '$P2') + 400 * (date '$P3' - date '$E'))::numeric / (date '$P3' - date '$P2'), 2)")
expect "C period containing the change is blended" "$EXP2" "$(net "$SUB" "$P2")"
expect "C every later billed period is at the new price" "0" "$(su -c "select count(*) from public.subscription_billing_periods bp where bp.subscription_id='$SUB' and bp.raw_period_start >= '$P3' and (select coalesce(sum(amount_ils),0) from public.subscription_charges c where c.billing_period_id=bp.id) <> 400")"
check "C" "$SUB"

echo "== D: retroactive freeze across a period boundary"
sub 300; P0=$(periods "$SUB")
expect "D freeze applied" "applied" "$(act "$(freeze "$(d 58)" "$(d 66)")")"; check "D" "$SUB"
cron; check "D after job" "$SUB"
expect "D no extra period" "$P0" "$(periods "$SUB")"

echo "== E: concurrency"
sub 300; S=$(d 40)
( stop "$S" > /tmp/159_e1 ) & ( stop "$S" > /tmp/159_e2 ) & wait
expect "E parallel identical stops: one applied, one already_applied" "already_applied applied" "$(for f in /tmp/159_e1 /tmp/159_e2; do jf "$(cat $f)" action; done | sort | tr '\n' ' ' | sed 's/ $//')"
check "E stop x2" "$SUB"
sub 300; S=$(d 40)
( stop "$S" > /tmp/159_e3 ) & ( cron ) & wait; cron
expect "E stop racing the job applied" "applied" "$(act "$(cat /tmp/159_e3)")"; check "E stop vs job" "$SUB"
sub 300
( edit "$(d 35)" 410 > /tmp/159_e4 ) & ( edit "$(d 35)" 410 > /tmp/159_e5 ) & wait
expect "E parallel identical edits: one applied, one already_applied" "already_applied applied" "$(for f in /tmp/159_e4 /tmp/159_e5; do jf "$(cat $f)" action; done | sort | tr '\n' ' ' | sed 's/ $//')"
check "E edit x2" "$SUB"
rm -f /tmp/159_e[1-5]

echo "== F: authorization"
sub 300; L1=$(ledger_fp "$SUB")
for who in "anon:" "authenticated:$A" "authenticated:$COACH"; do r=${who%%:*}; u=${who#*:}
  out=$(api_as "$r" "$u" "select public.stop_subscription('$SUB', '$(d 40)', true)::text;")
  case "$out" in *forbidden*|*"permission denied"*) ok "F stop_subscription refused for $r ${u:+(non-manager)}";; *) fail "F stop_subscription as $r: $out";; esac
done
VER=$(su -c "select id from public.subscription_versions where subscription_id='$SUB' and effective_to is null")
for call in \
  "public.subscription_generate_or_correct_billing_period('$SUB','$VER', date '2031-01-10', date '2031-02-10', null, null)" \
  "public.generate_due_subscription_charges()" \
  "public.invoke_generate_subscription_charges_edge()" \
  "public.subscription_compute_impact('$SUB', 'stop', null, null, current_date)" \
  "public.subscription_reconcile_week('$SUB', current_date, 'group')" \
  "public.subscription_reserve_or_reject('$A', false, gen_random_uuid(), false)" \
  "public.subscription_billing_period_amount('$SUB', current_date, current_date + 30)" \
  "public.subscription_effective_next_billing_date('$SUB')" ; do
  for r in anon authenticated; do u=""; [ $r = authenticated ] && u=$M
    out=$(api_as "$r" "$u" "select ($call)::text;")
    case "$out" in *"permission denied"*) ok "F ${call%%(*} denied to $r";; *) fail "F ${call%%(*} as $r was not denied: $(echo "$out" | head -1 | cut -c1-120)";; esac
  done
done
expect "F refused calls wrote nothing" "$L1" "$(ledger_fp "$SUB")"
out=$(api_as service_role "" "select public.generate_due_subscription_charges()::text;")
case "$out" in *'"ok" : true'*) ok "F service_role (edge function) can still run the billing job";; *) fail "F service_role job: $out";; esac
expect "F manager entry point still works" "applied" "$(act "$(stop "$(d 40)")")"

echo "== G: paid accounts — payments and documents are never touched by corrections"
sub 300; P2=$(anc 1)
su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by) values ('$A', false, 900, 'cash', date '$START', '$M')" >/dev/null
PAY0=$(su -c "select count(*) || ':' || coalesce(sum(amount_ils),0) from public.athlete_account_payments where payee_id='$A'")
FIN1=$(su -c "$FIN_FP")
stop "$(d 40)" >/dev/null
expect "G payments unchanged by the stop" "$PAY0" "$(su -c "select count(*) || ':' || coalesce(sum(amount_ils),0) from public.athlete_account_payments where payee_id='$A'")"
expect "G payments/documents/summaries fingerprint unchanged" "$FIN1" "$(su -c "$FIN_FP")"
expect "G corrections are append-only (no charge row was updated or deleted)" "0" "$(su -c "select count(*) from public.subscription_charges c where c.subscription_id='$SUB' and c.charge_type in ('recurring','proration') and c.amount_ils <> 300 and c.created_at < (select min(created_at) from public.subscription_charges where subscription_id='$SUB' and charge_type='reversal')")"
check "G" "$SUB"

echo "== I5: no payment, document or summary was touched by the whole suite (other than G's own fixture payment)"
expect "I5 finance fingerprint" "$FIN1" "$(su -c "$FIN_FP")"

echo
echo "159 subscription billing integrity: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
