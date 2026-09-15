-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 4 static review fix).
--
-- Gap found on re-review: publish_legal_document(consent_type, title, body_text) is a
-- generic, pre-existing manager RPC (granted to `authenticated`, is_manager-gated
-- internally) that accepts ANY legal_consent_type and, on call, auto-increments that
-- type's version and marks it is_current — this is exactly the "electronic_receipts
-- consent text" editor already shown in the receipts manager screen, and today only ever
-- called with consent_type = 'electronic_receipts' from the client.
--
-- Nothing at the RPC level stopped it from also being called for terms_of_service /
-- privacy_policy. Unlike electronic_receipts (whose full text IS the short DB row), the
-- Terms/Privacy full documents live in the app's static bundle
-- (mobile/src/lib/legalContent.ts), versioned in lockstep with a code deploy + migration.
-- If this RPC were ever called for those types (accidentally, via a future UI wiring
-- mistake, or directly), it would bump legal_documents.version and mark it current
-- WITHOUT updating the app's actual document content — and if
-- app_settings.legal_consent_gate_enabled is already on, that alone would immediately
-- require every existing user to re-accept a "new version" whose real content never
-- actually changed. That is precisely the unintended mass re-gate the manager rollout
-- toggle exists to prevent.
--
-- Fix: restrict publish_legal_document to the one type it was actually built for.
-- Terms/Privacy/Marketing version bumps must ship as a migration (matching
-- LEGAL_VERSIONS + legalContent.ts in the same change), not through this ad-hoc RPC.

create or replace function public.publish_legal_document(p_consent_type public.legal_consent_type, p_title text, p_body_text text)
returns json language plpgsql security definer set search_path = public as $$
declare v_version int; v_id uuid;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_consent_type <> 'electronic_receipts' then
    return json_build_object('ok', false, 'error', 'unsupported_consent_type');
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.legal_documents where consent_type = p_consent_type;
  update public.legal_documents set is_current = false where consent_type = p_consent_type and is_current;
  insert into public.legal_documents (consent_type, version, title, body_text, is_current, created_by)
  values (p_consent_type, v_version, trim(p_title), trim(p_body_text), true, auth.uid()) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'version', v_version);
end; $$;
