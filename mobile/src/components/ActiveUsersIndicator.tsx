import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useActiveUsers, type ActiveUser } from "../context/AppPresenceContext";
import { AppModal } from "./AppModal";
import { PressableScale } from "./PressableScale";
import { FadeSlideIn } from "./FadeSlideIn";

function roleLabel(role: ActiveUser["role"], t: (key: string) => string): string {
  if (role === "coach") return t("roles.coach");
  if (role === "manager") return t("roles.manager");
  return t("roles.athlete");
}

/** A single small line — "N active now" — tap it to see who. Renders nothing until the count is known. */
export function ActiveUsersIndicator() {
  const { t, isRTL } = useI18n();
  const { profile } = useAuth();
  const users = useActiveUsers();
  const [open, setOpen] = useState(false);
  if (users == null) return null;

  const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PressableScale
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t("activeUsers.now").replace("{n}", String(users.length))}
      >
        <View style={[styles.row, isRTL && styles.rowRtl]}>
          <View style={styles.dot} />
          <Text style={styles.txt}>{t("activeUsers.now").replace("{n}", String(users.length))}</Text>
        </View>
      </PressableScale>

      <AppModal
        visible={open}
        onClose={() => setOpen(false)}
        variant="sheet"
        backdropAccessibilityLabel={t("common.close")}
      >
        <Text style={[styles.sheetTitle, isRTL && styles.rtlText]}>{t("activeUsers.title")}</Text>
        <View style={styles.list}>
          {sorted.map((u, index) => (
            <FadeSlideIn key={u.userId} delay={Math.min(index, theme.motion.maxStaggerIndex) * 30}>
              <View style={[styles.userRow, isRTL && styles.userRowRtl]}>
                <View style={styles.avatarDot} />
                <View style={styles.userTextWrap}>
                  <Text style={[styles.userName, isRTL && styles.rtlText]} numberOfLines={1}>
                    {u.name}
                    {u.userId === profile?.user_id ? ` ${t("activeUsers.you")}` : ""}
                  </Text>
                  <Text style={[styles.userRole, isRTL && styles.rtlText]}>{roleLabel(u.role, t)}</Text>
                </View>
              </View>
            </FadeSlideIn>
          ))}
        </View>
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  rowRtl: { flexDirection: "row-reverse" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.success },
  txt: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.text,
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  rtlText: { textAlign: "right" },
  list: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.lg, gap: theme.spacing.xs },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  userRowRtl: { flexDirection: "row-reverse" },
  avatarDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success },
  userTextWrap: { flex: 1, minWidth: 0 },
  userName: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  userRole: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginTop: 1 },
});
