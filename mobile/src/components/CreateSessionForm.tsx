import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { theme } from "../theme";
import { PrimaryButton } from "./PrimaryButton";
import { DEFAULT_SESSION_START_TIME, suggestNextSessionStartTime } from "../lib/sessionTime";
import { isMissingSessionSeriesRpc, staffCreateSessionSeries } from "../lib/sessionSeries";
import { isMissingColumnError } from "../lib/dbColumnErrors";
import { toISODateLocal, isValidISODateString } from "../lib/isoDate";
import { SessionWhenFields } from "./SessionWhenFields";
import { SessionCapacityFields } from "./SessionCapacityFields";
import {
  clampSessionDuration,
  clampSessionMaxParticipants,
  isValidSessionDuration,
  isValidSessionMaxParticipants,
  normalizeSessionDurationString,
  normalizeSessionMaxString,
} from "../lib/sessionCapacityOptions";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useAppAlert } from "../context/AppAlertContext";
import { findExistingParticipantByNameOrPhone } from "../lib/findExistingParticipant";
import { promptAddExistingParticipant } from "../lib/promptExistingParticipant";
import { athleteSearchSubtitle } from "../lib/displayName";
import { useDiscardChangesPrompt } from "../hooks/useDiscardChangesPrompt";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { SessionSlotRateField } from "./SessionSlotRateField";
import { SessionOptionsSection, type SessionOptionItem } from "./SessionOptionsSection";
import { SessionSeriesOptionsExpand } from "./SessionSeriesOptionsExpand";
import { CollapsiblePricingForm } from "./CollapsiblePricingForm";
import { fetchActiveGlobalTierPrice, parseCustomSlotPriceDraft } from "../lib/sessionSlotPrice";
import { AppSearchSheet } from "./AppSearchSheet";
import { CoachPickerSheet } from "./CoachPickerSheet";
import { ParticipantQuickAddPanel } from "./ParticipantQuickAddPanel";

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
  const { promptDiscardChanges, discardDialog } = useDiscardChangesPrompt(isRTL);
  const { showToast } = useToast();
  const { showAlert } = useAppAlert();
  const navigation = useNavigation();
  const [date, setDate] = useState(() => initialDate?.trim() || toISODateLocal(new Date()));
  const [time, setTime] = useState(DEFAULT_SESSION_START_TIME);
  const [coachId, setCoachId] = useState(fixedCoachId ?? "");
  const coachYouLabel = t("sessionForm.coachYou");
  const [coachLabel, setCoachLabel] = useState(fixedCoachLabel ? `${fixedCoachLabel} — ${coachYouLabel}` : "");
  const [coachColor, setCoachColor] = useState<string | null>(null);
  const [showCoachPicker, setShowCoachPicker] = useState(false);
  const [max, setMax] = useState("1");
  const [durationMinutes, setDurationMinutes] = useState("55");
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatOngoing, setRepeatOngoing] = useState(true);
  const [repeatCopyRoster, setRepeatCopyRoster] = useState(false);
  const [weeklyOccurrences, setWeeklyOccurrences] = useState("4");
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [isKickbox, setIsKickbox] = useState(false);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [customSlotPriceDraft, setCustomSlotPriceDraft] = useState("");
  const [tierSlotPriceIls, setTierSlotPriceIls] = useState<number | null>(null);

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
  const [defaultTimeLoading, setDefaultTimeLoading] = useState(true);

  const noteSummary = useMemo(() => {
    const trimmed = note.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
  }, [note]);

  useEffect(() => {
    if (note.trim()) setNoteOpen(true);
  }, [note]);

  /** Serialized baseline once coach list is ready (manager) or immediately (fixed coach). */
  const [createBaseline, setCreateBaseline] = useState<string | null>(null);
  const createBaselineRef = useRef<string | null>(null);
  createBaselineRef.current = createBaseline;
  const allowLeaveCreateRef = useRef(false);
  const formSerializedRef = useRef("");

  const formSerialized = useMemo(
    () =>
      JSON.stringify({
        date,
        time,
        coachId,
        coachLabel,
        max,
        durationMinutes,
        repeatWeekly,
        repeatOngoing,
        repeatCopyRoster,
        weeklyOccurrences,
        open,
        hidden,
        isKickbox,
        note,
        customSlotPriceDraft,
        ath: selectedAthletes.map((a) => a.user_id).slice().sort(),
        man: selectedManual.map((m) => m.manual_participant_id).slice().sort(),
      }),
    [
      date,
      time,
      coachId,
      coachLabel,
      max,
      durationMinutes,
      repeatWeekly,
      repeatOngoing,
      repeatCopyRoster,
      weeklyOccurrences,
      open,
      hidden,
      isKickbox,
      note,
      customSlotPriceDraft,
      selectedAthletes,
      selectedManual,
    ]
  );

  useEffect(() => {
    const cap = parseInt(max, 10);
    if (!Number.isFinite(cap) || cap < 1) {
      setTierSlotPriceIls(null);
      return;
    }
    let cancelled = false;
    const asOf = isValidISODateString(date.trim()) ? date.trim() : toISODateLocal(new Date());
    void (async () => {
      try {
        const tierP = await fetchActiveGlobalTierPrice(supabase, cap, { isKickbox, asOf });
        if (cancelled) return;
        setTierSlotPriceIls(tierP);
      } catch (error) {
        if (cancelled) return;
        showToast({
          message: t("common.error"),
          detail: error instanceof Error ? error.message : undefined,
          variant: "error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [max, date, isKickbox]);
  formSerializedRef.current = formSerialized;

  useEffect(() => {
    setCreateBaseline(null);
  }, [initialDate, date]);

  useEffect(() => {
    if (createBaseline !== null) return;
    if (defaultTimeLoading) return;
    setCreateBaseline(formSerialized);
  }, [createBaseline, defaultTimeLoading, fixedCoachId, formSerialized]);

  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveCreateRef.current) return;
      const baseline = createBaselineRef.current;
      if (baseline === null || formSerializedRef.current === baseline) return;
      e.preventDefault();
      promptDiscardChanges(
        t("sessionForm.unsavedTitle"),
        t("sessionForm.unsavedCreateBody"),
        { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
        () => {
          allowLeaveCreateRef.current = true;
          navigation.dispatch(e.data.action);
        }
      );
    });
  }, [navigation, t]);

  function confirmLeaveCreateThen(go: () => void) {
    const baseline = createBaselineRef.current;
    if (baseline === null || formSerializedRef.current === baseline) {
      allowLeaveCreateRef.current = true;
      go();
      return;
    }
    promptDiscardChanges(
      t("sessionForm.unsavedTitle"),
      t("sessionForm.unsavedCreateBody"),
      { cancel: t("common.cancel"), discard: t("sessionForm.discard") },
      () => {
        allowLeaveCreateRef.current = true;
        go();
      }
    );
  }

  useEffect(() => {
    if (initialDate?.trim()) setDate(initialDate.trim());
  }, [initialDate]);

  useEffect(() => {
    setDurationMinutes((cur) => normalizeSessionDurationString(cur));
    setMax((cur) => normalizeSessionMaxString(cur));
  }, []);

  useEffect(() => {
    if (!isValidISODateString(date)) {
      setDefaultTimeLoading(false);
      return;
    }
    let cancelled = false;
    setDefaultTimeLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("training_sessions")
        .select("start_time")
        .eq("session_date", date);
      if (cancelled) return;
      if (error) {
        setTime(DEFAULT_SESSION_START_TIME);
        return;
      }
      const startTimes = ((data as { start_time: string }[] | null) ?? []).map((r) => r.start_time);
      setTime(suggestNextSessionStartTime(startTimes));
    })().finally(() => {
      if (!cancelled) setDefaultTimeLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    if (fixedCoachId) {
      setCoachId(fixedCoachId);
      setCoachLabel(fixedCoachLabel ? `${fixedCoachLabel} — ${coachYouLabel}` : coachYouLabel);
    }
  }, [fixedCoachId, fixedCoachLabel, coachYouLabel]);

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

  function selectCoach(opt: CoachOption) {
    setCoachId(opt.user_id);
    setCoachLabel(`${opt.full_name} — ${opt.role}`);
    setCoachColor(opt.calendar_color ?? null);
    setShowCoachPicker(false);
  }

  const runTraineeSearch = useCallback(async (termRaw: string) => {
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
        .is("disabled_at", null)
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
  }, []);

  const traineeSearchRows = useMemo(() => {
    type Row =
      | { kind: "athlete"; key: string; full_name: string; meta: string; athlete: AthletePick }
      | { kind: "manual"; key: string; full_name: string; meta: string; manual: { id: string; full_name: string; phone: string } };
    const rows: Row[] = [
      ...manualResults.map((m) => ({
        kind: "manual" as const,
        key: m.id,
        full_name: m.full_name,
        meta: m.phone,
        manual: m,
      })),
      ...athleteResults.map((a) => ({
        kind: "athlete" as const,
        key: a.user_id,
        full_name: a.full_name,
        meta: athleteSearchSubtitle(a.phone),
        athlete: a,
      })),
    ];
    rows.sort((a, b) => a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" }));
    return rows;
  }, [athleteResults, manualResults]);

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
      const existing = await findExistingParticipantByNameOrPhone(name, phone);
      if (existing) {
        const add = await promptAddExistingParticipant(showAlert, t, existing);
        if (!add) return;
        if (existing.kind === "app") {
          addAthletePick({
            user_id: existing.id,
            full_name: existing.fullName,
            username: existing.username,
            phone: existing.phone,
          });
        } else {
          addManualPick({ id: existing.id, full_name: existing.fullName, phone: existing.phone });
        }
        setQuickName("");
        setQuickPhone("");
        return;
      }

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
      setError(t("sessionForm.invalidDate"));
      return;
    }
    if (!coachId) {
      setError(fixedCoachId ? t("sessionForm.accountResolveFailed") : t("sessionForm.chooseCoach"));
      return;
    }
    const parsedDuration = parseInt(durationMinutes.trim(), 10);
    const duration = clampSessionDuration(parsedDuration);
    if (!isValidSessionDuration(parsedDuration)) {
      setError(t("sessionForm.invalidDuration"));
      return;
    }
    const startT = time.trim() || "18:00";
    const parsedMax = parseInt(max.trim(), 10);
    const maxP = clampSessionMaxParticipants(parsedMax);
    if (!isValidSessionMaxParticipants(parsedMax)) {
      setError(language === "he" ? "בחרו גודל קבוצה בין 1 ל-15." : "Choose a group size between 1 and 15.");
      return;
    }
    const customParsed = parseCustomSlotPriceDraft(customSlotPriceDraft);
    if (!customParsed.ok) {
      setError(t("managerSession.customSlotPriceInvalid"));
      showToast({ message: t("common.error"), detail: t("managerSession.customSlotPriceInvalid"), variant: "error" });
      return;
    }

    const athleteIds = selectedAthletes.map((a) => a.user_id);
    const manualIds = selectedManual.map((m) => m.manual_participant_id);
    const useSeriesRpc = repeatWeekly;
    let count = 1;
    let insertedIds: string[] = [];
    let usedLegacyInsert = false;

    setSaving(true);

    if (useSeriesRpc) {
      let fixedWeeks = 4;
      if (!repeatOngoing) {
        const n = parseInt(weeklyOccurrences.trim(), 10);
        fixedWeeks = Number.isFinite(n) ? n : 4;
        if (fixedWeeks < 1) fixedWeeks = 1;
        if (fixedWeeks > 52) fixedWeeks = 52;
      }
      const seriesRes = await staffCreateSessionSeries({
        anchorDate: trimmedDate,
        startTime: startT,
        coachId,
        maxParticipants: maxP,
        durationMinutes: duration,
        isOpen: open,
        isHidden: hidden,
        isKickbox,
        customSlotPriceIls: customParsed.price,
        repeatMode: repeatOngoing ? "ongoing" : "fixed_weeks",
        fixedWeeks: repeatOngoing ? undefined : fixedWeeks,
        copyRoster: repeatCopyRoster,
        athleteIds,
        manualIds,
      });
      if (!seriesRes.ok && isMissingSessionSeriesRpc({ message: seriesRes.error })) {
        showToast({ message: t("common.error"), detail: t("session.seriesNeedsDb"), variant: "error" });
        setSaving(false);
        return;
      }
      if (!seriesRes.ok) {
        setError(seriesRes.error ?? t("common.error"));
        showToast({ message: t("common.error"), detail: seriesRes.error ?? "", variant: "error" });
        setSaving(false);
        return;
      }
      insertedIds = seriesRes.session_ids ?? [];
      count = seriesRes.count ?? insertedIds.length;
    } else {
      const rows = [
        {
          session_date: trimmedDate,
          start_time: startT,
          coach_id: coachId,
          max_participants: maxP,
          is_open_for_registration: open,
          is_hidden: hidden,
          is_kickbox: isKickbox,
          duration_minutes: duration,
          custom_slot_price_ils: customParsed.price,
        },
      ];
      let res = await supabase.from("training_sessions").insert(rows).select("id");
      let err = res.error;
      insertedIds = ((res.data as { id: string }[] | null) ?? []).map((r) => r.id);
      if (err && (isMissingColumnError(err.message, "is_hidden") || isMissingColumnError(err.message, "is_kickbox"))) {
        const rowsLegacy = rows.map(({ is_hidden: _h, is_kickbox: _k, custom_slot_price_ils: _p, ...rest }) => rest);
        const retry = await supabase.from("training_sessions").insert(rowsLegacy).select("id");
        err = retry.error;
        if (!err) usedLegacyInsert = true;
        insertedIds = ((retry.data as { id: string }[] | null) ?? []).map((r) => r.id);
      }
      if (err) {
        setSaving(false);
        setError(err.message);
        showToast({ message: t("common.error"), detail: err.message, variant: "error" });
        return;
      }

      if (customParsed.price != null && insertedIds.length > 0 && !rows[0].custom_slot_price_ils) {
        for (const sid of insertedIds) {
          const { data, error: priceErr } = await supabase.rpc("staff_set_session_custom_slot_price", {
            p_session_id: sid,
            p_price_ils: customParsed.price,
          });
          if (priceErr || !data?.ok) {
            showToast({
              message: language === "he" ? "האימון נשמר, אבל התעריף לא נשמר." : "Saved, but the session rate could not be saved.",
              variant: "info",
            });
            break;
          }
        }
      }

      const isBenignDuplicate = (code: string) => code === "already_registered" || code === "already_in_session";
      if (insertedIds.length > 0 && (athleteIds.length > 0 || manualIds.length > 0)) {
        for (const sid of insertedIds) {
          for (const uid of athleteIds) {
            const { data, error } = await supabase.rpc("coach_add_athlete", {
              p_session_id: sid,
              p_user_id: uid,
              p_allow_over_capacity: false,
            });
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
            const { data, error } = await supabase.rpc("add_manual_participant_to_session", {
              p_session_id: sid,
              p_manual_participant_id: mid,
              p_allow_over_capacity: false,
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
    }

    setSaving(false);

    const noteBody = note.trim();
    if (noteBody && insertedIds.length > 0) {
      const batch = await supabase.rpc("add_session_note_many", { p_session_ids: insertedIds, p_body: noteBody });
      if (batch.error) {
        const m = String(batch.error.message || "");
        if (m.includes("add_session_note_many")) {
          for (const sid of insertedIds) {
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

    if (usedLegacyInsert && hidden) {
      showToast({
        message: language === "he" ? "נשמר (אימונים גלויים)" : "Saved (visible sessions)",
        detail:
          language === "he"
            ? "חסרה בעמודה `is_hidden` בפרויקט (המיגרציה לא הופעלה)."
            : "Your project is missing the `is_hidden` column (migration not applied).",
        variant: "info",
      });
    } else if (useSeriesRpc && count > 0) {
      showToast({
        message: repeatOngoing
          ? t("session.seriesCreatedOngoing").replace("{n}", String(count))
          : t("session.seriesCreated").replace("{n}", String(count)),
        variant: "success",
      });
    } else if (count > 1) {
      showToast({
        message: language === "he" ? `נוצרו ${count} אימונים שבועיים.` : `Created ${count} weekly sessions.`,
        variant: "success",
      });
    } else {
      showToast({ message: t("common.saved"), variant: "success" });
    }
    allowLeaveCreateRef.current = true;
    router.back();
  }

  const sessionOptions = useMemo<SessionOptionItem[]>(
    () => [
      {
        key: "open",
        label: t("session.openRegistration"),
        value: open,
        onValueChange: setOpen,
        tone: "open",
      },
      {
        key: "hidden",
        label: t("session.hiddenStaffOnly"),
        value: hidden,
        onValueChange: setHidden,
        tone: "hidden",
      },
      {
        key: "kickbox",
        label: t("session.kickboxSession"),
        value: isKickbox,
        onValueChange: setIsKickbox,
        tone: "kickbox",
      },
      {
        key: "repeat",
        label: t("session.repeatWeekly"),
        value: repeatWeekly,
        onValueChange: setRepeatWeekly,
        tone: "repeat",
        expandedWhenOn: (
          <SessionSeriesOptionsExpand
            repeatOngoing={repeatOngoing}
            onRepeatOngoingChange={setRepeatOngoing}
            weeklyOccurrences={weeklyOccurrences}
            onWeeklyOccurrencesChange={setWeeklyOccurrences}
            repeatCopyRoster={repeatCopyRoster}
            onRepeatCopyRosterChange={setRepeatCopyRoster}
          />
        ),
      },
    ],
    [t, open, hidden, isKickbox, repeatWeekly, repeatOngoing, repeatCopyRoster, weeklyOccurrences, isRTL]
  );

  const traineeCount = selectedAthletes.length + selectedManual.length;

  return (
    <>
    <ScrollView contentContainerStyle={sf.content} style={sf.screen} keyboardShouldPersistTaps="handled">
      <View style={sf.sections}>
        <View style={sf.card}>
          <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("sessionForm.when")}</Text>
          <SessionWhenFields
            date={date}
            time={time}
            onDateChange={setDate}
            onTimeChange={setTime}
            dateLabel={t("sessionForm.sessionDate")}
            timeLabel={t("sessionForm.startTime")}
          />
        </View>

        <View style={sf.card}>
          <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("sessionForm.trainer")}</Text>
          {fixedCoachId ? (
            <View style={sf.formPanel}>
              <View style={styles.trainerRow}>
                <View style={styles.trainerLeading}>
                  {coachColor ? (
                    <View style={[styles.coachColorDot, { backgroundColor: coachColor }]} />
                  ) : null}
                  <Text style={[sf.controlText, styles.trainerName]} numberOfLines={2} ellipsizeMode="tail">
                    {coachLabel || coachYouLabel}
                  </Text>
                </View>
              </View>
            </View>
          ) : (
            <>
              <View style={sf.formPanel}>
                <Pressable
                  style={({ pressed }) => [styles.trainerRow, pressed && styles.trainerRowPressed]}
                  onPress={() => setShowCoachPicker(true)}
                  accessibilityRole="button"
                  accessibilityLabel={t("sessionForm.chooseTrainer")}
                >
                  <View style={styles.trainerLeading}>
                    {coachLabel && coachColor ? (
                      <View style={[styles.coachColorDot, { backgroundColor: coachColor }]} />
                    ) : null}
                    <Text
                      style={[coachLabel ? sf.controlText : sf.controlPlaceholder, styles.trainerName]}
                      numberOfLines={2}
                      ellipsizeMode="tail"
                    >
                      {coachLabel || t("sessionForm.chooseTrainer")}
                    </Text>
                  </View>
                  <Text style={styles.trainerChev}>{isRTL ? "‹" : "›"}</Text>
                </Pressable>
              </View>
              <CoachPickerSheet
                visible={showCoachPicker}
                onClose={() => setShowCoachPicker(false)}
                selectedCoachId={coachId}
                onSelect={(coach) =>
                  selectCoach({
                    user_id: coach.user_id,
                    full_name: coach.full_name,
                    role: coach.role,
                    username: coach.username,
                    calendar_color: coach.calendar_color,
                  })
                }
              />
            </>
          )}
        </View>

        <View style={sf.card}>
          <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("sessionForm.capacity")}</Text>
          <SessionCapacityFields
            duration={durationMinutes}
            max={max}
            onDurationChange={setDurationMinutes}
            onMaxChange={setMax}
            durationLabel={t("sessionForm.lengthMin")}
            maxLabel={t("sessionForm.maxParticipants")}
          />
        </View>

        <View style={sf.card}>
          <Text style={[sf.cardTitle, isRTL && styles.rtlText]}>{t("session.optionsTitle")}</Text>
          <View style={styles.optionsPanel}>
            <SessionOptionsSection embedded isRTL={isRTL} options={sessionOptions} />
          </View>
        </View>

        <SessionSlotRateField
          layout="form"
          value={customSlotPriceDraft}
          onChangeValue={setCustomSlotPriceDraft}
          tierPriceIls={tierSlotPriceIls}
          hasCustomOnServer={false}
        />

        <View style={sf.card}>
          <View style={[sf.sectionHeaderRow, isRTL && sf.sectionHeaderRowRtl]}>
            <Text style={[sf.cardTitle, styles.sectionTitleInline, isRTL && styles.rtlText]}>{t("sessionForm.trainees")}</Text>
            {traineeCount > 0 ? (
              <View style={sf.countBadge}>
                <Text style={sf.countBadgeTxt}>{traineeCount}</Text>
              </View>
            ) : null}
          </View>
          <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl]}>{t("sessionForm.traineesHint")}</Text>

          <Pressable
            style={({ pressed }) => [styles.traineeSelectBtn, pressed && styles.traineeSelectBtnPressed]}
            onPress={() => setTraineesOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t("sessionForm.selectTrainees")}
          >
            <Text style={styles.traineeSelectBtnTxt}>{t("sessionForm.selectTrainees")}</Text>
            <Text style={styles.traineeSelectChev}>{isRTL ? "‹" : "›"}</Text>
          </Pressable>

          {traineeCount > 0 ? (
            <View style={styles.selectedList}>
              {selectedAthletes.map((a) => (
                <View key={a.user_id} style={styles.selectedChip}>
                  <Text style={styles.selectedChipTxt} numberOfLines={1} ellipsizeMode="tail">
                    {a.full_name}
                  </Text>
                  <Pressable
                    onPress={() => removeAthletePick(a.user_id)}
                    style={styles.chipX}
                    accessibilityRole="button"
                    accessibilityLabel={t("common.remove")}
                  >
                    <Text style={styles.chipXTxt}>✕</Text>
                  </Pressable>
                </View>
              ))}
              {selectedManual.map((m) => (
                <View key={m.manual_participant_id} style={styles.selectedChip}>
                  <Text style={styles.selectedChipTxt} numberOfLines={1} ellipsizeMode="tail">
                    {m.full_name}
                  </Text>
                  <Pressable
                    onPress={() => removeManualPick(m.manual_participant_id)}
                    style={styles.chipX}
                    accessibilityRole="button"
                    accessibilityLabel={t("common.remove")}
                  >
                    <Text style={styles.chipXTxt}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        <View style={sf.card}>
          <CollapsiblePricingForm
            variant="inline"
            title={t("sessionForm.note")}
            expanded={noteOpen}
            onToggle={() => setNoteOpen((open) => !open)}
            summary={noteSummary}
            isRTL={isRTL}
          >
            <Text style={[sf.sectionHint, isRTL && sf.sectionHintRtl]}>{t("sessionForm.noteHint")}</Text>
            <TextInput
              style={[sf.control, styles.noteInput, isRTL && styles.rtlInput]}
              value={note}
              onChangeText={setNote}
              placeholder={t("sessionForm.notePlaceholder")}
              placeholderTextColor={theme.colors.textSoft}
              multiline
              textAlignVertical="top"
              accessibilityLabel={t("sessionForm.note")}
            />
          </CollapsiblePricingForm>
        </View>

        <View style={styles.footer}>
          {error ? (
            <Text style={[sf.error, isRTL && styles.rtlText]} accessibilityLiveRegion="polite">
              {appendNetworkHint(error, t("network.offlineHint"))}
            </Text>
          ) : null}
          <PrimaryButton
            label={t("sessionForm.saveSession")}
            onPress={save}
            loading={saving}
            loadingLabel={t("common.loading")}
          />
          <Pressable
            onPress={() => confirmLeaveCreateThen(() => router.back())}
            style={({ pressed }) => [styles.secondaryAction, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={t("common.cancel")}
          >
            <Text style={styles.secondaryActionTxt}>{t("common.cancel")}</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>

      <AppSearchSheet
        visible={traineesOpen}
        onClose={() => {
          setTraineesOpen(false);
          setTraineesQ("");
        }}
        title={t("sessionForm.trainees")}
        dismissLabel={t("common.ok")}
        isRTL={isRTL}
        backdropAccessibilityLabel={t("common.cancel")}
        headerExtra={
          <ParticipantQuickAddPanel
            name={quickName}
            phone={quickPhone}
            onNameChange={setQuickName}
            onPhoneChange={setQuickPhone}
            onSubmit={() => void quickAddManual()}
            busy={traineesBusy}
          />
        }
        searchLabel={t("sessionForm.searchTrainees")}
        searchConfig={{
          value: traineesQ,
          onChangeText: setTraineesQ,
          onSearch: (term) => void runTraineeSearch(term),
          placeholder: t("sessionForm.searchTrainees"),
          loading: traineesSearching,
          accessibilityLabel: t("sessionForm.searchTrainees"),
        }}
        results={
          <ScrollView
            style={styles.traineeResultsScroll}
            contentContainerStyle={styles.traineeResultsContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator
          >
            {traineeSearchRows.length === 0 ? (
              <Text style={styles.pickerEmpty}>{t("sessionForm.noResults")}</Text>
            ) : (
              traineeSearchRows.map((row) => {
                const already =
                  row.kind === "athlete"
                    ? selectedAthletes.some((x) => x.user_id === row.athlete.user_id)
                    : selectedManual.some((x) => x.manual_participant_id === row.manual.id);
                return (
                  <Pressable
                    key={row.key}
                    style={({ pressed }) => [
                      styles.pickerRowSlim,
                      pressed && { opacity: 0.9 },
                      already && { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.cta },
                    ]}
                    onPress={() => {
                      if (row.kind === "athlete") {
                        if (already) removeAthletePick(row.athlete.user_id);
                        else addAthletePick(row.athlete);
                      } else {
                        if (already) removeManualPick(row.manual.id);
                        else addManualPick(row.manual);
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: already }}
                  >
                    <Text style={styles.pickerRowName} numberOfLines={1} ellipsizeMode="tail">
                      {row.full_name}
                    </Text>
                    <Text style={styles.pickerRowMeta} numberOfLines={1} ellipsizeMode="tail">
                      {row.meta}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        }
      />

    {discardDialog}
    </>
  );
}

const styles = StyleSheet.create({
  rtlText: { textAlign: "right" },
  rtlInput: { textAlign: "right" },
  sectionTitleInline: { marginBottom: 0, flex: 1 },
  trainerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 52,
  },
  trainerRowPressed: { opacity: 0.9 },
  trainerLeading: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, minWidth: 0 },
  trainerName: { flex: 1 },
  trainerChev: { fontSize: 20, fontWeight: "300", color: theme.colors.textSoft, lineHeight: 22 },
  optionsPanel: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  traineeSelectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    minHeight: 48,
  },
  traineeSelectBtnPressed: { opacity: 0.9 },
  traineeSelectBtnTxt: { flex: 1, fontSize: 15, fontWeight: "800", color: theme.colors.text },
  traineeSelectChev: { fontSize: 20, fontWeight: "300", color: theme.colors.textSoft },
  footer: { gap: theme.spacing.sm, paddingTop: theme.spacing.xs },
  coachColorDot: {
    width: 10,
    height: 10,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  pickerItemLeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    flex: 1,
    minWidth: 0,
  },
  sectionSpacer: { height: theme.spacing.sm },
  traineeResultsScroll: { flex: 1 },
  traineeResultsContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
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
  modalHeaderRtl: { flexDirection: "row-reverse" },
  modalTitle: { fontSize: 17, fontWeight: "800", letterSpacing: 0.2, color: theme.colors.text },
  modalClose: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "800" },
  modalLoader: { paddingVertical: theme.spacing.xl },
  pickerItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: theme.colors.borderMuted },
  pickerItemTextCol: { flex: 1 },
  pickerItemName: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  pickerItemRole: {
    fontSize: 13,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
    textTransform: "none",
    fontWeight: "700",
  },
  pickerEmpty: { padding: theme.spacing.lg, color: theme.colors.textSoft, textAlign: "center", fontWeight: "700" },
  secondaryAction: { paddingVertical: theme.spacing.sm, alignItems: "center", minHeight: 44, justifyContent: "center" },
  secondaryActionTxt: { color: theme.colors.textMuted, fontWeight: "800" },
  noteInput: { minHeight: 110, paddingVertical: theme.spacing.sm },

  selectedList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  selectedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    maxWidth: "100%",
  },
  selectedChipTxt: { color: theme.colors.text, fontWeight: "800", flexShrink: 1 },
  chipX: { width: 26, height: 26, borderRadius: theme.radius.full, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.borderMuted, alignItems: "center", justifyContent: "center" },
  chipXTxt: { color: theme.colors.textMuted, fontWeight: "900", fontSize: 12, lineHeight: 14 },

  traineeSearchRow: { flexDirection: "row", gap: theme.spacing.sm, alignItems: "center" },
  traineeSearchRowRtl: { flexDirection: "row-reverse" },
  traineeSearchInput: { flex: 1 },
  traineeSearchBtn: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.cta,
    borderRadius: theme.radius.md,
  },
  traineeSearchBtnTxt: { color: theme.colors.ctaText, fontWeight: "800", letterSpacing: 0.2 },

  modalSubTitle: {
    marginTop: theme.spacing.xs,
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.3,
    fontSize: 12,
    textTransform: "uppercase",
  },
  modalSubTitleSpacing: { marginTop: theme.spacing.md },

  traineeList: { marginTop: theme.spacing.sm },
  pickerRowSlim: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    marginBottom: theme.spacing.sm,
  },
  pickerRowName: { fontWeight: "800", color: theme.colors.text },
  pickerRowMeta: { marginTop: 2, color: theme.colors.textMuted, fontWeight: "700", fontSize: 12 },

  quickAddRow: { gap: theme.spacing.sm },
  quickAddInput: {
    ...sf.control,
    ...sf.controlInput,
    marginBottom: theme.spacing.sm,
  },
});
