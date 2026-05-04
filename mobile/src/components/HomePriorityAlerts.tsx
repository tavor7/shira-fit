import { useState } from "react";
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
import type { HomePriorityAlertItem } from "../lib/homePriorityAlerts";
import { useI18n } from "../context/I18nContext";

type Props = {
  items: HomePriorityAlertItem[];
  /** First N tappable rows; rest summarized with a sheet for the full list. */
  maxVisible?: number;
};

const wrapBase: ViewStyle = {
  marginBottom: theme.spacing.md,
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
  const rtlAlign = variant === "strip" ? styles.rtl : modalStyles.rtlSheet;

  const baseDir: "ltr" | "rtl" = isRTL ? "rtl" : "ltr";
  if (item.labelSegments?.length) {
    return (
      <Text style={[textStyle, { writingDirection: baseDir }]} numberOfLines={numberOfLines}>
        {item.labelSegments.map((seg, idx) => (
          <Text key={idx} style={{ writingDirection: seg.dir === "rtl" ? "rtl" : "ltr" }}>
            {seg.text}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Text style={[textStyle, isRTL && rtlAlign]} numberOfLines={numberOfLines}>
      {item.label}
    </Text>
  );
}

export function HomePriorityAlerts({ items, maxVisible = 2 }: Props) {
  const { isRTL, t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (items.length === 0) return null;

  const visible = items.slice(0, maxVisible);
  const rest = items.length - visible.length;

  function openItem(href: HomePriorityAlertItem["href"]) {
    setSheetOpen(false);
    router.push(href);
  }

  return (
    <>
      <View style={[wrapBase, isRTL && { borderLeftWidth: 0, borderRightWidth: 4, borderRightColor: theme.colors.cta }]}>
        {visible.map((it, i) => (
          <Pressable
            key={it.id}
            onPress={() => router.push(it.href)}
            style={({ pressed }) => [
              styles.row,
              (i < visible.length - 1 || rest > 0) && styles.rowBorder,
              pressed && { opacity: 0.88 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={it.label}
          >
            <AlertLabel item={it} variant="strip" numberOfLines={2} />
          </Pressable>
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
              {interpolate(t("homeAlerts.sheetSubtitle"), { n: items.length })}
            </Text>
            <ScrollView
              style={modalStyles.scroll}
              contentContainerStyle={modalStyles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
              {items.map((it, i) => (
                <Pressable
                  key={it.id}
                  onPress={() => openItem(it.href)}
                  style={({ pressed }) => [
                    modalStyles.sheetRow,
                    i < items.length - 1 && modalStyles.sheetRowBorder,
                    pressed && { opacity: 0.88 },
                  ]}
                  accessibilityLabel={it.label}
                >
                  <AlertLabel item={it} variant="sheet" numberOfLines={3} />
                </Pressable>
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
  row: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  text: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 14,
    lineHeight: 20,
  },
  rtl: { writingDirection: "rtl", textAlign: "right" },
  moreRow: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
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
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  sheetRow: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  sheetRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  sheetRowText: {
    color: theme.colors.text,
    fontWeight: "700",
    fontSize: 14,
    lineHeight: 20,
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
