import { Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { STUDIO_CONTACT, getPrivacyPolicyUrl } from "../constants/studioContact";
import { useI18n } from "../context/I18nContext";

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
  Alert.alert("Cannot open link", "Try again from your phone browser.");
}

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
      <Text style={styles.cellTitle}>{title}</Text>
      <Text style={styles.cellSub} numberOfLines={1}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

export function StudioContactFooter() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 10);

  return (
    <View style={[styles.wrap, { paddingBottom: bottom }]}>
      <View style={styles.row}>
        <Cell
          title="Instagram"
          subtitle="@shira.fit.studio"
          onPress={() => void openUrl(STUDIO_CONTACT.instagramUrl)}
        />
        <View style={styles.divider} />
        <Cell title="Website" subtitle="shira-fit" onPress={() => void openUrl(STUDIO_CONTACT.websiteUrl)} />
        <View style={styles.divider} />
        <Cell title="Call" subtitle={STUDIO_CONTACT.phoneDisplay} onPress={() => void openUrl(STUDIO_CONTACT.phoneTel)} />
      </View>
      <Pressable
        onPress={() => void openUrl(getPrivacyPolicyUrl())}
        style={({ pressed }) => [styles.privacyRow, pressed && styles.cellPressed]}
        accessibilityRole="link"
        accessibilityLabel={t("footer.privacyPolicy")}
      >
        <Text style={styles.privacyTxt}>{t("footer.privacyPolicy")}</Text>
      </Pressable>
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
  },
  cellPressed: { opacity: 0.75 },
  cellTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.text,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  cellSub: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.textMuted,
    letterSpacing: 0.2,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
    marginVertical: 6,
  },
  privacyRow: {
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
  },
  privacyTxt: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textMuted,
    textDecorationLine: "underline",
  },
});
