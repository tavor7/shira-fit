import { Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { STUDIO_CONTACT } from "../constants/studioContact";
import { useAppAlert } from "../context/AppAlertContext";
import { useI18n } from "../context/I18nContext";
import { AppText } from "./AppText";

type CellProps = {
  title: string;
  subtitle: string;
  onPress: () => void;
};

function Cell({ title, subtitle, onPress }: CellProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
      accessibilityRole="link"
      accessibilityLabel={`${title}: ${subtitle}`}
    >
      <AppText variant="label" style={styles.cellTitle}>
        {title}
      </AppText>
      <AppText variant="caption" muted numberOfLines={1} style={styles.cellSub}>
        {subtitle}
      </AppText>
    </Pressable>
  );
}

export function StudioContactFooter() {
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 10);
  const { showOk } = useAppAlert();
  const { t } = useI18n();

  async function openUrl(url: string) {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      /* fall through */
    }
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showOk(t("footer.cannotOpenTitle"), t("footer.cannotOpenBody"));
  }

  return (
    <View style={[styles.wrap, { paddingBottom: bottom }]}>
      <View style={styles.row}>
        <Cell
          title={t("footer.instagram")}
          subtitle="@shira.fit.studio"
          onPress={() => void openUrl(STUDIO_CONTACT.instagramUrl)}
        />
        <View style={styles.divider} />
        <Cell title={t("footer.website")} subtitle="shira-fit" onPress={() => void openUrl(STUDIO_CONTACT.websiteUrl)} />
        <View style={styles.divider} />
        <Cell title={t("footer.call")} subtitle={STUDIO_CONTACT.phoneDisplay} onPress={() => void openUrl(STUDIO_CONTACT.phoneTel)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.backgroundAlt,
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingTop: 12,
    paddingHorizontal: theme.spacing.sm,
  },
  cell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: theme.radius.md,
    minHeight: 44,
  },
  cellPressed: { opacity: 0.75 },
  cellTitle: {
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  cellSub: {
    marginTop: 4,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: 6,
  },
});
