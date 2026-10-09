import { router, Stack } from "expo-router";
import { View } from "react-native";
import { EmptyState } from "../src/components/EmptyState";
import { useI18n } from "../src/context/I18nContext";
import { useScreenContentStyle } from "../src/hooks/useScreenLayout";
import { theme } from "../src/theme";

/** Unknown URL (old link, typo): replaces Expo Router's English developer page ("Unmatched Route … Sitemap"). */
export default function NotFoundScreen() {
  const { t, isRTL } = useI18n();
  const screenContent = useScreenContentStyle("standard");
  return (
    <View style={[{ flex: 1, backgroundColor: theme.colors.backgroundAlt, justifyContent: "center" }, screenContent]}>
      <Stack.Screen options={{ title: t("errors.notFoundTitle") }} />
      <EmptyState
        tone="notFound"
        title={t("errors.notFoundTitle")}
        body={t("errors.notFound")}
        actionLabel={t("common.back")}
        onAction={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        isRTL={isRTL}
      />
    </View>
  );
}
