#!/usr/bin/env bash
# Payment reminders: financial correctness, family accounts, permissions and RLS, lifecycle, concurrency, and that general
# manager messages and financial records are untouched. Real connections as `authenticated`.
# Usage: PSQL=... supabase/tests/209_payment_reminders_tests.sh   (LOCAL stack only, commits fixtures)
set -u
PSQL=${PSQL:?set PSQL}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@" </dev/null; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
as() { local uid=$1; shift
  echo "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}'; $*; commit;" \
    | $PSQL -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
new_user() { local role=$1 id; id=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$id','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t209-$id@t.local',now(),now());
         update public.profiles set approval_status='approved', role='$role', full_name='T209 $role' where user_id='$id'" >/dev/null
  echo "$id"; }
# A real debt through the normal finance path: an attended session at a custom price.
debt() { local u=$1 amt=$2 s
  s=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, custom_slot_price_ils)
             values (current_date - (1 + floor(random()*20))::int, make_time(6 + floor(random()*14)::int, floor(random()*60)::int, floor(random()*60)::int), '$COACH', 10, $amt) returning id")
  su -c "insert into public.session_registrations (session_id, user_id, status, attended) values ('$s','$u','active',true)" >/dev/null; }
pay() { local u=$1 amt=$2 d=${3:-current_date}
  su -c "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at)
         values ('$u', false, $amt, 'cash', $d)" >/dev/null; }
balance() { su -c "select public._payment_account_balance(public._payment_account_key('$1', false))::numeric(12,2)"; }
send() { local mgr=$1 to=$2 amt=$3; as "$mgr" "select public.send_payment_reminder('$to', $amt)"; }
err() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/\{.*\}/);if(!m){console.log("NOJSON:"+s.slice(0,120));return}const o=JSON.parse(m[0]);console.log(o.ok?"ok":o.error)})'; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/\{.*\}/);if(!m){console.log("NOJSON");return}let o=JSON.parse(m[0]);for(const k of process.argv[1].split("."))o=o==null?o:o[k];console.log(o===null||o===undefined?"null":(typeof o==="object"?JSON.stringify(o):o))})' "$1"; }
pending() { as "$1" "select public.get_pending_manager_direct_message()"; }
status_of() { su -c "select case when read_at is not null then 'read' when closed_reason is not null then closed_reason else 'pending' end from public.manager_direct_messages where id='$1'"; }
last_reminder() { su -c "select id from public.manager_direct_messages where recipient_id='$1' and message_kind='payment_reminder' order by created_at desc limit 1"; }
fin() { su -c "select (select coalesce(sum(amount_ils),0)||'/'||count(*) from public.athlete_account_payments) || '|' || (select coalesce(sum(amount_ils),0)||'/'||count(*) from public.subscription_charges) || '|' || (select coalesce(sum(amount_paid),0)||'/'||count(*) from public.session_registrations) || '|' || (select count(*) from public.documents)"; }

MGR=$(new_user manager); MGR2=$(new_user manager); COACH=$(new_user coach)

echo "--- financial correctness"
A=$(new_user athlete); debt "$A" 210
expect "the balance comes from the finance function" 210.00 "$(balance "$A")"
expect "and equals that function's own row" 210.00 "$(su -c "select outstanding_ils from public._period_merged_athlete_finance('2000-01-01','2100-01-01') where kind='app' and pid='$A'")"
BEFORE=$(fin)
expect "a stale amount is refused" balance_changed "$(send "$MGR" "$A" 999 | err)"
expect "and the refusal says the current amount" 210 "$(send "$MGR" "$A" 999 | field current_amount)"
expect "sending at the real amount works" ok "$(send "$MGR" "$A" 210 | err)"
M=$(last_reminder "$A")
expect "the stored amount is the server's" 210.00 "$(su -c "select amount_ils from public.manager_direct_messages where id='$M'")"
expect "the sender row keeps the manager for audit" "$MGR" "$(su -c "select sender_id from public.manager_direct_messages where id='$M'")"
expect "financial records unchanged by sending" "$BEFORE" "$(fin)"

Z=$(new_user athlete)
expect "zero balance refused" no_debt "$(send "$MGR" "$Z" 0 | err)"
C=$(new_user athlete); pay "$C" 120
expect "credit balance refused" no_debt "$(send "$MGR" "$C" -120 | err)"
F=$(new_user athlete); debt "$F" 300; pay "$F" 100 "current_date + 30"
expect "a future-dated recorded payment counts" 200.00 "$(balance "$F")"
FF=$(new_user athlete); debt "$FF" 100; pay "$FF" 100 "current_date + 30"
expect "fully paid by a future-dated payment is no debt" no_debt "$(send "$MGR" "$FF" 0 | err)"
R=$(new_user athlete); debt "$R" 90
su -c "insert into public.athlete_account_payments (payee_id,payee_is_manual,amount_ils,payment_method,paid_at,reversed_at,reversed_by) values ('$R',false,90,'cash',current_date,now(),'$MGR')" >/dev/null
expect "a reversed payment does not count" 90.00 "$(balance "$R")"

echo "--- the athlete's view: recheck before showing"
P=$(pending "$A")
expect "reminder is shown" payment_reminder "$(echo "$P" | field message.message_kind)"
expect "from the studio, not the manager" "Shira Fit Studio" "$(echo "$P" | field message.sender_name)"
expect "with the amount" 210 "$(echo "$P" | field message.amount_ils | sed 's/\.00$//')"
case "$(echo "$P" | field message.body)" in *210*) ok "message contains the amount";; *) fail "message has no amount";; esac
case "$P" in *session*|*charge*|*T209*) fail "payload leaks details: $P";; *) ok "no breakdown or names in the payload";; esac
expect "being fetched does not mark it read" pending "$(status_of "$M")"
expect "an app restart shows it again" "$(echo "$P" | field message.id)" "$(pending "$A" | field message.id)"
pay "$A" 60
P=$(pending "$A")
expect "after a partial payment the current amount shows" 150 "$(echo "$P" | field message.amount_ils | sed 's/\.00$//')"
case "$(echo "$P" | field message.body)" in *150*) ok "the fallback message uses the current amount too";; *) fail "stale message body";; esac
expect "history keeps what was sent" 210.00 "$(su -c "select amount_ils from public.manager_direct_messages where id='$M'")"
expect "and what was shown" 150.00 "$(su -c "select shown_amount_ils from public.manager_direct_messages where id='$M'")"
expect "a second reminder is refused while unread" already_pending "$(send "$MGR2" "$A" 150 | err)"
as "$A" "select public.mark_manager_direct_message_read('$M')" >/dev/null
expect "acknowledging marks it read" read "$(status_of "$M")"
expect "with a read time" t "$(su -c "select read_at is not null from public.manager_direct_messages where id='$M'")"
expect "nothing more to show" null "$(pending "$A" | field message)"
expect "no cooldown after reading" ok "$(send "$MGR" "$A" 150 | err)"

echo "--- settled before it was seen"
S=$(new_user athlete); debt "$S" 80; send "$MGR" "$S" 80 >/dev/null; M=$(last_reminder "$S"); pay "$S" 80
expect "settled reminder is not shown" null "$(pending "$S" | field message)"
expect "it is closed as settled" settled "$(status_of "$M")"
expect "it stays in the history" 1 "$(su -c "select count(*) from public.manager_direct_messages where id='$M'")"
S2=$(new_user athlete); debt "$S2" 80; send "$MGR" "$S2" 80 >/dev/null; M2=$(last_reminder "$S2"); pay "$S2" 80
expect "the manager card closes it too" settled "$(as "$MGR" "select public.manager_payment_reminder_status('$S2')" | field history.0.status)"
expect "a closed reminder cannot be acknowledged" not_found "$(as "$S2" "select public.mark_manager_direct_message_read('$M2')" | err)"

echo "--- family accounts"
Y=$(new_user athlete); O=$(new_user athlete); OUT=$(new_user athlete)
QP=$(su -c "insert into public.manual_participants (full_name, phone) values ('T209 quick', gen_random_uuid()::text) returning id")
FAM=$(su -c "insert into public.athlete_families (name) values ('T209 fam') returning id")
su -c "insert into public.athlete_family_members (family_id, user_id) values ('$FAM','$Y'),('$FAM','$O'); insert into public.athlete_family_members (family_id, manual_participant_id) values ('$FAM','$QP')" >/dev/null
debt "$Y" 340; pay "$O" 80; debt "$OUT" 55
expect "combined family balance" 260.00 "$(balance "$Y")"
expect "the same from either member" 260.00 "$(balance "$O")"
expect "an outsider is separate" 55.00 "$(balance "$OUT")"
ST=$(as "$MGR" "select public.manager_payment_reminder_status('$Y')")
expect "status is the family account" true "$(echo "$ST" | field is_family)"
expect "lists every member" 3 "$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.match(/\{.*\}/)[0]).members.length))')"
expect "a quick-add member cannot receive it" no_login "$(echo "$ST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.match(/\{.*\}/)[0]).members.find(m=>m.kind==="manual").ineligible_reason))')"
expect "a member with a credit can still be chosen, the family owes" ok "$(send "$MGR" "$O" 260 | err)"
MF=$(last_reminder "$O")
expect "one unread per family: another member is refused" already_pending "$(send "$MGR2" "$Y" 260 | err)"
expect "the chosen member sees it" 260 "$(pending "$O" | field message.amount_ils | sed 's/\.00$//')"
expect "flagged as a family account" true "$(pending "$O" | field message.is_family)"
expect "the other member does not" null "$(pending "$Y" | field message)"
expect "an outsider does not" null "$(pending "$OUT" | field message)"
P=$(pending "$O"); case "$P" in *T209*|*"$Y"*) fail "another member's details leaked: $P";; *) ok "no other member's name or id reaches the recipient";; esac
expect "a family member cannot read the manager status" forbidden "$(as "$Y" "select public.manager_payment_reminder_status('$O')" | err)"
as "$O" "select public.mark_manager_direct_message_read('$MF')" >/dev/null
expect "after it is read another member can receive one" ok "$(send "$MGR" "$Y" 260 | err)"
MY=$(last_reminder "$Y")
su -c "delete from public.athlete_family_members where user_id='$Y'" >/dev/null
expect "leaving the family closes the old family reminder unseen" null "$(pending "$Y" | field message)"
expect "as account_changed" account_changed "$(status_of "$MY")"
su -c "insert into public.athlete_family_members (family_id, user_id) values ('$FAM','$Y')" >/dev/null
BA=$(new_user athlete); BB=$(new_user athlete); FB=$(su -c "insert into public.athlete_families (name) values ('T209 even') returning id")
su -c "insert into public.athlete_family_members (family_id, user_id) values ('$FB','$BA'),('$FB','$BB')" >/dev/null
debt "$BA" 150; pay "$BB" 150
expect "a member owes but the family is even: refused" no_debt "$(send "$MGR" "$BA" 150 | err)"
expect "search list shows the combined balance" 0 "$(as "$MGR" "select public.manager_account_balances()" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.match(/\{.*\}/s)[0]).rows.find(x=>x.id===process.argv[1]);console.log(Number(r.balance))})' "$BA")"

echo "--- who can receive one"
expect "a coach cannot" recipient_not_eligible "$(send "$MGR" "$COACH" 1 | err)"
expect "a manager cannot" recipient_not_eligible "$(send "$MGR" "$MGR2" 1 | err)"
D=$(new_user athlete); debt "$D" 50; su -c "update public.profiles set disabled_at=now() where user_id='$D'" >/dev/null
expect "a disabled athlete cannot" recipient_not_eligible "$(send "$MGR" "$D" 50 | err)"
PA=$(new_user athlete); debt "$PA" 50; su -c "update public.profiles set approval_status='pending' where user_id='$PA'" >/dev/null
expect "an unapproved athlete cannot" recipient_not_eligible "$(send "$MGR" "$PA" 50 | err)"
expect "a quick-add id cannot" recipient_not_eligible "$(send "$MGR" "$QP" 1 | err)"

echo "--- permissions and RLS"
N=$(new_user athlete); debt "$N" 70
expect "an athlete cannot send" forbidden "$(send "$N" "$N" 70 | err)"
expect "a coach cannot send" forbidden "$(send "$COACH" "$N" 70 | err)"
expect "a coach cannot read balances" forbidden "$(as "$COACH" "select public.manager_account_balances()" | err)"
expect "an athlete cannot read balances" forbidden "$(as "$N" "select public.manager_account_balances()" | err)"
expect "a coach cannot read status" forbidden "$(as "$COACH" "select public.manager_payment_reminder_status('$N')" | err)"
send "$MGR" "$N" 70 >/dev/null; MN=$(last_reminder "$N")
expect "a coach cannot cancel" forbidden "$(as "$COACH" "select public.cancel_payment_reminder('$MN')" | err)"
expect "the recipient cannot cancel" forbidden "$(as "$N" "select public.cancel_payment_reminder('$MN')" | err)"
OTHER=$(new_user athlete)
expect "someone else cannot acknowledge it" not_found "$(as "$OTHER" "select public.mark_manager_direct_message_read('$MN')" | err)"
expect "someone else's fetch has nothing" null "$(pending "$OTHER" | field message)"
expect "a recipient cannot read reminders from the table directly" 0 "$(as "$N" "select count(*) from public.manager_direct_messages where message_kind='payment_reminder'")"
expect "another athlete cannot either" 0 "$(as "$OTHER" "select count(*) from public.manager_direct_messages where id='$MN'")"
denied() { as "$1" "$2" | grep -cE "row-level security|permission denied|violates check"; }
expect "a manager cannot insert a reminder directly" 1 "$(denied "$MGR" "insert into public.manager_direct_messages (sender_id,recipient_id,body,message_kind,amount_ils,account_key,is_family_account) values ('$MGR','$OTHER','x','payment_reminder',1,'user:$OTHER',false)")"
expect "nor smuggle an amount onto a general message" 1 "$(denied "$MGR" "insert into public.manager_direct_messages (sender_id,recipient_id,body,amount_ils) values ('$MGR','$OTHER','x',5)")"
expect "nor forge a closed general message" 1 "$(denied "$MGR" "insert into public.manager_direct_messages (sender_id,recipient_id,body,closed_at,closed_reason) values ('$MGR','$OTHER','x',now(),'settled')")"
expect "an athlete cannot insert" 1 "$(denied "$OTHER" "insert into public.manager_direct_messages (sender_id,recipient_id,body) values ('$OTHER','$N','x')")"
expect "a manager cannot update a reminder" 1 "$(denied "$MGR" "update public.manager_direct_messages set amount_ils=1 where id='$MN'")"
expect "a recipient cannot mark it read directly" 1 "$(denied "$N" "update public.manager_direct_messages set read_at=now() where id='$MN'")"
expect "a manager cannot delete a reminder" 1 "$(denied "$MGR" "delete from public.manager_direct_messages where id='$MN'")"
for FN in "_payment_balance_rows()" "_payment_account_key(uuid,boolean)" "_payment_account_members(text)" "_payment_account_balance(text)" "_payment_account_has_hidden(text)" "_payment_recipient_ineligible_reason(uuid)" "_payment_account_refresh(text)"; do
  expect "$FN not callable by clients" f "$(su -c "select has_function_privilege('authenticated','public.$FN','execute') or has_function_privilege('anon','public.$FN','execute')")"
done
for FN in "send_payment_reminder(uuid,numeric)" "cancel_payment_reminder(uuid)" "manager_account_balances()" "manager_payment_reminder_status(uuid,boolean)"; do
  expect "$FN not callable by anon" f "$(su -c "select has_function_privilege('anon','public.$FN','execute')")"
done

echo "--- cancelling"
expect "the general cancel cannot delete a reminder" not_found_or_already_read "$(as "$MGR" "select public.cancel_manager_direct_message('$MN')" | err)"
expect "any manager can cancel, not only the sender" ok "$(as "$MGR2" "select public.cancel_payment_reminder('$MN')" | err)"
expect "cancelled" cancelled "$(status_of "$MN")"
expect "the row stays" 1 "$(su -c "select count(*) from public.manager_direct_messages where id='$MN'")"
expect "records who cancelled" "$MGR2" "$(su -c "select closed_by from public.manager_direct_messages where id='$MN'")"
expect "the athlete no longer sees it" null "$(pending "$N" | field message)"
expect "acknowledging it now does nothing" not_found "$(as "$N" "select public.mark_manager_direct_message_read('$MN')" | err)"
expect "cancelling twice is refused" not_found_or_already_read "$(as "$MGR2" "select public.cancel_payment_reminder('$MN')" | err)"
expect "another can be sent after cancelling" ok "$(send "$MGR" "$N" 70 | err)"
expect "the audit log has the send" t "$(su -c "select exists (select 1 from public.user_activity_events where event_type='payment_reminder_sent' and target_id='$MN')")"
expect "the audit log has the cancel" t "$(su -c "select exists (select 1 from public.user_activity_events where event_type='payment_reminder_cancelled' and target_id='$MN')")"

echo "--- hidden registrations"
H=$(new_user athlete); debt "$H" 40
HS=$(su -c "select session_id from public.session_registrations where user_id='$H' limit 1")
su -c "insert into public.super_user_hidden_registrations (session_id, user_id, hide_from_athlete, hidden_by) values ('$HS','$H',true,'$MGR')" >/dev/null
expect "refused, so an amount cannot reveal it" has_hidden_registrations "$(send "$MGR" "$H" 40 | err)"
expect "an ordinary manager does not see the number" null "$(as "$MGR" "select public.manager_payment_reminder_status('$H')" | field balance)"
expect "nor in the search list" null "$(as "$MGR" "select public.manager_account_balances()" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.match(/\{.*\}/s)[0]).rows.find(x=>x.id===process.argv[1]);console.log(r.balance===null?"null":r.balance)})' "$H")"

echo "--- general messages are unchanged"
G=$(new_user athlete)
GM=$(as "$MGR" "select public.send_manager_direct_message('$G','hello','love','operational')" | field id)
[ -n "$GM" ] && ok "general send works" || fail "general send"
expect "a direct general insert still works" 1 "$(as "$MGR" "insert into public.manager_direct_messages (sender_id,recipient_id,body) values ('$MGR','$G','direct') returning 1")"
expect "shown first, oldest first, with its real sender" "T209 manager" "$(pending "$G" | field message.sender_name)"
expect "kind general" general "$(pending "$G" | field message.message_kind)"
expect "its body is untouched" hello "$(pending "$G" | field message.body)"
expect "the recipient can still read it directly" 2 "$(as "$G" "select count(*) from public.manager_direct_messages where recipient_id='$G'")"
expect "mark read still works" ok "$(as "$G" "select public.mark_manager_direct_message_read('$GM')" | err)"
GC=$(as "$MGR" "select public.send_manager_direct_message('$G','bye','work','operational')" | field id)
expect "the general cancel still deletes" ok "$(as "$MGR" "select public.cancel_manager_direct_message('$GC')" | err)"
expect "gone" 0 "$(su -c "select count(*) from public.manager_direct_messages where id='$GC'")"
W=$(new_user athlete); debt "$W" 33
as "$MGR" "select public.send_manager_direct_message('$W','older general','love','operational')" >/dev/null; WG=$(su -c "select id from public.manager_direct_messages where recipient_id='$W'")
send "$MGR" "$W" 33 >/dev/null
expect "messages queue in order: general first" general "$(pending "$W" | field message.message_kind)"
as "$W" "select public.mark_manager_direct_message_read('$WG')" >/dev/null
expect "then the reminder" payment_reminder "$(pending "$W" | field message.message_kind)"

echo "--- concurrent sends (15 rounds: two managers, one family, different recipients)"
BAD=0
for round in $(seq 1 15); do
  CA=$(new_user athlete); CB=$(new_user athlete); CF=$(su -c "insert into public.athlete_families (name) values ('T209 race') returning id")
  su -c "insert into public.athlete_family_members (family_id, user_id) values ('$CF','$CA'),('$CF','$CB')" >/dev/null
  debt "$CA" 44
  send "$MGR" "$CA" 44 > /tmp/t209a.$$ & P1=$!
  send "$MGR2" "$CB" 44 > /tmp/t209b.$$ & P2=$!
  wait $P1 $P2
  N1=$(su -c "select count(*) from public.manager_direct_messages where account_key='family:$CF' and read_at is null and closed_at is null")
  R1=$(err < /tmp/t209a.$$); R2=$(err < /tmp/t209b.$$)
  [ "$N1" = 1 ] || BAD=$((BAD+1))
  case "$R1$R2" in okalready_pending|already_pendingok) ;; *) fail "round $round: answers $R1 / $R2"; BAD=$((BAD+1));; esac
done
expect "rounds without exactly one reminder and one clean refusal" 0 "$BAD"
rm -f /tmp/t209a.$$ /tmp/t209b.$$


echo "passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
