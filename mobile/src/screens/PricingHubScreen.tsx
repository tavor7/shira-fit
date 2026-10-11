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
import { SubscriptionPriceDefaultsSection } from "../components/subscriptions/SubscriptionPriceDefaultsSection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

type Tab = "session" | "coach" | "subscriptions";

export function PricingHubScreen({ variant }: { variant: "manager" | "coach" }) {
  const { t, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("standard");
  const { profile } = useAuth();
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  // Coaches only see their own pay rates, read-only (compensation is written by managers only); studio session pricing is manager-only.
  const tabFromParam = (): Tab =>
    variant === "coach" || tab === "coach" ? "coach" : tab === "subscriptions" ? "subscriptions" : "session";
  const initial = tabFromParam();
  const [active, setActive] = useState<Tab>(initial);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setActive(tabFromParam());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, variant]);

  const tabs = useMemo(
    () =>
      (
        [
          { id: "session" as const, label: t("menu.sessionPricing") },
          {
            id: "coach" as const,
            label: variant === "manager" ? t("menu.coachSessionPricing") : t("menu.myCoachSessionPricing"),
          },
          // Manager-only: default subscription prices (server-side manager-only RLS as well).
          { id: "subscriptions" as const, label: t("menu.subscriptionPricing") },
        ] satisfies { id: Tab; label: string }[]
      ).filter((x) => (variant === "manager" ? true : x.id === "coach")),
    [t, variant],
  );

  return (
    <View style={styles.screen}>
      {variant === "manager" ? <ManagerMoneyHubTabs /> : null}
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={[styles.content, screenContent]} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, isRTL && styles.rtl]}>{t("menu.pricingHub")}</Text>

      {tabs.length > 1 ? (
        <SlidingPillTabBar
          tabs={tabs}
          active={active}
          onChange={(id) => setActive(id as Tab)}
          style={styles.tabBar}
        />
      ) : null}

      <FadeSlideIn key={active} style={styles.body}>
        {active === "session" ? (
          <SessionPricingScreen hideIntro />
        ) : active === "subscriptions" && variant === "manager" ? (
          <SubscriptionPriceDefaultsSection />
        ) : variant === "manager" ? (
          <CoachCapacityPricingScreen allowCoachPicker hideIntro />
        ) : (
          <CoachCapacityPricingScreen lockedCoachId={profile?.user_id ?? null} hideIntro readOnly />
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
  title: { ...theme.typography.headline, color: theme.colors.text, marginBottom: 10 },

  tabBar: { marginBottom: theme.spacing.md },

  body: { marginTop: 4, gap: 0 },
});
