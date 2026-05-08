import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";

export type ManagerPillTabItem = {
  id: string;
  label: string;
  href: Href;
  isActive: (pathname: string) => boolean;
};

function startsWithAny(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

type TabDensity = "comfortable" | "compact";

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
  const { language, isRTL } = useI18n();

  const activeId = tabs.find((x) => x.isActive(pathname))?.id ?? tabs[0]?.id ?? "";
  const compact = density === "compact";

  return (
    <View style={styles.strip}>
      <View style={[styles.row, isRTL && styles.rowRtl]}>
        {tabs.map((x) => {
          const active = x.id === activeId;
          return (
            <Pressable
              key={x.id}
              onPress={() => router.replace(x.href)}
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
              <View style={[compact ? styles.indicatorCompact : styles.indicator, active && styles.indicatorActive]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
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
  indicator: {
    marginTop: 8,
    height: 2,
    borderRadius: 2,
    backgroundColor: "transparent",
    alignSelf: "stretch",
  },
  indicatorCompact: {
    marginTop: 6,
    height: 2,
    borderRadius: 2,
    backgroundColor: "transparent",
    alignSelf: "stretch",
  },
  indicatorActive: {
    backgroundColor: theme.colors.cta,
  },
});

/** Main overview: dashboard, activity log, reports (no link to setup — use the menu). */
export function ManagerOverviewHubTabs() {
  const { t } = useI18n();

  const tabs = useMemo<ManagerPillTabItem[]>(
    () => [
      {
        id: "overview",
        label: t("menu.overview"),
        href: "/(app)/manager/dashboard",
        isActive: (p) => startsWithAny(p, ["/manager/dashboard", "/manager/weekly-detail"]),
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

/** Studio setup: edit users, colors, roles, pricing, opening (no link back to overview — use the menu). */
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
        id: "pricing",
        label: t("menu.pricingHub"),
        href: "/(app)/manager/pricing",
        isActive: (p) => startsWithAny(p, ["/manager/pricing", "/manager/coach-capacity-pricing"]),
      },
      {
        id: "opening",
        label: t("menu.openingSchedule"),
        href: "/(app)/manager/opening-schedule",
        isActive: (p) => startsWithAny(p, ["/manager/opening-schedule"]),
      },
    ],
    [t]
  );

  return <ManagerPillTabBar tabs={tabs} density="compact" />;
}
