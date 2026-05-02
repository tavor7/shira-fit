import { createElement, type ChangeEvent, type CSSProperties, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import type { TimePickerFieldProps } from "./TimePickerField";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

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

/** Native `<select>` — ScrollView wheels break inside Modal on react-native-web (no reliable scroll). */
function DomTimeSelect({
  value,
  onChange,
  options,
  formatOption,
  width,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  options: number[];
  formatOption: (n: number) => string;
  width: number;
  ariaLabel: string;
}) {
  const style: CSSProperties = {
    width,
    minHeight: 52,
    paddingLeft: 12,
    paddingRight: 28,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surfaceElevated,
    color: theme.colors.text,
    fontSize: 22,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23a1a1aa' d='M6 8L2 4h8z'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    outline: "none",
    touchAction: "manipulation",
  };

  return createElement(
    "select",
    {
      value: String(value),
      "aria-label": ariaLabel,
      onChange: (e: ChangeEvent<HTMLSelectElement>) => {
        onChange(Number(e.target.value));
      },
      style,
    },
    options.map((n) => createElement("option", { key: n, value: String(n) }, formatOption(n)))
  );
}

export function TimePickerField({ label, value, onChange }: TimePickerFieldProps) {
  const { language, isRTL } = useI18n();
  const [open, setOpen] = useState(false);
  const [draftH, setDraftH] = useState(18);
  const [draftM, setDraftM] = useState(0);

  const display = (() => {
    const p = parseHHMM(value);
    if (!p) return language === "he" ? "בחרו שעה" : "Choose time";
    return toHHMM(p.hh, p.mm);
  })();

  const openSheet = () => {
    const p = parseHHMM(value);
    setDraftH(p?.hh ?? 18);
    setDraftM(p?.mm ?? 0);
    setOpen(true);
  };

  const applyAndClose = () => {
    onChange(toHHMM(draftH, draftM));
    setOpen(false);
  };

  const colW = 88;
  const hourLabel = language === "he" ? "שעה" : "Hour";
  const minLabel = language === "he" ? "דקות" : "Min";

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

            <View style={[styles.pickersRow, isRTL && styles.pickersRowRtl]}>
              <View style={styles.pickerCol}>
                <Text style={styles.wheelColLabel}>{hourLabel}</Text>
                <View style={styles.selectFrame}>
                  <DomTimeSelect
                    value={draftH}
                    onChange={setDraftH}
                    options={HOURS}
                    formatOption={(n) => String(n).padStart(2, "0")}
                    width={colW}
                    ariaLabel={hourLabel}
                  />
                </View>
              </View>
              <Text style={styles.wheelSep}>:</Text>
              <View style={styles.pickerCol}>
                <Text style={styles.wheelColLabel}>{minLabel}</Text>
                <View style={styles.selectFrame}>
                  <DomTimeSelect
                    value={draftM}
                    onChange={setDraftM}
                    options={MINUTES}
                    formatOption={(n) => String(n).padStart(2, "0")}
                    width={colW}
                    ariaLabel={minLabel}
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
  pickersRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    gap: 8,
  },
  pickersRowRtl: { flexDirection: "row-reverse" },
  pickerCol: { alignItems: "center" },
  wheelColLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  selectFrame: {
    borderRadius: theme.radius.md,
    overflow: "hidden",
  },
  wheelSep: {
    fontSize: 28,
    fontWeight: "200",
    color: theme.colors.textMuted,
    marginBottom: 28,
    lineHeight: 32,
  },
});
