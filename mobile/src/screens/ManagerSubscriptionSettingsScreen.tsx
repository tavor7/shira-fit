import { ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { SubscriptionTermsSettingsCard } from "../components/subscriptions/SubscriptionTermsSettingsCard";
import { SubscriptionPriceDefaultsSection } from "../components/subscriptions/SubscriptionPriceDefaultsSection";
import { useScreenContentStyle } from "../hooks/useScreenLayout";

/** Setup -> Subscriptions: the subscription terms (summary + way into management) and the default prices. */
export default function ManagerSubscriptionSettingsScreen() {
  const screenContent = useScreenContentStyle("narrow");
  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.container, screenContent]} keyboardShouldPersistTaps="handled">
      <ManagerStudioSetupTabs />
      <SubscriptionTermsSettingsCard />
      <SubscriptionPriceDefaultsSection />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  container: { padding: theme.spacing.md, gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
});
