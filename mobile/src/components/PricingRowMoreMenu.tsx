import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";

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
  isRTL,
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const triggerRef = useRef<View>(null);

  function openMenu() {
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, width: w, height: h });
      setOpen(true);
    });
  }

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <Pressable
          onPress={openMenu}
          style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel={menuAccessibilityLabel}
        >
          <Text style={styles.triggerTxt}>⋮</Text>
        </Pressable>
      </View>
      <AppModal
        visible={open}
        onClose={() => setOpen(false)}
        variant="popover"
        width={200}
        anchorRect={anchor ?? undefined}
        backdropAccessibilityLabel={closeAccessibilityLabel}
      >
        <View style={styles.menu}>
          <Pressable
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            onPress={() => {
              setOpen(false);
              onEdit();
            }}
            accessibilityRole="button"
            accessibilityLabel={editLabel}
          >
            <Text style={[styles.itemTxt, isRTL && styles.rtl]}>{editLabel}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.item, styles.itemLast, pressed && styles.itemPressed]}
            onPress={() => {
              setOpen(false);
              onRemove();
            }}
            accessibilityRole="button"
            accessibilityLabel={removeLabel}
          >
            <Text style={[styles.itemTxtDanger, isRTL && styles.rtl]}>{removeLabel}</Text>
          </Pressable>
        </View>
      </AppModal>
    </>
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
  menu: { paddingVertical: 4 },
  item: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
  },
  itemLast: { borderBottomWidth: 0 },
  itemPressed: { backgroundColor: theme.colors.surfaceElevated },
  itemTxt: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  itemTxtDanger: { fontSize: 15, fontWeight: "700", color: theme.colors.error },
  rtl: { textAlign: "right" },
});
