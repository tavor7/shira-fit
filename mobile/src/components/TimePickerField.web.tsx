import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { TimePickerFieldProps } from "./TimePickerField";

const ITEM_H = 44;
const WHEEL_VISIBLE_ROWS = 5;
const WHEEL_HEIGHT = ITEM_H * WHEEL_VISIBLE_ROWS;

function parseHHMM(v: string): { hh: number; mm: number } | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const hh = Math.max(0, Math.min(23, parseInt(m[1] ?? "", 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2] ?? "", 10)));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { hh, mm };
}

function toHHMM(hh: number, mm: number): string {
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

type WheelColumnProps = {
  values: number[];
  selected: number;
  onSelect: (n: number) => void;
  formatItem: (n: number) => string;
  width: number;
};

function WheelColumn({ values, selected, onSelect, formatItem, width }: WheelColumnProps) {
  const ref = useRef<ScrollView>(null);
  const pad = (WHEEL_HEIGHT - ITEM_H) / 2;
  const maxIdx = values.length - 1;

  const scrollToIndex = useCallback(
    (idx: number, animated: boolean) => {
      const i = Math.max(0, Math.min(maxIdx, idx));
      const y = i * ITEM_H;
      ref.current?.scrollTo({ y, animated });
    },
    [maxIdx]
  );

  useEffect(() => {
    const idx = values.indexOf(selected);
    if (idx < 0) return;
    const id = requestAnimationFrame(() => scrollToIndex(idx, false));
    return () => cancelAnimationFrame(id);
  }, [selected, values, scrollToIndex]);

  const finalize = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      let idx = Math.round(y / ITEM_H);
      idx = Math.max(0, Math.min(maxIdx, idx));
      scrollToIndex(idx, true);
      const v = values[idx];
      if (v !== undefined && v !== selected) onSelect(v);
    },
    [maxIdx, onSelect, scrollToIndex, selected, values]
  );

  return (
    <ScrollView
      ref={ref}
      style={{ width, height: WHEEL_HEIGHT }}
      contentContainerStyle={{ paddingVertical: pad }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_H}
      decelerationRate="fast"
      nestedScrollEnabled
      onMomentumScrollEnd={finalize}
      onScrollEndDrag={finalize}
    >
      {values.map((n) => {
        const active = n === selected;
        return (
          <View key={n} style={[styles.wheelItem, { height: ITEM_H, width }]}>
            <Text style={[styles.wheelItemText, active && styles.wheelItemTextActive]} numberOfLines={1}>
              {formatItem(n)}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

export function TimePickerField({ label, value, onChange }: TimePickerFieldProps) {
  const { language, isRTL } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftH, setDraftH] = useState(18);
  const [draftM, setDraftM] = useState(0);
  const [sheetKey, setSheetKey] = useState(0);

  const display = (() => {
    const p = parseHHMM(value);
    if (!p) return language === "he" ? "בחרו שעה" : "Choose time";
    return toHHMM(p.hh, p.mm);
  })();

  const openSheet = () => {
    const p = parseHHMM(value);
    setDraftH(p?.hh ?? 18);
    setDraftM(p?.mm ?? 0);
    setSheetKey((k) => k + 1);
    setOpen(true);
  };

  const applyAndClose = () => {
    onChange(toHHMM(draftH, draftM));
    setOpen(false);
  };

  const colW = 76;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, isRTL && styles.rtlText]}>{label}</Text>
      <Pressable onPress={openSheet} style={({ pressed }) => [styles.touch, pressed && styles.touchPressed]}>
        <Text style={[styles.touchText, isRTL && styles.rtlTextLight]} numberOfLines={1} ellipsizeMode="tail">
          {display}
        </Text>
        <Text style={[styles.chev, isRTL ? styles.chevRtl : styles.chevLtr]}>▼</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFlex} onPress={() => setOpen(false)} accessibilityLabel={language === "he" ? "סגירה" : "Dismiss"} />
          <View style={styles.sheet}>
            <View style={styles.toolbar}>
              <Pressable onPress={() => setOpen(false)} hitSlop={12} style={styles.tbBtn}>
                <Text style={styles.tbMuted}>{language === "he" ? "ביטול" : "Cancel"}</Text>
              </Pressable>
              <Text style={styles.tbTitle} numberOfLines={1}>
                {label}
              </Text>
              <Pressable onPress={applyAndClose} hitSlop={12} style={styles.tbBtn}>
                <Text style={styles.tbCta}>{language === "he" ? "אישור" : "Done"}</Text>
              </Pressable>
            </View>

            <View style={[styles.wheelsRow, isRTL && styles.wheelsRowRtl]}>
              <View style={styles.wheelCol}>
                <Text style={styles.wheelColLabel}>{language === "he" ? "שעה" : "Hour"}</Text>
                <View style={styles.wheelFrame}>
                  <View pointerEvents="none" style={styles.wheelHighlight} />
                  <WheelColumn
                    key={`h-${sheetKey}`}
                    values={HOURS}
                    selected={draftH}
                    onSelect={setDraftH}
                    formatItem={(n) => String(n).padStart(2, "0")}
                    width={colW}
                  />
                </View>
              </View>
              <Text style={styles.wheelSep}>:</Text>
              <View style={styles.wheelCol}>
                <Text style={styles.wheelColLabel}>{language === "he" ? "דקות" : "Min"}</Text>
                <View style={styles.wheelFrame}>
                  <View pointerEvents="none" style={styles.wheelHighlight} />
                  <WheelColumn
                    key={`m-${sheetKey}`}
                    values={MINUTES}
                    selected={draftM}
                    onSelect={setDraftM}
                    formatItem={(n) => String(n).padStart(2, "0")}
                    width={colW}
                  />
                </View>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: theme.spacing.sm, alignSelf: "stretch", minWidth: 0 },
  label: { marginBottom: 6, fontWeight: "700", color: theme.colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  rtlText: { textAlign: "right" },
  touch: {
    alignSelf: "stretch",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: theme.colors.surfaceElevated,
    overflow: "hidden",
  },
  touchPressed: { opacity: 0.92 },
  touchText: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: "700", color: theme.colors.text },
  rtlTextLight: { textAlign: "right" },
  chev: { fontSize: 10, color: theme.colors.textMuted },
  chevLtr: { marginLeft: 8 },
  chevRtl: { marginRight: 8 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdropFlex: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    paddingBottom: theme.spacing.lg,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  tbBtn: { minWidth: 64 },
  tbMuted: { fontSize: 16, fontWeight: "600", color: theme.colors.textMuted },
  tbTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: theme.colors.text },
  tbCta: { fontSize: 16, fontWeight: "800", color: theme.colors.cta },
  wheelsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    gap: 6,
  },
  wheelsRowRtl: { flexDirection: "row-reverse" },
  wheelCol: { alignItems: "center" },
  wheelColLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  wheelFrame: {
    position: "relative",
    borderRadius: theme.radius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  wheelHighlight: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    marginTop: -ITEM_H / 2,
    height: ITEM_H,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderInput,
    backgroundColor: "rgba(244,244,245,0.06)",
    zIndex: 1,
  },
  wheelSep: {
    fontSize: 28,
    fontWeight: "200",
    color: theme.colors.textMuted,
    marginBottom: ITEM_H * 1.25,
    lineHeight: 32,
  },
  wheelItem: { alignItems: "center", justifyContent: "center" },
  wheelItemText: { fontSize: 20, fontWeight: "600", color: theme.colors.textSoft, fontVariant: ["tabular-nums"] as any },
  wheelItemTextActive: { fontSize: 22, fontWeight: "800", color: theme.colors.text },
});
