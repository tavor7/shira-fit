import { Tabs } from "expo-router";
import { theme } from "../../../src/theme";
import { useI18n } from "../../../src/context/I18nContext";

/**
 * Athlete home: browse vs. my sessions live as stack routes reachable from the header menu.
 * The bottom tab bar is hidden on every platform (web already hid it — native now matches).
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
        tabBarStyle: { display: "none" as const, height: 0, overflow: "hidden" },
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
