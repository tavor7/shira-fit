-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 1c).
-- Seeds the SHORT gate-facing acknowledgment/consent statements for the three new
-- consent types. The full, section-by-section legal documents live in the app's static
-- legal pages (mobile/src/lib/legalContent.ts) so managers/staff always see exactly what
-- users saw — these rows exist to drive the versioned consent-gate mechanism, matching
-- the electronic_receipts row already seeded in 20260629100000_digital_documents.sql.
--
-- Publishing these rows does NOT gate anyone by itself:
--   * New users: the signup screen always captures explicit consent once this ships.
--   * Existing users: only gated once a manager turns on
--     app_settings.legal_consent_gate_enabled (see get_required_consents below).
--
-- IMPORTANT (acknowledgment vs. consent, per legal review): the Terms row is phrased as
-- agreement to a contract ("I agree"); the Privacy Policy row is phrased as
-- acknowledgment of having read the notice ("I have read and acknowledge"), NOT as
-- consent to every processing activity described in the policy — Israeli law treats most
-- of that processing as based on the service contract/legitimate interest, not consent.
-- Marketing consent is a separate, genuinely optional row (see step 5 migration).

insert into public.legal_documents (consent_type, version, title, body_text, title_en, body_text_en, is_current)
values (
  'terms_of_service',
  1,
  'תקנון ותנאי שימוש',
  'קראתי ואני מסכים/ה לתנאי השימוש של Shira Fit (גרסה 1).',
  'Terms of Use',
  'I have read and agree to the Shira Fit Terms of Use (version 1).',
  true
)
on conflict (consent_type, version) do nothing;

insert into public.legal_documents (consent_type, version, title, body_text, title_en, body_text_en, is_current)
values (
  'privacy_policy',
  1,
  'מדיניות פרטיות',
  'קראתי ומאשר/ת שקיבלתי את מדיניות הפרטיות של Shira Fit (גרסה 1).',
  'Privacy Policy',
  'I have read and acknowledge the Shira Fit Privacy Policy (version 1).',
  true
)
on conflict (consent_type, version) do nothing;

insert into public.legal_documents (consent_type, version, title, body_text, title_en, body_text_en, is_current)
values (
  'marketing_communications',
  1,
  'הסכמה לקבלת הודעות שיווקיות',
  'אני מאשר/ת מרצוני ובאופן מפורש קבלת הודעות שיווקיות ופרסומיות (מבצעים, הטבות ותוכן פרסומי) מ-Shira Fit בוואטסאפ, בדוא"ל ו/או בהתראות פוש. ידוע לי שהסכמה זו אינה תנאי לשימוש בשירות וניתן לבטלה בכל עת בהגדרות ההתראות.',
  'Marketing Communications Consent',
  'I voluntarily and explicitly consent to receive marketing and promotional messages (offers, promotions, and advertising content) from Shira Fit via WhatsApp, email, and/or push notifications. I understand this consent is not required to use the service and can be withdrawn at any time in notification settings.',
  true
)
on conflict (consent_type, version) do nothing;
