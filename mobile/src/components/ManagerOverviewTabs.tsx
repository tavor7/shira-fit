import { useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { logRedirectToManagerSessions } from "../lib/managerSessionsRedirectLog";
import { useAuth } from "../context/AuthContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";

export type ManagerPillTabItem = {
  id: string;
  label: string;
  href: Href;
  isActive: (pathname: string) => boolean;
};

function normalizePathname(pathname: string): string {
  const stripped = pathname.replace(/^\/\([^/]+\)/, "");
  return stripped || "/";
}

function startsWithAny(pathname: string, prefixes: string[]) {
  const p = normalizePathname(pathname);
  return prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

type TabDensity = "comfortable" | "compact";

type PillTabCoreProps = {
  tabs: { id: string; label: string }[];
  activeId: string;
  onPressTab: (id: string) => void;
  density?: TabDensity;
};

function PillTabBarCore({ tabs, activeId, onPressTab, density = "comfortable" }: PillTabCoreProps) {
  const { language, isRTL } = useI18n();
  const compact = density === "compact";

  // A thin underline slides + resizes to the measured active-tab position — the same idiom
  // as the tab bar pill, just an underline instead of a filled pill. Slides when the same
  // instance's activeId changes (state tabs); a freshly-mounted instance (route tabs remount
  // per screen) has no prior position to slide from, so it's placed instantly instead of
  // sliding in from an arbitrary spot.
  const layouts = useRef<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const indicatorX = useRef(new Animated.Value(0)).current;
  const indicatorW = useRef(new Animated.Value(0)).current;
  const indicatorY = useRef(new Animated.Value(0)).current;
  const indicatorOpacity = useRef(new Animated.Value(0)).current;
  const hasPositionedRef = useRef(false);
  const reduceMotionRef = useReduceMotionRef();

  const moveTo = useCallback(
    (id: string, animate: boolean) => {
      const l = layouts.current[id];
      if (!l) return;
      const anims = [
        [indicatorX, l.x],
        [indicatorW, l.width],
        [indicatorY, l.y + l.height - 2],
      ] as const;
      if (animate && !reduceMotionRef.current) {
        Animated.parallel(
          anims.map(([val, target]) =>
            Animated.timing(val, {
              toValue: target,
              duration: theme.motion.normal,
              easing: theme.motion.easeOut,
              useNativeDriver: false,
            })
          )
        ).start();
      } else {
        anims.forEach(([val, target]) => val.setValue(target));
      }
      if (!hasPositionedRef.current) {
        hasPositionedRef.current = true;
        Animated.timing(indicatorOpacity, {
          toValue: 1,
          duration: theme.motion.fast,
          easing: theme.motion.easeOut,
          useNativeDriver: false,
        }).start();
      }
    },
    [indicatorX, indicatorW, indicatorY, indicatorOpacity, reduceMotionRef]
  );

  useEffect(() => {
    if (hasPositionedRef.current) moveTo(activeId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleLayout = (id: string) => (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    const prev = layouts.current[id];
    layouts.current[id] = { x, y, width, height };
    if (id === activeId && (!prev || prev.x !== x || prev.y !== y || prev.width !== width)) {
      moveTo(id, false);
    }
  };

  return (
    <View style={styles.strip}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.underlineShared,
            {
              transform: [{ translateX: indicatorX }, { translateY: indicatorY }],
              width: indicatorW,
              opacity: indicatorOpacity,
            },
          ]}
        />
        {tabs.map((x) => {
          const active = x.id === activeId;
          return (
            <Pressable
              key={x.id}
              onLayout={handleLayout(x.id)}
              onPress={() => onPressTab(x.id)}
              style={({ pressed }) => [
                compact ? styles.tabCompact : styles.tab,
                pressed && !active && styles.tabPressed,
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={language === "he" ? `מעבר ל-${x.label}` : `Go to ${x.label}`}
            >
              <Text
                style={[compact ? styles.labelCompact : styles.label, active && styles.labelActive]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {x.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Minimal underline tabs — text + thin accent bar (no pill boxes).
 * Overview uses comfortable spacing; setup uses compact for more labels per row.
 */
export function ManagerPillTabBar({
  tabs,
  density = "comfortable",
}: {
  tabs: ManagerPillTabItem[];
  density?: TabDensity;
}) {
  const pathname = usePathname() ?? "";
  const { loading: authLoading, user, profile } = useAuth();

  const activeId = tabs.find((x) => x.isActive(normalizePathname(pathname)))?.id ?? tabs[0]?.id ?? "";

  return (
    <PillTabBarCore
      tabs={tabs}
      activeId={activeId}
      density={density}
      onPressTab={(id) => {
        const tab = tabs.find((x) => x.id === id);
        if (!tab) return;
        if (tab.href === "/(app)/manager/sessions") {
          logRedirectToManagerSessions("src/components/ManagerOverviewTabs.tsx", "overview_tab_sessions", {
            authLoading,
            authUserId: user?.id ?? null,
            profileRole: profile?.role ?? null,
          });
        }
        router.replace(tab.href);
      }}
    />
  );
}

/** Same look as route tabs, for in-screen section switching. */
export function ManagerStatePillTabBar({
  tabs,
  active,
  onChange,
  density = "comfortable",
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  density?: TabDensity;
}) {
  return <PillTabBarCore tabs={tabs} activeId={active} onPressTab={onChange} density={density} />;
}

const styles = StyleSheet.create({
  strip: {
    alignSelf: "stretch",
    marginBottom: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: 2,
    rowGap: 0,
  },
  rowRtl: { flexDirection: "row-reverse" },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: "flex-end",
  },
  tabCompact: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 42,
    justifyContent: "flex-end",
  },
  tabPressed: { opacity: 0.55 },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.textMuted,
    letterSpacing: 0.1,
  },
  labelCompact: {
    fontSize: 12.5,
    fontWeight: "600",
    color: theme.colors.textMuted,
    letterSpacing: 0.12,
  },
  labelActive: {
    fontWeight: "800",
    color: theme.colors.text,
  },
  underlineShared: {
    position: "absolute",
    top: 0,
    left: 0,
    height: 2,
    borderRadius: 2,
    backgroundColor: theme.colors.cta,
  },
});

/** Main menu: overview, activity log, reports (Money is in the ≡ menu). */
export function ManagerOverviewHubTabs() {
  const { t } = useI18n();

  const tabs = useMemo<ManagerPillTabItem[]>(
    () => [
      {
        id: "overview",
        label: t("menu.overview"),
        href: "/(app)/manager/dashboard",
        isActive: (p) =>
          startsWithAny(p, [
            "/manager/dashboard",
            "/manager/weekly-detail",
            "/manager/finance-daily",
            "/manager/finance-expected",
            "/manager/missing-attendance",
          ]),
      },
      {
        id: "activity",
        label: t("menu.activityLog"),
        href: "/(app)/manager/activity-log",
        isActive: (p) => startsWithAny(p, ["/manager/activity-log"]),
      },
      {
        id: "reports",
        label: t("menu.reports"),
        href: "/(app)/manager/reports",
        isActive: (p) =>
          startsWithAny(p, ["/manager/reports", "/manager/participant-history", "/manager/coach-sessions-report"]),
      },
    ],
    [t]
  );

  return <ManagerPillTabBar tabs={tabs} density="comfortable" />;
}

const moneyHubShell = {
  paddingHorizontal: theme.spacing.md,
  paddingTop: theme.spacing.md,
} as const;

/** Money hub: payments, receipts, pricing (shown under the Money main tab). */
export function ManagerMoneyHubTabs() {
  const { t } = useI18n();

  const tabs = useMemo<ManagerPillTabItem[]>(
    () => [
      {
        id: "payments",
        label: t("menu.accountPayments"),
        href: "/(app)/manager/account-payments",
        isActive: (p) => startsWithAny(p, ["/manager/account-payments"]),
      },
      {
        id: "documents",
        label: t("menu.documentsInvoices"),
        href: "/(app)/manager/documents-invoices",
        isActive: (p) => startsWithAny(p, ["/manager/documents-invoices"]),
      },
      {
        id: "pricing",
        label: t("menu.pricingHub"),
        href: "/(app)/manager/pricing",
        isActive: (p) => startsWithAny(p, ["/manager/pricing", "/manager/coach-capacity-pricing"]),
      },
    ],
    [t]
  );

  return (
    <View style={moneyHubShell}>
      <ManagerPillTabBar tabs={tabs} density="comfortable" />
    </View>
  );
}

/** Studio setup: edit users, colors, roles, opening (no link back to overview — use the menu). */
export function ManagerStudioSetupTabs() {
  const { t } = useI18n();

  const tabs = useMemo<ManagerPillTabItem[]>(
    () => [
      {
        id: "users",
        label: t("menu.editUsers"),
        href: "/(app)/staff/users",
        isActive: (p) => startsWithAny(p, ["/staff/users", "/staff/profile", "/staff/manual"]),
      },
      {
        id: "families",
        label: t("menu.families"),
        href: "/(app)/manager/families",
        isActive: (p) => startsWithAny(p, ["/manager/families"]),
      },
      {
        id: "colors",
        label: t("menu.trainerColors"),
        href: "/(app)/manager/trainer-colors",
        isActive: (p) => startsWithAny(p, ["/manager/trainer-colors"]),
      },
      {
        id: "roles",
        label: t("menu.roles"),
        href: "/(app)/manager/roles",
        isActive: (p) => startsWithAny(p, ["/manager/roles"]),
      },
      {
        id: "opening",
        label: t("menu.openingSchedule"),
        href: "/(app)/manager/opening-schedule",
        isActive: (p) => startsWithAny(p, ["/manager/opening-schedule"]),
      },
      {
        id: "birthdays",
        label: t("menu.birthdayMessages"),
        href: "/(app)/manager/birthday-messages",
        isActive: (p) => startsWithAny(p, ["/manager/birthday-messages"]),
      },
      {
        id: "whatsapp",
        label: t("menu.whatsappRollout"),
        href: "/(app)/manager/whatsapp-rollout",
        isActive: (p) => startsWithAny(p, ["/manager/whatsapp-rollout"]),
      },
    ],
    [t]
  );

  return <ManagerPillTabBar tabs={tabs} density="compact" />;
}
