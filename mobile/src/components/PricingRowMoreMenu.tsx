import { Pressable, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { FoldableActionsMenu } from "./FoldableActionsMenu";
import { AppIcon } from "./AppIcon";

type Props = {
  editLabel: string;
  removeLabel: string;
  onEdit: () => void;
  onRemove: () => void;
  menuAccessibilityLabel: string;
  closeAccessibilityLabel: string;
  isRTL?: boolean;
};

export function PricingRowMoreMenu({
  editLabel,
  removeLabel,
  onEdit,
  onRemove,
  menuAccessibilityLabel,
  closeAccessibilityLabel,
}: Props) {
  return (
    <FoldableActionsMenu
      menuTitle={menuAccessibilityLabel}
      closeAccessibilityLabel={closeAccessibilityLabel}
      backdropAccessibilityLabel={closeAccessibilityLabel}
      hideHeader
      items={[
        { label: editLabel, onPress: onEdit },
        { label: removeLabel, onPress: onRemove, danger: true },
      ]}
      renderTrigger={(open) => (
        <Pressable
          onPress={open}
          style={({ pressed }) => [styles.triggerHit, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel={menuAccessibilityLabel}
        >
          <View style={styles.trigger}>
            <AppIcon name="ellipsis-vertical" size="sm" color={theme.colors.textMuted} />
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  // 36px visual circle inside a 44px hit area (padding cancelled by a negative margin).
  triggerHit: { padding: 4, margin: -4 },
  trigger: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
});
