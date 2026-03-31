import { ReactNode, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { ActionButton } from "./ActionButton";

export type FoldableActionsMenuItem = {
  label: string;
  onPress: () => void;
  badgeCount?: number;
};

type Props = {
  label?: string;
  items: FoldableActionsMenuItem[];
  renderTrigger?: (open: () => void) => ReactNode;
};

export function FoldableActionsMenu({ label = "Menu", items, renderTrigger }: Props) {
  const [open, setOpen] = useState(false);

  const safeItems = useMemo(() => items.filter((i) => i.label.trim().length > 0), [items]);

  return (
    <>
      {renderTrigger ? renderTrigger(() => setOpen(true)) : <ActionButton label={label} onPress={() => setOpen(true)} />}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          {/* Separate overlay avoids nested <button> on react-native-web */}
          <Pressable style={styles.overlay} onPress={() => setOpen(false)} accessibilityRole="button" />
          <View style={styles.card}>
            {safeItems.map((item) => (
              <Pressable
                key={item.label}
                style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                onPress={() => {
                  setOpen(false);
                  item.onPress();
                }}
                accessibilityRole="button"
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
    minWidth: 240,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
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

