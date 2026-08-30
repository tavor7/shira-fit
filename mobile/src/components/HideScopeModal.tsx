import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppModal } from "./AppModal";
import { AppSwitch } from "./AppSwitch";
import { PrimaryButton } from "./PrimaryButton";
import type { HideScope } from "../types/database";

type Props = {
  visible: boolean;
  athleteName: string;
  busy?: boolean;
  /** Prefills the toggles (e.g. re-hiding after adjusting scope). Defaults to athlete-only. */
  initialScope?: HideScope;
  onClose: () => void;
  onConfirm: (scope: HideScope) => void;
};

const DEFAULT_SCOPE: HideScope = { athlete: true, coach: false, manager: false };

/** Super User only: choose which audiences a hide targets before confirming. */
export function HideScopeModal({ visible, athleteName, busy, initialScope, onClose, onConfirm }: Props) {
  const { t, isRTL } = useI18n();
  const [scope, setScope] = useState<HideScope>(initialScope ?? DEFAULT_SCOPE);

  useEffect(() => {
    if (visible) setScope(initialScope ?? DEFAULT_SCOPE);
  }, [visible, initialScope]);

  const noneSelected = !scope.athlete && !scope.coach && !scope.manager;

  const rows: { key: keyof HideScope; label: string; hint: string }[] = [
    { key: "athlete", label: t("superUser.scopeAthlete"), hint: t("superUser.scopeAthleteHint") },
    { key: "coach", label: t("superUser.scopeCoach"), hint: t("superUser.scopeCoachHint") },
    { key: "manager", label: t("superUser.scopeManager"), hint: t("superUser.scopeManagerHint") },
  ];

  return (
    <AppModal visible={visible} onClose={onClose} variant="sheet" backdropAccessibilityLabel={t("common.close")}>
      <View style={styles.wrap}>
        <Text style={[styles.title, isRTL && styles.rtlText]}>{t("superUser.hideConfirmTitle")}</Text>
        <Text style={[styles.subtitle, isRTL && styles.rtlText]} numberOfLines={2}>
          {athleteName}
        </Text>
        <Text style={[styles.hint, isRTL && styles.rtlText]}>{t("superUser.scopePickerHint")}</Text>

        <View style={styles.rows}>
          {rows.map((row) => (
            <View key={row.key} style={[styles.row, isRTL && styles.rowRtl]}>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowLabel, isRTL && styles.rtlText]}>{row.label}</Text>
                <Text style={[styles.rowHint, isRTL && styles.rtlText]}>{row.hint}</Text>
              </View>
              <AppSwitch
                value={scope[row.key]}
                onValueChange={(v) => setScope((s) => ({ ...s, [row.key]: v }))}
                accessibilityLabel={row.label}
                disabled={busy}
              />
            </View>
          ))}
        </View>

        {noneSelected ? (
          <Text style={[styles.warn, isRTL && styles.rtlText]}>{t("superUser.scopeNoneSelected")}</Text>
        ) : null}

        <PrimaryButton
          label={t("superUser.hideAction")}
          loadingLabel={t("common.loading")}
          loading={busy}
          disabled={noneSelected}
          onPress={() => onConfirm(scope)}
        />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: theme.spacing.md, gap: theme.spacing.sm },
  rtlText: { textAlign: "right" },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text },
  subtitle: { fontSize: 14, fontWeight: "700", color: theme.colors.textMuted },
  hint: { fontSize: 12, color: theme.colors.textMuted, lineHeight: 17, marginTop: 2 },
  rows: { marginTop: theme.spacing.sm, gap: theme.spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.surface,
  },
  rowRtl: { flexDirection: "row-reverse" },
  rowCopy: { flex: 1 },
  rowLabel: { color: theme.colors.text, fontWeight: "800", fontSize: 14 },
  rowHint: { color: theme.colors.textMuted, fontSize: 12, marginTop: 2 },
  warn: { color: theme.colors.error, fontSize: 12, fontWeight: "700" },
});
