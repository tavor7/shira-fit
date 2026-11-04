#!/usr/bin/env bash
# A change must not take coverage from a session completed before it took effect. The studio clock is pinned, so every weekday
# is exercised whatever day this runs. SCRATCH DATABASES ONLY: replaces two clock functions for the run and restores them on exit.
. "$(dirname "$0")/lib_subscription_harness.sh"
ORIG_TODAY=$(su -c "select pg_get_functiondef('public._studio_today_date()'::regprocedure)")
ORIG_ENDED=$(su -c "select pg_get_functiondef('public._session_has_ended(public.training_sessions)'::regprocedure)")
restore() { printf '%s;\n%s;\n' "$ORIG_TODAY" "$ORIG_ENDED" | $PSQL -q >/dev/null; }
trap restore EXIT
REAL=$(su -c "select public._studio_today_date()")
W=$(su -c "select (date '$REAL' - extract(dow from date '$REAL')::int)::date")
day() { su -c "select (date '$W' + $1)::date"; }
pin() { # a timestamptz. The function bodies are the real ones, with now() replaced.
  $PSQL -q >/dev/null <<SQL
create or replace function public._studio_today_date() returns date language sql stable as \$f\$ select (timezone('Asia/Jerusalem', timestamptz '$1'))::date \$f\$;
create or replace function public._session_has_ended(v_sess public.training_sessions) returns boolean language plpgsql stable as \$f\$
declare v_start timestamptz; v_end timestamptz;
begin
  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');
  v_end := v_start + make_interval(mins => coalesce(v_sess.duration_minutes, 60));
  return timestamptz '$1' >= v_end;
end \$f\$;
SQL
  TODAY=$(su -c "select public._studio_today_date()")
}
at() { pin "$(day "$1") $2 Asia/Jerusalem"; } # day offset, time
newsub() { mkuser athlete; A=$U; mksub "$A" "$(day -21)" "$1" 360 ${2:-}; }
cover() { su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,registration_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$1','$2','$(su -c "select (date '$2' - extract(dow from date '$2')::int)::date")','group',true,'registration') on conflict (registration_id) where registration_id is not null do update set covered=true,non_coverage_reason=null" >/dev/null; }
done_s() { local dt; dt=$(day "$1"); mksession "$dt" 8 "${2:-}"; su -c "update public.training_sessions set custom_slot_price_ils=80 where id='$SX'" >/dev/null; past_reg "$A" "$SX" true; cover "$REG" "$dt"; }
planned() { local dt; dt=$(day "$1"); mksession "$dt" 8 "${2:-}"; su -c "update public.training_sessions set custom_slot_price_ils=80 where id='$SX'" >/dev/null; past_reg "$A" "$SX" null; cover "$REG" "$dt"; }
extra_s() { done_s "$@"; su -c "update public.subscription_registration_coverage set covered=false,non_coverage_reason='allowance_exceeded' where registration_id='$REG'" >/dev/null; }
snap() { su -c "select coalesce(string_agg(coalesce(registration_id,manual_participant_id)::text||':'||covered||':'||coalesce(non_coverage_reason::text,''),',' order by coalesce(registration_id,manual_participant_id)::text),'') from public.subscription_registration_coverage where subscription_id='$SUB'"; }
changed() { su -c "select count(*) from unnest(string_to_array('$1',',')) a full join unnest(string_to_array('$2',',')) b on a=b where a is null" ; }
owes() { su -c "select coalesce(sum(public.session_billing_price_ils(r.session_id,r.user_id,null)),0)::int from public.session_registrations r join public.subscription_registration_coverage c on c.registration_id=r.id where r.user_id='$A' and r.attended and not c.covered"; }
reserve() { su -c "select (d).outcome from (select public.subscription_reserve_or_reject('$A',false,'$1',true) d) x"; }
over() { su -c "select coalesce(sum(greatest((u->>'used')::int-(u->>'effective_weekly_limit')::int,0)),0) from jsonb_array_elements(public._subscription_week_usage(null,'$A',false,'$W',array['group']::public.subscription_tier[])) u"; }
allow() { echo "jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',$1))"; }
# change kind date ... : preview, compare with what really happens
change() { local kind=$1 p c before after pv
  case "$kind" in
    stop)   p="select public.stop_subscription_with_future_registrations('$SUB','$2',false,null,null,null)::text;"
            c="select public.stop_subscription_with_future_registrations('$SUB','$2',true,${3:-null},${4:-null},$([ -n "${4:-}" ] && echo "ARRAY[]::uuid[]" || echo null))::text;" ;;
    freeze) p="select public.freeze_subscription('$SUB','$2','$3',false)::text;"; c="select public.freeze_subscription('$SUB','$2','$3',true)::text;" ;;
    limit)  p="select public.edit_subscription_version('$SUB','$2',null,null,false,$(allow "$3"),false)::text;"; c="select public.edit_subscription_version('$SUB','$2',null,null,false,$(allow "$3"),true)::text;" ;;
    shorten) p="select public.edit_subscription_version('$SUB','$2',null,'$3',false,null,false)::text;"; c="select public.edit_subscription_version('$SUB','$2',null,'$3',false,null,true)::text;" ;;
  esac
  before=$(snap); R=$(api "$M" "$p"); pv=$(su -c "select coalesce(('$R'::jsonb)#>>'{impact,count}',('$R'::jsonb)->>'count','?')")
  R=$(api "$M" "$c"); expect "$kind accepted" "true" "$(jf "$R" ok)"; after=$(snap)
  expect "$kind: the preview matches what happened" "$pv" "$(changed "$before" "$after")"
}

echo "== The original report: Sunday and Monday attended, change on Wednesday"
for kind in stop freeze limit; do
  at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; CH0=$(charges "$SUB")
  case $kind in stop) change stop "$TODAY";; freeze) change freeze "$TODAY" "$(day 5)";; limit) change limit "$TODAY" 1;; esac
  expect "$kind: Sunday keeps coverage" "true:" "$(cov "$R0")"; expect "$kind: Monday keeps coverage" "true:" "$(cov "$R1")"
  expect "$kind: no regular price appears" "0" "$(owes)"; expect "$kind: nothing reads as over-allocated" "0" "$(over)"
done

echo "== Limit of three, three completed, Wednesday stop"
at 3 12:00; newsub 3; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; change stop "$TODAY"
expect "all three stay" "true:|true:|true:" "$(cov "$R0")|$(cov "$R1")|$(cov "$R2")"; expect "no regular price" "0" "$(owes)"

echo "== Charges are what they are with no sessions at all"
for kind in stop freeze limit; do
  at 3 12:00; newsub 2; SUB0=$SUB; case $kind in stop) change stop "$TODAY";; freeze) change freeze "$TODAY" "$(day 5)";; limit) change limit "$TODAY" 1;; esac; CTRL=$(charges "$SUB0")
  newsub 2; done_s 0; done_s 1; case $kind in stop) change stop "$TODAY";; freeze) change freeze "$TODAY" "$(day 5)";; limit) change limit "$TODAY" 1;; esac
  expect "$kind: same charges as the control" "$CTRL" "$(charges "$SUB")"
done

echo "== Every weekday: sessions before the change stay, sessions after it follow the change"
for X in 0 1 2 3 4 5 6; do for kind in stop freeze limit shorten; do
  at "$X" 12:00; newsub 2; RS=()
  [ "$X" -ge 1 ] && { done_s 0; RS+=("$REG"); }; [ "$X" -ge 2 ] && { done_s 1; RS+=("$REG"); }
  mksession "$(day -7)"; past_reg "$A" "$SX" true; LAST=$REG; cover "$LAST" "$(day -7)"
  case $kind in
    stop) change stop "$TODAY";; freeze) change freeze "$TODAY" "$(su -c "select date '$TODAY'+1")";;
    limit) change limit "$TODAY" 1;; shorten) change shorten "$TODAY" "$TODAY";;
  esac
  for r in ${RS[@]+"${RS[@]}"}; do expect "dow $X $kind: completed session keeps coverage" "true:" "$(cov "$r")"; done
  expect "dow $X $kind: last week untouched" "true:" "$(cov "$LAST")"; expect "dow $X $kind: no regular price" "0" "$(owes)"; expect "dow $X $kind: not over-allocated" "0" "$(over)"
done; done

echo "== Future bookings after a mid-week change face the reduced limit"
at 3 12:00; newsub 2; done_s 0; done_s 1; change limit "$TODAY" 1
mksession "$(day 4)"; expect "lowered limit: next booking is extra" "allowance_exceeded" "$(reserve "$SX")"
at 3 12:00; newsub 3; done_s 0; change freeze "$(day 3)" "$(day 4)"
mksession "$(day 5)"; expect "after a freeze, within the prorated limit: covered" "covered" "$(reserve "$SX")"
at 3 12:00; newsub 3; done_s 0; done_s 1; change freeze "$(day 3)" "$(day 4)"
mksession "$(day 5)"; expect "after a freeze, prorated limit used up: extra" "allowance_exceeded" "$(reserve "$SX")"
at 3 12:00; newsub 2; done_s 0; done_s 1; change stop "$TODAY"
mksession "$(day 4)"; expect "after a stop: not subscribed" "not_subscribed" "$(reserve "$SX")"

echo "== A booking made earlier does not outrank a completed session"
at 3 12:00; newsub 3; planned 5; RF=$REG; done_s 0; R0=$REG; done_s 1; R1=$REG; change freeze "$(day 3)" "$(day 4)"
expect "completed sessions stay" "true:|true:" "$(cov "$R0")|$(cov "$R1")"
expect "the future booking gives way" "false:allowance_exceeded" "$(cov "$RF")"
expect "no extra covered session was created" "2" "$(su -c "select count(*) from public.subscription_registration_coverage where subscription_id='$SUB' and covered")"

echo "== Booking order does not change which sessions stay"
at 3 12:00; newsub 2; done_s 2; R2=$REG; done_s 0; R0=$REG; done_s 1; R1=$REG; su -c "update public.subscription_registration_coverage set covered=false,non_coverage_reason='allowance_exceeded' where registration_id='$R2'" >/dev/null
change stop "$TODAY"; expect "the earliest two by date stay" "true:|true:" "$(cov "$R0")|$(cov "$R1")"; expect "the extra stays extra" "false:allowance_exceeded" "$(cov "$R2")"

echo "== A change effective before a session, against after it"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change limit "$(day 0)" 1
expect "lowered from Sunday, same-day Sunday session stays" "true:" "$(cov "$R0")"; expect "Monday was after the change: regular price" "false:allowance_exceeded" "$(cov "$R1")"; expect "the price is expected" "80" "$(owes)"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change limit "$(day 2)" 1
expect "lowered from Tuesday, backdated, both before it: stay" "true:|true:" "$(cov "$R0")|$(cov "$R1")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; change stop "$(day 1)"
expect "backdated stop: before it stays" "true:" "$(cov "$R0")"; expect "backdated stop: on its date, already over, stays" "true:" "$(cov "$R1")"; contains "backdated stop: after it does not" "false:" "$(cov "$R2")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; change freeze "$(day 1)" "$(day 2)"
expect "backdated freeze: before it stays" "true:" "$(cov "$R0")"; expect "backdated freeze: first day, already over, stays" "true:" "$(cov "$R1")"; expect "backdated freeze: inside it, frozen" "false:frozen" "$(cov "$R2")"
at 3 12:00; newsub 3; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; change shorten "$TODAY" "$(day 1)"
expect "shortened, effective today: before it stays" "true:|true:|true:" "$(cov "$R0")|$(cov "$R1")|$(cov "$R2")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change limit "$TODAY" 0
expect "tier removed today: completed sessions stay" "true:|true:" "$(cov "$R0")|$(cov "$R1")"

echo "== A session later today is not protected, one earlier today is"
at 3 12:00; newsub 2; done_s 3 08:00; RE=$REG; planned 3 18:00; RL=$REG; change stop "$TODAY" "'charge_regular_price'" "ARRAY['$RL']::uuid[]"
expect "earlier today, over: stays" "true:" "$(cov "$RE")"; contains "later today: not covered" "false:" "$(cov "$RL")"

echo "== Partial weeks, and limits known before the session"
at 3 12:00; mkuser athlete; A=$U; mksub "$A" "$TODAY" 2 360
mksession "$(day 4)"; S1=$SX; mksession "$(day 5)"; S2=$SX; expect "started Wednesday: first is covered" "covered" "$(reserve "$S1")"
past_reg "$A" "$S1" null; cover "$REG" "$(day 4)"; expect "prorated to one: second is extra" "allowance_exceeded" "$(reserve "$S2")"
at 3 12:00; newsub 2; change freeze "$(day 3)" "$(day 5)"; done_s 0; R0=$REG; extra_s 1; RX=$REG
change limit "$TODAY" 2; expect "an extra under a limit known beforehand is not promoted by a later change" "false:allowance_exceeded" "$(cov "$RX")"
mark "$RX" false; mark "$RX" true; expect "and an attendance round trip does not make it free" "false:allowance_exceeded" "$(cov "$RX")"

echo "== Attendance edits after a stop"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change stop "$TODAY"
mark "$R1" false; expect "marked absent: released" "false:no_show_released" "$(cov "$R1")"
mark "$R1" true; expect "marked attended again: coverage restored" "true:" "$(cov "$R1")"; expect "no regular price" "0" "$(owes)"
mark "$R1" null; expect "unmarked: stays" "true:" "$(cov "$R1")"
mark "$R0" true; expect "re-saving another session changes nothing" "true:|true:" "$(cov "$R0")|$(cov "$R1")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; mark "$R1" false; change stop "$TODAY"; mark "$R1" true
expect "released before the stop, corrected after it: restored" "true:" "$(cov "$R1")"

echo "== Unpenalized no-shows and charged penalties"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; extra_s 2; RX=$REG; change stop "$TODAY"
mark "$R0" false; expect "released no-show stays released" "false:no_show_released" "$(cov "$R0")"
expect "after the stop a freed slot does not make an extra session free: the change creates no new coverage" "false:allowance_exceeded" "$(cov "$RX")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; extra_s 2; RX=$REG; mark "$R0" false
expect "released before any change: the slot goes to the extra session" "true:" "$(cov "$RX")"; change stop "$TODAY"
expect "and that coverage survives the stop" "true:|true:" "$(cov "$R1")|$(cov "$RX")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change stop "$TODAY"; mark "$R1" false true
expect "charged no-show on a covered session stays covered" "true:" "$(cov "$R1")"
at 3 12:00; newsub 1; done_s 0; R0=$REG; extra_s 1; RX=$REG; mark "$RX" false true; change stop "$TODAY"
expect "a penalty at the regular price keeps that price" "false:allowance_exceeded" "$(cov "$RX")"
mark "$R0" false; expect "even when a slot frees up" "false:allowance_exceeded" "$(cov "$RX")"

echo "== Paid at the regular price"
at 3 12:00; newsub 2; done_s 0; R0=$REG; extra_s 1; RX=$REG; su -c "update public.session_registrations set amount_paid=80,payment_method='cash' where id='$RX'" >/dev/null; change stop "$TODAY"
mark "$R0" false; expect "keeps its price, with no credit" "false:paid_at_regular_price" "$(cov "$RX")"

echo "== Coverage that was never valid can still be corrected"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; mark "$R2" true
su -c "update public.session_registrations set attended=null where id='$R2'; update public.session_registrations set attended=true where id='$R2'" >/dev/null
expect "three covered against a limit of two: the third is corrected" "true:|true:|false:allowance_exceeded" "$(cov "$R0")|$(cov "$R1")|$(cov "$R2")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; done_s 2; R2=$REG; change stop "$TODAY"
expect "a stop does not make invalid coverage valid" "false:allowance_exceeded" "$(cov "$R2")"

echo "== Deletion stays its own operation"
del() { R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB')::text;"); R=$(api "$M" "select public.delete_subscription_with_future_registrations('$SUB',null,true,null,null,'$(jf "$R" fingerprint)')::text;"); }
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; del
expect "deleting reprices completed sessions" "false:subscription_deleted|false:subscription_deleted" "$(cov "$R0")|$(cov "$R1")"; expect "at the regular price" "160" "$(owes)"

echo "== Receipt-locked sessions"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; su -c "update public.session_registrations set amount_paid=50,payment_method='cash' where id='$R1'; insert into public.external_manual_receipts(row_kind,record_id,note) values ('session_reg','$R1','t')" >/dev/null
RCPT=$(su -c "select md5(e::text) from public.external_manual_receipts e where record_id='$R1'"); change stop "$TODAY"
expect "a stop keeps it covered" "true:" "$(cov "$R1")"; expect "the receipt is untouched" "$RCPT" "$(su -c "select md5(e::text) from public.external_manual_receipts e where record_id='$R1'")"
at 3 12:00; newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; su -c "update public.session_registrations set amount_paid=50,payment_method='cash' where id='$R1'; insert into public.external_manual_receipts(row_kind,record_id,note) values ('session_reg','$R1','t')" >/dev/null
del; expect "deleting leaves it for the correction workflow" "pending" "$(su -c "select status from public.subscription_deletion_corrections where subscription_id='$SUB'")"; expect "still covered until decided" "true:" "$(cov "$R1")"; expect "the other is repriced" "false:subscription_deleted" "$(cov "$R0")"

echo "== Midnight and time zones"
pin "$(day 3) 00:10 Asia/Jerusalem"; newsub 3; done_s 0; R0=$REG; done_s 1; R1=$REG; planned 2 23:30; RN=$REG; change stop "$TODAY"
expect "still running across midnight, begun before the stop: stays" "true:" "$(cov "$RN")"; expect "with the others" "true:|true:" "$(cov "$R0")|$(cov "$R1")"
pin "$(day 2) 21:30 UTC"; expect "studio date, not UTC" "$(day 2)" "$TODAY"; pin "$(day 2) 22:30 UTC"; expect "studio date moved on" "$(day 3)" "$TODAY"
newsub 2; done_s 0; R0=$REG; done_s 1; R1=$REG; change stop "$TODAY"; expect "UTC evening is the next studio day: both stay" "true:|true:" "$(cov "$R0")|$(cov "$R1")"

echo "== Manual participants follow the same rule"
at 3 12:00; mkmanual; R=$(api "$M" "select public.create_subscription('$MP',true,360,'$(day -21)',null,null,$(allow 2))::text;"); SUB=$(jf "$R" subscription_id); VER=$(su -c "select id from public.subscription_versions where subscription_id='$SUB' and effective_to is null")
for o in 0 1; do dt=$(day $o); mksession "$dt"; RM=$(su -c "insert into public.session_manual_participants(session_id,manual_participant_id,added_at,attended) values ('$SX','$MP',now(),true) returning id" | head -1); su -c "insert into public.subscription_registration_coverage(subscription_id,version_id,manual_participant_id,session_date,week_start,tier,covered,decided_by) values ('$SUB','$VER','$RM','$dt','$W','group',true,'registration') on conflict (manual_participant_id) where manual_participant_id is not null do update set covered=true,non_coverage_reason=null" >/dev/null; eval "RM$o=$RM"; done
change stop "$TODAY"; expect "both stay" "true:|true:" "$(covm "$RM0")|$(covm "$RM1")"

echo "== Reports agree: Overview, weekly usage and the athlete's view"
at 3 12:00; newsub 2; done_s 0; done_s 1; change limit "$TODAY" 1
J=$(api "$M" "select public.manager_subscription_week_utilization('$W')::text;")
expect "Overview: used two, none over" "2|2|0" "$(su -c "select r->>'occupied','x' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$A'" | cut -d'|' -f1)|$(su -c "select r->>'available' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$A'")|$(su -c "select r->>'over' from jsonb_array_elements(('$J'::jsonb)->'rows') r where r->>'payee_id'='$A'")"
expect "the integrity check does not flag this athlete" "0" "$(over)"
expect "bookings still use the reduced limit" "1" "$(su -c "select public.subscription_effective_weekly_limit('$A',false,'group','$W')")"
finish
