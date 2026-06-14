import { paymentMethodAttendanceLabel } from "./paymentMethod";

export type ActivityLogRow = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  reverted_at: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isFromTo(val: unknown): val is { from: unknown; to: unknown } {
  return typeof val === "object" && val !== null && "from" in val && "to" in val;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function L(he: boolean, en: string, h: string): string {
  return he ? h : en;
}

function formatAttended(v: unknown, he: boolean): string {
  if (v === null || v === undefined || v === "") return L(he, "Not set", "לא סומן");
  if (v === true || v === "true") return L(he, "Arrived", "הגיע");
  if (v === false || v === "false") return L(he, "Absent", "נעדר");
  return str(v);
}

function formatBool(v: unknown, he: boolean): string {
  if (v === true || v === "true") return L(he, "Yes", "כן");
  if (v === false || v === "false") return L(he, "No", "לא");
  return str(v);
}

function formatPaymentMethod(v: unknown, language: string): string {
  if (v === null || v === undefined || v === "") return L(language === "he", "None", "ללא");
  return paymentMethodAttendanceLabel(String(v), language as "he" | "en");
}

function sessionFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    session_date: { en: "Date", he: "תאריך" },
    start_time: { en: "Start time", he: "שעת התחלה" },
    coach_id: { en: "Coach", he: "מאמן" },
    max_participants: { en: "Max participants", he: "מקסימום משתתפים" },
    is_open_for_registration: { en: "Open for registration", he: "פתוח להרשמה" },
    duration_minutes: { en: "Duration (min)", he: "משך (דקות)" },
    is_hidden: { en: "Hidden", he: "מוסתר" },
    is_kickbox: { en: "Kickbox", he: "קיקבוקס" },
    custom_slot_price_ils: { en: "Custom slot price", he: "מחיר מותאם לאימון" },
    registration_open_weekday: { en: "Registration open weekday", he: "יום פתיחת הרשמה" },
    registration_open_time: { en: "Registration open time", he: "שעת פתיחת הרשמה" },
  };
  return map[key] ? (he ? map[key].he : map[key].en) : key;
}

function profileFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    full_name: { en: "Full name", he: "שם מלא" },
    phone: { en: "Phone", he: "טלפון" },
    gender: { en: "Gender", he: "מין" },
    date_of_birth: { en: "Date of birth", he: "תאריך לידה" },
    username: { en: "Username", he: "שם משתמש" },
  };
  return map[key] ? (he ? map[key].he : map[key].en) : key;
}

function attendanceFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    attended: { en: "Attendance", he: "נוכחות" },
    payment_method: { en: "Payment method", he: "אמצעי תשלום" },
    amount_paid: { en: "Amount paid", he: "סכום ששולם" },
    charge_no_show: { en: "Charge no-show fee", he: "חיוב על נעדרות" },
    charged_full_price: { en: "Late-cancel studio fee", he: "חיוב ביטול מאוחר" },
    penalty_collected_ils: { en: "Penalty collected", he: "סכום שנגבה" },
    amount_ils: { en: "Amount", he: "סכום" },
    paid_at: { en: "Paid on", he: "תאריך תשלום" },
    payer_name: { en: "Payer", he: "משלם" },
    body: { en: "Note", he: "הערה" },
  };
  return map[key] ? (he ? map[key].he : map[key].en) : key;
}

function pricingFieldLabel(key: string, he: boolean): string {
  const map: Record<string, { en: string; he: string }> = {
    max_participants: { en: "Capacity tier", he: "דרגת קיבולת" },
    price_ils: { en: "Price", he: "מחיר" },
    is_kickbox: { en: "Kickbox", he: "קיקבוקס" },
    effective_from: { en: "Effective from", he: "בתוקף מ" },
    effective_to: { en: "Effective to", he: "בתוקף עד" },
  };
  return map[key] ? (he ? map[key].he : map[key].en) : key;
}

function formatCoachRef(id: string, profileLabels: Record<string, string>): string {
  if (!id) return "—";
  return profileLabels[id] ?? id;
}

function formatSessionRef(sid: string | null | undefined, sessionSummaries: Record<string, string>): string | null {
  if (!sid) return null;
  return sessionSummaries[sid] ?? sid;
}

function formatUserRef(uid: string | null | undefined, profileLabels: Record<string, string>): string | null {
  if (!uid) return null;
  return profileLabels[uid] ?? uid;
}

function formatManualRef(
  mid: string | null | undefined,
  manualLabels: Record<string, string>,
  mu: Record<string, unknown>
): string | null {
  if (!mid) return null;
  if (manualLabels[mid]) return manualLabels[mid];
  const fn = typeof mu.full_name === "string" ? mu.full_name.trim() : "";
  const ph = typeof mu.phone === "string" ? mu.phone.trim() : "";
  if (fn && ph) return `${fn} · ${ph}`;
  if (fn) return fn;
  return mid;
}

function resolveSessionId(item: ActivityLogRow, mu: Record<string, unknown>): string | null {
  if (item.target_id && (item.target_type === "training_session" || item.event_type.startsWith("session_"))) {
    return item.target_id;
  }
  if (typeof mu.session_id === "string") return mu.session_id;
  return item.target_id;
}

function appendChangeLines(
  lines: string[],
  changes: Record<string, unknown>,
  he: boolean,
  language: string,
  profileLabels: Record<string, string>,
  labelFor: (key: string, he: boolean) => string,
  valueFor?: (key: string, v: unknown) => string
) {
  for (const [key, val] of Object.entries(changes)) {
    if (!isFromTo(val)) continue;
    const fromRaw = val.from;
    const toRaw = val.to;
    if (key === "coach_id") {
      lines.push(
        `${labelFor(key, he)}: ${formatCoachRef(str(fromRaw), profileLabels)} → ${formatCoachRef(str(toRaw), profileLabels)}`
      );
      continue;
    }
    const from = valueFor ? valueFor(key, fromRaw) : str(fromRaw);
    const to = valueFor ? valueFor(key, toRaw) : str(toRaw);
    lines.push(`${labelFor(key, he)}: ${from || "—"} → ${to || "—"}`);
  }
}

function appendPricingSnapshot(lines: string[], snap: Record<string, unknown>, he: boolean, prefix: string) {
  const keys = ["max_participants", "price_ils", "is_kickbox", "effective_from", "effective_to"] as const;
  const parts: string[] = [];
  for (const k of keys) {
    if (snap[k] != null && snap[k] !== "") parts.push(`${pricingFieldLabel(k, he)}: ${str(snap[k])}`);
  }
  if (parts.length) lines.push(`${prefix}${parts.join(" · ")}`);
}

function appendCalendarNoteFields(lines: string[], mu: Record<string, unknown>, he: boolean) {
  const title = mu.title ?? (mu.after && typeof mu.after === "object" ? (mu.after as Record<string, unknown>).title : null);
  const body = mu.body ?? (mu.after && typeof mu.after === "object" ? (mu.after as Record<string, unknown>).body : null);
  const start = mu.start_date ?? (mu.after && typeof mu.after === "object" ? (mu.after as Record<string, unknown>).start_date : null);
  const end = mu.end_date ?? (mu.after && typeof mu.after === "object" ? (mu.after as Record<string, unknown>).end_date : null);
  if (title != null) lines.push(`${L(he, "Title", "כותרת")}: ${str(title)}`);
  if (start != null) lines.push(`${L(he, "From", "מ")}: ${str(start)}`);
  if (end != null) lines.push(`${L(he, "To", "עד")}: ${str(end)}`);
  if (typeof body === "string" && body.trim()) lines.push(`${L(he, "Note", "הערה")}: ${body.trim()}`);
}

function attendanceValueFormatter(key: string, v: unknown, he: boolean, language: string): string {
  if (key === "attended") return formatAttended(v, he);
  if (key === "charge_no_show" || key === "charged_full_price" || key === "is_kickbox" || key === "is_hidden" || key === "is_open_for_registration") {
    return formatBool(v, he);
  }
  if (key === "payment_method") return formatPaymentMethod(v, language);
  if (key === "amount_paid" || key === "amount_ils" || key === "penalty_collected_ils" || key === "price_ils") {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (Number.isFinite(n) && (key.includes("ils") || key === "amount_paid")) {
      return `${n} ₪`;
    }
    return str(v);
  }
  return str(v);
}

export function collectActivityLogIds(
  row: ActivityLogRow,
  profileIds: Set<string>,
  sessionIds: Set<string>,
  manualIds: Set<string>
) {
  if (row.actor_user_id) profileIds.add(row.actor_user_id);
  if (row.target_type === "profile" && row.target_id) profileIds.add(row.target_id);
  if (row.target_type === "training_session" && row.target_id) sessionIds.add(row.target_id);
  if (row.target_type === "manual_participant" && row.target_id) manualIds.add(row.target_id);

  const m = row.metadata;
  if (!m || typeof m !== "object") return;
  const mu = m as Record<string, unknown>;

  if (typeof mu.target_user_id === "string") profileIds.add(mu.target_user_id);
  if (typeof mu.edited_user_id === "string") profileIds.add(mu.edited_user_id);
  if (typeof mu.user_id === "string") profileIds.add(mu.user_id);
  if (typeof mu.session_id === "string") sessionIds.add(mu.session_id);
  if (typeof mu.author_id === "string") profileIds.add(mu.author_id);
  if (typeof mu.manual_participant_id === "string") manualIds.add(mu.manual_participant_id);
  if (typeof mu.payee_id === "string") {
    if (mu.payee_is_manual === true) manualIds.add(mu.payee_id);
    else profileIds.add(mu.payee_id);
  }
  if (typeof mu.coach_id === "string" && UUID_RE.test(mu.coach_id)) profileIds.add(mu.coach_id);

  for (const snapKey of ["after", "before"] as const) {
    const snap = mu[snapKey];
    if (snap && typeof snap === "object") {
      const s = snap as Record<string, unknown>;
      const c = s.coach_id;
      if (typeof c === "string" && UUID_RE.test(c)) profileIds.add(c);
    }
  }

  const ch = mu.changes;
  if (ch && typeof ch === "object") {
    for (const v of Object.values(ch as Record<string, unknown>)) {
      if (isFromTo(v)) {
        if (typeof v.from === "string" && UUID_RE.test(v.from)) profileIds.add(v.from);
        if (typeof v.to === "string" && UUID_RE.test(v.to)) profileIds.add(v.to);
      }
    }
  }
}

export function buildActivityLogDetailLines(
  item: ActivityLogRow,
  profileLabels: Record<string, string>,
  manualLabels: Record<string, string>,
  sessionSummaries: Record<string, string>,
  language: string
): string[] {
  const lines: string[] = [];
  const he = language === "he";
  const m = item.metadata || {};
  const mu = m as Record<string, unknown>;
  const attendanceFmt = (key: string, v: unknown) => attendanceValueFormatter(key, v, he, language);

  if (["athlete_approved", "athlete_rejected", "athlete_approval_updated"].includes(item.event_type)) {
    const tid = (typeof mu.target_user_id === "string" ? mu.target_user_id : null) ?? item.target_id;
    const fn = typeof mu.target_full_name === "string" ? mu.target_full_name.trim() : "";
    const un = typeof mu.target_username === "string" ? mu.target_username.trim() : "";
    const fromMeta =
      fn && un ? `${fn} (@${un})` : fn ? fn : un ? `@${un}` : tid ? formatUserRef(tid, profileLabels) ?? "—" : "—";
    lines.push(`${L(he, "Athlete / user", "מתאמן / משתמש")}: ${fromMeta}`);
    if (mu.previous_approval_status != null && mu.new_approval_status != null) {
      lines.push(`${L(he, "Approval", "אישור")}: ${str(mu.previous_approval_status)} → ${str(mu.new_approval_status)}`);
    } else if (mu.previous_approval_status != null && mu.status != null) {
      lines.push(`${L(he, "Approval", "אישור")}: ${str(mu.previous_approval_status)} → ${str(mu.status)}`);
    } else if (mu.new_approval_status != null) {
      lines.push(`${L(he, "New approval status", "סטטוס אישור חדש")}: ${str(mu.new_approval_status)}`);
    } else if (mu.status != null) {
      lines.push(`${L(he, "New status", "סטטוס חדש")}: ${str(mu.status)}`);
    }
    return lines;
  }

  if (item.event_type === "profile_updated") {
    const edited = (typeof mu.edited_user_id === "string" ? mu.edited_user_id : null) ?? item.target_id ?? null;
    if (edited) lines.push(`${L(he, "Edited profile", "פרופיל שעודכן")}: ${formatUserRef(edited, profileLabels) ?? edited}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, profileFieldLabel);
    }
    const legacy = ["full_name", "phone", "gender", "date_of_birth", "username"].filter((k) => mu[k] === true);
    if (legacy.length && (!mu.changes || typeof mu.changes !== "object" || Object.keys(mu.changes as object).length === 0)) {
      lines.push(
        `${L(he, "Fields touched (older log — values not stored)", "שדות שעודכנו (רישום ישן — ללא ערכים)")}: ${legacy.join(", ")}`
      );
    }
    return lines;
  }

  if (item.event_type === "session_created" && mu.after && typeof mu.after === "object") {
    const snap = mu.after as Record<string, unknown>;
    const sid = item.target_id;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    lines.push(`${L(he, "Date", "תאריך")}: ${str(snap.session_date)} · ${L(he, "Time", "שעה")}: ${str(snap.start_time).slice(0, 5)}`);
    lines.push(`${L(he, "Max", "מקסימום")}: ${str(snap.max_participants)} · ${L(he, "Duration", "משך")}: ${str(snap.duration_minutes)} min`);
    const cid = snap.coach_id;
    if (typeof cid === "string") lines.push(`${L(he, "Coach", "מאמן")}: ${formatCoachRef(cid, profileLabels)}`);
    lines.push(
      `${L(he, "Open for registration", "פתוח להרשמה")}: ${str(snap.is_open_for_registration)} · ${L(he, "Hidden", "מוסתר")}: ${str(snap.is_hidden)}`
    );
    return lines;
  }

  if (item.event_type === "session_deleted" && mu.before && typeof mu.before === "object") {
    const snap = mu.before as Record<string, unknown>;
    const sess = formatSessionRef(item.target_id, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    lines.push(`${L(he, "Was", "היה")}: ${str(snap.session_date)} · ${str(snap.start_time).slice(0, 5)} · ${L(he, "max", "מקס")} ${str(snap.max_participants)}`);
    const cid = snap.coach_id;
    if (typeof cid === "string") lines.push(`${L(he, "Coach", "מאמן")}: ${formatCoachRef(cid, profileLabels)}`);
    return lines;
  }

  if (item.event_type === "session_updated") {
    const sid = resolveSessionId(item, mu);
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, sessionFieldLabel, (key, v) =>
        key === "is_open_for_registration" || key === "is_hidden" || key === "is_kickbox" ? formatBool(v, he) : str(v)
      );
    }
    return lines;
  }

  if (
    item.event_type === "session_registration" ||
    item.event_type === "session_registration_cancelled" ||
    item.event_type === "session_registration_status_changed"
  ) {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const pid = typeof mu.user_id === "string" ? mu.user_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    const part = formatUserRef(pid, profileLabels);
    if (part) lines.push(`${L(he, "Participant", "משתתף")}: ${part}`);
    if (mu.status != null) lines.push(`${L(he, "Registration status", "סטטוס הרשמה")}: ${str(mu.status)}`);
    if (mu.from != null && mu.to != null) lines.push(`${L(he, "Status change", "שינוי סטטוס")}: ${str(mu.from)} → ${str(mu.to)}`);
    return lines;
  }

  if (item.event_type === "athlete_profile_created" || item.event_type === "profile_created") {
    const tid = item.target_id;
    if (tid) lines.push(`${L(he, "Profile", "פרופיל")}: ${formatUserRef(tid, profileLabels) ?? tid}`);
    if (mu.role != null) lines.push(`${L(he, "Role", "תפקיד")}: ${str(mu.role)}`);
    if (mu.approval_status != null) lines.push(`${L(he, "Approval status", "סטטוס אישור")}: ${str(mu.approval_status)}`);
    return lines;
  }

  if (["auth_login", "email_confirmed", "password_reset_completed", "signup_completed"].includes(item.event_type)) {
    lines.push(L(he, "This event is tied to the actor account only.", "אירוע זה משויך לחשבון המבצע בלבד."));
    return lines;
  }

  if (item.event_type === "user_role_changed") {
    const tid = item.target_id;
    if (tid) lines.push(`${L(he, "User", "משתמש")}: ${formatUserRef(tid, profileLabels) ?? tid}`);
    if (mu.previous_role != null && mu.new_role != null) {
      lines.push(`${L(he, "Role", "תפקיד")}: ${str(mu.previous_role)} → ${str(mu.new_role)}`);
    }
    return lines;
  }

  if (item.event_type === "manual_participant_created" || item.event_type === "manual_participant_updated") {
    const mid = item.target_id;
    const name = formatManualRef(mid, manualLabels, mu);
    if (name) lines.push(`${L(he, "Quick-add person", "משתתף מהיר")}: ${name}`);
    if (typeof mu.full_name === "string" && mu.full_name.trim()) {
      lines.push(`${L(he, "Name", "שם")}: ${mu.full_name.trim()}`);
    }
    if (typeof mu.phone === "string" && mu.phone.trim()) {
      lines.push(`${L(he, "Phone", "טלפון")}: ${mu.phone.trim()}`);
    }
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, profileFieldLabel);
    }
    return lines;
  }

  if (
    item.event_type === "session_manual_participant_added" ||
    item.event_type === "session_manual_participant_removed" ||
    item.event_type === "manual_participant_attendance_updated"
  ) {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const mid = typeof mu.manual_participant_id === "string" ? mu.manual_participant_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    const manual = formatManualRef(mid, manualLabels, mu);
    if (manual) lines.push(`${L(he, "Quick-add participant", "משתתף מהיר")}: ${manual}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel, attendanceFmt);
    }
    return lines;
  }

  if (item.event_type === "registration_attendance_updated") {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const pid = typeof mu.user_id === "string" ? mu.user_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    const part = formatUserRef(pid, profileLabels);
    if (part) lines.push(`${L(he, "Participant", "משתתף")}: ${part}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel, attendanceFmt);
    }
    return lines;
  }

  if (item.event_type === "waitlist_request_created" || item.event_type === "waitlist_request_removed") {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const pid = typeof mu.user_id === "string" ? mu.user_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    const part = formatUserRef(pid, profileLabels);
    if (part) lines.push(`${L(he, "Athlete", "מתאמן")}: ${part}`);
    return lines;
  }

  if (item.event_type === "cancellation_charge_updated" || item.event_type === "cancellation_penalty_collected_updated") {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const pid = typeof mu.user_id === "string" ? mu.user_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    const part = formatUserRef(pid, profileLabels);
    if (part) lines.push(`${L(he, "Participant", "משתתף")}: ${part}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel, attendanceFmt);
    }
    return lines;
  }

  if (item.event_type === "registration_opening_schedule_updated") {
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, sessionFieldLabel);
    }
    return lines;
  }

  if (
    item.event_type === "account_payment_created" ||
    item.event_type === "account_payment_updated" ||
    item.event_type === "account_payment_deleted"
  ) {
    const payeeId = typeof mu.payee_id === "string" ? mu.payee_id : null;
    const payeeManual = mu.payee_is_manual === true;
    if (payeeId) {
      const payee = payeeManual ? formatManualRef(payeeId, manualLabels, mu) : formatUserRef(payeeId, profileLabels);
      if (payee) lines.push(`${L(he, "Payee", "מקבל תשלום")}: ${payee}`);
    }
    if (mu.amount_ils != null) lines.push(`${L(he, "Amount", "סכום")}: ${attendanceFmt("amount_ils", mu.amount_ils)}`);
    if (mu.payment_method != null) lines.push(`${L(he, "Payment method", "אמצעי תשלום")}: ${formatPaymentMethod(mu.payment_method, language)}`);
    if (mu.paid_at != null) lines.push(`${L(he, "Paid on", "תאריך תשלום")}: ${str(mu.paid_at)}`);
    if (mu.payer_name != null && String(mu.payer_name).trim()) lines.push(`${L(he, "Payer", "משלם")}: ${str(mu.payer_name)}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel, attendanceFmt);
    }
    return lines;
  }

  if (item.event_type.startsWith("athlete_family_")) {
    if (mu.name != null) lines.push(`${L(he, "Family name", "שם משפחה")}: ${str(mu.name)}`);
    if (Array.isArray(mu.members)) lines.push(`${L(he, "Members", "חברים")}: ${mu.members.length}`);
    return lines;
  }

  if (item.event_type.startsWith("session_note_")) {
    const sid = typeof mu.session_id === "string" ? mu.session_id : null;
    const sess = formatSessionRef(sid, sessionSummaries);
    if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
    if (typeof mu.body === "string" && mu.body.trim()) lines.push(`${L(he, "Note", "הערה")}: ${mu.body.trim()}`);
    if (mu.changes && typeof mu.changes === "object") {
      appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel);
    }
    return lines;
  }

  if (item.event_type.startsWith("calendar_note_")) {
    appendCalendarNoteFields(lines, mu, he);
    if (mu.before && typeof mu.before === "object") {
      appendPricingSnapshot(lines, mu.before as Record<string, unknown>, he, `${L(he, "Before", "לפני")}: `);
    }
    if (mu.after && typeof mu.after === "object") {
      appendPricingSnapshot(lines, mu.after as Record<string, unknown>, he, `${L(he, "After", "אחרי")}: `);
    }
    return lines;
  }

  if (item.event_type.startsWith("pricing_setting_")) {
    if (mu.table != null) lines.push(`${L(he, "Table", "טבלה")}: ${str(mu.table)}`);
    if (mu.after && typeof mu.after === "object") {
      appendPricingSnapshot(lines, mu.after as Record<string, unknown>, he, `${L(he, "New", "חדש")}: `);
    }
    if (mu.before && typeof mu.before === "object") {
      appendPricingSnapshot(lines, mu.before as Record<string, unknown>, he, `${L(he, "Previous", "קודם")}: `);
    }
    return lines;
  }

  if (item.event_type === "activity_event_reverted") {
    const revertedType = mu.reverted_event_type;
    if (typeof revertedType === "string") {
      lines.push(`${L(he, "Reverted action", "פעולה שבוטלה")}: ${activityLogEventLabel(revertedType, language)}`);
    }
    return lines;
  }

  // Generic fallback — still show whatever metadata we have.
  const sid = resolveSessionId(item, mu);
  const sess = formatSessionRef(sid, sessionSummaries);
  if (sess) lines.push(`${L(he, "Session", "אימון")}: ${sess}`);
  const uid = typeof mu.user_id === "string" ? mu.user_id : item.target_type === "profile" ? item.target_id : null;
  const part = formatUserRef(uid, profileLabels);
  if (part) lines.push(`${L(he, "Participant", "משתתף")}: ${part}`);
  const mid = typeof mu.manual_participant_id === "string" ? mu.manual_participant_id : item.target_type === "manual_participant" ? item.target_id : null;
  const manual = formatManualRef(mid, manualLabels, mu);
  if (manual) lines.push(`${L(he, "Quick-add participant", "משתתף מהיר")}: ${manual}`);
  if (mu.changes && typeof mu.changes === "object") {
    appendChangeLines(lines, mu.changes as Record<string, unknown>, he, language, profileLabels, attendanceFieldLabel, attendanceFmt);
  }
  const skip = new Set(["changes", "session_id", "user_id", "manual_participant_id", "before", "after", "table"]);
  for (const [key, val] of Object.entries(mu)) {
    if (skip.has(key) || val == null || typeof val === "object") continue;
    lines.push(`${attendanceFieldLabel(key, he)}: ${str(val)}`);
  }

  return lines;
}

export function activityLogEventLabel(eventType: string, language: string): string {
  const map: Record<string, { en: string; he: string }> = {
    auth_login: { en: "Login", he: "התחברות" },
    email_confirmed: { en: "Email confirmed", he: "אימייל אומת" },
    password_reset_completed: { en: "Password reset completed", he: "איפוס סיסמה הושלם" },
    signup_completed: { en: "Signup completed", he: "הרשמה הושלמה" },
    athlete_profile_created: { en: "Athlete profile created", he: "פרופיל מתאמן נוצר" },
    profile_created: { en: "Profile created", he: "פרופיל נוצר" },
    profile_updated: { en: "Profile updated", he: "פרופיל עודכן" },
    athlete_approved: { en: "Athlete approved", he: "מתאמן אושר" },
    athlete_rejected: { en: "Athlete rejected", he: "מתאמן נדחה" },
    athlete_approval_updated: { en: "Athlete approval updated", he: "סטטוס אישור עודכן" },
    session_created: { en: "Session created", he: "אימון נוצר" },
    session_updated: { en: "Session updated", he: "אימון עודכן" },
    session_deleted: { en: "Session deleted", he: "אימון נמחק" },
    session_registration: { en: "Session registration", he: "הרשמה לאימון" },
    session_registration_cancelled: { en: "Registration cancelled", he: "הרשמה בוטלה" },
    session_registration_status_changed: { en: "Registration status changed", he: "סטטוס הרשמה השתנה" },
    activity_event_reverted: { en: "Action reverted", he: "פעולה בוטלה" },
    session_manual_participant_added: { en: "Quick-add participant added", he: "משתתף מהיר נוסף לאימון" },
    session_manual_participant_removed: { en: "Quick-add participant removed", he: "משתתף מהיר הוסר מהאימון" },
    registration_attendance_updated: { en: "Registration attendance updated", he: "נוכחות הרשמה עודכנה" },
    manual_participant_attendance_updated: { en: "Quick-add attendance updated", he: "נוכחות משתתף מהיר עודכנה" },
    user_role_changed: { en: "User role changed", he: "תפקיד משתמש השתנה" },
    manual_participant_created: { en: "Quick-add person created", he: "משתתף מהיר נוצר" },
    manual_participant_updated: { en: "Quick-add person updated", he: "משתתף מהיר עודכן" },
    account_payment_created: { en: "Account payment recorded", he: "תשלום חשבון נרשם" },
    account_payment_updated: { en: "Account payment updated", he: "תשלום חשבון עודכן" },
    account_payment_deleted: { en: "Account payment deleted", he: "תשלום חשבון נמחק" },
    pricing_setting_created: { en: "Pricing setting added", he: "הגדרת מחיר נוספה" },
    pricing_setting_updated: { en: "Pricing setting updated", he: "הגדרת מחיר עודכנה" },
    pricing_setting_deleted: { en: "Pricing setting removed", he: "הגדרת מחיר הוסרה" },
    calendar_note_created: { en: "Calendar note added", he: "הערת לוח שנה נוספה" },
    calendar_note_updated: { en: "Calendar note updated", he: "הערת לוח שנה עודכנה" },
    calendar_note_deleted: { en: "Calendar note removed", he: "הערת לוח שנה הוסרה" },
    session_note_created: { en: "Session note added", he: "הערת אימון נוספה" },
    session_note_updated: { en: "Session note updated", he: "הערת אימון עודכנה" },
    session_note_deleted: { en: "Session note removed", he: "הערת אימון הוסרה" },
    athlete_family_created: { en: "Family group created", he: "קבוצת משפחה נוצרה" },
    athlete_family_updated: { en: "Family group updated", he: "קבוצת משפחה עודכנה" },
    athlete_family_deleted: { en: "Family group deleted", he: "קבוצת משפחה נמחקה" },
    cancellation_charge_updated: { en: "Late-cancel charge updated", he: "חיוב ביטול מאוחר עודכן" },
    cancellation_penalty_collected_updated: { en: "Late-cancel collection updated", he: "גביית ביטול מאוחר עודכנה" },
    registration_opening_schedule_updated: { en: "Registration opening schedule updated", he: "לוח פתיחת הרשמה עודכן" },
    waitlist_request_created: { en: "Waitlist request added", he: "בקשת המתנה נוספה" },
    waitlist_request_removed: { en: "Waitlist request removed", he: "בקשת המתנה הוסרה" },
  };
  const m = map[eventType];
  if (!m) return eventType;
  return language === "he" ? m.he : m.en;
}
