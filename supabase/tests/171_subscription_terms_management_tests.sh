#!/usr/bin/env bash
# Regression test for 20261014160000_subscription_terms_management.sql (draft / preview / publish / restore / toggle).
#
# Real RPCs over an `authenticator` connection (JWT claims, one transaction per call, like PostgREST).
#   A  manager-only: coach, athlete and anon cannot read the admin view, save/publish/restore, toggle, or write tables
#   B  drafts never change what athletes see (current document, gate text, statuses)
#   C  validation: incomplete Hebrew or English refused; a draft changed since review refused (draft_changed)
#   D  publish without renewed acceptance: accepted athletes stay accepted; with it: pending until they accept the new one
#   E  history is immutable: no UPDATE of text / flag, no DELETE (even as postgres); only is_current flips
#   F  restore = copy an old version into the draft and publish it as a NEW version with the old text
#   G  each acceptance points to an immutable version whose exact text is retrievable
#   H  toggle takes effect immediately with no deploy: on -> pending + own registration refused; off -> gate gone,
#      registration allowed, nothing required for new subscriptions; consents, subscriptions and billing preserved;
#      other legal gates (Terms of Use / Privacy) untouched
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/171_subscription_terms_management_tests.sh   (SCRATCH/LOCAL DATABASES ONLY;
# toggles app_settings.subscription_terms_enforced and restores it to FALSE; publishes new subscription_terms versions)
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
su() { $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
contains() { case "$3" in *"$2"*) ok "$1";; *) fail "$1: expected '$2' in '$(echo "$3" | head -2 | cut -c1-220)'";; esac; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
trap 'su -c "update public.app_settings set subscription_terms_enforced = false where id = 1; delete from public.legal_document_drafts" >/dev/null 2>&1' EXIT

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); A=$(uid); B=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f171-$n-' || u.k || '@t.local',
         jsonb_build_object('full_name', 'F171 ' || u.k, 'phone', '08' || u.k || '$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'm'), ('$C'::uuid, 'c'), ('$A'::uuid, 'a'), ('$B'::uuid, 'b')) u(id, k);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A','$B');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "delete from public.legal_document_drafts; update public.app_settings set subscription_terms_enforced = false where id = 1" >/dev/null
TODAY=$(su -c "select public._studio_today_date()")
SESS=$(su -c "insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration) values (public._week_start_sunday(public._studio_today_date()) + 8, '11:05', '$C', 8, true) returning id" | head -1)
ALLOW="jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',2))"
SA=$(jf "$(api "$M" "select public.create_subscription('$A', false, 300, '$TODAY', null, null, $ALLOW)::text;" | grep '^{')" subscription_id)
status() { su -c "select public._subscription_terms_status_for_user('$1')->>'status'"; }
mydoc() { api "$1" "select public.get_my_subscription_terms()::text;" | grep '^{'; }
draft_at() { su -c "select updated_at from public.legal_document_drafts where consent_type = 'subscription_terms'"; }
publish() { api "$M" "select public.publish_subscription_terms_draft($1, '$(draft_at)'::timestamptz)::text;" | grep '^{'; }
CUR=$(su -c "select version from public.legal_documents where consent_type = 'subscription_terms' and is_current")
CUR_BODY_MD5=$(su -c "select md5(body_text || body_text_en) from public.legal_documents where consent_type = 'subscription_terms' and is_current")
LONG_HE=$(printf 'סעיף בדיקה %.0s' $(seq 1 30)); LONG_EN=$(printf 'Test clause %.0s' $(seq 1 30))
CHARGES0=$(su -c "select count(*) || '|' || sum(amount_ils) from public.subscription_charges where subscription_id = '$SA'")
LCG=$(su -c "select legal_consent_gate_enabled from public.app_settings where id = 1")
OTHER_GATES=$(su -c "select md5(string_agg(consent_type || version || title || body_text || is_current, '|' order by consent_type, version)) from public.legal_documents where consent_type <> 'subscription_terms'")

echo "== A: manager-only"
for who in "coach:$C" "athlete:$A"; do l=${who%%:*}; u=${who#*:}
  contains "$l cannot read the admin view" "forbidden" "$(api "$u" "select public.get_subscription_terms_admin()::text;")"
  contains "$l cannot save a draft" "forbidden" "$(api "$u" "select public.save_subscription_terms_draft('t','t','b','b')::text;")"
  contains "$l cannot restore a version" "forbidden" "$(api "$u" "select public.copy_subscription_terms_version_to_draft($CUR)::text;")"
  contains "$l cannot publish" "forbidden" "$(api "$u" "select public.publish_subscription_terms_draft(false, now())::text;")"
  contains "$l cannot toggle enforcement" "forbidden" "$(api "$u" "select public.set_subscription_terms_enforced(true)::text;")"
  R=$(api "$u" "insert into public.legal_document_drafts (consent_type, title) values ('subscription_terms', 'x'); select 1;"); case "$R" in *"permission denied"*|*"row-level security"*) ok "$l cannot write drafts directly";; *) fail "$l draft insert: $R";; esac
  R=$(api "$u" "insert into public.legal_documents (consent_type, version, title, body_text, is_current) values ('subscription_terms', 999, 'x', 'x', false); select 1;"); case "$R" in *"permission denied"*|*"row-level security"*) ok "$l cannot insert a terms version directly";; *) fail "$l version insert: $R";; esac
  expect "$l reads no drafts" "0" "$(api "$u" "select count(*) from public.legal_document_drafts;" | tail -1)"
done
for call in "public.get_subscription_terms_admin()" "public.save_subscription_terms_draft('t','t','b','b')" "public.publish_subscription_terms_draft(false, now())"; do
  contains "anon refused: ${call%%(*}" "permission denied" "$(api_as anon "" "select ($call)::text;")"
done
contains "manager reads the admin view" '"ok" : true' "$(api "$M" "select public.get_subscription_terms_admin()::text;")"

echo "== B: drafts never change what athletes see"
contains "manager enables" '"enforced" : true' "$(api "$M" "select public.set_subscription_terms_enforced(true)::text;")"
expect "A pending" "pending" "$(status "$A")"
R=$(api "$M" "select public.save_subscription_terms_draft('טיוטה', 'Draft', '$LONG_HE', '$LONG_EN')::text;")
contains "draft saved" '"ok" : true' "$R"
expect "current version unchanged" "$CUR|$CUR_BODY_MD5" "$(su -c "select version || '|' || md5(body_text || body_text_en) from public.legal_documents where consent_type = 'subscription_terms' and is_current")"
contains "athlete still gets the published text" "\"version\" : $CUR" "$(mydoc "$A")"
R=$(mydoc "$A"); case "$R" in *"טיוטה"*|*"Test clause"*) fail "draft text leaked to the athlete";; *) ok "draft text never reaches the athlete";; esac
expect "admin view shows the draft" "טיוטה" "$(api "$M" "select public.get_subscription_terms_admin()->'draft'->>'title';" | tail -1)"

echo "== C: validation"
api "$M" "select public.save_subscription_terms_draft('כותרת', '', '$LONG_HE', 'short')::text;" >/dev/null
R=$(publish false); contains "incomplete English refused" "incomplete" "$R"; contains "missing English title reported" "title_en_missing" "$R"; contains "short English body reported" "body_en_incomplete" "$R"
api "$M" "select public.save_subscription_terms_draft('', 'Title', 'קצר', '$LONG_EN')::text;" >/dev/null
R=$(publish false); contains "incomplete Hebrew refused" "body_he_incomplete" "$R"
api "$M" "select public.save_subscription_terms_draft('כותרת חדשה', 'New title', '$LONG_HE', '$LONG_EN')::text;" >/dev/null
contains "a draft changed since review is refused" "draft_changed" "$(api "$M" "select public.publish_subscription_terms_draft(false, now() - interval '1 day')::text;")"
expect "still no new version" "$CUR" "$(su -c "select max(version) from public.legal_documents where consent_type = 'subscription_terms'")"

echo "== D: publishing"
contains "A accepts the current version" '"ok" : true' "$(api "$A" "select public.accept_subscription_terms($CUR)::text;")"
R=$(publish false); contains "publish without renewed acceptance" '"ok" : true' "$R"; V1=$(jf "$R" version)
expect "new current version" "$V1|true|false" "$(su -c "select version || '|' || is_current || '|' || requires_reconsent from public.legal_documents where consent_type = 'subscription_terms' and version = $V1")"
expect "draft cleared after publishing" "0" "$(su -c "select count(*) from public.legal_document_drafts")"
expect "A stays accepted" "accepted" "$(status "$A")"
SB=$(jf "$(api "$M" "select public.create_subscription('$B', false, 300, '$TODAY', null, null, $ALLOW)::text;" | grep '^{')" subscription_id)
contains "B (never accepted) sees the NEW text" "New title" "$(mydoc "$B")"
api "$M" "select public.save_subscription_terms_draft('כותרת 3', 'Title 3', '$LONG_HE', '$LONG_EN')::text;" >/dev/null
R=$(publish true); contains "publish with renewed acceptance" '"ok" : true' "$R"; V2=$(jf "$R" version)
expect "A must accept again" "pending" "$(status "$A")"
contains "A's own registration refused while pending" "subscription_terms_required" "$(api "$A" "select public.register_for_session('$SESS')::text;")"
contains "A accepts the new version" '"ok" : true' "$(api "$A" "select public.accept_subscription_terms($V2)::text;")"
expect "A accepted; both acceptances kept" "accepted|2" "$(status "$A")|$(su -c "select count(*) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"

echo "== E: history is immutable"
for sql in "update public.legal_documents set body_text = 'x' where consent_type = 'subscription_terms' and version = $CUR" \
           "update public.legal_documents set title_en = 'x' where consent_type = 'subscription_terms' and version = $V1" \
           "update public.legal_documents set requires_reconsent = true where consent_type = 'subscription_terms' and version = $V1" \
           "delete from public.legal_documents where consent_type = 'subscription_terms' and version = $CUR"; do
  R=$(su -c "$sql" 2>&1); case "$R" in *immutable*|*"cannot be deleted"*) ok "refused even as postgres: ${sql:0:70}";; *) fail "not refused: ${sql:0:70}: $R";; esac
done
expect "original text intact" "$CUR_BODY_MD5" "$(su -c "select md5(body_text || body_text_en) from public.legal_documents where consent_type = 'subscription_terms' and version = $CUR")"

echo "== F: restore an earlier version as a new one"
contains "copy version $CUR into the draft" '"ok" : true' "$(api "$M" "select public.copy_subscription_terms_version_to_draft($CUR)::text;")"
R=$(publish false); contains "publish the restored text" '"ok" : true' "$R"; V3=$(jf "$R" version)
expect "restored version is new, with the original text" "$((V2 + 1))|$CUR_BODY_MD5" "$V3|$(su -c "select md5(body_text || body_text_en) from public.legal_documents where consent_type = 'subscription_terms' and version = $V3")"
expect "the old version itself is unchanged and not current" "f" "$(su -c "select is_current from public.legal_documents where consent_type = 'subscription_terms' and version = $CUR")"
expect "A still accepted (restore did not require renewed acceptance)" "accepted" "$(status "$A")"
contains "unknown version refused" "version_not_found" "$(api "$M" "select public.copy_subscription_terms_version_to_draft(99999)::text;")"

echo "== G: exact accepted text"
expect "every acceptance of A points to an existing immutable version" "2|2" "$(su -c "select count(*) || '|' || count(ld.id) from public.user_consents uc left join public.legal_documents ld on ld.consent_type = 'subscription_terms' and ld.version = uc.consent_version where uc.user_id = '$A' and uc.consent_type = 'subscription_terms'")"
expect "first acceptance resolves to the original text" "$CUR_BODY_MD5" "$(su -c "select md5(ld.body_text || ld.body_text_en) from public.user_consents uc join public.legal_documents ld on ld.consent_type = 'subscription_terms' and ld.version = uc.consent_version where uc.user_id = '$A' and uc.consent_type = 'subscription_terms' order by uc.consent_version limit 1")"

echo "== H: toggle takes effect immediately"
expect "B pending while on" "pending" "$(status "$B")"
contains "B blocked: own registration refused" "subscription_terms_required" "$(api "$B" "select public.register_for_session('$SESS')::text;")"
contains "manager disables" '"enforced" : false' "$(api "$M" "select public.set_subscription_terms_enforced(false)::text;")"
contains "B: no gate right away" '"blocking" : false' "$(mydoc "$B")"
contains "B registers right away" '"ok" : true' "$(api "$B" "select public.register_for_session('$SESS')::text;")"
C2=$(uid); su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values ('$C2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','f171-$n-new@t.local', jsonb_build_object('full_name','F171 new','phone','0899$n','gender','female','address','A','zip_code','1'), now(), now()); update public.profiles set approval_status='approved' where user_id='$C2'" >/dev/null
api "$M" "select public.create_subscription('$C2', false, 300, '$TODAY', null, null, $ALLOW)::text;" >/dev/null
expect "new subscription while off: not required" "not_required" "$(status "$C2")"
expect "A's acceptances preserved while off" "2" "$(su -c "select count(*) from public.user_consents where user_id = '$A' and consent_type = 'subscription_terms'")"
expect "A's billing unchanged by all of this" "$CHARGES0" "$(su -c "select count(*) || '|' || sum(amount_ils) from public.subscription_charges where subscription_id = '$SA'")"
contains "manager re-enables" '"enforced" : true' "$(api "$M" "select public.set_subscription_terms_enforced(true)::text;")"
expect "A still accepted after re-enabling (consent preserved)" "accepted" "$(status "$A")"
expect "new athlete now asked" "pending" "$(status "$C2")"
api "$M" "select public.set_subscription_terms_enforced(false)::text;" >/dev/null
expect "Terms of Use / Privacy / receipts / marketing documents untouched" "$OTHER_GATES" "$(su -c "select md5(string_agg(consent_type || version || title || body_text || is_current, '|' order by consent_type, version)) from public.legal_documents where consent_type <> 'subscription_terms'")"
expect "Terms of Use / Privacy gate setting untouched" "$LCG" "$(su -c "select legal_consent_gate_enabled from public.app_settings where id = 1")"

echo
echo "171 subscription terms management: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
