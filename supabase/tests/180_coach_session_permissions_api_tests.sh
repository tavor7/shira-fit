#!/usr/bin/env bash
# Direct API test for 20261020100000_coach_session_configuration_manager_only.sql: real users signed in through GoTrue,
# every call a real HTTP request to PostgREST (REST and RPC), exactly what a modified client could send.
# Roles: anon (no token), athlete, coach C (assigned to S1 / S1B), coach C2 (assigned to S2), manager, super user.
#   N  each configuration path (RPC and direct table write) is refused for anon, athlete, C and C2, with an explicit
#      error (HTTP 401/403, {"ok":false,"error":"forbidden"} or "full") or an RLS-filtered empty result, and the database
#      rows of every fixture session, series, roster price and walk-in are identical afterwards
#   P  C adds / removes / moves participants within own sessions, records attendance and payment, writes own notes;
#      manager and super user change configuration through the same API
# Usage: PSQL="docker exec -i <db> psql -U postgres" API_URL=http://127.0.0.1:<port> ANON_KEY=... SERVICE_ROLE_KEY=... \
#        supabase/tests/180_coach_session_permissions_api_tests.sh   (SCRATCH/LOCAL STACKS ONLY)
set -u
PSQL=${PSQL:?set PSQL}; API_URL=${API_URL:?set API_URL}; ANON_KEY=${ANON_KEY:?}; SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY:?}
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local API_URL"; exit 1;; esac
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@" </dev/null; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
jq1() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=eval("j"+process.argv[1]);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"; }
# http TOKEN METHOD PATH [BODY] -> "STATUS BODY"
http() { local tok=$1 method=$2 path=$3 body=${4:-} out
  local args=(-H "apikey: $ANON_KEY"); [ -n "$tok" ] && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(--data-binary "$body")
  out=$(curl -s -w '\n%{http_code}' -X "$method" "$API_URL$path" "${args[@]}" -H 'content-type: application/json' \
    -H 'Prefer: return=representation')
  echo "${out##*$'\n'} ${out%$'\n'*}"; }
rpc() { http "$1" POST "/rest/v1/rpc/$2" "$3"; }
# refused: 401/403, forbidden, RLS error, or a 2xx write that touched no row ([])
refused() { case "$2" in 401*|403*|*forbidden*|*"row-level security"*|*"permission denied"*|"200 []"|"204 ") ok "N $1 refused (${2:0:60})";; *) fail "N $1 NOT refused: ${2:0:180}";; esac; }
is_full() { case "$2" in *'"full"'*) ok "N $1 refused as full";; *) fail "N $1: expected full, got ${2:0:160}";; esac; }
okjson() { case "$2" in 200*'"ok":true'*|200*'"ok" : true'*) ok "P $1";; *) fail "P $1: ${2:0:200}";; esac; }
okrows() { case "$2" in 200\ \[\{*|201\ \[\{*) ok "P $1";; *) fail "P $1: ${2:0:200}";; esac; }

n=$(date +%s%N | tail -c 8)
mkuser() { # tag role -> "uuid token"
  local r; r=$(curl -s -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'content-type: application/json' -d "{\"email\":\"t180-$1-$n@t.local\",\"password\":\"Passw0rd!x\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"t180 $1\",\"phone\":\"05$n$3\",\"gender\":\"female\",\"address\":\"A\",\"zip_code\":\"1\"}}")
  local id; id=$(echo "$r" | jq1 ".id")
  su -c "update public.profiles set approval_status='approved', role='$2' where user_id='$id'" >/dev/null
  local tok; tok=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"t180-$1-$n@t.local\",\"password\":\"Passw0rd!x\"}" | jq1 ".access_token")
  echo "$id $tok"
}
read -r M_ID M <<<"$(mkuser mgr manager 1)"; read -r SU_ID SUT <<<"$(mkuser su manager 2)"
read -r C_ID C <<<"$(mkuser coach coach 3)"; read -r C2_ID C2 <<<"$(mkuser coach2 coach 4)"
read -r A_ID A <<<"$(mkuser ath athlete 5)"; read -r B_ID B <<<"$(mkuser ath2 athlete 6)"
su -c "update public.profiles set is_super_user = true where user_id = '$SU_ID'" >/dev/null
[ -n "$M" ] && [ -n "$C" ] && [ -n "$C2" ] && [ -n "$A" ] || { echo "could not create fixture users"; exit 1; }

D1=$(su -c "select (current_date + (7 - extract(dow from current_date)::int) + 1)::date"); D2=$(su -c "select ('$D1'::date + 1)")
sess() { su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values ('$1', '$2', '$3', $4, true) returning id" | head -1; }
S1=$(sess "$D1" 10:05 "$C_ID" 3); S1B=$(sess "$D2" 10:05 "$C_ID" 3); SF=$(sess "$D1" 10:35 "$C_ID" 1); S2=$(sess "$D1" 11:05 "$C2_ID" 3)
su -c "insert into public.session_registrations (session_id, user_id, status) values ('$S1', '$A_ID', 'active'), ('$SF', '$B_ID', 'active')" >/dev/null
W=$(su -c "insert into public.manual_participants (full_name, phone, created_by) values ('W180 $n', '070$n', '$M_ID') returning id" | head -1)
su -c "insert into public.session_manual_participants (session_id, manual_participant_id) values ('$S1', '$W')" >/dev/null
SERIES=$(rpc "$M" staff_create_session_series "{\"p_anchor_date\":\"$D1\",\"p_start_time\":\"09:05\",\"p_coach_id\":\"$C_ID\",\"p_max_participants\":4,\"p_duration_minutes\":60,\"p_is_open\":true,\"p_is_hidden\":false,\"p_is_kickbox\":false,\"p_custom_slot_price_ils\":null,\"p_repeat_mode\":\"fixed_weeks\",\"p_fixed_weeks\":2,\"p_copy_roster\":false,\"p_athlete_ids\":[],\"p_manual_ids\":[]}")
okjson "manager creates a recurring series over the API" "$SERIES"
SER=$(su -c "select id from public.session_series where coach_id = '$C_ID' order by created_at desc limit 1"); SS1=$(su -c "select id from public.training_sessions where series_id = '$SER' order by session_date limit 1")

snapshot() { su -c "select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'T' || row(t.*)::text x from public.training_sessions t where t.coach_id in ('$C_ID','$C2_ID')
  union all select 'S' || row(s.*)::text from public.session_series s where s.coach_id in ('$C_ID','$C2_ID')
  union all select 'R' || row(r.*)::text from public.session_registrations r join public.training_sessions t on t.id = r.session_id where t.coach_id in ('$C_ID','$C2_ID')
  union all select 'M' || row(m.*)::text from public.session_manual_participants m join public.training_sessions t on t.id = m.session_id where t.coach_id in ('$C_ID','$C2_ID')
  union all select 'P' || row(p.*)::text from public.session_roster_slot_prices p join public.training_sessions t on t.id = p.session_id where t.coach_id in ('$C_ID','$C2_ID')) q"; }
BEFORE=$(snapshot)

UPD="{\"p_session_id\":\"$S1\",\"p_scope\":\"this\",\"p_session_date\":null,\"p_start_time\":\"12:00\",\"p_coach_id\":null,\"p_max_participants\":9,\"p_duration_minutes\":60,\"p_is_open\":false,\"p_is_hidden\":true,\"p_is_kickbox\":null,\"p_custom_slot_price_ils\":1}"
CREATE="{\"p_anchor_date\":\"$D2\",\"p_start_time\":\"08:35\",\"p_coach_id\":\"$C_ID\",\"p_max_participants\":4,\"p_duration_minutes\":60,\"p_is_open\":true,\"p_is_hidden\":false,\"p_is_kickbox\":false,\"p_custom_slot_price_ils\":null,\"p_repeat_mode\":\"fixed_weeks\",\"p_fixed_weeks\":1,\"p_copy_roster\":false,\"p_athlete_ids\":[],\"p_manual_ids\":[]}"
for who in "anon:" "athlete:$A" "coach-assigned:$C" "coach-not-assigned:$C2"; do label=${who%%:*}; T=${who#*:}
  echo "== $label"
  R=$(rpc "$T" staff_create_session_series "$CREATE"); refused "$label: create session/series (RPC)" "$R"
  R=$(rpc "$T" staff_update_session_series_scope "$UPD"); refused "$label: edit S1 time/capacity/open/hidden/price (RPC)" "$R"
  R=$(rpc "$T" staff_update_session_series_scope "{\"p_session_id\":\"$SS1\",\"p_scope\":\"future\",\"p_session_date\":null,\"p_start_time\":\"12:00\",\"p_coach_id\":null,\"p_max_participants\":9,\"p_duration_minutes\":60,\"p_is_open\":null,\"p_is_hidden\":null,\"p_is_kickbox\":null,\"p_custom_slot_price_ils\":null}"); refused "$label: edit series this-and-future (RPC)" "$R"
  R=$(rpc "$T" staff_set_session_custom_slot_price "{\"p_session_id\":\"$S1\",\"p_price_ils\":1}"); refused "$label: session price (RPC)" "$R"
  R=$(rpc "$T" staff_set_session_roster_slot_price "{\"p_session_id\":\"$S1\",\"p_user_id\":\"$A_ID\",\"p_manual_participant_id\":null,\"p_price_ils\":1}"); refused "$label: athlete price in session (RPC)" "$R"
  R=$(rpc "$T" staff_move_session_participant "{\"p_from_session_id\":\"$S1\",\"p_to_session_id\":\"$SF\",\"p_user_id\":\"$A_ID\",\"p_manual_participant_id\":null,\"p_allow_over_capacity\":false,\"p_decrease_source_max\":false,\"p_increase_dest_max\":true,\"p_accept_extra_subscription_charge\":false}"); refused "$label: move with capacity increase (RPC)" "$R"
  R=$(rpc "$T" maintain_session_series_horizon "{}"); refused "$label: horizon generation (RPC)" "$R"
  R=$(rpc "$T" reconcile_series_duplicate_sessions "{}"); refused "$label: duplicate cleanup (RPC)" "$R"
  R=$(http "$T" PATCH "/rest/v1/training_sessions?id=eq.$S1" '{"max_participants":9,"is_hidden":true}'); refused "$label: PATCH training_sessions" "$R"
  R=$(http "$T" POST "/rest/v1/training_sessions" "{\"session_date\":\"$D2\",\"start_time\":\"08:35\",\"coach_id\":\"$C_ID\",\"max_participants\":4}"); refused "$label: POST training_sessions" "$R"
  R=$(http "$T" POST "/rest/v1/session_series" "{\"coach_id\":\"$C_ID\",\"anchor_date\":\"$D1\",\"start_time\":\"08:05\",\"max_participants\":4,\"repeat_mode\":\"ongoing\"}"); refused "$label: POST session_series" "$R"
  R=$(http "$T" PATCH "/rest/v1/session_series?id=eq.$SER" '{"max_participants":9,"status":"ended"}'); refused "$label: PATCH session_series" "$R"
  R=$(http "$T" POST "/rest/v1/session_roster_slot_prices" "{\"session_id\":\"$S1\",\"user_id\":\"$A_ID\",\"price_ils\":1}"); refused "$label: POST session_roster_slot_prices" "$R"
  R=$(http "$T" PATCH "/rest/v1/session_manual_participants?session_id=eq.$S1" "{\"session_id\":\"$S1B\"}"); refused "$label: PATCH session_manual_participants (move walk-in)" "$R"
done
echo "== coach-not-assigned on C's sessions (participant operations)"
R=$(rpc "$C2" coach_add_athlete "{\"p_session_id\":\"$S1\",\"p_user_id\":\"$B_ID\",\"p_allow_over_capacity\":false,\"p_accept_extra_subscription_charge\":false}"); refused "C2 adds an athlete to C's session" "$R"
R=$(rpc "$C2" coach_remove_athlete "{\"p_session_id\":\"$S1\",\"p_user_id\":\"$A_ID\"}"); refused "C2 removes C's athlete" "$R"
R=$(rpc "$C2" set_registration_attendance "{\"p_session_id\":\"$S1\",\"p_user_id\":\"$A_ID\",\"p_status\":\"arrived\",\"p_payment_method\":\"cash\",\"p_amount_paid\":5,\"p_charge_no_show\":false}"); refused "C2 records attendance in C's session" "$R"
R=$(rpc "$C2" staff_move_session_participant "{\"p_from_session_id\":\"$S1\",\"p_to_session_id\":\"$S1B\",\"p_user_id\":\"$A_ID\",\"p_manual_participant_id\":null,\"p_allow_over_capacity\":false,\"p_decrease_source_max\":false,\"p_increase_dest_max\":false,\"p_accept_extra_subscription_charge\":false}"); refused "C2 moves C's athlete" "$R"
R=$(rpc "$C2" add_session_note "{\"p_session_id\":\"$S1\",\"p_body\":\"x\"}"); refused "C2 adds a note to C's session" "$R"
echo "== coach-assigned: capacity is enforced"
R=$(rpc "$C" coach_add_athlete "{\"p_session_id\":\"$SF\",\"p_user_id\":\"$A_ID\",\"p_allow_over_capacity\":true,\"p_accept_extra_subscription_charge\":false}"); is_full "C adds over capacity to own full session" "$R"
R=$(rpc "$C" add_manual_participant_to_session "{\"p_session_id\":\"$SF\",\"p_manual_participant_id\":\"$W\",\"p_allow_over_capacity\":true,\"p_accept_extra_subscription_charge\":false}"); is_full "C adds a walk-in over capacity" "$R"
R=$(rpc "$C" staff_move_session_participant "{\"p_from_session_id\":\"$S1\",\"p_to_session_id\":\"$SF\",\"p_user_id\":\"$A_ID\",\"p_manual_participant_id\":null,\"p_allow_over_capacity\":true,\"p_decrease_source_max\":false,\"p_increase_dest_max\":false,\"p_accept_extra_subscription_charge\":false}"); refused "C moves over capacity" "$R"
echo "== deletes (last)"
for who in "anon:" "athlete:$A" "coach-assigned:$C" "coach-not-assigned:$C2"; do label=${who%%:*}; T=${who#*:}
  R=$(rpc "$T" staff_delete_session_series_scope "{\"p_session_id\":\"$S1\",\"p_scope\":\"this\"}"); refused "$label: delete S1 (RPC)" "$R"
  R=$(rpc "$T" staff_delete_session_series_scope "{\"p_session_id\":\"$SS1\",\"p_scope\":\"future\"}"); refused "$label: end series (RPC)" "$R"
  R=$(http "$T" DELETE "/rest/v1/training_sessions?id=eq.$S2"); refused "$label: DELETE training_sessions" "$R"
  R=$(http "$T" DELETE "/rest/v1/session_series?id=eq.$SER"); refused "$label: DELETE session_series" "$R"
done
expect "no refused API call changed any fixture row" "$BEFORE" "$(snapshot)"

echo "== P coach-assigned on own sessions"
R=$(rpc "$C" coach_add_athlete "{\"p_session_id\":\"$S1B\",\"p_user_id\":\"$B_ID\",\"p_allow_over_capacity\":false,\"p_accept_extra_subscription_charge\":false}"); okjson "C adds an athlete" "$R"
R=$(rpc "$C" coach_remove_athlete "{\"p_session_id\":\"$S1B\",\"p_user_id\":\"$B_ID\"}"); okjson "C removes that athlete" "$R"
R=$(rpc "$C" staff_move_session_participant "{\"p_from_session_id\":\"$S1\",\"p_to_session_id\":\"$S1B\",\"p_user_id\":\"$A_ID\",\"p_manual_participant_id\":null,\"p_allow_over_capacity\":false,\"p_decrease_source_max\":false,\"p_increase_dest_max\":false,\"p_accept_extra_subscription_charge\":false}"); okjson "C moves an athlete between own sessions" "$R"
R=$(rpc "$C" set_registration_attendance "{\"p_session_id\":\"$S1B\",\"p_user_id\":\"$A_ID\",\"p_status\":\"arrived\",\"p_payment_method\":\"bit\",\"p_amount_paid\":12.5,\"p_charge_no_show\":false}"); okjson "C records arrival, partial payment and method" "$R"
expect "payment stored" "bit|12.50" "$(su -c "select payment_method || '|' || amount_paid from public.session_registrations where session_id = '$S1B' and user_id = '$A_ID'")"
R=$(rpc "$C" add_session_note "{\"p_session_id\":\"$S1B\",\"p_body\":\"ops\"}"); okjson "C adds a note" "$R"
expect "capacities unchanged by coach operations (S1|S1B|SF)" "3|3|1" "$(su -c "select (select max_participants from public.training_sessions where id = '$S1') || '|' || (select max_participants from public.training_sessions where id = '$S1B') || '|' || (select max_participants from public.training_sessions where id = '$SF')")"
echo "== P manager and super user"
R=$(rpc "$M" staff_update_session_series_scope "$UPD"); okjson "manager edits S1" "$R"
expect "manager edit applied" "12:00:00|9|f|t|1.00" "$(su -c "select start_time || '|' || max_participants || '|' || (case when is_open_for_registration then 't' else 'f' end) || '|' || (case when is_hidden then 't' else 'f' end) || '|' || custom_slot_price_ils from public.training_sessions where id = '$S1'")"
R=$(http "$M" PATCH "/rest/v1/training_sessions?id=eq.$S1" '{"max_participants":8}'); okrows "manager PATCHes training_sessions" "$R"
R=$(http "$M" PATCH "/rest/v1/session_series?id=eq.$SER" '{"max_participants":4}'); okrows "manager PATCHes session_series" "$R"
R=$(rpc "$SUT" staff_set_session_custom_slot_price "{\"p_session_id\":\"$S2\",\"p_price_ils\":60}"); okjson "super user sets a price" "$R"
R=$(rpc "$M" staff_delete_session_series_scope "{\"p_session_id\":\"$S2\",\"p_scope\":\"this\"}"); okjson "manager deletes S2" "$R"

echo
echo "180 coach session permissions (API): $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
