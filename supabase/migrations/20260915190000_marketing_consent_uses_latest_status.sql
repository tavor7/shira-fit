-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 4 static review fix).
--
-- Bug found while tracing "user opts out -> future marketing messages are blocked":
-- consent status is intentionally append-only/auditable (declining inserts a NEW row
-- rather than deleting or updating the prior accepted one, so the historical evidence
-- that consent was once given is preserved). has_current_marketing_consent's original
-- query only checked whether *an* accepted row existed for the current version —
-- opting out does not remove that row, so a later decline never actually took effect:
-- marketing sends would have kept going through after opt-out.
--
-- electronic_receipts doesn't have this problem because record_user_consent maintains a
-- dedicated "current state" column (profiles.electronic_receipts_consent_version) as a
-- side effect. marketing_communications has no equivalent column, so "current" must be
-- derived from the single MOST RECENT row for (user, consent_type) instead of "does an
-- accepted row exist anywhere in history".

create or replace function public.has_current_marketing_consent(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uc.status = 'accepted'
        and uc.consent_version = (
          select coalesce(max(ld.version), 0)
          from public.legal_documents ld
          where ld.consent_type = 'marketing_communications' and ld.is_current
        )
      from public.user_consents uc
      where uc.user_id = p_user_id
        and uc.consent_type = 'marketing_communications'
      order by uc.accepted_at desc, uc.created_at desc
      limit 1
    ),
    false
  );
$$;
