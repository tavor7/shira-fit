import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { AppIcon } from "./AppIcon";
import { useAppNavItems } from "./GlobalQuickMenu";

/**
 * Persistent staff navigation on wide screens (Phase 5 / D): the same destinations as the ≡ menu,
 * always visible, with the current section marked. Mirrors to the right edge in Hebrew via <html dir>.
 */
export function StaffSideRail() {
  const { t } = useI18n();
  const { items, pathname } = useAppNavItems();
  return (
    <View style={styles.rail} role="navigation" aria-label={t("menu.navTitle")}>
      <Text style={styles.brand} importantForAccessibility="no" accessibilityElementsHidden>
        SHIRA FIT
      </Text>
      <ScrollView contentContainerStyle={styles.list}>
        {items.map((it) => {
          const current = it.isActive(pathname);
          return (
            <Pressable
              key={it.label}
              onPress={it.onPress}
              accessibilityRole="link"
              aria-current={current ? "page" : undefined}
              accessibilityLabel={it.badgeCount ? `${it.label}, ${it.badgeCount}` : it.label}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.item,
                current && styles.itemOn,
                (pressed || hovered) && !current && styles.itemHover,
              ]}
            >
              <AppIcon name={it.icon ?? "ellipse-outline"} size="md" color={current ? theme.colors.text : theme.colors.textMuted} />
              <Text style={[styles.label, current && styles.labelOn]} numberOfLines={1}>
                {it.label}
              </Text>
              {it.badgeCount && it.badgeCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeTxt}>{it.badgeCount > 99 ? "99+" : String(it.badgeCount)}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: 232,
    flexShrink: 0,
    backgroundColor: theme.colors.backgroundAlt,
    borderEndWidth: 1,
    borderEndColor: theme.colors.borderMuted,
    paddingTop: theme.spacing.md,
  },
  brand: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "900",
    fontStyle: "italic",
    letterSpacing: 2,
    paddingHorizontal: theme.spacing.md + 4,
    paddingBottom: theme.spacing.md,
    minHeight: 48,
  },
  list: { paddingHorizontal: theme.spacing.sm, gap: 2, paddingBottom: theme.spacing.lg },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: theme.controls.minTouch + 4,
    paddingHorizontal: 12,
    borderRadius: theme.radius.sm,
  },
  itemOn: { backgroundColor: theme.colors.surfaceElevated },
  itemHover: { backgroundColor: theme.colors.surface },
  label: { flex: 1, color: theme.colors.textMuted, fontSize: 15, fontWeight: "700" },
  labelOn: { color: theme.colors.text },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: theme.colors.cta,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeTxt: { color: theme.colors.ctaText, fontSize: 12, fontWeight: "800" },
});
