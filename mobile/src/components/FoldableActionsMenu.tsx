import { ReactNode, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { theme } from "../theme";
import { ActionButton } from "./ActionButton";

export type FoldableActionsMenuItem = {
  label: string;
  onPress: () => void;
  badgeCount?: number;
  /** Screen reader label; defaults to `label`. */
  accessibilityLabel?: string;
};

type Props = {
  label?: string;
  items: FoldableActionsMenuItem[];
  renderTrigger?: (open: () => void) => ReactNode;
  /** Announced for the full-screen dismiss layer (required for i18n). */
  backdropAccessibilityLabel: string;
  /** Hide the small header row (e.g. "Menu"). */
  hideHeader?: boolean;
  /** Hide the close (X) button in the header row. */
  hideCloseButton?: boolean;
  /** When the key changes (usually route change), close the menu to avoid blocking scroll. */
  closeOnKey?: string;
};

export function FoldableActionsMenu({
  label = "Menu",
  items,
  renderTrigger,
  backdropAccessibilityLabel,
  hideHeader,
  hideCloseButton,
  closeOnKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(280, Math.max(200, Math.round(width * 0.78)));

  const safeItems = useMemo(() => items.filter((i) => i.label.trim().length > 0), [items]);

  useEffect(() => {
    // Close on navigation changes so the modal backdrop doesn't "freeze" the UI.
    setOpen(false);
  }, [closeOnKey]);

  return (
    <>
      {renderTrigger ? renderTrigger(() => setOpen(true)) : <ActionButton label={label} onPress={() => setOpen(true)} />}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          {/* Separate overlay avoids nested <button> on react-native-web */}
          <Pressable
            style={styles.overlay}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel={backdropAccessibilityLabel}
          />
          <View style={[styles.card, { width: cardWidth }]}>
            {!hideHeader ? (
              <View style={styles.cardHeader}>
                <Text style={styles.cardHeaderTxt} numberOfLines={1}>
                  {label}
                </Text>
                {!hideCloseButton ? (
                  <Pressable
                    onPress={() => setOpen(false)}
                    style={({ pressed }) => [styles.cardClose, pressed && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Close menu"
                  >
                    <Text style={styles.cardCloseTxt}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {safeItems.map((item) => (
              <Pressable
                key={item.label}
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                onPress={() => {
                  setOpen(false);
                  item.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={item.accessibilityLabel ?? item.label}
              >
                <View style={styles.itemRow}>
                  <Text style={styles.itemText}>{item.label}</Text>
                  {item.badgeCount && item.badgeCount > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeTxt}>
                        {item.badgeCount > 99 ? "99+" : String(item.badgeCount)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    padding: theme.spacing.md,
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.backgroundAlt,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardHeader: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  cardHeaderTxt: { color: theme.colors.textMuted, fontWeight: "900", letterSpacing: 0.2, fontSize: 12, textTransform: "uppercase", maxWidth: "70%" },
  cardClose: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  cardCloseTxt: { color: theme.colors.textMuted, fontWeight: "900" },
  item: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderMuted,
  },
  itemRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  itemPressed: { backgroundColor: theme.colors.surfaceElevated },
  itemText: { color: theme.colors.text, fontWeight: "700", fontSize: 14, letterSpacing: 0.2 },
  badge: {
    minWidth: 22,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.error,
  },
  badgeTxt: { color: "#fff", fontWeight: "900", fontSize: 11, letterSpacing: 0.2 },
});

