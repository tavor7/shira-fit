/** Matches SQL manager_activity_revert_info reason codes. */
export type ActivityRevertReason =
  | "already_reverted"
  | "no_changes"
  | "no_previous_status"
  | "profile_missing"
  | "athlete_missing"
  | "session_missing"
  | "session_has_registrations"
  | "session_has_participants"
  | "missing_registration_context"
  | "registration_not_active"
  | "registration_not_cancelled"
  | "registration_missing"
  | "missing_status_context"
  | "session_ended"
  | "session_full"
  | "not_revertible"
  | "missing_attendance_context"
  | "manual_participant_not_in_session"
  | "manual_participant_already_in_session"
  | "missing_role_context"
  | "missing_cancellation_context"
  | "cancellation_missing"
  | "missing_note_context"
  | "session_note_missing"
  | "session_note_already_exists";

const REVERTIBLE_EVENT_TYPES = new Set([
  "profile_updated",
  "athlete_approved",
  "athlete_rejected",
  "athlete_approval_updated",
  "session_updated",
  "session_created",
  "session_registration",
  "session_registration_cancelled",
  "session_registration_status_changed",
  "session_manual_participant_added",
  "session_manual_participant_removed",
  "registration_attendance_updated",
  "manual_participant_attendance_updated",
  "user_role_changed",
  "cancellation_charge_updated",
  "cancellation_penalty_collected_updated",
  "registration_opening_schedule_updated",
  "session_note_created",
  "session_note_deleted",
]);

type ActivityRow = {
  event_type: string;
  reverted_at?: string | null;
  metadata: Record<string, unknown> | null;
  target_id: string | null;
};

export function activityRevertReasonLabel(reason: string, language: string): string {
  const he = language === "he";
  const map: Record<string, { en: string; he: string }> = {
    already_reverted: { en: "Already reverted", he: "כבר בוטל" },
    no_changes: { en: "No stored changes to undo", he: "אין שינויים שמורים לביטול" },
    no_previous_status: { en: "Previous approval status missing", he: "חסר סטטוס אישור קודם" },
    profile_missing: { en: "Profile no longer exists", he: "הפרופיל כבר לא קיים" },
    athlete_missing: { en: "Athlete no longer exists", he: "המתאמן כבר לא קיים" },
    session_missing: { en: "Session no longer exists", he: "האימון כבר לא קיים" },
    session_has_registrations: { en: "Session already has registrations", he: "לאימון כבר יש נרשמים" },
    session_has_participants: { en: "Session already has participants", he: "לאימון כבר יש משתתפים" },
    missing_registration_context: { en: "Registration details missing from log", he: "חסרים פרטי הרשמה ברישום" },
    registration_not_active: { en: "Registration is no longer active", he: "ההרשמה כבר לא פעילה" },
    registration_not_cancelled: { en: "Registration is not cancelled", he: "ההרשמה לא במצב בוטל" },
    registration_missing: { en: "Registration no longer exists", he: "ההרשמה כבר לא קיימת" },
    missing_status_context: { en: "Status change details missing", he: "חסרים פרטי שינוי סטטוס" },
    session_ended: { en: "Session has already ended", he: "האימון כבר הסתיים" },
    session_full: { en: "Session is full", he: "האימון מלא" },
    not_revertible: { en: "This action cannot be undone from the log", he: "לא ניתן לבטל פעולה זו מהיומן" },
    remove_failed: { en: "Could not remove registration", he: "לא ניתן להסיר את ההרשמה" },
    restore_failed: { en: "Could not restore registration", he: "לא ניתן לשחזר את ההרשמה" },
    not_found: { en: "Event not found", he: "האירוע לא נמצא" },
    forbidden: { en: "Not allowed", he: "אין הרשאה" },
    missing_attendance_context: { en: "Attendance details missing from log", he: "חסרים פרטי נוכחות ברישום" },
    manual_participant_not_in_session: { en: "Quick-add participant is no longer on this session", he: "משתתף מהיר כבר לא באימון" },
    manual_participant_already_in_session: { en: "Quick-add participant is already on this session", he: "משתתף מהיר כבר באימון" },
    missing_role_context: { en: "Previous role missing from log", he: "חסר תפקיד קודם ברישום" },
    missing_cancellation_context: { en: "Cancellation details missing from log", he: "חסרים פרטי ביטול ברישום" },
    cancellation_missing: { en: "Cancellation no longer exists", he: "רשומת הביטול כבר לא קיימת" },
    missing_note_context: { en: "Note details missing from log", he: "חסרים פרטי הערה ברישום" },
    session_note_missing: { en: "Session note no longer exists", he: "הערת האימון כבר לא קיימת" },
    session_note_already_exists: { en: "Session note already exists again", he: "הערת האימון כבר קיימת שוב" },
  };
  const m = map[reason];
  if (m) return he ? m.he : m.en;
  return reason;
}

function hasChanges(metadata: Record<string, unknown>): boolean {
  const changes = metadata.changes;
  return !!changes && typeof changes === "object" && Object.keys(changes as object).length > 0;
}

/** Client-side hint for showing the revert button; server validates on submit. */
export function activityEventLooksRevertible(row: ActivityRow): boolean {
  if (row.reverted_at) return false;
  if (!REVERTIBLE_EVENT_TYPES.has(row.event_type)) return false;
  const m = row.metadata ?? {};

  if (row.event_type === "profile_updated" || row.event_type === "session_updated") {
    return hasChanges(m);
  }
  if (["athlete_approved", "athlete_rejected", "athlete_approval_updated"].includes(row.event_type)) {
    return typeof m.previous_approval_status === "string" && m.previous_approval_status.length > 0;
  }
  if (row.event_type === "session_created") {
    return !!row.target_id;
  }
  if (row.event_type === "session_registration" || row.event_type === "session_registration_cancelled") {
    return typeof m.session_id === "string" && typeof m.user_id === "string";
  }
  if (row.event_type === "session_registration_status_changed") {
    return !!row.target_id && typeof m.from === "string";
  }
  if (row.event_type === "session_manual_participant_added" || row.event_type === "session_manual_participant_removed") {
    return typeof m.session_id === "string" && typeof m.manual_participant_id === "string";
  }
  if (row.event_type === "registration_attendance_updated") {
    return typeof m.session_id === "string" && typeof m.user_id === "string" && hasChanges(m);
  }
  if (row.event_type === "manual_participant_attendance_updated") {
    return typeof m.session_id === "string" && typeof m.manual_participant_id === "string" && hasChanges(m);
  }
  if (row.event_type === "user_role_changed") {
    return typeof m.previous_role === "string" && m.previous_role.length > 0;
  }
  if (row.event_type === "cancellation_charge_updated" || row.event_type === "cancellation_penalty_collected_updated") {
    return !!row.target_id && hasChanges(m);
  }
  if (row.event_type === "registration_opening_schedule_updated") {
    return hasChanges(m);
  }
  if (row.event_type === "session_note_created") {
    return !!row.target_id;
  }
  if (row.event_type === "session_note_deleted") {
    return !!row.target_id && typeof m.body === "string" && typeof m.session_id === "string";
  }
  return false;
}
