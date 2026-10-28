/**
 * RPC outcome registry (Phase 3A) -- the canonical, source-controlled classification of every outcome code the
 * database functions currently return. CLASSIFICATION ONLY: nothing in this module reports, logs or changes behaviour.
 *
 * Keys are (operation, code):
 *   - `operation` is the SQL function that EMITS the code (what pg_proc calls proname). For client-facing RPCs this is
 *     the name passed to supabase.rpc(). Internal helpers (leading underscore) are operations too; an RPC that returns
 *     a helper's result is linked to it through DELEGATES.
 *   - `code` is the exact string in the result's `error` key (or the extra keys in CODE_BEARING_KEYS).
 *
 * Precedence: operation rule > relayed (delegate) operation rule > global rule > unknown. Unknown stays unknown:
 * there is no wildcard and no naming heuristic anywhere.
 *
 * Adding a code to a function makes `rpcOutcomesCompleteness.test.ts` fail until the new (operation, code) pair is
 * added below with a deliberate class. See README.md in this folder.
 */
import type { RegisteredOutcomeClass, RuleEntry } from "./types";

const B: RegisteredOutcomeClass = "business";
const V: RegisteredOutcomeClass = "authorization_validation";
const T: RegisteredOutcomeClass = "technical";
const U: RegisteredOutcomeClass = "uncertain";

/**
 * Codes whose meaning was verified to be identical in EVERY operation that returns them (all occurrences read).
 * Keep this list tiny: a code that merely looks universal belongs in the per-operation table.
 *   - account_disabled is deliberately NOT global: it means "the caller is disabled" in register_for_session but
 *     "the target participant is disabled" in staff operations.
 */
export const GLOBAL_RULES: Readonly<Record<string, RuleEntry>> = {
  forbidden: [V, "The authenticated caller lacks the role/ownership required for the operation. Same meaning in every operation."],
  not_authenticated: [V, "The call carried no authenticated user (auth.uid() is null). Same meaning in every operation."],
  subscription_terms_required: [
    B,
    "RAISEd by subscription_reserve_or_reject only when the caller registers THEMSELF (register_for_session) while their subscription-terms acceptance is pending - the server side of the mandatory terms screen. Staff paths never raise it. Same meaning everywhere.",
  ],
};

/** Operations whose result carries codes under keys other than `error`. Used by the extractor. */
export const CODE_BEARING_KEYS: Readonly<Record<string, readonly string[]>> = {
  // manager_revert_activity_event returns these `reason` values as its own `error`.
  manager_activity_revert_info: ["error", "reason"],
};

/**
 * DIRECT relays: the operation returns (part of) the result of the listed operations, so their codes can appear in
 * its result. Resolution follows the chain transitively. Every entry is checked against the real call graph.
 */
export const DELEGATES: Readonly<Record<string, readonly string[]>> = {
  coach_add_athlete: ["_coach_add_athlete_core"],
  copy_subscription_terms_version_to_draft: ["save_subscription_terms_draft"],
  create_document_with_payment: ["set_registration_attendance", "set_manual_participant_attendance"],
  edit_subscription_version: ["subscription_compute_impact"],
  freeze_subscription: ["subscription_compute_impact"],
  maintain_session_series_horizon: ["_maintain_session_series_horizon_core"],
  manager_revert_activity_event: [
    "manager_activity_revert_info",
    "manager_remove_athlete",
    "coach_add_athlete",
    "add_manual_participant_to_session",
  ],
  manager_weekly_stats: ["manager_weekly_stats_core"],
  staff_update_profile_text: ["staff_update_profile"],
  stop_subscription: ["subscription_compute_impact"],
  stop_subscription_with_future_registrations: ["subscription_compute_impact"],
  sync_signup_electronic_receipts_consent: ["_try_sync_signup_consent_for_user"],
  sync_signup_legal_consents: ["_try_sync_signup_legal_consents_for_user"],
};

/**
 * Reviewed calls between outcome-emitting functions that are NOT relays (the callee's result is swallowed,
 * aggregated into a list, or only its exception can escape). Listed so that a NEW call edge between two outcome
 * emitters must be reviewed as relay vs consumed. Several of these are known follow-ups (see README "Open follow-ups").
 */
export const CONSUMED_CALLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  _coach_add_athlete_core: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  _subscription_resolve_future_registrations: {
    manager_remove_athlete: "result discarded (PERFORM); the nested is_manager check is already true (same already-verified manager caller) and not_active is impossible here (the resolver's own query filters to status='active' under FOR UPDATE)",
    remove_manual_participant_from_session: "result discarded (PERFORM); the nested is_coach_or_manager check is already true (same already-verified manager caller) and not_in_session is impossible here (the resolver's own query just locked this exact row)",
  },
  _copy_session_roster: {
    _coach_add_athlete_core: "result discarded (PERFORM) inside an exception-swallowing block",
    coach_add_athlete: "result discarded (PERFORM) inside an exception-swallowing block",
    _series_add_manual_participant_checked: "result discarded (PERFORM) inside an exception-swallowing block; the function returns void anyway",
  },
  _series_add_manual_participant_checked: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  add_manual_participant_to_session: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  create_documents_from_payments: { _create_document_from_payment_row: "per-row result aggregated into a list, never returned as the top-level error" },
  create_subscription: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  cron_maintain_session_series_horizon: { _maintain_session_series_horizon_core: "cron entry point; result discarded (PERFORM)" },
  edit_subscription_version: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  freeze_subscription: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  generate_due_subscription_charges: { subscription_generate_or_correct_billing_period: "per-subscription outcome recorded in the job result" },
  manager_revert_activity_event: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  reactivate_subscription: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  register_for_session: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  staff_create_session_series: {
    coach_add_athlete: "result discarded (PERFORM) inside an exception-swallowing block",
    _series_add_manual_participant_checked: "result discarded (PERFORM) inside an exception-swallowing block; the function returns void anyway",
  },
  staff_move_session_participant: { subscription_reserve_or_reject: "decision record; only a RAISE can escape (defensive ones, and subscription_terms_required)" },
  stop_subscription: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  stop_subscription_with_future_registrations: {
    subscription_generate_or_correct_billing_period: "result discarded (PERFORM)",
    _subscription_resolve_future_registrations: "returns a plain int (rows resolved), not an error-code-bearing result; stored into v_future_resolved and reported back as a count, never relayed as a code",
  },
  delete_subscription_with_future_registrations: { _subscription_resolve_future_registrations: "returns a plain int (rows resolved), not an error-code-bearing result; stored into v_future_resolved and reported back as a count, never relayed as a code" },
  subscription_compute_impact: { subscription_generate_or_correct_billing_period: "result discarded (PERFORM)" },
  tg_auth_user_signup_consent: {
    _try_sync_signup_consent_for_user: "trigger; result discarded and exceptions swallowed so signup can never be blocked",
    _try_sync_signup_legal_consents_for_user: "trigger; result discarded and exceptions swallowed so signup can never be blocked",
  },
};

/**
 * Operations with `'error', <non-literal expression>` sites. Their possible values cannot be enumerated statically.
 * A value that is not a registered code is looked up as `unknown` (never silently classified); the result is flagged
 * `dynamicErrorPossible` so later instrumentation knows the string may be raw database text.
 *   sqlerrm      raw SQLERRM returned to the caller (an unexpected database exception converted to ok:false)
 *   coalesce(    fallback expression around a relayed code
 *   v_impact->>  code relayed from subscription_compute_impact (covered by DELEGATES)
 *   left(        truncated error text recorded per failed subscription in the job result
 *   p_entities   named-argument call into _report_system_error (System Issues monitoring); the
 *                extractor's regex matches the `p_entities :=` token near a jsonb_build_object call,
 *                not an actual dynamically-constructed error code returned to any caller
 *   p_message    same as p_entities but for a `p_message := format(...)` call into
 *                _report_system_error -- a human-readable System Issues description, never a
 *                code relayed to any ok:false caller
 */
export const DYNAMIC_ERROR_SITES: Readonly<Record<string, readonly string[]>> = {
  _create_document_from_payment_row: ["sqlerrm"],
  _maintain_session_series_horizon_core: ["p_entities", "sqlerrm"],
  _series_add_manual_participant_checked: ["p_entities"],
  clear_must_change_password: ["sqlerrm"],
  coach_add_athlete: ["p_entities", "sqlerrm"],
  edit_subscription_version: ["v_impact->>"],
  financial_backup_record_health_snapshot: ["p_message"],
  freeze_subscription: ["v_impact->>"],
  generate_due_subscription_charges: ["left(", "p_entities"],
  manager_revert_activity_event: ["coalesce(", "sqlerrm"],
  staff_get_temp_password: ["sqlerrm"],
  staff_list_payments_without_receipt: ["sqlerrm"],
  staff_set_account_disabled: ["sqlerrm"],
  staff_set_manual_participant_disabled: ["sqlerrm"],
  staff_set_session_roster_slot_price: ["sqlerrm"],
  stop_subscription: ["v_impact->>"],
  stop_subscription_with_future_registrations: ["v_impact->>"],
};

/**
 * Operation-specific rules. [class, rationale] is used where the class is not the obvious reading of the code
 * (technical / uncertain / overrides) so that a reviewer sees the evidence next to the decision.
 */
export const OPERATION_RULES: Readonly<Record<string, Readonly<Record<string, RuleEntry>>>> = {
  _system_push_outbox_process: {
    missing_vault_secrets: [T, "The critical-push outbox processor is dark-launched (critical_push_enabled defaults to false) and has no app-visible caller; a missing vault configuration is an operational/infra state, not a classification a user can ever observe."],
    internal: [T, "Internal, cron-only function with no app-visible caller; its own outer exception handler's generic fallback, never a business outcome."],
  },
  _coach_add_athlete_core: {
    account_disabled: [B, "The TARGET participant is disabled on the session date; a business restriction on staff-added participants, not an authorization failure of the caller."],
    full: B,
    invalid_athlete: V,
    is_session_coach: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_limit_exceeded: B,
  },
  _guard_receipted_session_payment: {
    payment_locked_receipt_issued: [B, "Raised by the row trigger when ANY caller, including a manager (the manager exemption was removed 2026-10-20 -- owner policy: no one may modify/delete a receipted payment while the receipt is active), tries to change a receipt-relevant field of (or delete) a session_registrations/session_manual_participants row that already has an active issued receipt. A business-state refusal, not role-dependent, matching _guard_receipted_account_payment's account_payment_locked_receipt_issued."],
    session_payment_has_receipt_history: [B, "Raised on DELETE only when ANY document (including a cancelled one) has ever referenced this row -- narrowly extends history protection to deletion once a receipt has ever existed, even after cancellation (owner rule 2026-10-22); ordinary attendance/payment UPDATEs are unaffected."],
  },
  _guard_receipted_account_payment: {
    account_payment_locked_receipt_issued: [B, "Raised by the row trigger when ANY caller, including a manager, tries to change a receipt-relevant field of (or delete) an athlete_account_payments row that already has an active issued receipt; a business-state refusal protecting receipt/payment consistency (owner rule 2026-10-20), matching _guard_receipted_session_payment's payment_locked_receipt_issued since 2026-10-20."],
    account_payment_reversed_immutable: [B, "Raised on any UPDATE or DELETE of a row already marked reversed_at (State D, owner rule 2026-10-22): a reversed payment is kept purely for historical auditability and can never again be edited, deleted, or un-reversed through ordinary editing."],
    account_payment_has_receipt_history: [B, "Raised on DELETE only when a receipt has ever been issued for this payment, even if since cancelled (State C, owner rule 2026-10-22): the row must survive because a document still references it by id, even though that document is itself cancelled."],
    unauthorized_payment_reversal: [B, "Raised when an UPDATE attempts to set reversed_at (or change reversed_by) outside the one authorized transition inside _revert_document_payment, which sets a transaction-local flag immediately before its own UPDATE; no other code path sets that flag, so this always indicates a direct bypass attempt, never a legitimate caller (owner rule 2026-10-22)."],
  },
  _guard_delete_receipted_session: {
    session_has_receipted_payment: [B, "Raised by the row trigger when ANY caller tries to delete a training_sessions row carrying a payment with an active issued receipt (owner rule 2026-10-20); applies uniformly to every deletion path (series-scope delete, bulk day-clear, activity-log revert of session creation, direct PostgREST delete)."],
  },
  _reject_subscription_hard_delete: {
    subscription_record_immutable: [B, "Raised by the row trigger when ANY caller attempts a hard DELETE on an append-only subscription/billing-history table (subscriptions, subscription_versions, subscription_freezes, subscription_billing_periods, subscription_charges, subscription_registration_coverage, subscription_impact_events, subscription_impact_event_registrations); no legitimate path ever does this (owner rule 2026-10-20) -- see migration 20261023130000."],
  },
  _reject_document_hard_delete: {
    document_record_immutable: [B, "Raised by the row trigger when ANY caller (including delete_document and service_role) attempts a hard DELETE on documents or document_events; these are append-only financial/audit history -- cancel_document (a status update) is the only legitimate way to void a document (owner rule 2026-10-22, see migration 20261023190000)."],
  },
  _reject_document_pdf_overwrite: {
    document_pdf_object_immutable: [B, "Raised by the Storage row trigger when ANY caller attempts to UPDATE (including upsert=true) an existing documents/* object in the document-pdfs bucket; every PDF version must use a new, unique path via finalize_document_pdf, so a legitimate upload never hits this -- it exists specifically so a redeployed older generate-document-pdf (e.g. during a rollback) can't silently destroy a previously issued receipt (see migration 20261025160000). Same append-only-guard pattern as _reject_subscription_hard_delete / _reject_document_hard_delete above."],
  },
  _create_document_from_payment_row: {
    business_id_required: V,
    digital_receipts_disabled: B,
    document_already_exists: B,
    payment_not_found: [B, "Payment row id comes from the \"payments without receipt\" list and may have been documented/removed since: stale reference."],
    payment_reversed: [B, "The account payment this row refers to has already been reversed (cancel_document with p_revert_payment=true); it has no remaining financial effect left to receipt (2026-10-21)."],
  },
  _try_sync_signup_consent_for_user: {
    missing_user_id: V,
    user_not_found: [U, "Looks up auth.users by id inside the signup consent sync (trigger path and the client sync RPC). Impossible inside the trigger; reachable only by a live JWT of a deleted account. Cannot tell stale-session from invariant."],
  },
  _try_sync_signup_legal_consents_for_user: {
    missing_user_id: V,
  },
  _validate_athlete_account_payment: {
    account_disabled_payee: B,
    invalid_athlete_payee: V,
    invalid_manual_payee: V,
  },
  _validate_subscription_payee: {
    invalid_athlete_payee: V,
    invalid_manual_payee: V,
  },
  accept_subscription_terms: {
    no_subscription: [V, "The caller has no subscription of their own to accept terms for (e.g. a manager or coach: consent is never given on someone else's behalf)."],
    not_enabled: [B, "Subscription-terms enforcement is switched off by the studio, so there is nothing to accept yet; expected while the terms await approval."],
    not_found: [B, "No current subscription-terms document is published; a configuration state, not a fault."],
    version_mismatch: [B, "The terms were updated between display and acceptance; the client reloads and shows the new version (stale view, expected)."],
  },
  add_manual_participant_to_session: {
    account_disabled: [B, "The TARGET participant is disabled on the session date; a business restriction on staff-added participants, not an authorization failure of the caller."],
    already_in_session: B,
    full: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_limit_exceeded: B,
  },
  add_session_note: {
    empty: V,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  cancel_document: {
    already_cancelled: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    reason_required: V,
  },
  cancel_manager_direct_message: {
    invalid_message: V,
    not_found_or_already_read: B,
  },
  cancel_registration: {
    not_registered: B,
    reason_required: V,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    session_started: B,
    update_failed: [U, "A prior check found the row, then the UPDATE touched 0 rows: either a benign concurrent change (double tap) or an invariant problem. The code does not distinguish the two."],
  },
  coach_remove_athlete: {
    not_active: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  copy_subscription_terms_version_to_draft: {
    version_not_found: [B, "Looks a terms version up by the number the manager picked from the history list; absence means the list was stale, an expected state."],
  },
  create_document: {
    business_id_required: V,
    digital_receipts_disabled: B,
    document_already_exists: [B, "As of 2026-10-21, create_document also rejects a duplicate active receipt for the same payment source (pre-check and a unique_violation catch against documents_active_payment_source_uidx), matching create_document_with_payment / _create_document_from_payment_row."],
    invalid_amount: V,
    payment_reversed: [B, "The account payment this call targets (p_source_type='account_payment', an existing p_source_id) has already been reversed; it has no remaining financial effect left to receipt (2026-10-21)."],
  },
  create_document_with_payment: {
    business_id_required: V,
    digital_receipts_disabled: B,
    document_already_exists: B,
    invalid_amount: V,
    invalid_mode: V,
    not_on_roster: B,
    payee_required: V,
    payment_method_required: V,
    session_id_required: V,
  },
  create_documents_from_payments: {
    no_rows_selected: B,
    too_many_rows: B,
  },
  create_subscription: {
    conflicting_active_subscription: B,
    invalid_allowance: V,
    invalid_anchor_day: V,
    invalid_date_range: V,
    invalid_initial_payment_amount: V,
    invalid_initial_payment_method: V,
    invalid_payee: V,
    invalid_price: V,
    invalid_start_date: V,
  },
  delete_athlete_family: {
    missing_family_id: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  delete_document: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    operational_mode_locked: B,
  },
  delete_monthly_summary: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  delete_session_note: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  delete_subscription: {
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_has_payments: [B, "Owner policy (2026-10-26): a subscription with any valid (unreversed) payment, even partial, cannot be deleted. Expected rejection -- the UI should show a localized warning and suggest stop_subscription instead."],
  },
  delete_subscription_with_future_registrations: {
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_has_payments: [B, "Owner policy (2026-10-26): a subscription with any valid (unreversed) payment, even partial, cannot be deleted. Expected rejection -- the UI should show a localized warning and suggest stop instead."],
    invalid_future_registration_action: V,
    future_registration_action_required: [V, "Returned on the confirmed call only when future (session_date >= today, not yet ended) subscription-covered registrations exist and the UI didn't supply p_future_registration_action -- the preview response already lists them, so a well-behaved client always resolves this by re-submitting with 'remove' or 'charge_regular_price' chosen."],
    future_registrations_expectation_required: [V, "Returned on the confirmed call when resolving something but the UI omitted p_expected_future_registration_ids/p_expected_future_manual_participant_ids -- the staleness check (see future_registrations_changed) cannot be skipped by a client that forgets to pass what it previewed."],
    future_registrations_changed: [B, "A registration for a future session appeared (e.g. the athlete self-registered) AFTER the manager's preview and before they confirmed -- expected optimistic-concurrency rejection, same class as discard_subscription_terms_draft's draft_changed / finalize_document_pdf's version_conflict. The UI should re-preview and let the manager re-decide, never silently resolve the unseen registration."],
  },
  discard_subscription_terms_draft: {
    draft_changed: [B, "The draft was saved again after the manager loaded it; the screen reloads instead of deleting newer text (optimistic concurrency, expected)."],
  },
  edit_subscription_version: {
    concurrent_modification: [U, "edit_subscription_version holds the subscription admin advisory lock, so a 0-row guarded UPDATE means either a writer that bypasses the lock or a purely defensive branch. Needs implementation review."],
    effective_from_before_current_version: B,
    effective_from_required: V,
    invalid_price: V,
    no_current_version: [T, "Every subscription keeps exactly one open version (stop_subscription only sets stopped_effective_date; prod has 0 subscriptions without one). Occurrence = invariant violation."],
  },
  allocate_document_pdf_version: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  finalize_document_pdf: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    version_conflict: [B, "Expected race-loser outcome when two regenerations finalize concurrently -- the migration's own comment documents this as safe to retry (nothing was overwritten, the loser's upload just goes to an unreferenced path). Replaces the old pdf_already_exists code, which finalize_document_pdf no longer emits (overwriting is categorically impossible since 20261025110000; p_allow_overwrite is accepted only for call-signature compatibility)."],
  },
  freeze_subscription: {
    freeze_overlap: B,
    invalid_freeze_dates: V,
    no_current_version: [T, "Every subscription keeps exactly one open version (stop_subscription only sets stopped_effective_date; prod has 0 subscriptions without one). Occurrence = invariant violation."],
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  get_current_legal_document: {
    not_found: [T, "No current published legal document for the requested consent type. Production has a current document for all 4 types, so absence is a data/deployment fault."],
  },
  get_session_registration_open_state: {
    invalid_session_id: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  get_subscription_detail: {
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  get_whatsapp_delivery_status: {
    missing_delivery: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  list_documents: {
    invalid_customer_type: V,
  },
  list_receipt_go_live_gaps: {
    invalid_gap_type: V,
  },
  manager_activity_revert_info: {
    already_reverted: B,
    athlete_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    cancellation_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    manual_participant_already_in_session: B,
    manual_participant_not_in_session: B,
    missing_attendance_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    missing_cancellation_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    missing_note_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    missing_registration_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    missing_role_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    missing_status_context: [T, "The activity event metadata lacks keys the writer is supposed to record: logging/producer defect."],
    no_changes: B,
    no_previous_status: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    not_revertible: B,
    profile_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    registration_missing: [B, "The activity event refers to a registration that no longer exists (session deleted / cleaned up): the event can no longer be reverted."],
    registration_not_active: B,
    registration_not_cancelled: B,
    session_ended: B,
    session_full: B,
    session_has_participants: B,
    session_has_registrations: B,
    session_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    session_note_already_exists: B,
    session_note_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  manager_announce_group_session: {
    not_found: [B, "Looks the session up by an id the client just received from creating it; absence would mean it was deleted/changed in the meantime (stale reference), an expected state."],
    not_group: [B, "Expected no-op: the announcement is a GROUP-session-only feature, and the UI already only offers the toggle for group-capacity sessions -- a non-group session reaching this RPC at all would itself be unexpected, but the server-side check is the authoritative one."],
    not_bookable: [B, "Expected no-op: a hidden or not-open-for-registration session has no eligible audience to announce to."],
    push_disabled: [B, "Expected no-op while the global push kill switch is off; deliberately does not consume the one-shot dedupe row, so a later retry with the switch back on can still send."],
  },
  manager_duplicate_sessions_day: {
    invalid_dates: V,
    same_day: B,
    target_not_empty: B,
  },
  manager_remove_athlete: {
    not_active: B,
  },
  manager_revert_activity_event: {
    already_reverted: B,
    full: B,
    not_revertible: B,
    registration_missing: [B, "The activity event refers to a registration that no longer exists (session deleted / cleaned up): the event can no longer be reverted."],
    remove_failed: [T, "Fallback code used only when manager_remove_athlete returned ok:false WITHOUT its own error code: unexpected result shape."],
    restore_failed: [T, "Fallback code used only when the restore callee returned ok:false WITHOUT its own error code: unexpected result shape."],
    subscription_limit_exceeded: B,
  },
  manager_set_cancellation_charge: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    not_late_cancellation: B,
    session_not_found: [T, "The row references the session through a FOREIGN KEY ... ON DELETE CASCADE (session_notes, cancellations) or the caller has already locked the session row (subscription_reserve_or_reject), so this branch is unreachable unless an invariant is violated."],
  },
  manager_set_cancellation_penalty_collected: {
    invalid_amount: V,
    not_chargeable: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  manager_subscription_overview_stats: {
    invalid_range: V,
  },
  mark_manager_direct_message_read: {
    invalid_message: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  mark_payment_receipt_external: {
    document_already_exists: B,
    invalid_row_id: V,
  },
  notify_session_participants_updated: {
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  open_sessions_for_week: {
    invalid_week_start: V,
  },
  prepare_document_pdf_regeneration: {
    needs_payment_method: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    operational_mode_locked: B,
  },
  queue_ops_smoke_test_job: {
    ops_smoke_test_path_must_be_isolated: [V, "Input validation on this service_role-only entry point: p_storage_path must be under _ops_smoke_test/, structurally preventing it from ever queuing anything that could resemble a real receipt. Same class as other invalid_* input-validation rejections (e.g. record_subscription_payment's invalid_amount/invalid_payment_method)."],
  },
  publish_legal_document: {
    unsupported_consent_type: V,
  },
  publish_subscription_terms_draft: {
    draft_changed: [B, "The draft was saved again after the manager reviewed it; the screen reloads and asks for another review (optimistic concurrency, expected)."],
    incomplete: V,
    invalid_value: V,
    no_draft: [B, "Nothing to publish (the draft was already published or never saved), e.g. a double tap or a second manager; expected."],
  },
  reactivate_subscription: {
    conflicting_active_subscription: B,
    invalid_date_range: V,
    invalid_start_date: V,
    source_has_no_version: [T, "A subscription always has at least one version; occurrence = invariant violation."],
    source_subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  record_subscription_payment: {
    invalid_amount: V,
    invalid_payment_method: V,
    invalid_subscription: V,
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_deleted: [B, "Added 2026-10-26 alongside the delete-payment-guard advisory lock: the subscription was tombstoned (by a concurrent or earlier delete) before this payment could be recorded against it. Expected race outcome, not an error in the caller's input."],
  },
  register_for_session: {
    account_disabled: [V, "The CALLER's own account is disabled (profiles.disabled_at). Authorization outcome."],
    already_registered: B,
    full: B,
    no_profile: [T, "profiles rows are created by the on_auth_user_created trigger; prod has 0 auth users without a profile. Occurrence = invariant violation."],
    not_approved_athlete: [V, "The caller is not an approved athlete. Authorization outcome."],
    registration_closed: B,
    session_ended: B,
    session_not_available: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    subscription_limit_exceeded: B,
  },
  remove_manual_participant_from_session: {
    not_in_session: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  request_waitlist: {
    account_disabled: [V, "The CALLER's own account is disabled (profiles.disabled_at). Authorization outcome."],
    not_approved_athlete: [V, "The caller is not an approved athlete. Authorization outcome."],
    not_full: B,
    session_ended: B,
    session_not_available: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    session_started: [B, "Athletes may join a waitlist only before the studio-local session start (Asia/Jerusalem); at or after the start the request is refused. Same code and meaning as cancel_registration / staff_move_session_participant."],
  },
  save_whatsapp_rollout_config: {
    invalid_mode: V,
  },
  send_custom_push_notification: {
    body_required: V,
    push_disabled: B,
  },
  send_manager_direct_message: {
    invalid_body: V,
    invalid_recipient: V,
    invalid_theme: V,
    recipient_marketing_consent_missing: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  send_test_push_notification: {
    invalid_type: V,
  },
  send_whatsapp_manager_test_message: {
    invalid_phone: V,
    invalid_template: V,
    missing_user: V,
    rollout_off: B,
  },
  save_subscription_terms_draft: {
    too_long: V,
  },
  set_athlete_approval: {
    not_athlete: V,
  },
  set_document_payment_method: {
    invalid_status: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  set_manager_birthday_message_settings: {
    body_required: V,
    invalid_body: V,
    invalid_theme: V,
  },
  set_manager_notification_prefs: {
    both_flags_required: V,
  },
  set_manual_participant_attendance: {
    invalid_amount: V,
    invalid_status: V,
    not_in_session: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    update_failed: [U, "A prior check found the row, then the UPDATE touched 0 rows: either a benign concurrent change (double tap) or an invariant problem. The code does not distinguish the two."],
  },
  set_registration_attendance: {
    invalid_amount: V,
    invalid_status: V,
    not_active_registration: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  set_registration_opening_schedule: {
    invalid_time: V,
    invalid_weekday: V,
  },
  set_user_role: {
    user_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  set_whatsapp_notifications_enabled: {
    feature_not_available: B,
    invalid_phone: V,
  },
  set_whatsapp_rollout_mode: {
    invalid_mode: V,
  },
  set_subscription_terms_enforced: {
    invalid_value: V,
    no_document: [B, "Enforcement can't be turned on before a subscription-terms document is published; a configuration state, not a fault."],
  },
  staff_create_session_series: {
    invalid_capacity: V,
    invalid_input: V,
  },
  staff_delete_session_series_scope: {
    invalid_scope: V,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_get_manual_participant_meta: {
    manual_participant_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_get_temp_password: {
    user_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_get_user_auth_meta: {
    user_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_move_session_participant: {
    account_disabled: [B, "The TARGET participant is disabled on the session date; a business restriction on staff-added participants, not an authorization failure of the caller."],
    already_in_session: B,
    full: B,
    invalid_capacity: V,
    invalid_participant: V,
    invalid_session: V,
    not_on_source: B,
    payment_recorded: B,
    roster_locked: B,
    same_session: B,
    same_week: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    session_started: B,
    subscription_limit_exceeded: B,
  },
  staff_session_receipt_roster: {
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_set_account_disabled: {
    user_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_set_manual_participant_disabled: {
    manual_participant_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_set_session_custom_coach_rate: {
    invalid_amount: V,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_set_session_custom_slot_price: {
    invalid_amount: V,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_set_session_roster_slot_price: {
    invalid_amount: V,
    invalid_payee: V,
    not_on_roster: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_update_manual_participant: {
    manual_participant_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_update_profile: {
    user_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  staff_update_profile_text: {
    invalid_user_id: V,
    user_not_found: [V, "Raised when the supplied user id text is empty/blank: input validation, not a stale reference."],
  },
  staff_update_session_series_scope: {
    invalid_scope: V,
    series_date_conflict: B,
    session_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  stop_subscription: {
    no_current_version: [T, "Every subscription keeps exactly one open version (stop_subscription only sets stopped_effective_date; prod has 0 subscriptions without one). Occurrence = invariant violation."],
    stop_date_required: V,
  },
  stop_subscription_with_future_registrations: {
    no_current_version: [T, "Every subscription keeps exactly one open version (stop_subscription only sets stopped_effective_date; prod has 0 subscriptions without one). Occurrence = invariant violation."],
    stop_date_required: V,
    invalid_future_registration_action: V,
    future_registration_action_required: [V, "Returned on the confirmed call only when future (session_date >= p_stop_date, not yet ended) subscription-covered registrations exist and the UI didn't supply p_future_registration_action -- the preview response already lists them, so a well-behaved client always resolves this by re-submitting with 'remove' or 'charge_regular_price' chosen."],
    future_registrations_expectation_required: [V, "Returned on the confirmed call when resolving something but the UI omitted p_expected_future_registration_ids/p_expected_future_manual_participant_ids -- the staleness check (see future_registrations_changed) cannot be skipped by a client that forgets to pass what it previewed."],
    future_registrations_changed: [B, "A registration for a future session appeared (e.g. the athlete self-registered) AFTER the manager's preview and before they confirmed -- expected optimistic-concurrency rejection, same class as discard_subscription_terms_draft's draft_changed / finalize_document_pdf's version_conflict. The UI should re-preview and let the manager re-decide, never silently resolve the unseen registration."],
  },
  _subscription_resolve_future_registrations: {
    invalid_future_registration_action: [T, "Defensive guard -- stop_subscription_with_future_registrations/delete_subscription_with_future_registrations both validate p_future_registration_action is 'remove' or 'charge_regular_price' before ever calling this internal helper, so reaching this RAISE indicates a caller bug, not a reachable user-facing state."],
  },
  get_subscription_weekly_usage: {
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  subscription_compute_impact: {
    effective_from_before_current_version: B,
    effective_from_required: V,
    freeze_dates_required: V,
    freeze_overlap: B,
    no_current_version: [T, "Every subscription keeps exactly one open version (stop_subscription only sets stopped_effective_date; prod has 0 subscriptions without one). Occurrence = invariant violation."],
    stop_date_required: V,
    subscription_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    unsupported_action_type: V,
  },
  subscription_generate_or_correct_billing_period: {
    correction_charge_type_required: V,
    subscription_not_found: [T, "Internal billing helper called only with ids its callers have just validated; not-found is an invariant violation."],
    version_not_found: [T, "Internal billing helper called with a version id its caller just read: invariant violation."],
    version_subscription_mismatch: [T, "Internal billing helper called with a version that belongs to another subscription: invariant violation."],
  },
  subscription_reserve_or_reject: {
    session_not_found: [T, "The row references the session through a FOREIGN KEY ... ON DELETE CASCADE (session_notes, cancellations) or the caller has already locked the session row (subscription_reserve_or_reject), so this branch is unreachable unless an invariant is violated."],
  },
  super_user_hide_registration: {
    no_scope_selected: B,
    registration_not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  super_user_unhide_registration: {
    not_hidden: B,
  },
  super_user_update_hidden_scope: {
    not_hidden: B,
  },
  system_issue_acknowledge: {
    invalid_state: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  system_issue_mute: {
    invalid_state: B,
    invalid_until: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  system_issue_reopen: {
    invalid_state: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  system_issue_resolve: {
    invalid_reason: V,
    invalid_state: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    stale: B,
  },
  system_issue_unmute: {
    invalid_state: B,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  unmark_payment_receipt_external: {
    invalid_row_id: V,
  },
  update_document_customer_email: {
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  update_receipt_settings: {
    cannot_change_number_while_operational: B,
    invalid_next_document_number: V,
  },
  update_session_note: {
    empty: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
    session_not_found: [T, "The row references the session through a FOREIGN KEY ... ON DELETE CASCADE (session_notes, cancellations) or the caller has already locked the session row (subscription_reserve_or_reject), so this branch is unreachable unless an invariant is violated."],
  },
  upsert_athlete_family: {
    invalid_athlete: V,
    invalid_manual: V,
    invalid_member: V,
    invalid_members: V,
    member_in_other_family: B,
    name_required: V,
    not_found: [B, "Looks a row up by an id the UI took from a list it displayed earlier; absence means the row was deleted/changed in the meantime (stale reference), an expected state."],
  },
  upsert_manual_participant: {
    name_required: V,
    phone_required: V,
  },
};
