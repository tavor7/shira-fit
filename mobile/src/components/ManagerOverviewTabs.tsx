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

const pillStyles = StyleSheet.create({
  trackWrap: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 6,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    marginBottom: theme.spacing.md,
    overflow: "hidden",
    alignSelf: "stretch",
    width: "100%",
  },
  trackRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, rowGap: 6 },
  trackRowRtl: { flexDirection: "row-reverse" },
  slot: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 120,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  slotActive: { backgroundColor: theme.colors.cta, borderColor: theme.colors.cta },
  slotPressed: { opacity: 0.9 },
  txt: { fontWeight: "800", fontSize: 12, color: theme.colors.textMuted, letterSpacing: 0.2 },
  txtActive: { color: theme.colors.ctaText },
});

/**
 * Shared pill tab bar (manager overview hub vs studio setup). Same visuals for both.
 */
export function ManagerPillTabBar({ tabs }: { tabs: ManagerPillTabItem[] }) {
  const pathname = usePathname() ?? "";
  const { language, isRTL } = useI18n();

  const activeId = tabs.find((x) => x.isActive(pathname))?.id ?? tabs[0]?.id ?? "";

  return (
    <View style={pillStyles.trackWrap}>
      <View style={[pillStyles.trackRow, isRTL && pillStyles.trackRowRtl]}>
        {tabs.map((x) => {
          const active = x.id === activeId;
          return (
            <Pressable
              key={x.id}
              onPress={() => router.replace(x.href)}
              style={({ pressed }) => [
                pillStyles.slot,
                active && pillStyles.slotActive,
                pressed && !active && pillStyles.slotPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={language === "he" ? `מעבר ל-${x.label}` : `Go to ${x.label}`}
            >
              <Text style={[pillStyles.txt, active && pillStyles.txtActive]} numberOfLines={1} ellipsizeMode="tail">
                {x.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Main overview: weekly dashboard, activity log, reports — plus entry to studio setup. */
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
      {
        id: "setup",
        label: t("menu.managerSetup"),
        href: "/(app)/staff/users",
        isActive: (p) =>
          startsWithAny(p, [
            "/staff/users",
            "/staff/profile",
            "/staff/manual",
            "/manager/trainer-colors",
            "/manager/roles",
            "/manager/pricing",
            "/manager/coach-capacity-pricing",
            "/manager/opening-schedule",
          ]),
      },
    ],
    [t]
  );

  return <ManagerPillTabBar tabs={tabs} />;
}

/** Studio / admin setup: users, colors, roles, pricing, opening — plus return to main overview. */
export function ManagerStudioSetupTabs() {
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

  return <ManagerPillTabBar tabs={tabs} />;
}
