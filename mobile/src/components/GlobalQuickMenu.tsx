import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { FoldableActionsMenu, type FoldableActionsMenuItem } from "./FoldableActionsMenu";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";

type RouteItem = FoldableActionsMenuItem & {
  /** Match current pathname; when true we hide the item. */
  isActive: (pathname: string) => boolean;
};

function startsWithAny(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

export function GlobalQuickMenu() {
  const { profile } = useAuth();
  const { t, language, toggleLanguage } = useI18n();
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
  }, [profile?.role]);

  const items = useMemo<RouteItem[]>(() => {
    const role = profile?.role ?? "";

    // A minimal set that stays consistent across pages.
    if (role === "manager") {
      return [
        {
          label: t("menu.sessions"),
          onPress: () => router.push("/(app)/manager/sessions"),
          isActive: (p) => startsWithAny(p, ["/manager/sessions"]),
        },
        {
          label: t("menu.approve"),
          onPress: () => router.push("/(app)/manager/approve"),
          isActive: (p) => startsWithAny(p, ["/manager/approve"]),
          badgeCount: pendingApproveCount,
        },
        {
          label: t("menu.editUsers"),
          onPress: () => router.push("/(app)/staff/users"),
          isActive: (p) => startsWithAny(p, ["/staff/users", "/staff/profile", "/staff/manual"]),
        },
        {
          label: t("menu.create"),
          onPress: () => router.push("/(app)/manager/create-session"),
          isActive: (p) => startsWithAny(p, ["/manager/create-session"]),
        },
        {
          label: t("menu.history"),
          onPress: () => router.push("/(app)/manager/participant-history"),
          isActive: (p) => startsWithAny(p, ["/manager/participant-history"]),
        },
        {
          label: t("menu.trainerReport"),
          onPress: () => router.push("/(app)/manager/coach-sessions-report"),
          isActive: (p) => startsWithAny(p, ["/manager/coach-sessions-report"]),
        },
        {
          label: t("menu.trainerColors"),
          onPress: () => router.push("/(app)/manager/trainer-colors"),
          isActive: (p) => startsWithAny(p, ["/manager/trainer-colors"]),
        },
        {
          label: t("menu.roles"),
          onPress: () => router.push("/(app)/manager/roles"),
          isActive: (p) => startsWithAny(p, ["/manager/roles"]),
        },
        {
          label: t("menu.openingSchedule"),
          onPress: () => router.push("/(app)/manager/opening-schedule"),
          isActive: (p) => startsWithAny(p, ["/manager/opening-schedule"]),
        },
        {
          label: language === "he" ? t("lang.english") : t("lang.hebrew"),
          onPress: () => toggleLanguage(),
          isActive: () => false,
        },
      ];
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
          label: t("menu.participantHistory"),
          onPress: () => router.push("/(app)/coach/participant-history"),
          isActive: (p) => startsWithAny(p, ["/coach/participant-history"]),
        },
        {
          label: t("menu.createSession"),
          onPress: () => router.push("/(app)/coach/create-session"),
          isActive: (p) => startsWithAny(p, ["/coach/create-session"]),
        },
        {
          label: language === "he" ? t("lang.english") : t("lang.hebrew"),
          onPress: () => toggleLanguage(),
          isActive: () => false,
        },
      ];
    }

    // athlete / pending / unknown
    return [
      {
        label: t("menu.sessions"),
        onPress: () => router.push("/(app)/athlete/sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/sessions"]),
      },
      {
        label: language === "he" ? "האימונים שלי" : "My sessions",
        onPress: () => router.push("/(app)/athlete/my-sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/my-sessions"]),
      },
      {
        label: language === "he" ? t("lang.english") : t("lang.hebrew"),
        onPress: () => toggleLanguage(),
        isActive: () => false,
      },
    ];
  }, [profile?.role, pendingApproveCount, t, language, toggleLanguage]);

  const visible = useMemo(() => items.filter((i) => !i.isActive(pathname)), [items, pathname]);

  return (
    <View style={styles.wrap}>
      <FoldableActionsMenu
        items={visible}
        renderTrigger={(open) => (
          <Pressable
            onPress={open}
            style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
            accessibilityRole="button"
            accessibilityLabel="Open menu"
          >
            <Text style={styles.triggerIcon}>≡</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingLeft: theme.spacing.sm },
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

