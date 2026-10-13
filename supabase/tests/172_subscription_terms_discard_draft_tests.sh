#!/usr/bin/env bash
# Regression test for 20261014180000_subscription_terms_discard_draft.sql.
#
# Real RPCs over an `authenticator` connection (JWT claims, one transaction per call, like PostgREST).
#   A  manager-only: coach and athlete get forbidden, anon cannot execute, the table stays RPC-write-only
#   B  no draft: discarding is a no-op success (double tap / second manager)
#   C  a draft saved after it was loaded is not discarded (draft_changed)
#   D  discarding removes the draft only: published versions, the current document and consents are untouched; logged
# Usage: PSQL=... PSQL_AUTH=... supabase/tests/172_subscription_terms_discard_draft_tests.sh   (SCRATCH/LOCAL DATABASES ONLY;
# deletes the subscription-terms draft)
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
trap 'su -c "delete from public.legal_document_drafts" >/dev/null 2>&1' EXIT

n=$(date +%s%N | tail -c 9)
uid() { su -c "select gen_random_uuid()"; }
M=$(uid); C=$(uid); A=$(uid)
su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f172-$n-' || u.k || '@t.local',
         jsonb_build_object('full_name', 'F172 ' || u.k, 'phone', '07' || u.k || '$n', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values ('$M'::uuid, 'm'), ('$C'::uuid, 'c'), ('$A'::uuid, 'a')) u(id, k);
  update public.profiles set approval_status='approved' where user_id in ('$M','$C','$A');
  update public.profiles set role='manager' where user_id='$M'; update public.profiles set role='coach' where user_id='$C'" >/dev/null
su -c "delete from public.legal_document_drafts" >/dev/null
draft_at() { su -c "select updated_at from public.legal_document_drafts where consent_type = 'subscription_terms'"; }
drafts() { su -c "select count(*) from public.legal_document_drafts"; }
DOCS=$(su -c "select md5(string_agg(consent_type::text || version || title || body_text || coalesce(body_text_en, '') || is_current || requires_reconsent, '|' order by consent_type, version)) from public.legal_documents")
CONSENTS=$(su -c "select count(*) || '|' || md5(coalesce(string_agg(id::text || status::text || consent_version, ',' order by id), '')) from public.user_consents")
[ -n "$DOCS" ] || { echo "fixture: documents fingerprint is empty"; exit 1; }
LONG_HE=$(printf 'סעיף בדיקה %.0s' $(seq 1 30)); LONG_EN=$(printf 'Test clause %.0s' $(seq 1 30))
api "$M" "select public.save_subscription_terms_draft('טיוטה', 'Draft', '$LONG_HE', '$LONG_EN')::text;" >/dev/null

echo "== A: manager-only"
contains "coach cannot discard" "forbidden" "$(api "$C" "select public.discard_subscription_terms_draft('$(draft_at)'::timestamptz)::text;")"
contains "athlete cannot discard" "forbidden" "$(api "$A" "select public.discard_subscription_terms_draft('$(draft_at)'::timestamptz)::text;")"
contains "anon cannot execute" "permission denied" "$(api_as anon "" "select public.discard_subscription_terms_draft(now())::text;")"
contains "authenticated cannot delete drafts directly" "permission denied" "$(api "$M" "delete from public.legal_document_drafts where consent_type = 'subscription_terms';")"
expect "draft still there after refused attempts" "1" "$(drafts)"

echo "== C: a draft changed since it was loaded is kept"
contains "stale timestamp refused" "draft_changed" "$(api "$M" "select public.discard_subscription_terms_draft('2000-01-01'::timestamptz)::text;")"
contains "missing timestamp refused" "draft_changed" "$(api "$M" "select public.discard_subscription_terms_draft(null)::text;")"
expect "draft kept" "1" "$(drafts)"

echo "== D: discard"
R=$(api "$M" "select public.discard_subscription_terms_draft('$(draft_at)'::timestamptz)::text;")
contains "manager discards the draft" '"discarded" : true' "$R"
expect "draft gone" "0" "$(drafts)"
expect "published versions and current document unchanged" "$DOCS" "$(su -c "select md5(string_agg(consent_type::text || version || title || body_text || coalesce(body_text_en, '') || is_current || requires_reconsent, '|' order by consent_type, version)) from public.legal_documents")"
expect "consents unchanged" "$CONSENTS" "$(su -c "select count(*) || '|' || md5(coalesce(string_agg(id::text || status::text || consent_version, ',' order by id), '')) from public.user_consents")"
expect "discard logged" "1" "$(su -c "select count(*) from public.user_activity_events where actor_user_id = '$M' and event_type = 'subscription_terms_draft_discarded'")"

echo "== B: nothing to discard"
contains "second discard is a no-op success" '"discarded" : false' "$(api "$M" "select public.discard_subscription_terms_draft(now())::text;")"

echo
echo "172 subscription terms discard draft: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
