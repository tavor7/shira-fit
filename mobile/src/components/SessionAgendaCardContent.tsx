import { View, Text, StyleSheet } from "react-native";
import { theme } from "../theme";
import type { SessionsWeekItem } from "./SessionsWeekCalendar";
import { useI18n } from "../context/I18nContext";
import { StatusChip } from "./StatusChip";
import { KickboxSessionBadge } from "./KickboxSessionBadge";
import { SessionSeriesIndicator } from "./SessionSeriesIndicator";
import { type SessionTemporalPhase, formatSessionStartTime, getSessionTemporalPhase } from "../lib/sessionTime";
import { firstWordOfDisplayName } from "../lib/displayName";

type Props = {
  item: SessionsWeekItem;
  /** Narrow column (week grid); slightly smaller type */
  compact?: boolean;
  /** From parent when already computed (week grid); otherwise derived from session times. */
  temporalPhase?: SessionTemporalPhase;
};

export function SessionAgendaCardContent({ item, compact, temporalPhase: temporalPhaseProp }: Props) {
  const { language, isRTL, t } = useI18n();
  const temporalPhase =
    temporalPhaseProp ?? getSessionTemporalPhase(item.session_date, item.start_time, item.durationMinutes ?? 60);
  const accent = item.accentColor;
  const showFill = item.signedUpCount !== undefined && item.maxParticipants !== undefined;
  const staffLabels = item.showStaffSessionLabels === true;
  const showRegState = item.hideRegistrationState !== true;
  const showTemporalPills = item.hideTemporalDimming !== true;
  const c = item.signedUpCount ?? 0;
  const m = item.maxParticipants ?? 0;
  const full = showFill && m > 0 && c >= m;
  const left = showFill && m > 0 ? Math.max(0, m - c) : null;
  const regOpen = item.isOpenForRegistration !== false;
  const waitlistInvite = typeof item.onJoinWaitlist === "function";
  const onWaitlist = item.athleteOnWaitlist === true;
  const registered = item.athleteRegistered === true;
  const showRegistered = registered && temporalPhase !== "past";

  const timeStyle =
    temporalPhase === "past"
      ? [styles.time, compact && styles.timeCompact, styles.timePast]
      : temporalPhase === "live"
        ? [styles.time, compact && styles.timeCompact, styles.timeLive]
        : [styles.time, compact && styles.timeCompact];

  const leftAccentWidth = showRegistered ? 4 : 3;

  return (
    <View
      style={[
        styles.inner,
        accent ? { borderLeftWidth: leftAccentWidth, borderLeftColor: accent, paddingLeft: 8 } : null,
      ]}
    >
      <View style={styles.timeRow}>
        <View style={styles.timeRowLeft}>
          <Text style={timeStyle}>{formatSessionStartTime(item.start_time)}</Text>
          {showTemporalPills ? (
            temporalPhase === "live" ? (
              <View style={styles.livePill}>
                <Text style={styles.livePillTxt}>{language === "he" ? "עכשיו" : "Live"}</Text>
              </View>
            ) : temporalPhase === "past" ? (
              <View style={styles.endedPill}>
                <Text style={styles.endedPillTxt}>{language === "he" ? "הסתיים" : "Ended"}</Text>
              </View>
            ) : null
          ) : null}
          {item.timeBadgeText ? (
            <View style={[styles.timeBadge, compact && styles.timeBadgeCompact]}>
              <Text style={[styles.timeBadgeTxt, compact && styles.timeBadgeTxtCompact]}>{item.timeBadgeText}</Text>
            </View>
          ) : null}
          {item.timeBadgeText2 ? (
            <View style={[styles.timeBadge, compact && styles.timeBadgeCompact]}>
              <Text style={[styles.timeBadgeTxt, compact && styles.timeBadgeTxtCompact]}>{item.timeBadgeText2}</Text>
            </View>
          ) : null}
          {item.isKickbox ? <KickboxSessionBadge compact isRTL={isRTL} /> : null}
        </View>

        {item.isRecurringSeries ? (
          <View style={styles.repeatBadgePin}>
            <SessionSeriesIndicator compact />
          </View>
        ) : null}
      </View>
      {item.trainerName ? (
        <Text style={[styles.trainer, compact && styles.trainerCompact, showRegistered && styles.trainerRegistered]} numberOfLines={1}>
          {firstWordOfDisplayName(item.trainerName)}
        </Text>
      ) : null}
      {showRegistered ? (
        <View
          style={[styles.registeredBanner, compact && styles.registeredBannerCompact, isRTL && styles.registeredBannerRtl]}
          accessibilityLabel={t("athleteCalendar.registeredStatus")}
          accessibilityRole="text"
        >
          {compact ? (
            <>
              <Text style={styles.registeredBannerCheck}>✓</Text>
              <Text style={[styles.registeredBannerTxtStacked, isRTL && styles.registeredBannerTxtRtl]}>
                {t("athleteCalendar.registeredCompact")}
              </Text>
            </>
          ) : (
            <Text style={styles.registeredBannerTxt}>
              ✓ {t("athleteCalendar.registeredStatus")}
            </Text>
          )}
        </View>
      ) : null}
      {showRegState && showFill && !staffLabels && temporalPhase !== "past" && !showRegistered && !(full && waitlistInvite) ? (
        <View style={[styles.chips, isRTL && styles.chipsRtl]}>
          {full && onWaitlist ? (
            <StatusChip
              label={compact ? t("athleteCalendar.onWaitlistCompact") : t("athleteCalendar.onWaitlistStatus")}
              tone="success"
            />
          ) : full ? (
            <StatusChip label={language === "he" ? "מלא" : "Full"} tone="danger" />
          ) : !regOpen ? (
            <StatusChip label={language === "he" ? "סגור" : "Closed"} tone="neutral" />
          ) : (
            <>
              <StatusChip label={language === "he" ? "פתוח" : "Open"} tone="success" />
              {left !== null ? (
                <StatusChip label={language === "he" ? `${left} מקומות` : `${left} left`} tone="neutral" />
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {showFill && !staffLabels && !registered ? (
        <Text style={[styles.fill, compact && styles.fillCompact]}>
          {c} / {m}
        </Text>
      ) : null}
      {showFill && staffLabels ? (
        <View style={styles.fillRow}>
          <Text style={[styles.fillInlineText, compact && styles.fillInlineTextCompact]}>{item.signedUpCount}/{item.maxParticipants}</Text>
          {(item.waitlistCount ?? 0) > 0 ? (
            <Text style={[styles.waitInlineText, compact && styles.waitInlineTextCompact]}>({String(item.waitlistCount)})</Text>
          ) : null}
        </View>
      ) : null}
      {showRegState && staffLabels && temporalPhase !== "past" ? (
        <View
          style={[
            styles.stateBar,
            item.isOpenForRegistration ? styles.stateBarOpen : styles.stateBarClosed,
          ]}
        />
      ) : !staffLabels && item.subtitle ? (
        item.subtitleUnclamped ? (
          <Text style={[styles.subtitle, compact && styles.subtitleCompact]}>{item.subtitle}</Text>
        ) : (
          <Text style={[styles.subtitle, compact && styles.subtitleCompact]} numberOfLines={2}>
            {item.subtitle}
          </Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inner: { paddingVertical: 2 },
  timeRow: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    paddingEnd: 26, // reserve space for pinned repeat badge
  },
  timeRowLeft: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0, flexWrap: "wrap" },
  repeatBadgePin: {
    position: "absolute",
    top: 0,
    end: 0,
  },
  registeredBanner: {
    marginTop: 6,
    alignSelf: "stretch",
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.cta,
  },
  registeredBannerCompact: {
    marginTop: 5,
    paddingVertical: 5,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  registeredBannerRtl: { alignSelf: "stretch" },
  registeredBannerCheck: {
    color: theme.colors.ctaText,
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 14,
  },
  registeredBannerTxtStacked: {
    color: theme.colors.ctaText,
    fontSize: 9,
    fontWeight: "900",
    lineHeight: 11,
    textAlign: "center",
    marginTop: 1,
  },
  registeredBannerTxtRtl: { writingDirection: "rtl" },
  registeredBannerTxt: {
    color: theme.colors.ctaText,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.2,
    textAlign: "center",
  },
  time: { fontWeight: "800", color: theme.colors.cta, fontSize: 15, letterSpacing: 0.2, lineHeight: 18 },
  timeCompact: { fontSize: 14, lineHeight: 17 },
  timePast: { color: theme.colors.textSoft, fontWeight: "600" },
  timeLive: { color: theme.colors.success, fontWeight: "900" },
  livePill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  livePillTxt: { color: theme.colors.success, fontSize: 9, fontWeight: "900", letterSpacing: 0.4 },
  endedPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  endedPillTxt: { color: theme.colors.textSoft, fontSize: 9, fontWeight: "800" },
  timeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  timeBadgeCompact: { paddingHorizontal: 7, paddingVertical: 2 },
  timeBadgeTxt: { color: theme.colors.textMuted, fontWeight: "900", fontSize: 11, letterSpacing: 0.2 },
  timeBadgeTxtCompact: { fontSize: 10 },
  trainer: { marginTop: 4, color: theme.colors.text, fontSize: 12, fontWeight: "600", lineHeight: 15 },
  trainerCompact: { fontSize: 11, marginTop: 3 },
  trainerRegistered: { color: theme.colors.cta, fontWeight: "800" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  chipsRtl: { flexDirection: "row-reverse" },
  fillRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "nowrap" },
  fill: { marginTop: 6, fontSize: 12, fontWeight: "700", color: theme.colors.textMuted, letterSpacing: 0.5 },
  fillInline: { marginTop: 0, flexShrink: 1 },
  fillCompact: { marginTop: 4, fontSize: 11 },
  fillInlineText: { color: theme.colors.textMuted, fontWeight: "900", fontSize: 12, letterSpacing: 0.2 },
  fillInlineTextCompact: { fontSize: 11 },
  waitInlineText: { color: "#A5B4FC", fontWeight: "900", fontSize: 12, letterSpacing: 0.2 },
  waitInlineTextCompact: { fontSize: 11 },
  subtitle: { marginTop: 4, color: theme.colors.textMuted, fontSize: 11, lineHeight: 14 },
  subtitleCompact: { fontSize: 10, marginTop: 3 },
  stateBar: {
    marginTop: 8,
    height: 3,
    borderRadius: 2,
    alignSelf: "stretch",
  },
  stateBarOpen: { backgroundColor: "rgba(34,197,94,0.65)" },
  stateBarClosed: { backgroundColor: "rgba(148,163,184,0.55)" },
});
