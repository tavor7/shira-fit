import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { router } from "expo-router";
import { theme } from "../theme";
import type { HomePriorityAlertItem, HomePriorityLabelSegment } from "../lib/homePriorityAlerts";
import { dismissHomeAlert, filterUndismissedAlerts, loadDismissedHomeAlertIds } from "../lib/dismissedHomeAlerts";
import { useI18n } from "../context/I18nContext";

type Props = {
  items: HomePriorityAlertItem[];
  maxVisible?: number;
  /** Store dismissals per auth user (SecureStore / localStorage on web). */
  dismissStorageUserId?: string | null;
  /** Fires when visible count changes after load/dismiss (optional layout for parents). */
  onVisibleCountChange?: (visibleCount: number) => void;
};

const wrapBase: ViewStyle = {
  marginBottom: theme.spacing.sm,
  borderLeftWidth: 4,
  borderLeftColor: theme.colors.cta,
  backgroundColor: theme.colors.surface,
  borderRadius: theme.radius.md,
  borderWidth: 1,
  borderColor: theme.colors.borderMuted,
  overflow: "hidden",
};

function interpolate(str: string, params: Record<string, string | number>) {
  let s = str;
  for (const [k, v] of Object.entries(params)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

function AlertLabel({
  item,
  variant,
  numberOfLines,
}: {
  item: HomePriorityAlertItem;
  variant: "strip" | "sheet";
  numberOfLines?: number;
}) {
  const { isRTL } = useI18n();
  const textStyle = variant === "strip" ? styles.text : modalStyles.sheetRowText;
  const subjectStyle = variant === "strip" ? styles.segSubject : modalStyles.segSubject;
  const rtlAlign = variant === "strip" ? styles.rtl : modalStyles.rtlSheet;

  const baseDir: "ltr" | "rtl" = isRTL ? "rtl" : "ltr";

  function segmentRun(run: HomePriorityLabelSegment[], lineNumberOfLines?: number) {
    return (
      <Text
        style={[{ writingDirection: baseDir }, isRTL && styles.segmentLineRtl]}
        numberOfLines={lineNumberOfLines}
      >
        {run.map((seg, idx) => {
          const isSubject = seg.role === "subject";
          return (
            <Text
              key={idx}
              style={[
                isSubject ? subjectStyle : textStyle,
                { writingDirection: seg.dir === "rtl" ? "rtl" : "ltr" },
              ]}
            >
              {seg.text}
            </Text>
          );
        })}
      </Text>
    );
  }

  if (item.labelSegments?.length) {
    const segs = item.labelSegments;
    let splitAt = 0;
    while (splitAt < segs.length && segs[splitAt].role === "subject") splitAt++;
    const subjectSegs = segs.slice(0, splitAt);
    const bodySegs = segs.slice(splitAt);
    const stacked = subjectSegs.length > 0 && bodySegs.length > 0;

    if (stacked) {
      return (
        <View style={[styles.labelStack, isRTL && styles.labelStackRtl]}>
          {segmentRun(subjectSegs, 1)}
          {segmentRun(bodySegs, numberOfLines)}
        </View>
      );
    }

    return segmentRun(segs, numberOfLines);
  }
  return (
    <Text style={[textStyle, isRTL && rtlAlign]} numberOfLines={numberOfLines}>
      {item.label}
    </Text>
  );
}

export function HomePriorityAlerts({
  items,
  maxVisible = 2,
  dismissStorageUserId,
  onVisibleCountChange,
}: Props) {
  const { isRTL, t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!dismissStorageUserId) {
      setDismissed(new Set());
      return;
    }
    let cancelled = false;
    loadDismissedHomeAlertIds(dismissStorageUserId).then((s) => {
      if (!cancelled) setDismissed(s);
    });
    return () => {
      cancelled = true;
    };
  }, [dismissStorageUserId]);

  const activeItems = useMemo(() => {
    if (!dismissStorageUserId) return items;
    return filterUndismissedAlerts(items, dismissed);
  }, [items, dismissed, dismissStorageUserId]);

  useEffect(() => {
    onVisibleCountChange?.(activeItems.length);
  }, [activeItems.length, onVisibleCountChange]);

  const dismissEnabled = !!dismissStorageUserId;

  const handleDismiss = useCallback(
    async (id: string) => {
      if (!dismissStorageUserId) return;
      await dismissHomeAlert(dismissStorageUserId, id);
      setDismissed((prev) => new Set([...prev, id]));
    },
    [dismissStorageUserId]
  );

  if (activeItems.length === 0) return null;

  const visible = activeItems.slice(0, maxVisible);
  const rest = activeItems.length - visible.length;

  function openItem(href: HomePriorityAlertItem["href"]) {
    setSheetOpen(false);
    router.push(href);
  }

  function RowChrome({
    it,
    variant,
    showBottomBorder,
  }: {
    it: HomePriorityAlertItem;
    variant: "strip" | "sheet";
    showBottomBorder: boolean;
  }) {
    const a11y = `${it.isNew ? `${t("homeAlerts.newBadge")}. ` : ""}${it.label}`;
    const body = (
      <View style={[styles.rowContent, isRTL && styles.rowContentRtl]}>
        {it.isNew ? (
          <View style={styles.newBadge}>
            <Text style={styles.newBadgeTxt}>{t("homeAlerts.newBadge")}</Text>
          </View>
        ) : null}
        <View style={styles.rowLabelFlex}>
          <AlertLabel item={it} variant={variant} numberOfLines={variant === "strip" ? 2 : 3} />
        </View>
      </View>
    );

    const dismissBtn = dismissEnabled ? (
      <Pressable
        onPress={() => void handleDismiss(it.id)}
        style={({ pressed }) => [styles.dismissHit, isRTL && styles.dismissHitRtl, pressed && { opacity: 0.75 }]}
        accessibilityRole="button"
        accessibilityLabel={t("homeAlerts.dismissA11y")}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Text style={styles.dismissGlyph}>×</Text>
      </Pressable>
    ) : null;

    if (variant === "strip") {
      return (
        <View style={[styles.rowOuter, showBottomBorder && styles.rowBorder, isRTL && styles.rowOuterRtl]}>
          <Pressable
            style={({ pressed }) => [styles.rowTap, isRTL && styles.rowTapRtl, pressed && { opacity: 0.88 }]}
            onPress={() => router.push(it.href)}
            accessibilityRole="button"
            accessibilityLabel={a11y}
          >
            {body}
          </Pressable>
          {dismissBtn}
        </View>
      );
    }

    return (
      <View style={[modalStyles.sheetRowOuter, showBottomBorder && modalStyles.sheetRowBorder, isRTL && modalStyles.sheetRowOuterRtl]}>
        <Pressable
          style={({ pressed }) => [modalStyles.sheetRowTap, isRTL && modalStyles.sheetRowTapRtl, pressed && { opacity: 0.88 }]}
          onPress={() => openItem(it.href)}
          accessibilityRole="button"
          accessibilityLabel={a11y}
        >
          {body}
        </Pressable>
        {dismissBtn}
      </View>
    );
  }

  return (
    <>
      <View style={[wrapBase, isRTL && { borderLeftWidth: 0, borderRightWidth: 4, borderRightColor: theme.colors.cta }]}>
        {visible.map((it, i) => (
          <RowChrome
            key={it.id}
            it={it}
            variant="strip"
            showBottomBorder={i < visible.length - 1 || rest > 0}
          />
        ))}
        {rest > 0 ? (
          <Pressable
            onPress={() => setSheetOpen(true)}
            style={({ pressed }) => [styles.moreRow, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel={t("homeAlerts.viewAllHint")}
          >
            <Text style={[styles.moreText, styles.moreTextLink, isRTL && styles.rtl]}>
              {interpolate(t("homeAlerts.moreCount"), { n: rest })}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <View style={modalStyles.root}>
          <Pressable
            style={modalStyles.backdrop}
            onPress={() => setSheetOpen(false)}
            accessibilityLabel={t("common.cancel")}
          />
          <View style={[modalStyles.sheet, isRTL && { direction: "rtl" }]}>
            <View style={modalStyles.handle} />
            <Text style={[modalStyles.title, isRTL && styles.rtl]}>{t("homeAlerts.sheetTitle")}</Text>
            <Text style={[modalStyles.sub, isRTL && styles.rtl]}>
              {interpolate(t("homeAlerts.sheetSubtitle"), { n: activeItems.length })}
            </Text>
            <ScrollView
              style={modalStyles.scroll}
              contentContainerStyle={modalStyles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
              {activeItems.map((it, i) => (
                <RowChrome
                  key={it.id}
                  it={it}
                  variant="sheet"
                  showBottomBorder={i < activeItems.length - 1}
                />
              ))}
            </ScrollView>
            <Pressable
              style={({ pressed }) => [modalStyles.doneBtn, pressed && { opacity: 0.9 }]}
              onPress={() => setSheetOpen(false)}
            >
              <Text style={modalStyles.doneBtnTxt}>{t("common.ok")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  rowOuter: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingStart: theme.spacing.sm,
    paddingEnd: theme.spacing.xs,
  },
  /** Hebrew / RTL: accent bar on the logical end — keep copy off the thick border + ×. */
  rowOuterRtl: {
    paddingStart: theme.spacing.md,
    paddingEnd: theme.spacing.md + 6,
  },
  rowTap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  rowTapRtl: {
    paddingEnd: theme.spacing.xs,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  rowContentRtl: {
    flexDirection: "row-reverse",
  },
  rowLabelFlex: {
    flex: 1,
    minWidth: 0,
  },
  /** Subject line above body (late cancellation, etc.) */
  labelStack: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  labelStackRtl: {
    alignItems: "flex-end",
    alignSelf: "stretch",
  },
  segmentLineRtl: {
    textAlign: "right",
    alignSelf: "stretch",
  },
  dismissHit: {
    justifyContent: "center",
    alignSelf: "stretch",
    paddingHorizontal: theme.spacing.xs,
    minWidth: 44,
  },
  dismissHitRtl: {
    paddingStart: theme.spacing.sm,
    paddingEnd: theme.spacing.xs,
  },
  dismissGlyph: {
    color: theme.colors.textMuted,
    fontSize: 24,
    fontWeight: "400",
    lineHeight: 28,
  },
  newBadge: {
    marginTop: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.successBg,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  newBadgeTxt: {
    fontSize: 10,
    fontWeight: "900",
    color: theme.colors.success,
    letterSpacing: 0.4,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  text: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    lineHeight: 22,
  },
  segSubject: {
    color: theme.colors.alertSubject,
    fontWeight: "800",
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.08,
  },
  rtl: { writingDirection: "rtl", textAlign: "right" },
  moreRow: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  moreText: {
    fontWeight: "700",
    fontSize: 13,
  },
  moreTextLink: {
    color: theme.colors.cta,
  },
});

const modalStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  sheet: {
    zIndex: 2,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: theme.spacing.lg,
    maxHeight: "88%",
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.borderMuted,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  title: {
    fontSize: 17,
    fontWeight: "800",
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.lg,
    marginBottom: 4,
  },
  sub: {
    fontSize: 13,
    color: theme.colors.textMuted,
    fontWeight: "600",
    paddingHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  scroll: {
    maxHeight: 360,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  sheetRowOuter: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingStart: theme.spacing.sm,
    paddingEnd: theme.spacing.xs,
  },
  sheetRowOuterRtl: {
    paddingStart: theme.spacing.md,
    paddingEnd: theme.spacing.md + 6,
  },
  sheetRowTap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  sheetRowTapRtl: {
    paddingEnd: theme.spacing.xs,
  },
  sheetRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  sheetRowText: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 15,
    lineHeight: 22,
  },
  segSubject: {
    color: theme.colors.alertSubject,
    fontWeight: "800",
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.08,
  },
  rtlSheet: { writingDirection: "rtl", textAlign: "right" },
  doneBtn: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.cta,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  doneBtnTxt: {
    color: theme.colors.ctaText,
    fontWeight: "900",
    fontSize: 15,
  },
});
