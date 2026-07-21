import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { ManagerMoneyHubTabs } from "../components/ManagerOverviewTabs";
import { SlidingPillTabBar } from "../components/SlidingPillTabBar";
import { FadeSlideIn } from "../components/FadeSlideIn";
import SessionPricingScreen from "./SessionPricingScreen";
import CoachCapacityPricingScreen from "./CoachCapacityPricingScreen";

type Tab = "session" | "coach";

export function PricingHubScreen({ variant }: { variant: "manager" | "coach" }) {
  const { t, isRTL } = useI18n();
  const { profile } = useAuth();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const initial = (tab === "coach" ? "coach" : "session") as Tab;
  const [active, setActive] = useState<Tab>(initial);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setActive((tab === "coach" ? "coach" : "session") as Tab);
  }, [tab]);

  const tabs = useMemo(
    () =>
      [
        { id: "session" as const, label: t("menu.sessionPricing") },
        {
          id: "coach" as const,
          label: variant === "manager" ? t("menu.coachSessionPricing") : t("menu.myCoachSessionPricing"),
        },
      ] satisfies { id: Tab; label: string }[],
    [t, variant],
  );

  return (
    <View style={styles.screen}>
      {variant === "manager" ? <ManagerMoneyHubTabs /> : null}
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.pricingHub")}</Text>

      <SlidingPillTabBar
        tabs={tabs}
        active={active}
        onChange={(id) => setActive(id as Tab)}
        style={styles.tabBar}
      />

      <FadeSlideIn key={active} style={styles.body}>
        {active === "session" ? (
          <SessionPricingScreen hideIntro />
        ) : variant === "manager" ? (
          <CoachCapacityPricingScreen allowCoachPicker hideIntro />
        ) : (
          <CoachCapacityPricingScreen lockedCoachId={profile?.user_id ?? null} hideIntro />
        )}
      </FadeSlideIn>
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  scroll: { flex: 1 },
  content: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm, paddingBottom: 40 },
  rtl: { textAlign: "right", alignSelf: "stretch" },
  title: { fontSize: 18, fontWeight: "900", color: theme.colors.text, marginBottom: 10 },

  tabBar: { marginBottom: theme.spacing.md },

  body: { marginTop: 4, gap: 0 },
});
