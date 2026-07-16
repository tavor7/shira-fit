import { View, Text, Pressable, ActivityIndicator, Platform } from "react-native";
import { theme } from "../theme";
import { PressableScale } from "./PressableScale";
import { AttStatusDot } from "./AttStatusDot";
import { attStatusFromRow, attStatusLabel } from "../lib/participantHistoryHelpers";
import { isSessionPaymentRecorded, paymentMethodHistoryLabel } from "../lib/paymentMethod";
import { firstWordOfDisplayName } from "../lib/displayName";
import { resolveSessionBillingPriceLocal } from "../lib/sessionSlotPrice";
import { formatISODateFullWithWeekdayAfter } from "../lib/dateFormat";
import { formatSessionStartTime } from "../lib/sessionTime";
import type { AthleteFamily } from "../lib/athleteFamilies";
import type { PricingRateTierRow } from "../lib/pricingRates";
import type { ParticipantHistoryRow } from "../types/database";
import type { LanguageCode } from "../i18n/translations";
import { participantHistoryStyles as styles } from "../screens/participantHistoryStyles";

type Props = {
  reg: ParticipantHistoryRow;
  isRTL: boolean;
  rtlRowFlip: boolean;
  language: LanguageCode;
  t: (key: string) => string;
  familyContext: AthleteFamily | null;
  isManagerHistory: boolean;
  isCoachHistory: boolean;
  memberKeyForRow: (reg: ParticipantHistoryRow) => string | null;
  athleteTiersByMember: Record<string, PricingRateTierRow[]>;
  athleteTiers: PricingRateTierRow[];
  globalTiers: PricingRateTierRow[];
  globalKickboxTiers: PricingRateTierRow[];
  sessionCustomPriceById: Record<string, number | null>;
  sessionKickboxById: Record<string, boolean>;
  sessionCoachById: Record<string, string>;
  expandedAttendanceId: string | null;
  attendanceBusyId: string | null;
  removingRegId: string | null;
  policyBusyId: string | null;
  openSession: (sessionId: string) => void;
  applyAttendance: (reg: ParticipantHistoryRow, status: "unset" | "arrived" | "absent") => Promise<void>;
  setExpandedAttendanceId: (updater: (cur: string | null) => string | null) => void;
  openEditAmount: (reg: ParticipantHistoryRow) => void;
  confirmRemoveRegistration: (reg: ParticipantHistoryRow) => void;
  applyNoShowCharge: (reg: ParticipantHistoryRow, charge: boolean) => Promise<void>;
  applyLateCancellationCharge: (cancellationId: string, charge: boolean) => Promise<void>;
};

export function SessionHistoryRow({
  reg,
  isRTL,
  rtlRowFlip,
  language,
  t,
  familyContext,
  isManagerHistory,
  isCoachHistory,
  memberKeyForRow,
  athleteTiersByMember,
  athleteTiers,
  globalTiers,
  globalKickboxTiers,
  sessionCustomPriceById,
  sessionKickboxById,
  sessionCoachById,
  expandedAttendanceId,
  attendanceBusyId,
  removingRegId,
  policyBusyId,
  openSession,
  applyAttendance,
  setExpandedAttendanceId,
  openEditAmount,
  confirmRemoveRegistration,
  applyNoShowCharge,
  applyLateCancellationCharge,
}: Props) {
  const hasPaymentMethod = isSessionPaymentRecorded(reg.payment_method);
  const amtRaw = reg.amount_paid;
  const amt =
    amtRaw !== null && amtRaw !== undefined && String(amtRaw).trim() !== ""
      ? Number(amtRaw)
      : null;
  const amtOk = amt !== null && Number.isFinite(amt);
  const recorder = (reg.payment_recorded_by_name ?? "").trim();
  const chargeNoShow = reg.charge_no_show === true;
  const showPaymentBlock =
    reg.reg_status === "active" &&
    (reg.attended === true || (reg.attended === false && chargeNoShow));
  const reporterLine = recorder
    ? t("participantHistory.reportedBy").replace("{name}", firstWordOfDisplayName(recorder))
    : t("participantHistory.reportedByUnknown");
  const reason = (reg.cancellation_reason ?? "").trim();
  const raw12 = reg.cancellation_within_12h;
  const within12 =
    raw12 === true || (raw12 == null && reg.cancellation_within_24h === true);
  const within12ExplicitFalse =
    raw12 === false || (raw12 == null && reg.cancellation_within_24h === false);
  const late =
    within12
      ? language === "he"
        ? "ביטול בתוך 12 ש׳ לפני האימון"
        : "Cancelled within 12h of session start"
      : within12ExplicitFalse
        ? language === "he"
          ? "ביטול מעל 12 ש׳ מראש"
          : "Cancelled more than 12h before session"
        : null;
  const feeCharged = reg.cancellation_charged === true;
  const staffCanEdit = isManagerHistory || isCoachHistory;
  const sessionPrice =
    typeof reg.max_participants === "number" && reg.max_participants > 0
      ? (() => {
          const mk = memberKeyForRow(reg);
          const rowTiers =
            mk && athleteTiersByMember[mk] && athleteTiersByMember[mk]!.length > 0
              ? athleteTiersByMember[mk]!
              : athleteTiers;
          return resolveSessionBillingPriceLocal({
            customSlotPriceIls: sessionCustomPriceById[reg.session_id],
            maxParticipants: reg.max_participants,
            isKickbox: sessionKickboxById[reg.session_id] ?? false,
            sessionDate: reg.session_date,
            athleteTiers: rowTiers,
            globalTiers,
            globalKickboxTiers,
          });
        })()
      : null;
  const metaLine =
    typeof reg.max_participants === "number" && reg.max_participants > 0
      ? sessionPrice != null
        ? t("participantHistory.sessionMeta").replace("{spots}", String(reg.max_participants)).replace("{price}", String(sessionPrice))
        : t("participantHistory.sessionMetaSpotsOnly").replace("{spots}", String(reg.max_participants))
      : null;
  const coachName = firstWordOfDisplayName(sessionCoachById[reg.session_id] ?? "");
  const attCurrent = attStatusFromRow(reg);
  const attOpen = expandedAttendanceId === reg.registration_id;
  const attLabel = attStatusLabel(attCurrent, t);
  const showPaidStatus = showPaymentBlock && hasPaymentMethod;
  const showUnpaidStatus = showPaymentBlock && !hasPaymentMethod;
  const timeCoachPart = coachName
    ? `${formatSessionStartTime(reg.start_time)} · ${coachName}`
    : formatSessionStartTime(reg.start_time);
  const statusBlock =
    reg.reg_status === "cancelled" ? (
      <View style={[styles.payPill, styles.payPillMuted]}>
        <Text style={[styles.payPillTxt, styles.payPillTxtMuted, isRTL && styles.rtlText]}>
          {language === "he" ? "בוטל" : "Cancelled"}
        </Text>
      </View>
    ) : showPaidStatus || showUnpaidStatus ? (
      <View
        style={[
          styles.payPill,
          showPaidStatus ? styles.payPillPaid : styles.payPillUnpaid,
          isRTL && styles.payPillRtl,
        ]}
      >
        <Text
          style={[
            styles.payPillTxt,
            showPaidStatus ? styles.payPillTxtPaid : styles.payPillTxtUnpaid,
            isRTL && styles.rtlText,
          ]}
          numberOfLines={1}
        >
          {showPaidStatus ? t("participantHistory.paidBadge") : t("participantHistory.unpaidBadge")}
        </Text>
        {showPaidStatus && amtOk ? (
          <Text style={[styles.payPillAmt, styles.ltrText]} numberOfLines={1}>
            {amt} ₪
          </Text>
        ) : null}
      </View>
    ) : reg.reg_status === "active" && !staffCanEdit ? (
      <View style={[styles.payPill, styles.payPillMuted, isRTL && styles.payPillRtl]}>
        <AttStatusDot status={attCurrent} />
        <Text style={[styles.payPillTxt, styles.payPillTxtMuted, isRTL && styles.rtlText]} numberOfLines={1}>
          {attLabel}
        </Text>
      </View>
    ) : null;
  const sessionCardInner = (
    <>
        {isRTL ? (
          <View style={[styles.sessionHeadRow, rtlRowFlip && styles.sessionHeadRowRtl]}>
            <View style={[styles.sessionHeadMain, styles.sessionHeadMainRtl]}>
              <Text style={[styles.cardDatePrimary, styles.sessionHeadTextHe]} numberOfLines={2}>
                {formatISODateFullWithWeekdayAfter(reg.session_date, language)}
              </Text>
              <Text style={[styles.cardDateMeta, styles.sessionHeadTextHe, styles.sessionHeadTimeHe]} numberOfLines={1}>
                {timeCoachPart}
              </Text>
              {familyContext ? (
                <Text style={[styles.sessionSubline, styles.sessionMemberName, styles.sessionHeadTextHe]} numberOfLines={1}>
                  {t("families.assignedTo").replace(
                    "{name}",
                    reg.athlete_name?.trim() || "—"
                  )}
                </Text>
              ) : null}
            </View>
            {metaLine || statusBlock ? (
              <View style={styles.sessionHeadAsideHe}>
                {metaLine ? (
                  <Text style={[styles.sessionMetaAsideHe, styles.rtlText]} numberOfLines={2}>
                    {metaLine}
                  </Text>
                ) : null}
                {statusBlock}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.sessionHeadRow}>
            <View style={styles.sessionHeadMain}>
              <Text style={styles.cardDatePrimary} numberOfLines={2}>
                {formatISODateFullWithWeekdayAfter(reg.session_date, language)}
              </Text>
              <Text style={[styles.cardDateMeta, styles.ltrText]} numberOfLines={1}>
                {timeCoachPart}
              </Text>
              {familyContext ? (
                <Text style={[styles.sessionSubline, styles.sessionMemberName]} numberOfLines={1}>
                  {t("families.assignedTo").replace(
                    "{name}",
                    reg.athlete_name?.trim() || "—"
                  )}
                </Text>
              ) : null}
            </View>
            {metaLine || statusBlock ? (
              <View style={styles.sessionHeadAside}>
                {metaLine ? (
                  <Text style={styles.sessionMetaAside} numberOfLines={2}>
                    {metaLine}
                  </Text>
                ) : null}
                {statusBlock}
              </View>
            ) : null}
          </View>
        )}
        {showPaymentBlock && hasPaymentMethod ? (
          <View style={styles.sessionFootnoteRow}>
            <Text style={[styles.sessionFootnote, isRTL && styles.rtlText]} numberOfLines={2}>
              {[paymentMethodHistoryLabel(reg.payment_method, language), reporterLine].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ) : null}
    </>
  );

  return (
    <View style={styles.row}>
      {staffCanEdit ? (
        <PressableScale
          onPress={() => openSession(reg.session_id)}
          scaleTo={0.985}
          style={({ pressed }) => [
            styles.sessionCardBody,
            isRTL && styles.sessionCardBodyRtl,
            pressed && styles.sessionCardBodyPressed,
            Platform.OS === "web" && styles.sessionCardBodyWeb,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${formatISODateFullWithWeekdayAfter(reg.session_date, language)} · ${timeCoachPart}`}
        >
          {sessionCardInner}
        </PressableScale>
      ) : (
        <View style={[styles.sessionCardBody, isRTL && styles.sessionCardBodyRtl]}>{sessionCardInner}</View>
      )}

      {reg.reg_status === "active" && staffCanEdit ? (
        <>
          {attOpen && attendanceBusyId !== `att:${reg.registration_id}` ? (
            <View style={[styles.attPicker, rtlRowFlip && styles.attPickerRtl]}>
              {(["unset", "arrived", "absent"] as const).map((status) => {
                const on = attCurrent === status;
                return (
                  <Pressable
                    key={status}
                    onPress={() => void applyAttendance(reg, status)}
                    style={({ pressed }) => [
                      styles.attPickerOpt,
                      on && styles.attPickerOptOn,
                      pressed && { opacity: 0.9 },
                    ]}
                  >
                    <AttStatusDot status={status} />
                    <Text style={[styles.attPickerTxt, on && styles.attPickerTxtOn, isRTL && styles.rtlText]}>
                      {attStatusLabel(status, t)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <View style={[styles.actionBar, rtlRowFlip && styles.actionBarRtl]}>
            <Pressable
              onPress={() =>
                setExpandedAttendanceId((cur) =>
                  cur === reg.registration_id ? null : reg.registration_id
                )
              }
              disabled={attendanceBusyId === `att:${reg.registration_id}`}
              style={({ pressed }) => [
                styles.actionBarItem,
                styles.actionBarItemWide,
                pressed && { opacity: 0.9 },
              ]}
              accessibilityRole="button"
              accessibilityState={{ expanded: attOpen }}
            >
              {attendanceBusyId === `att:${reg.registration_id}` ? (
                <ActivityIndicator size="small" color={theme.colors.text} />
              ) : (
                <>
                  <AttStatusDot status={attCurrent} />
                  <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]} numberOfLines={1}>
                    {attLabel}
                  </Text>
                  <Text style={styles.actionBarChevron}>{attOpen ? "▴" : "▾"}</Text>
                </>
              )}
            </Pressable>
            {reg.attended === true ? (
              <>
                <View style={styles.actionBarSep} />
                <Pressable
                  onPress={() => openEditAmount(reg)}
                  style={({ pressed }) => [styles.actionBarItem, pressed && styles.actionBarItemPressed]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.actionBarLabel, isRTL && styles.rtlText]}>
                    {hasPaymentMethod
                      ? t("participantHistory.editShort")
                      : t("participantHistory.payShort")}
                  </Text>
                </Pressable>
              </>
            ) : null}
            <View style={styles.actionBarSep} />
            <Pressable
              onPress={() => confirmRemoveRegistration(reg)}
              disabled={removingRegId === reg.registration_id}
              style={({ pressed }) => [
                styles.actionBarItem,
                styles.actionBarItemDanger,
                pressed && removingRegId !== reg.registration_id && styles.actionBarItemPressed,
              ]}
              accessibilityRole="button"
            >
              {removingRegId === reg.registration_id ? (
                <ActivityIndicator size="small" color={theme.colors.error} />
              ) : (
                <Text style={[styles.actionBarLabelDanger, isRTL && styles.rtlText]}>
                  {t("participantHistory.removeShort")}
                </Text>
              )}
            </Pressable>
          </View>
        </>
      ) : null}

      {reg.reg_status === "active" && reg.attended === false && staffCanEdit ? (
        <View style={styles.cardInset}>
          <Text style={[styles.cardInsetLabel, isRTL && styles.rtlText]}>
            {t("participantHistory.noShowChargeHeading")}
          </Text>
          {policyBusyId === `ns:${reg.registration_id}` ? (
            <ActivityIndicator color={theme.colors.cta} style={styles.cardSpinner} />
          ) : (
            <View style={[styles.actionBar, styles.actionBarInset, rtlRowFlip && styles.actionBarRtl]}>
              <Pressable
                onPress={() => void applyNoShowCharge(reg, false)}
                style={({ pressed }) => [
                  styles.actionBarItem,
                  !chargeNoShow && styles.actionBarItemActive,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text style={[styles.actionBarLabel, !chargeNoShow && styles.actionBarLabelActive, isRTL && styles.rtlText]}>
                  {t("managerSession.cancelChargeWaive")}
                </Text>
              </Pressable>
              <View style={styles.actionBarSep} />
              <Pressable
                onPress={() => void applyNoShowCharge(reg, true)}
                style={({ pressed }) => [
                  styles.actionBarItem,
                  chargeNoShow && styles.actionBarItemActive,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text style={[styles.actionBarLabel, chargeNoShow && styles.actionBarLabelActive, isRTL && styles.rtlText]}>
                  {t("managerSession.cancelChargeApply")}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {reg.reg_status === "cancelled" ? (
        <View style={styles.cardSubsection}>
          {reason.length > 0 ? (
            <Text style={[styles.cardNote, isRTL && styles.rtlText]}>
              {language === "he" ? "סיבה: " : "Reason: "}
              {reason}
            </Text>
          ) : null}
          {late ? (
            <View style={[styles.badge, within12 ? styles.badgeLate : styles.badgeLateOk, styles.badgeInline]}>
              <Text style={[styles.badgeTxt, within12 ? styles.badgeLateTxt : styles.badgeLateOkTxt]}>{late}</Text>
            </View>
          ) : null}
          {within12 && isManagerHistory && reg.cancellation_id ? (
            policyBusyId === `lc:${reg.cancellation_id}` ? (
              <ActivityIndicator color={theme.colors.cta} style={styles.cardSpinner} />
            ) : (
              <View style={[styles.policySeg, rtlRowFlip && styles.policySegRtl, styles.lateFeeSegMargin]}>
                <Pressable
                  onPress={() => void applyLateCancellationCharge(String(reg.cancellation_id), false)}
                  style={({ pressed }) => [
                    styles.policyBtn,
                    !feeCharged && styles.policyBtnOn,
                    pressed && { opacity: 0.88 },
                  ]}
                >
                  <Text style={[styles.policyBtnTxt, !feeCharged && styles.policyBtnTxtOn]}>
                    {t("managerSession.cancelChargeWaive")}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void applyLateCancellationCharge(String(reg.cancellation_id), true)}
                  style={({ pressed }) => [
                    styles.policyBtn,
                    feeCharged && styles.policyBtnOn,
                    pressed && { opacity: 0.88 },
                  ]}
                >
                  <Text style={[styles.policyBtnTxt, feeCharged && styles.policyBtnTxtOn]}>
                    {t("managerSession.cancelChargeApply")}
                  </Text>
                </Pressable>
              </View>
            )
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
