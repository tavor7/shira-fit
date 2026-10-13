import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AppIconName } from "./AppIcon";
import { Animated, type LayoutChangeEvent, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { theme } from "../theme";
import { selectionA11y } from "../lib/a11ySelection";
import { EdgeFade, useHorizontalOverflow } from "./ScrollEdgeFade";
import { useScreenContentStyle } from "../hooks/useScreenLayout";
import { useI18n } from "../context/I18nContext";
import { logRedirectToManagerSessions } from "../lib/managerSessionsRedirectLog";
import { useAuth } from "../context/AuthContext";
import { useReduceMotionRef } from "../hooks/useReduceMotion";
import { rowFlipFor } from "../lib/layoutDirection";

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

/** Edge fade (28px) + a little air, so the revealed tab never sits under the fade. */
const REVEAL_PAD = 36;

type PillTabCoreProps = {
  tabs: { id: string; label: string }[];
  activeId: string;
  onPressTab: (id: string) => void;
  density?: TabDensity;
};

function PillTabBarCore({ tabs, activeId, onPressTab, density = "comfortable" }: PillTabCoreProps) {
  const { isRTL } = useI18n();
  const compact = density === "compact";
  const scrollRef = useRef<ScrollView>(null);
  const tabRefs = useRef<Record<string, View | null>>({});
  const revealedRef = useRef<string | null>(null);
  const { edges, scrollProps } = useHorizontalOverflow(isRTL);

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

  /**
   * Keep the active tab fully visible when the row scrolls (phones, long Hebrew/English labels) — clear of the
   * edge fade, not just "nearest" (which left WhatsApp / Legal / Subscriptions half under the fade). Web scrolls
   * only the strip itself by the distance the tab sits outside it, so the page never jumps.
   */
  const reveal = useCallback((id: string) => {
    revealedRef.current = id;
    if (Platform.OS === "web") {
      const node = tabRefs.current[id] as unknown as HTMLElement | null;
      const strip = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement } | null)?.getScrollableNode?.();
      if (!node?.getBoundingClientRect || !strip?.getBoundingClientRect) return;
      const a = node.getBoundingClientRect();
      const b = strip.getBoundingClientRect();
      const pad = REVEAL_PAD;
      const dx = a.left < b.left + pad ? a.left - b.left - pad : a.right > b.right - pad ? a.right - b.right + pad : 0;
      if (dx) strip.scrollBy({ left: dx, behavior: reduceMotionRef.current ? "auto" : "smooth" });
      return;
    }
    const l = layouts.current[id];
    if (l) scrollRef.current?.scrollTo({ x: Math.max(0, l.x - REVEAL_PAD), animated: false });
  }, [reduceMotionRef]);

  useEffect(() => {
    if (hasPositionedRef.current) moveTo(activeId, true);
    // Selecting a tab (state tabs) also brings it fully into view, not only the first layout.
    if (hasPositionedRef.current) reveal(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleLayout = (id: string) => (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    const prev = layouts.current[id];
    layouts.current[id] = { x, y, width, height };
    if (id === activeId && (!prev || prev.x !== x || prev.y !== y || prev.width !== width)) {
      moveTo(id, false);
    }
    if (id === activeId && revealedRef.current !== activeId) reveal(id);
  };

  return (
    <View style={styles.strip}>
      {/* One scrollable row: wrapping onto a second row made the tabs jump between screens on phones. */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        {...scrollProps}
      >
      <View style={[styles.row, rowFlipFor(isRTL) && styles.rowRtl]} accessibilityRole="tablist">
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
              ref={(node) => {
                tabRefs.current[x.id] = node;
              }}
              onLayout={handleLayout(x.id)}
              onPress={() => onPressTab(x.id)}
              style={({ pressed }) => [
                compact ? styles.tabCompact : styles.tab,
                pressed && !active && styles.tabPressed,
              ]}
              {...selectionA11y("tab", active)}
              accessibilityLabel={x.label}
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
      </ScrollView>
      <EdgeFade side="start" visible={edges.start} isRTL={isRTL} />
      <EdgeFade side="end" visible={edges.end} isRTL={isRTL} />
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
    flexWrap: "nowrap",
    alignItems: "flex-end",
    gap: 2,
  },
  scrollContent: { flexGrow: 1 },
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
    minHeight: theme.controls.minTouch,
    justifyContent: "flex-end",
  },
  tabPressed: { opacity: 0.55 },
  label: {
    ...theme.typography.secondary,
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

/** Money hub: payments, receipts, pricing (shown under the Money main tab). */
export function ManagerMoneyHubTabs() {
  const { t } = useI18n();
  /** Always rendered above the screen's scroll content, so it frames itself like that content (all money screens are standard width). */
  const shell = useScreenContentStyle("standard", { scrolls: false });

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
      {
        id: "subscriptions",
        label: t("menu.subscriptions"),
        href: "/(app)/manager/subscriptions",
        isActive: (p) => startsWithAny(p, ["/manager/subscriptions"]),
      },
    ],
    [t]
  );

  return (
    <View style={[shell, { paddingTop: theme.spacing.md }]}>
      <ManagerPillTabBar tabs={tabs} density="comfortable" />
    </View>
  );
}

/** Below this width Studio setup is an index list with drill-down instead of a tab strip (Phase 5 / H). */
export const STUDIO_SETUP_INDEX_MAX_WIDTH = 768;

export type StudioSetupItem = ManagerPillTabItem & { icon: AppIconName; description: string };

/** Studio setup destinations — shared by the tab strip (wider screens) and the mobile index. */
export function useStudioSetupItems(): StudioSetupItem[] {
  const { t } = useI18n();
  return useMemo<StudioSetupItem[]>(
    () => [
      {
        id: "users",
        label: t("menu.editUsers"),
        icon: "people-outline",
        description: t("setup.desc.users"),
        href: "/(app)/staff/users",
        isActive: (p) => startsWithAny(p, ["/staff/users", "/staff/profile", "/staff/manual"]),
      },
      {
        id: "families",
        label: t("menu.families"),
        icon: "home-outline",
        description: t("setup.desc.families"),
        href: "/(app)/manager/families",
        isActive: (p) => startsWithAny(p, ["/manager/families"]),
      },
      {
        id: "subscriptions",
        label: t("menu.subscriptionSettings"),
        icon: "card-outline",
        description: t("setup.desc.subscriptions"),
        href: "/(app)/manager/subscription-settings",
        isActive: (p) => startsWithAny(p, ["/manager/subscription-settings", "/manager/subscription-terms"]),
      },
      {
        id: "opening",
        label: t("menu.openingSchedule"),
        icon: "time-outline",
        description: t("setup.desc.opening"),
        href: "/(app)/manager/opening-schedule",
        isActive: (p) => startsWithAny(p, ["/manager/opening-schedule"]),
      },
      {
        id: "birthdays",
        label: t("menu.birthdayMessages"),
        icon: "gift-outline",
        description: t("setup.desc.birthdays"),
        href: "/(app)/manager/birthday-messages",
        isActive: (p) => startsWithAny(p, ["/manager/birthday-messages"]),
      },
      {
        id: "whatsapp",
        label: t("menu.whatsappRollout"),
        icon: "logo-whatsapp",
        description: t("setup.desc.whatsapp"),
        href: "/(app)/manager/whatsapp-rollout",
        isActive: (p) => startsWithAny(p, ["/manager/whatsapp-rollout"]),
      },
      {
        id: "legal",
        label: t("menu.legalSettings"),
        icon: "shield-checkmark-outline",
        description: t("setup.desc.legal"),
        href: "/(app)/manager/legal-settings",
        isActive: (p) => startsWithAny(p, ["/manager/legal-settings"]),
      },
    ],
    [t]
  );
}

/** Studio setup tab strip — wider screens only; phones get the index (app/(app)/manager/setup) and Back instead. */
export function ManagerStudioSetupTabs() {
  const tabs = useStudioSetupItems();
  const { width } = useWindowDimensions();
  if (width < STUDIO_SETUP_INDEX_MAX_WIDTH) return null;
  return <ManagerPillTabBar tabs={tabs} density="compact" />;
}
