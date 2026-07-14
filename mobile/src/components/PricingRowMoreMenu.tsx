import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { FoldableActionsMenu } from "./FoldableActionsMenu";

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
          style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel={menuAccessibilityLabel}
        >
          <Text style={styles.triggerTxt}>⋮</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
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
  triggerTxt: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.textMuted,
    lineHeight: 20,
    marginTop: -2,
  },
});
