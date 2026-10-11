import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { router, usePathname } from "expo-router";
import { theme } from "../theme";
import { useAuth } from "../context/AuthContext";
import { isAthleteAccountDisabled } from "../lib/profileAccount";
import { FoldableActionsMenu, type FoldableActionsMenuItem } from "./FoldableActionsMenu";
import { supabase } from "../lib/supabase";
import { useI18n } from "../context/I18nContext";
import { useEffectiveNavRole } from "../context/ManagerAthletePreviewContext";
import { rpcGetMySubscription } from "../lib/athleteSubscription";
import type { AppIconName } from "./AppIcon";
import { useStaffRailVisible } from "../hooks/useStaffRail";
import { STUDIO_SETUP_INDEX_MAX_WIDTH } from "./ManagerOverviewTabs";

export type RouteItem = FoldableActionsMenuItem & {
  /** Match current pathname; when true we hide the item (menu) or mark it current (desktop rail). */
  isActive: (pathname: string) => boolean;
  /** Icon for the desktop side rail (Phase 5 / D). */
  icon?: AppIconName;
};

function startsWithAny(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

/** Role-specific destinations — one source for the mobile menu and the desktop staff rail. */
export function useAppNavItems(): { items: RouteItem[]; pathname: string } {
  const { profile } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname() ?? "";
  const { width } = useWindowDimensions();
  const [pendingApproveCount, setPendingApproveCount] = useState(0);
  const [hasSubscription, setHasSubscription] = useState(false);

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

  // "My Subscription" only belongs in this menu for an athlete who actually has one -- an
  // approved, non-disabled athlete with no subscription (the common case, since this is opt-in
  // manager-side) should never see a menu item that only leads to an empty state.
  useEffect(() => {
    const eligible =
      profile?.role === "athlete" && profile?.approval_status === "approved" && !isAthleteAccountDisabled(profile);
    if (!eligible) {
      setHasSubscription(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await rpcGetMySubscription(supabase);
        if (!cancelled) setHasSubscription(res.ok && res.has_subscription === true);
      } catch {
        if (!cancelled) setHasSubscription(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.role, profile?.approval_status, profile?.disabled_at, pathname]);

  const navRole = useEffectiveNavRole(profile);

  const items = useMemo<RouteItem[]>(() => {
    const role = navRole;

    const legalItem: RouteItem = {
      label: t("legal.footerHeading"),
        icon: "document-text-outline",
      onPress: () => router.push("/legal" as never),
      isActive: (p) => startsWithAny(p, ["/legal"]),
    };

    if (profile?.role === "athlete" && (profile?.approval_status === "pending" || isAthleteAccountDisabled(profile))) {
      return [];
    }

    // A minimal set that stays consistent across pages.
    if (role === "manager") {
      const managerItems: RouteItem[] = [
        {
          label: t("menu.sessions"),
        icon: "calendar-outline",
          onPress: () => router.push("/(app)/manager/sessions"),
          isActive: (p) => startsWithAny(p, ["/manager/sessions"]),
        },
        {
          label: t("menu.rosterCalendar"),
        icon: "list-outline",
          onPress: () => router.push("/(app)/manager/roster-calendar"),
          isActive: (p) => startsWithAny(p, ["/manager/roster-calendar"]),
        },
        {
          label: t("menu.overview"),
        icon: "stats-chart-outline",
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
          label: t("menu.money"),
        icon: "wallet-outline",
          onPress: () => router.push("/(app)/manager/account-payments"),
          isActive: (p) =>
            startsWithAny(p, [
              "/manager/account-payments",
              "/manager/documents-invoices",
              "/manager/pricing",
              "/manager/coach-capacity-pricing",
              "/manager/subscriptions",
            ]),
        },
        {
          label: t("menu.managerSetup"),
        icon: "settings-outline",
          onPress: () =>
            router.push((width < STUDIO_SETUP_INDEX_MAX_WIDTH ? "/(app)/manager/setup" : "/(app)/staff/users") as never),
          isActive: (p) =>
            startsWithAny(p, [
              "/manager/setup",
              "/staff/users",
              "/staff/profile",
              "/staff/manual",
              "/manager/families",
              "/manager/opening-schedule",
              "/manager/birthday-messages",
              "/manager/whatsapp-rollout",
              "/manager/legal-settings",
            ]),
        },
        {
          label: t("menu.approve"),
        icon: "person-add-outline",
          onPress: () => router.push("/(app)/manager/approve"),
          isActive: (p) => startsWithAny(p, ["/manager/approve"]),
          badgeCount: pendingApproveCount > 0 ? pendingApproveCount : undefined,
        },
      ];

      if (profile?.is_super_user === true) {
        managerItems.push({
          label: t("menu.superUserHidden"),
        icon: "eye-off-outline",
          onPress: () => router.push("/(app)/super/hidden-workouts" as never),
          isActive: (p) => startsWithAny(p, ["/super/hidden-workouts"]),
        });
      }

      return managerItems;
    }

    if (role === "coach") {
      return [
        {
          label: t("menu.sessions"),
        icon: "calendar-outline",
          onPress: () => router.push("/(app)/coach/sessions"),
          isActive: (p) => startsWithAny(p, ["/coach/sessions"]),
        },
        {
          label: t("menu.editUsers"),
        icon: "people-outline",
          onPress: () => router.push("/(app)/staff/users"),
          isActive: (p) => startsWithAny(p, ["/staff/users", "/staff/profile", "/staff/manual"]),
        },
        {
          label: t("menu.search"),
        icon: "search-outline",
          onPress: () => router.push("/(app)/staff/search"),
          isActive: (p) => startsWithAny(p, ["/staff/search"]),
        },
        {
          label: t("menu.participantHistory"),
        icon: "time-outline",
          onPress: () => router.push("/(app)/coach/participant-history"),
          isActive: (p) => startsWithAny(p, ["/coach/participant-history"]),
        },
        {
          label: t("menu.pricingHub"),
        icon: "pricetags-outline",
          onPress: () => router.push("/(app)/coach/pricing" as never),
          isActive: (p) => startsWithAny(p, ["/coach/pricing"]),
        },
        {
          label: t("menu.createSession"),
        icon: "add-circle-outline",
          onPress: () => router.push("/(app)/coach/create-session"),
          isActive: (p) => startsWithAny(p, ["/coach/create-session"]),
        },
        legalItem,
      ];
    }

    // athlete / pending / unknown (includes manager in athlete preview)
    const athleteItems: RouteItem[] = [
      {
        label: t("menu.sessions"),
        icon: "calendar-outline",
        onPress: () => router.push("/(app)/athlete/sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/sessions"]),
      },
      {
        label: t("menu.mySessionsShort"),
        icon: "bookmark-outline",
        onPress: () => router.push("/(app)/athlete/my-sessions"),
        isActive: (p) => startsWithAny(p, ["/athlete/my-sessions"]),
      },
    ];
    if (hasSubscription) {
      athleteItems.push({
        label: t("athleteSubscription.title"),
        icon: "card-outline",
        onPress: () => router.push("/(app)/athlete/subscription"),
        isActive: (p) => startsWithAny(p, ["/athlete/subscription"]),
      });
    }
    athleteItems.push(legalItem);
    return athleteItems;
  }, [
    navRole,
    width,
    profile?.role,
    profile?.approval_status,
    pendingApproveCount,
    hasSubscription,
    t,
  ]);

  return { items, pathname };
}

export function GlobalQuickMenu() {
  const { t } = useI18n();
  const openMenuA11y = t("a11y.openMenu");
  const closeMenuA11y = t("a11y.closeMenu");
  const { items, pathname } = useAppNavItems();
  const railVisible = useStaffRailVisible();
  const visible = useMemo(() => items.filter((i) => !i.isActive(pathname)), [items, pathname]);
  // Pending / disabled athletes have no destinations (account actions live in the account menu);
  // on wide staff screens the persistent side rail replaces this menu.
  if (railVisible || visible.length === 0) return null;

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
    height: theme.controls.minTouch,
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
  triggerIcon: { color: theme.colors.text, ...theme.typography.headline, letterSpacing: 0.5, marginTop: -1 },
});