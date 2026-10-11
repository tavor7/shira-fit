import { Pressable, StyleSheet, View } from "react-native";
import { router, usePathname } from "expo-router";
import { useAuth } from "../context/AuthContext";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import { isAthleteAccountDisabled } from "../lib/profileAccount";
import { replaceToManagerSessions } from "../lib/managerSessionsRedirectLog";
import { FoldableActionsMenu, type FoldableActionsMenuItem } from "./FoldableActionsMenu";
import { UserAvatar, initials } from "./UserAvatar";

/**
 * Right side of the app header: one initials avatar that opens the account menu
 * (Profile, language, athlete view / back to staff for managers, Log out). The page title
 * sits in the header itself (AppHeaderTitle), so the identity block and the two pills are gone.
 */
export function AppHeaderRight() {
  const { profile, loading, signOut, user } = useAuth();
  const { t, language, toggleLanguage } = useI18n();
  const { enabled: athletePreview, setEnabled } = useManagerAthletePreview();
  const pathname = usePathname() ?? "";

  const name = profile?.full_name || profile?.username || t("common.account");
  const pendingAthlete = profile?.role === "athlete" && profile?.approval_status === "pending";
  const blockedAthlete = pendingAthlete || isAthleteAccountDisabled(profile);
  const baseRole = profile?.role ? t(`roles.${profile.role}`) : "";
  const roleLine = profile?.role === "manager" && athletePreview ? t("header.managerAthleteView") : baseRole;

  const items: FoldableActionsMenuItem[] = [];
  if (!blockedAthlete) items.push({ label: t("header.profile"), onPress: () => router.push("/(app)/profile") });
  items.push({ label: language === "he" ? t("lang.english") : t("lang.hebrew"), onPress: () => toggleLanguage() });
  if (profile?.role === "manager") {
    items.push(
      athletePreview
        ? {
            label: t("menu.backToStaff"),
            onPress: async () => {
              await setEnabled(false);
              replaceToManagerSessions("src/components/AppHeaderRight.tsx", "athlete_preview_back_to_staff", {
                authLoading: loading,
                authUserId: user?.id ?? null,
                profileRole: profile?.role ?? null,
              });
            },
          }
        : {
            label: t("menu.athleteView"),
            onPress: async () => {
              await setEnabled(true);
              router.replace("/(app)/athlete/sessions");
            },
          }
    );
  }
  items.push({ label: t("header.logout"), onPress: () => void signOut(), danger: true });

  return (
    <View style={styles.wrap}>
      <FoldableActionsMenu
        menuTitle={roleLine ? `${name} · ${roleLine}` : name}
        closeAccessibilityLabel={t("a11y.closeMenu")}
        backdropAccessibilityLabel={t("a11y.closeMenu")}
        items={items}
        hideCloseButton
        closeOnKey={pathname}
        renderTrigger={(open) => (
          <Pressable
            onPress={open}
            disabled={loading}
            accessibilityRole="button"
            // Starts with the visible initials so the accessible name contains the visible label (WCAG 2.5.3, voice control).
            accessibilityLabel={`${initials(name)} · ${t("header.accountMenu")}: ${name}`}
            accessibilityHint={roleLine || undefined}
            style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
          >
            <UserAvatar name={loading ? "…" : name} seed={user?.id ?? name} size={36} />
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    /** Logical horizontal inset so LTR + RTL (and web `dir=rtl`) keep the gutter from the screen edge. */
    paddingStart: theme.spacing.sm,
    paddingEnd: theme.spacing.md,
  },
  trigger: {
    minWidth: theme.controls.minTouch,
    minHeight: theme.controls.minTouch,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
  },
  pressed: { opacity: 0.85 },
});
