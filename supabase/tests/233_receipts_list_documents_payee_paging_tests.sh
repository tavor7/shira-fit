#!/usr/bin/env bash
# Receipts screen: a payee filter over a wide range (Global) must find that payee's older receipts. list_documents used to
# return only the newest 200 rows of the range and the client filtered that page by payee, so a payee whose receipts were
# older than the 200th showed "No documents for this name" while the same receipts appeared under their month.
# Covers 20261107120000_list_documents_payee_filter.sql: payee filtering before paging, Global vs Month consistency,
# deterministic paging over equal dates, the manager-only guard, and that listing writes nothing. SCRATCH DATABASES ONLY.
. "$(dirname "$0")/lib_subscription_harness.sh"
TAG="T233-$(date +%s%N | tail -c 8)"
mkmanual; P=$MP                    # the reported payee: a quick-add participant
mkuser athlete; A=$U               # an app payee
mkuser athlete; F=$U               # filler payee, to push the others past the first page
cust() { su -c "insert into public.customers (name, profile_user_id, manual_participant_id) values ('$1', $2, $3) returning id" | head -1; }
CP=$(cust "$TAG-P" null "'$P'"); CA=$(cust "$TAG-A" "'$A'" null); CF=$(cust "$TAG-F" "'$F'" null)
# documents: customer, number suffix, created_at expression. source_type 'manual', so the listed date is created_at.
mkdocs() { su -c "insert into public.documents (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, service_type,
    service_description, payment_method, customer_name, business_name, business_id, business_address, business_phone, business_email, source_type, created_at)
  select '$TAG-' || $2, '$1', 50, 50, 0, 0, 'other', 'fixture', 'cash', '$TAG', 'B', '1', 'A', '0', 'b@t.local', 'manual', $3 ${4:-}" >/dev/null; }
mkdocs "$CP" "'0926'" "now() - interval '150 days'"
mkdocs "$CP" "'1024'" "now() - interval '110 days'"
mkdocs "$CA" "'1300'" "now() - interval '10 days'"
mkdocs "$CF" "lpad(g::text, 5, '0')" "now() - g * interval '1 minute'" "from generate_series(1, 260) g"
# three receipts sharing one timestamp, like several receipts for one session
mkuser athlete; T=$U; CT=$(cust "$TAG-T" "'$T'" null)
mkdocs "$CT" "'T' || g" "date_trunc('minute', now()) - interval '20 days'" "from generate_series(1, 3) g"

GSTART=$(su -c "select (now() - interval '200 days')::timestamptz"); GEND=$(su -c "select (now() + interval '1 day')::timestamptz")
MSTART=$(su -c "select date_trunc('month', now() - interval '150 days')"); MEND=$(su -c "select date_trunc('month', now() - interval '150 days') + interval '1 month' - interval '1 microsecond'")
ld() { api "${2:-$M}" "select public.list_documents($1)::text;"; }
# q JSON EXPR: EXPR reads the response as x.j and names its own FROM (x, plus any jsonb_array_elements(j->'rows')).
q() { su -c "with x(j) as (select '$(printf '%s' "$1" | sed "s/'/''/g")'::jsonb) select $2"; }
nums() { q "$1" "coalesce(string_agg(r->>'document_number', ',' order by r->>'document_number'), '') from x, jsonb_array_elements(j->'rows') r"; }
SNAP() { su -c "select md5(string_agg(to_jsonb(d)::text, '' order by id)) || ':' || (select next_document_number from public.receipt_settings) from public.documents d"; }
BEFORE=$(SNAP)

echo "the reported failure: the payee's receipts are older than the newest 200 of the range"
R=$(ld "'$GSTART', '$GEND', null, null, 200, 0")
expect "the unfiltered first page does not reach them (the condition that hid them)" "" "$(q "$R" "string_agg(r->>'document_number', ',') from x, jsonb_array_elements(j->'rows') r where r->>'customer_id' = '$CP'")"
R=$(ld "'$GSTART', '$GEND', null, null, 200, 0, null, '$P'")
expect "Global with the payee finds both" "$TAG-0926,$TAG-1024" "$(nums "$R")"
expect "and counts both" "2" "$(q "$R" "j->>'total' from x")"
R=$(ld "'$MSTART', '$MEND', null, null, 200, 0, null, '$P'")
expect "Month finds the receipt in that month" "$TAG-0926" "$(nums "$R")"
R=$(ld "'$GSTART', '$GEND', null, null, 200, 0, '$A', null")
expect "an app payee is filtered by user id" "$TAG-1300" "$(nums "$R")"
R=$(ld "'$GSTART', '$GEND', null, null, 200, 0, '$A', '$P'")
contains "both payee kinds at once are refused" "invalid_payee_filter" "$R"
R=$(ld "'$GSTART', '$GEND', null, null, 200, 0, gen_random_uuid(), null")
expect "a payee without receipts is empty, not an error" "true|0|0" "$(q "$R" "(j->>'ok') || '|' || (j->>'total') || '|' || jsonb_array_length(j->'rows') from x")"

echo "paging"
R=$(ld "'$GSTART', '$GEND', null, null, 100, 0, '$F', null")
expect "the filler payee pages by its own count" "260" "$(q "$R" "j->>'total' from x")"
seen=""; for off in 0 100 200; do R=$(ld "'$GSTART', '$GEND', null, null, 100, $off, '$F', null"); seen="$seen$(q "$R" "string_agg(r->>'id', ' ') from x, jsonb_array_elements(j->'rows') r") "; done
expect "pages cover every row once" "260 260" "$(echo $seen | tr ' ' '\n' | sort | uniq | wc -l | tr -d ' ') $(echo $seen | wc -w | tr -d ' ')"
order=""; for off in 0 1 2; do R=$(ld "'$GSTART', '$GEND', null, null, 1, $off, '$T', null"); order="$order$(nums "$R") "; done
expect "equal dates page in a stable order, newest number first" "$TAG-T3 $TAG-T2 $TAG-T1 " "$order"
R=$(ld "'$GSTART', '$GEND', null, null, 500, 0, '$F', null")
expect "rows are newest first" "0" "$(q "$R" "count(*) from (select (r->>'paid_at')::timestamptz p, lag((r->>'paid_at')::timestamptz) over (order by o) pp from x, jsonb_array_elements(j->'rows') with ordinality t(r, o)) s where p > pp")"
R=$(ld "'$GSTART', '$GEND', null, null, 10, 0")
expect "the old six-argument call still works" "true" "$(q "$R" "j->>'ok' from x")"

echo "access and side effects"
contains "a coach is refused" "forbidden" "$(ld "null, null, null, null, 10, 0, null, '$P'" "$CO")"
contains "an athlete is refused" "forbidden" "$(ld "null, null, null, null, 10, 0, null, '$P'" "$A")"
contains "anon cannot call it" "permission denied" "$(api_as anon "" "select public.list_documents(null, null, null, null, 10, 0, null, null)::text;")"
expect "listing changed no document and allocated no number" "$BEFORE" "$(SNAP)"
finish
