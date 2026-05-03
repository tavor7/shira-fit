import { Tabs } from "expo-router";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";

/**
 * Athlete home: bottom tabs for browse vs. my sessions (optional IA improvement from UX review).
 * Session detail remains a stack screen (hidden from the tab bar).
 */
export default function AthleteLayout() {
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.text,
        tabBarInactiveTintColor: theme.colors.textSoft,
        tabBarStyle: {
          backgroundColor: theme.colors.backgroundAlt,
          borderTopColor: theme.colors.borderMuted,
        },
        tabBarLabelStyle: { fontWeight: "800", fontSize: 12 },
        tabBarItemStyle: { paddingVertical: 4 },
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: t("tab.athleteBrowse"),
          tabBarLabel: t("tab.athleteBrowse"),
        }}
      />
      <Tabs.Screen
        name="my-sessions"
        options={{
          title: t("tab.athleteMySessions"),
          tabBarLabel: t("tab.athleteMySessions"),
        }}
      />
      <Tabs.Screen name="session/[id]" options={{ href: null }} />
    </Tabs>
  );
}
