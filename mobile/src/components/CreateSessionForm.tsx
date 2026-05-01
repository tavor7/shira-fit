import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Modal, FlatList, ActivityIndicator, useWindowDimensions } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "./PrimaryButton";
import { addDaysToISODate } from "../lib/sessionTime";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { toISODateLocal, isValidISODateString } from "../lib/isoDate";
import { DatePickerField } from "./DatePickerField";
import { TimePickerField } from "./TimePickerField";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { appendNetworkHint } from "../lib/networkErrors";
import { sessionFormIsCompact, sessionFormStyles as sf } from "./sessionFormStyles";

type CoachOption = { user_id: string; full_name: string; role: string; username: string; calendar_color?: string | null };

type Props = {
  initialDate?: string;
  /** When set, trainer is fixed (coach creating their own session). */
  fixedCoachId?: string;
  fixedCoachLabel?: string;
};

type AthletePick = { user_id: string; full_name: string; username: string; phone: string };
type ManualPick = { manual_participant_id: string; full_name: string; phone: string };

/** Escape % and _ so ilike filters stay valid. */
function escapeIlike(term: string) {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function CreateSessionForm({ initialDate, fixedCoachId, fixedCoachLabel }: Props) {
  const { language, t, isRTL } = useI18n();
  const { showToast } = useToast();
  const { width } = useWindowDimensions();
  const compact = sessionFormIsCompact(width);
  const [date, setDate] = useState(() => initialDate?.trim() || toISODateLocal(new Date()));
  const [time, setTime] = useState("18:00");
  const [coachId, setCoachId] = useState(fixedCoachId ?? "");
  const [coachLabel, setCoachLabel] = useState(
    fixedCoachLabel ? `${fixedCoachLabel} — ${language === "he" ? "את/ה" : "you"}` : ""
  );
  const [coachColor, setCoachColor] = useState<string | null>(null);
  const [coachOptions, setCoachOptions] = useState<CoachOption[]>([]);
  const [coachOptionsLoading, setCoachOptionsLoading] = useState(!fixedCoachId);
  const [showCoachPicker, setShowCoachPicker] = useState(false);
  const [max, setMax] = useState("12");
  const [durationMinutes, setDurationMinutes] = useState("55");
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [weeklyOccurrences, setWeeklyOccurrences] = useState("4");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [note, setNote] = useState("");

  // Trainee selection during creation.
  const [traineesOpen, setTraineesOpen] = useState(false);
  const [traineesQ, setTraineesQ] = useState("");
  const [traineesSearching, setTraineesSearching] = useState(false);
  const [athleteResults, setAthleteResults] = useState<AthletePick[]>([]);
  const [manualResults, setManualResults] = useState<{ id: string; full_name: string; phone: string }[]>([]);
  const [selectedAthletes, setSelectedAthletes] = useState<AthletePick[]>([]);
  const [selectedManual, setSelectedManual] = useState<ManualPick[]>([]);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [traineesBusy, setTraineesBusy] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialDate?.trim()) setDate(initialDate.trim());
  }, [initialDate]);

  useEffect(() => {
    if (fixedCoachId) {
      setCoachId(fixedCoachId);
      setCoachLabel(fixedCoachLabel ? `${fixedCoachLabel} — ${language === "he" ? "את/ה" : "you"}` : language === "he" ? "את/ה" : "You");
      setCoachOptionsLoading(false);
    }
  }, [fixedCoachId, fixedCoachLabel, language]);

  useEffect(() => {
    if (!fixedCoachId) return;
    (async () => {
      // Optional: show a color dot for fixed coach accounts too.
      let res = await supabase.from("profiles").select("calendar_color").eq("user_id", fixedCoachId).maybeSingle();
      if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
        setCoachColor(null);
        return;
      }
      setCoachColor((res.data as { calendar_color?: string | null } | null)?.calendar_color ?? null);
    })();
  }, [fixedCoachId]);

  const loadCoaches = useCallback(async () => {
    if (fixedCoachId) return;
    setCoachOptionsLoading(true);
    let res: any = await supabase
      .from("profiles")
      .select("user_id, full_name, role, username, calendar_color")
      .in("role", ["coach", "manager"])
      .order("full_name");
    if (res.error && isMissingColumnError(res.error.message, "calendar_color")) {
      res = await supabase
        .from("profiles")
        .select("user_id, full_name, role, username")
        .in("role", ["coach", "manager"])
        .order("full_name");
    }
    setCoachOptions((res.data as CoachOption[]) ?? []);
    setCoachOptionsLoading(false);
  }, [fixedCoachId]);

  useFocusEffect(useCallback(() => { loadCoaches(); }, [loadCoaches]));

  function selectCoach(opt: CoachOption) {
    setCoachId(opt.user_id);
    setCoachLabel(`${opt.full_name} — ${opt.role}`);
    setCoachColor(opt.calendar_color ?? null);
    setShowCoachPicker(false);
  }

  async function runTraineeSearch(termRaw: string) {
    const term = termRaw.trim();
    const safe = escapeIlike(term);
    setTraineesSearching(true);
    try {
      let pQuery = supabase
        .from("profiles")
        .select("user_id, full_name, username, phone")
        .eq("role", "athlete")
        .order("full_name", { ascending: true })
        .limit(50);
      if (term.length > 0) {
        pQuery = pQuery.or(`full_name.ilike.%${safe}%,username.ilike.%${safe}%,phone.ilike.%${safe}%`);
      }
      const { data: pData, error: pErr } = await pQuery;

      let mQuery = supabase
        .from("manual_participants")
        .select("id, full_name, phone")
        .order("full_name", { ascending: true })
        .limit(50);
      if (term.length > 0) {
        mQuery = mQuery.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
      }
      const { data: mData, error: mErr } = await mQuery;

      setAthleteResults((!pErr ? (pData as AthletePick[]) ?? [] : []) as AthletePick[]);
      setManualResults((!mErr ? (mData as any[]) ?? [] : []) as { id: string; full_name: string; phone: string }[]);
    } finally {
      setTraineesSearching(false);
    }
  }

  function addAthletePick(p: AthletePick) {
    setSelectedAthletes((prev) => (prev.some((x) => x.user_id === p.user_id) ? prev : [...prev, p]));
  }

  function addManualPick(m: { id: string; full_name: string; phone: string }) {
    const pick: ManualPick = { manual_participant_id: m.id, full_name: m.full_name, phone: m.phone };
    setSelectedManual((prev) => (prev.some((x) => x.manual_participant_id === pick.manual_participant_id) ? prev : [...prev, pick]));
  }

  function removeAthletePick(userId: string) {
    setSelectedAthletes((prev) => prev.filter((x) => x.user_id !== userId));
  }

  function removeManualPick(manualParticipantId: string) {
    setSelectedManual((prev) => prev.filter((x) => x.manual_participant_id !== manualParticipantId));
  }

  async function quickAddManual() {
    const name = quickName.trim();
    const phone = quickPhone.trim();
    if (name.length < 2 || phone.length < 3) {
      showToast({
        message: language === "he" ? "חסר מידע" : "Missing info",
        detail: language === "he" ? "הזינו שם וטלפון." : "Enter name and phone.",
        variant: "info",
      });
      return;
    }
    if (traineesBusy) return;
    setTraineesBusy(true);
    try {
      const { data, error } = await supabase.rpc("upsert_manual_participant", { p_full_name: name, p_phone: phone });
      if (error) {
        showToast({ message: t("common.error"), detail: error.message, variant: "error" });
        return;
      }
      if (!data?.ok) {
        showToast({ message: t("common.failed"), detail: String(data?.error ?? ""), variant: "error" });
        return;
      }
      const mid = String((data as any)?.manual_participant_id ?? "");
      if (!mid) return;
      addManualPick({ id: mid, full_name: name, phone });
      setQuickName("");
      setQuickPhone("");
    } finally {
      setTraineesBusy(false);
    }
  }

  async function save() {
    setError(null);
    const trimmedDate = date.trim();
    if (!isValidISODateString(trimmedDate)) {
      setError(language === "he" ? "בחרו תאריך אימון תקין." : "Please choose a valid session date.");
      return;
    }
    if (!coachId) {
      setError(
        fixedCoachId
          ? language === "he"
            ? "לא ניתן לזהות את החשבון שלך."
            : "Could not resolve your account."
          : language === "he"
            ? "בחרו מאמן או מנהל."
            : "Please choose a coach or manager."
      );
      return;
    }
    const parsedDuration = parseInt(durationMinutes.trim(), 10);
    const duration = Number.isFinite(parsedDuration) ? parsedDuration : 55;
    if (duration < 1 || duration > 24 * 60) {
      setError(
        language === "he"
          ? "משך האימון חייב להיות בין 1 ל-1440 דקות (24 שעות)."
          : "Session length must be between 1 and 1440 minutes (24 hours)."
      );
      return;
    }
    const startT = time.trim() || "18:00";
    const maxP = parseInt(max, 10) || 1;
    let count = 1;
    if (repeatWeekly) {
      const n = parseInt(weeklyOccurrences.trim(), 10);
      count = Number.isFinite(n) ? n : 4;
      if (count < 1) count = 1;
      if (count > 52) count = 52;
    }
    const rows = Array.from({ length: count }, (_, i) => ({
      session_date: addDaysToISODate(trimmedDate, i * 7),
      start_time: startT,
      coach_id: coachId,
      max_participants: maxP,
      is_open_for_registration: open,
      is_hidden: hidden,
      duration_minutes: duration,
    }));
    setSaving(true);
    let insertedIds: string[] = [];
    let res = await supabase.from("training_sessions").insert(rows).select("id");
    let err = res.error;
    insertedIds = ((res.data as { id: string }[] | null) ?? []).map((r) => r.id);
    let usedLegacyInsert = false;
    if (err && isMissingColumnError(err.message, "is_hidden")) {
      const rowsLegacy = rows.map(({ is_hidden: _h, ...rest }) => rest);
      const retry = await supabase.from("training_sessions").insert(rowsLegacy).select("id");
      err = retry.error;
      if (!err) usedLegacyInsert = true;
      insertedIds = ((retry.data as { id: string }[] | null) ?? []).map((r) => r.id);
    }
    setSaving(false);
    if (err) {
      setError(err.message);
      showToast({ message: t("common.error"), detail: err.message, variant: "error" });
      return;
    }

    const noteBody = note.trim();
    if (noteBody && insertedIds.length > 0) {
      const batch = await supabase.rpc("add_session_note_many", { p_session_ids: insertedIds, p_body: noteBody });
      if (batch.error) {
        const m = String(batch.error.message || "");
        if (m.includes("add_session_note_many")) {
          for (const sid of insertedIds) {
            // eslint-disable-next-line no-await-in-loop
            await supabase.rpc("add_session_note", { p_session_id: sid, p_body: noteBody });
          }
        } else {
          showToast({
            message: language === "he" ? "האימון נשמר, אבל ההערה לא נשמרה." : "Saved, but the note could not be saved.",
            variant: "info",
          });
        }
      }
    }

    // Add selected trainees to the newly created sessions.
    if (insertedIds.length > 0 && (selectedAthletes.length > 0 || selectedManual.length > 0)) {
      const athleteIds = selectedAthletes.map((a) => a.user_id);
      const manualIds = selectedManual.map((m) => m.manual_participant_id);

      const isBenignDuplicate = (code: string) => code === "already_registered" || code === "already_in_session";

      for (const sid of insertedIds) {
        for (const uid of athleteIds) {
          // eslint-disable-next-line no-await-in-loop
          const { data, error } = await supabase.rpc("coach_add_athlete", { p_session_id: sid, p_user_id: uid });
          if (error) {
            showToast({ message: language === "he" ? "שגיאה הוספת מתאמן" : "Error adding trainee", detail: error.message, variant: "error" });
            continue;
          }
          const e = String(data?.error ?? "");
          if (!data?.ok && e && !isBenignDuplicate(e)) {
            showToast({ message: t("common.failed"), detail: e, variant: "error" });
          }
        }
        for (const mid of manualIds) {
          // eslint-disable-next-line no-await-in-loop
          const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
            p_session_id: sid,
            p_manual_participant_id: mid,
          });
          if (error) {
            showToast({ message: language === "he" ? "שגיאה הוספת משתתף ידני" : "Error adding manual participant", detail: error.message, variant: "error" });
            continue;
          }
          const e = String(data?.error ?? "");
          if (!data?.ok && e && !isBenignDuplicate(e)) {
            showToast({ message: t("common.failed"), detail: e, variant: "error" });
          }
        }
      }
    }

    if (usedLegacyInsert && hidden) {
      showToast({
        message: language === "he" ? "נשמר (אימונים גלויים)" : "Saved (visible sessions)",
        detail:
          language === "he"
            ? "חסרה בעמודה `is_hidden` בפרויקט (המיגרציה לא הופעלה)."
            : "Your project is missing the `is_hidden` column (migration not applied).",
        variant: "info",
      });
    }
    if (!(usedLegacyInsert && hidden)) {
      if (count > 1) {
        showToast({
          message: language === "he" ? `נוצרו ${count} אימונים שבועיים.` : `Created ${count} weekly sessions.`,
          variant: "success",
        });
      } else {
        showToast({ message: t("common.saved"), variant: "success" });
      }
    }
    router.back();
  }

  return (
    <ScrollView contentContainerStyle={sf.content} style={sf.screen} keyboardShouldPersistTaps="handled">
      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "מתי" : "When"}</Text>
        <View style={[sf.row, compact && sf.rowStack]}>
          <View style={sf.col}>
            <DatePickerField label={language === "he" ? "תאריך אימון" : "Session date"} value={date} onChange={setDate} />
          </View>
          <View style={sf.col}>
            <TimePickerField label={language === "he" ? "שעת התחלה" : "Start time"} value={time} onChange={setTime} />
          </View>
        </View>
      </View>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "מאמן" : "Trainer"}</Text>
        {fixedCoachId ? (
          <View style={[sf.control, { justifyContent: "center" }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {coachColor ? (
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    backgroundColor: coachColor,
                    borderWidth: 1,
                    borderColor: theme.colors.borderMuted,
                  }}
                />
              ) : null}
              <Text style={[sf.controlText, { flex: 1 }]} numberOfLines={1} ellipsizeMode="tail">
                {coachLabel || (language === "he" ? "את/ה" : "You")}
              </Text>
            </View>
          </View>
        ) : (
          <>
            <Pressable
              style={({ pressed }) => [sf.control, pressed && { opacity: 0.9 }, { justifyContent: "center" }]}
              onPress={() => setShowCoachPicker(true)}
              accessibilityRole="button"
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                {coachLabel && coachColor ? (
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      backgroundColor: coachColor,
                      borderWidth: 1,
                      borderColor: theme.colors.borderMuted,
                    }}
                  />
                ) : null}
                <Text
                  style={[coachLabel ? sf.controlText : sf.controlPlaceholder, { flex: 1 }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {coachLabel || (language === "he" ? "בחרו מאמן לפי שם…" : "Choose trainer by name…")}
                </Text>
              </View>
            </Pressable>
            <Modal visible={showCoachPicker} transparent animationType="slide">
              <View style={styles.modalBackdrop}>
                <Pressable style={styles.modalBackdropTouch} onPress={() => setShowCoachPicker(false)} />
                <View style={styles.modalBox}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.modalTitle}>{language === "he" ? "כל המאמנים" : "All trainers"}</Text>
                    <Pressable onPress={() => setShowCoachPicker(false)}>
                      <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
                    </Pressable>
                  </View>
                  {coachOptionsLoading ? (
                    <ActivityIndicator size="large" color={theme.colors.text} style={styles.modalLoader} />
                  ) : (
                    <FlatList
                      data={coachOptions}
                      keyExtractor={(item) => item.user_id}
                      renderItem={({ item }) => (
                        <Pressable
                          style={({ pressed }) => [styles.pickerItem, pressed && { opacity: 0.85 }]}
                          onPress={() => selectCoach(item)}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                            {item.calendar_color ? (
                              <View
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: 999,
                                  backgroundColor: item.calendar_color,
                                  borderWidth: 1,
                                  borderColor: theme.colors.borderMuted,
                                }}
                              />
                            ) : null}
                            <View style={styles.pickerItemTextCol}>
                            <Text style={styles.pickerItemName} numberOfLines={1} ellipsizeMode="tail">
                              {item.full_name}
                            </Text>
                            <Text style={styles.pickerItemRole} numberOfLines={1} ellipsizeMode="tail">
                              @{item.username} · {item.role}
                            </Text>
                            </View>
                          </View>
                        </Pressable>
                      )}
                      ListEmptyComponent={
                        <Text style={styles.pickerEmpty}>
                          {language === "he" ? "עדיין אין מאמנים או מנהלים" : "No coaches or managers yet"}
                        </Text>
                      }
                    />
                  )}
                </View>
              </View>
            </Modal>
          </>
        )}
      </View>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "קיבולת" : "Capacity"}</Text>
        <View style={[sf.row, compact && sf.rowStack]}>
          <View style={sf.col}>
            <Text style={[sf.label, isRTL && sf.labelRtl]}>{language === "he" ? "משך (דקות)" : "Length (min)"}</Text>
            <TextInput
              style={[sf.control, sf.controlInput]}
              value={durationMinutes}
              onChangeText={setDurationMinutes}
              keyboardType="number-pad"
              placeholder={language === "he" ? "55" : "55"}
              placeholderTextColor={theme.colors.textSoft}
            />
          </View>
          <View style={sf.col}>
            <Text style={[sf.label, isRTL && sf.labelRtl]}>{language === "he" ? "מקסימום משתתפים" : "Max participants"}</Text>
            <TextInput
              style={[sf.control, sf.controlInput]}
              value={max}
              onChangeText={setMax}
              keyboardType="number-pad"
              placeholder={language === "he" ? "12" : "12"}
              placeholderTextColor={theme.colors.textSoft}
            />
            <View style={styles.quickCapsRow}>
              {[1, 2, 4, 12].map((n) => {
                const active = String(n) === max.trim();
                return (
                  <Pressable
                    key={n}
                    onPress={() => setMax(String(n))}
                    style={({ pressed }) => [styles.quickCapBtn, active && styles.quickCapBtnActive, pressed && { opacity: 0.92 }]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.quickCapTxt, active && styles.quickCapTxtActive]}>{n}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </View>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "הערה" : "Note"}</Text>
        <Text style={[sf.label, isRTL && sf.labelRtl]}>
          {language === "he" ? "הערה לצוות (נשמרת יחד עם האימון)" : "Staff note (saved with the session)"}
        </Text>
        <TextInput
          style={[sf.control, styles.noteInput, isRTL && { textAlign: "right" }]}
          value={note}
          onChangeText={setNote}
          placeholder={language === "he" ? "לדוגמה: עבודה על טכניקה…" : "Example: focus on technique…"}
          placeholderTextColor={theme.colors.textSoft}
          multiline
          textAlignVertical="top"
        />
      </View>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "מתאמנים" : "Trainees"}</Text>
        <Text style={[sf.label, isRTL && sf.labelRtl]}>
          {language === "he"
            ? "בחרו מתאמנים לאימון (הבחירה תישמר עם שמירת האימון)."
            : "Select trainees for the session (saved when you save the session)."}
        </Text>

        <PrimaryButton
          label={language === "he" ? "בחירת מתאמנים" : "Select trainees"}
          onPress={() => {
            setTraineesOpen(true);
            void runTraineeSearch(traineesQ || "");
          }}
          variant="ghost"
        />

        {selectedAthletes.length + selectedManual.length > 0 ? (
          <View style={styles.selectedList}>
            {selectedAthletes.map((a) => (
              <View key={a.user_id} style={styles.selectedChip}>
                <Text style={styles.selectedChipTxt} numberOfLines={1} ellipsizeMode="tail">
                  {a.full_name}
                </Text>
                <Pressable onPress={() => removeAthletePick(a.user_id)} style={styles.chipX} accessibilityRole="button">
                  <Text style={styles.chipXTxt}>✕</Text>
                </Pressable>
              </View>
            ))}
            {selectedManual.map((m) => (
              <View key={m.manual_participant_id} style={styles.selectedChip}>
                <Text style={styles.selectedChipTxt} numberOfLines={1} ellipsizeMode="tail">
                  {m.full_name}
                </Text>
                <Pressable onPress={() => removeManualPick(m.manual_participant_id)} style={styles.chipX} accessibilityRole="button">
                  <Text style={styles.chipXTxt}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <Modal visible={traineesOpen} transparent animationType="slide" onRequestClose={() => setTraineesOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropTouch} onPress={() => setTraineesOpen(false)} />
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{language === "he" ? "מתאמנים" : "Trainees"}</Text>
              <Pressable onPress={() => setTraineesOpen(false)}>
                <Text style={styles.modalClose}>{language === "he" ? t("common.ok") : "Done"}</Text>
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled">
              <View style={styles.traineeSearchRow}>
              <TextInput
                value={traineesQ}
                onChangeText={setTraineesQ}
                placeholder={language === "he" ? "חיפוש שם / טלפון…" : "Search name / phone…"}
                placeholderTextColor={theme.colors.placeholderOnLight}
                style={styles.traineeSearchInput}
                autoCapitalize="none"
                onSubmitEditing={() => void runTraineeSearch(traineesQ)}
              />
              <Pressable
                style={({ pressed }) => [styles.traineeSearchBtn, pressed && { opacity: 0.9 }]}
                onPress={() => void runTraineeSearch(traineesQ)}
                disabled={traineesSearching}
              >
                <Text style={styles.traineeSearchBtnTxt}>{traineesSearching ? "…" : t("common.search")}</Text>
              </Pressable>
              </View>

            <View style={{ height: 10 }} />

            <Text style={styles.modalSubTitle}>{language === "he" ? "מתאמנים עם חשבון" : "Athletes (with account)"}</Text>
            <View style={styles.traineeList}>
              {athleteResults.length === 0 ? (
                <Text style={styles.pickerEmpty}>{language === "he" ? "אין תוצאות." : "No results."}</Text>
              ) : (
                athleteResults.map((a) => {
                  const already = selectedAthletes.some((x) => x.user_id === a.user_id);
                  return (
                    <Pressable
                      key={a.user_id}
                      style={({ pressed }) => [
                        styles.pickerRowSlim,
                        pressed && { opacity: 0.9 },
                        already && { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.cta },
                      ]}
                      onPress={() => {
                        if (!already) addAthletePick(a);
                      }}
                      accessibilityRole="button"
                      disabled={already}
                    >
                      <Text style={styles.pickerRowName} numberOfLines={1} ellipsizeMode="tail">
                        {a.full_name}
                      </Text>
                      <Text style={styles.pickerRowMeta} numberOfLines={1} ellipsizeMode="tail">
                        @{a.username} · {a.phone}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </View>

            <Text style={[styles.modalSubTitle, { marginTop: 14 }]}>{language === "he" ? "Quick Add" : "Quick Add"}</Text>
            <View style={styles.traineeList}>
              {manualResults.length === 0 ? (
                <Text style={styles.pickerEmpty}>{language === "he" ? "אין תוצאות." : "No results."}</Text>
              ) : (
                manualResults.map((m) => {
                  const already = selectedManual.some((x) => x.manual_participant_id === m.id);
                  return (
                    <Pressable
                      key={m.id}
                      style={({ pressed }) => [
                        styles.pickerRowSlim,
                        pressed && { opacity: 0.9 },
                        already && { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.cta },
                      ]}
                      onPress={() => {
                        if (!already) addManualPick(m);
                      }}
                      accessibilityRole="button"
                      disabled={already}
                    >
                      <Text style={styles.pickerRowName} numberOfLines={1} ellipsizeMode="tail">
                        {m.full_name}
                      </Text>
                      <Text style={styles.pickerRowMeta} numberOfLines={1} ellipsizeMode="tail">
                        {m.phone}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </View>

            <View style={{ height: 12 }} />
            <Text style={styles.modalSubTitle}>{language === "he" ? "הוספה מהירה (לא חובה חשבון)" : "Quick add (no account required)"}</Text>
            <View style={styles.quickAddRow}>
              <TextInput
                value={quickName}
                onChangeText={setQuickName}
                placeholder={t("profile.fullName")}
                placeholderTextColor={theme.colors.placeholderOnLight}
                style={styles.quickAddInput}
              />
              <TextInput
                value={quickPhone}
                onChangeText={setQuickPhone}
                placeholder={t("profile.phone")}
                placeholderTextColor={theme.colors.placeholderOnLight}
                style={styles.quickAddInput}
                keyboardType="phone-pad"
              />
            </View>
            <PrimaryButton
              label={language === "he" ? "הוסף לטרעיינים" : "Add to trainees"}
              onPress={() => void quickAddManual()}
              loading={traineesBusy}
              loadingLabel={t("common.loading")}
            />
              </ScrollView>
            </View>
        </View>
      </Modal>

      <View style={sf.card}>
        <Text style={sf.cardTitle}>{language === "he" ? "אפשרויות" : "Options"}</Text>
        <Pressable style={({ pressed }) => [sf.toggle, pressed && { opacity: 0.9 }]} onPress={() => setOpen(!open)}>
          <Text style={[sf.toggleText, isRTL && { textAlign: "right" }]}>
            {language === "he" ? "פתוח להרשמה: " : "Open for registration: "}
            {open ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
          </Text>
        </Pressable>
        <View style={{ height: 10 }} />
        <Pressable style={({ pressed }) => [sf.toggle, pressed && { opacity: 0.9 }]} onPress={() => setHidden(!hidden)}>
          <Text style={[sf.toggleText, isRTL && { textAlign: "right" }]}>
            {language === "he" ? "מוסתר (צוות בלבד): " : "Hidden (staff-only): "}
            {hidden ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
          </Text>
        </Pressable>
        <View style={{ height: 10 }} />
        <Pressable style={({ pressed }) => [sf.toggle, pressed && { opacity: 0.9 }]} onPress={() => setRepeatWeekly(!repeatWeekly)}>
          <Text style={[sf.toggleText, isRTL && { textAlign: "right" }]}>
            {language === "he" ? "חזרה שבועית: " : "Repeat weekly: "}
            {repeatWeekly ? (language === "he" ? "כן" : "Yes") : language === "he" ? "לא" : "No"}
          </Text>
        </Pressable>
        {repeatWeekly ? (
          <View style={{ marginTop: 10 }}>
            <Text style={[sf.label, isRTL && sf.labelRtl]}>{language === "he" ? "מספר שבועות" : "Occurrences"}</Text>
            <TextInput
              style={[sf.control, sf.controlInput]}
              value={weeklyOccurrences}
              onChangeText={setWeeklyOccurrences}
              keyboardType="number-pad"
              placeholder="4"
              placeholderTextColor={theme.colors.textSoft}
            />
          </View>
        ) : null}
      </View>

      {error ? <Text style={[sf.error, isRTL && { textAlign: "right" }]}>{appendNetworkHint({ message: error } as any, t("network.offlineHint"))}</Text> : null}

      <View style={[sf.card, { marginBottom: 0 }]}>
        <PrimaryButton
          label={language === "he" ? "שמירת אימון" : "Save session"}
          onPress={save}
          loading={saving}
          loadingLabel={t("common.loading")}
        />
        <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.secondaryAction, pressed && { opacity: 0.85 }]}>
          <Text style={styles.secondaryActionTxt}>{t("common.cancel")}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  modalBackdropTouch: { ...StyleSheet.absoluteFillObject },
  modalBox: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxHeight: "80%",
    paddingBottom: theme.spacing.lg,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  modalTitle: { fontSize: 16, fontWeight: "900", color: theme.colors.text },
  modalClose: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "900" },
  modalLoader: { paddingVertical: theme.spacing.xl },
  pickerItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.borderMuted },
  pickerItemTextCol: { flex: 1 },
  pickerItemName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  pickerItemRole: { fontSize: 13, color: theme.colors.textMuted, marginTop: 4, textTransform: "none", fontWeight: "700" },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoft, textAlign: "center", fontWeight: "700" },
  secondaryAction: { marginTop: 12, paddingVertical: 10, alignItems: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  quickCapsRow: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  quickCapBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minWidth: 44,
    alignItems: "center",
  },
  quickCapBtnActive: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  quickCapTxt: { color: theme.colors.text, fontWeight: "900" },
  quickCapTxtActive: { color: theme.colors.ctaText },
  noteInput: { minHeight: 110, paddingVertical: 12 },

  selectedList: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  selectedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  selectedChipTxt: { color: theme.colors.text, fontWeight: "900", maxWidth: 140 },
  chipX: { width: 26, height: 26, borderRadius: theme.radius.full, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.borderMuted, alignItems: "center", justifyContent: "center" },
  chipXTxt: { color: theme.colors.textMuted, fontWeight: "900", fontSize: 12, lineHeight: 14 },

  traineeSearchRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  traineeSearchInput: { flex: 1, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.borderInput, borderRadius: theme.radius.md, padding: 10, color: theme.colors.text },
  traineeSearchBtn: { paddingVertical: 12, paddingHorizontal: 14, backgroundColor: theme.colors.cta, borderRadius: theme.radius.md },
  traineeSearchBtnTxt: { color: theme.colors.ctaText, fontWeight: "900", letterSpacing: 0.2 },

  modalSubTitle: { marginTop: 4, fontWeight: "900", color: theme.colors.textMuted, letterSpacing: 0.2, fontSize: 12, textTransform: "uppercase" },

  traineeList: { marginTop: 8 },
  pickerRowSlim: { borderWidth: 1, borderColor: theme.colors.borderMuted, borderRadius: theme.radius.md, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: theme.colors.surface, marginBottom: 8 },
  pickerRowName: { fontWeight: "900", color: theme.colors.text },
  pickerRowMeta: { marginTop: 2, color: theme.colors.textMuted, fontWeight: "700", fontSize: 12 },

  quickAddRow: { gap: 10 },
  quickAddInput: { borderWidth: 1, borderColor: theme.colors.borderInput, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, padding: 12, color: theme.colors.text, marginBottom: 10 },
});
