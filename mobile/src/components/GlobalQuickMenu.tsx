import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { isAthleteAccountDisabled } from "../lib/profileAccount";
import { FoldableActionsMenu, type FoldableActionsMenuItem } from "./FoldableActionsMenu";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import {
  useEffectiveNavRole,
  useManagerAthletePreview,
} from "../context/ManagerAthletePreviewContext";
import { replaceToManagerSessions } from "../lib/managerSessionsRedirectLog";

type RouteItem = FoldableActionsMenuItem & {
  /** Match current pathname; when true we hide the item. */
  isActive: (pathname: string) => boolean;
};

function startsWithAny(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

export function GlobalQuickMenu() {
  const { profile, loading: authLoading, user } = useAuth();
  const { t, language, toggleLanguage } = useI18n();
  const openMenuA11y = t("a11y.openMenu");
  const closeMenuA11y = t("a11y.closeMenu");
  const pathname = usePathname() ?? "";
  const [pendingApproveCount, setPendingApproveCount] = useState(0);

  useEffect(() => {
    if (profile?.role !== "manager") {
      setPendingApproveCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const { count, error } = await supabase
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "athlete")
        .eq("approval_status", "pending");
      if (!cancelled && !error) setPendingApproveCount(count ?? 0);
      if (!cancelled && error) setPendingApproveCount(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.role, pathname]);

  const navRole = useEffectiveNavRole(profile);
  const { setEnabled } = useManagerAthletePreview();

  const items = useMemo<RouteItem[]>(() => {
    const role = navRole;

    const languageItem: RouteItem = {
      label: language === "he" ? t("lang.english") : t("lang.hebrew"),
      onPress: () => toggleLanguage(),
      isActive: () => false,
    };

    if (profile?.role === "athlete" && (profile?.approval_status === "pending" || isAthleteAccountDisabled(profile))) {
      return [languageItem];
    }

    // A minimal set that stays consistent across pages.
    if (role === "manager") {
      const managerItems: RouteItem[] = [
        {
          label: t("menu.sessions"),
          onPress: () => router.push("/(app)/manager/sessions"),
          isActive: (p) => startsWithAny(p, ["/manager/sessions"]),
        },
        {
          label: t("menu.rosterCalendar"),
          onPress: () => router.push("/(app)/manager/roster-calendar"),
          isActive: (p) => startsWithAny(p, ["/manager/roster-calendar"]),
        },
        {
          label: t("menu.overview"),
          onPress: () => router.push("/(app)/manager/dashboard"),
          isActive: (p) =>
            startsWithAny(p, [
              "/manager/dashboard",
              "/manager/weekly-detail",
              "/manager/finance-daily",
              "/manager/finance-expected",
              "/manager/missing-attendance",
              "/manager/activity-log",
              "/manager/reports",
              "/manager/participant-history",
              "/manager/coach-sessions-report",
            ]),
        },
        {
          label: t("menu.managerSetup"),
          onPress: () => router.push("/(app)/staff/users"),
          isActive: (p) =>
            startsWithAny(p, [
              "/staff/users",
              "/staff/profile",
              "/staff/manual",
              "/manager/families",
              "/manager/account-payments",
              "/manager/trainer-colors",
              "/manager/roles",
              "/manager/pricing",
              "/manager/coach-capacity-pricing",
              "/manager/opening-schedule",
            ]),
        },
        {
          label: t("menu.approve"),
          onPress: () => router.push("/(app)/manager/approve"),
          isActive: (p) => startsWithAny(p, ["/manager/approve"]),
          badgeCount: pendingApproveCount > 0 ? pendingApproveCount : undefined,
        },
      ];

      managerItems.push(
        {
          label: t("menu.athleteView"),
          onPress: async () => {
            await setEnabled(true);
            router.replace("/(app)/athlete/sessions");
          },
          isActive: () => false,
        },
        languageItem,
      );

      return managerItems;
    }

    if (role === "coach") {
      return [
        {
          label: t("menu.sessions"),
          onPress: () => router.push("/(app)/coach/sessions"),
          isActive: (p) => startsWithAny(p, ["/coach/sessions"]),
        },
        {
          label: t("menu.editUsers"),
          onPress: () => router.push("/(app)/staff/users"),
          isActive: (p) => startsWithAny(p, ["/staff/users", "/staff/profile", "/staff/manual"]),
        },
        {
          label: t("menu.search"),
          onPress: () => router.push("/(app)/staff/search"),
          isActive: (p) => startsWithAny(p, ["/staff/search"]),
        },
        {
          label: t("menu.participantHistory"),
          onPress: () => router.push("/(app)/coach/participant-history"),
          isActive: (p) => startsWithAny(p, ["/coach/participant-history"]),
        },
        {
          label: t("menu.pricingHub"),
          onPress: () => router.push("/(app)/coach/pricing" as never),
          isActive: (p) => startsWithAny(p, ["/coach/pricing"]),
        },
        {
          label: t("menu.createSession"),
          onPress: () => router.push("/(app)/coach/create-session"),
          isActive: (p) => startsWithAny(p, ["/coach/create-session"]),
        },
        languageItem,
      ];
    }

    // athlete / pending / unknown (includes manager in athlete preview)
    const athleteItems: RouteItem[] = [
      {
        label: t("menu.sessions"),
        onPress: () => router.push("/(app)/athlete/sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/sessions"]),
      },
      {
        label: t("menu.mySessionsShort"),
        onPress: () => router.push("/(app)/athlete/my-sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/my-sessions"]),
      },
    ];
    if (profile?.role === "manager") {
      athleteItems.push({
        label: t("menu.backToStaff"),
        onPress: async () => {
          await setEnabled(false);
          replaceToManagerSessions("src/components/GlobalQuickMenu.tsx", "athlete_preview_back_to_staff", {
            authLoading,
            authUserId: user?.id ?? null,
            profileRole: profile?.role ?? null,
          });
        },
        isActive: () => false,
      });
    }
    athleteItems.push(languageItem);
    return athleteItems;
  }, [
    navRole,
    profile?.role,
    profile?.approval_status,
    pendingApproveCount,
    t,
    language,
    toggleLanguage,
    setEnabled,
    authLoading,
    user?.id,
  ]);

  const visible = useMemo(() => items.filter((i) => !i.isActive(pathname)), [items, pathname]);

  return (
    <View style={styles.wrap}>
      <FoldableActionsMenu
        menuTitle={t("menu.navTitle")}
        closeAccessibilityLabel={closeMenuA11y}
        items={visible}
        backdropAccessibilityLabel={closeMenuA11y}
        hideHeader
        hideCloseButton
        closeOnKey={pathname}
        renderTrigger={(open) => (
          <Pressable
            onPress={open}
            style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
            accessibilityRole="button"
            accessibilityLabel={openMenuA11y}
          >
            <Text style={styles.triggerIcon} importantForAccessibility="no" maxFontSizeMultiplier={theme.a11y.chromeMaxFontMultiplier}>
              ≡
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  trigger: {
    height: 38,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  triggerPressed: { opacity: 0.9, backgroundColor: theme.colors.surface },
  triggerIcon: { color: theme.colors.text, fontSize: 18, fontWeight: "900", letterSpacing: 0.5, marginTop: -1 },
});