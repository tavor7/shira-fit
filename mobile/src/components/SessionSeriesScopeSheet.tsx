import { View, Text, Pressable, StyleSheet } from "react-native";
import { AppModal } from "./AppModal";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

export type SeriesScopeChoice = "this" | "future";

type Props = {
  visible: boolean;
  mode: "edit" | "delete";
  onClose: () => void;
  onChoose: (scope: SeriesScopeChoice) => void;
};

export function SessionSeriesScopeSheet({ visible, mode, onClose, onChoose }: Props) {
  const { t, isRTL } = useI18n();
  const title = mode === "delete" ? t("session.seriesScopeDeleteTitle") : t("session.seriesScopeEditTitle");
  const subtitle = mode === "delete" ? t("session.seriesScopeDeleteSubtitle") : t("session.seriesScopeEditSubtitle");

  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      variant="sheet"
      animationType="slide"
      backdropAccessibilityLabel={t("common.cancel")}
      cardStyle={styles.card}
    >
      <Text style={[styles.title, isRTL && styles.rtl]}>{title}</Text>
      <Text style={[styles.sub, isRTL && styles.rtl]}>{subtitle}</Text>

      <Pressable
        style={({ pressed }) => [styles.choice, pressed && styles.choicePressed]}
        onPress={() => onChoose("this")}
        accessibilityRole="button"
      >
        <Text style={[styles.choiceTitle, isRTL && styles.rtl]}>{t("session.seriesScopeThisOnly")}</Text>
        <Text style={[styles.choiceHint, isRTL && styles.rtl]}>
          {mode === "delete" ? t("session.seriesScopeThisOnlyDeleteHint") : t("session.seriesScopeThisOnlyEditHint")}
        </Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.choice, styles.choiceFuture, pressed && styles.choicePressed]}
        onPress={() => onChoose("future")}
        accessibilityRole="button"
      >
        <Text style={[styles.choiceTitle, isRTL && styles.rtl]}>{t("session.seriesScopeThisAndFuture")}</Text>
        <Text style={[styles.choiceHint, isRTL && styles.rtl]}>
          {mode === "delete" ? t("session.seriesScopeFutureDeleteHint") : t("session.seriesScopeFutureEditHint")}
        </Text>
      </Pressable>

      <Pressable onPress={onClose} style={styles.cancelBtn} accessibilityRole="button">
        <Text style={[styles.cancelTxt, isRTL && styles.rtl]}>{t("common.cancel")}</Text>
      </Pressable>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
  },
  title: { fontSize: 20, fontWeight: "900", color: theme.colors.text, marginBottom: 6 },
  sub: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted, marginBottom: theme.spacing.md, lineHeight: 18 },
  choice: {
    padding: 14,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: 10,
  },
  choiceFuture: {
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.backgroundAlt,
  },
  choicePressed: { opacity: 0.9 },
  choiceTitle: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  choiceHint: { marginTop: 4, fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, lineHeight: 17 },
  cancelBtn: { marginTop: 4, paddingVertical: 12, alignItems: "center" },
  cancelTxt: { fontSize: 15, fontWeight: "700", color: theme.colors.textMuted },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
