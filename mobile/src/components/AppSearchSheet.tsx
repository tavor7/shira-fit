import { ReactNode, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ListRenderItem,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { useKeyboardInset } from "../hooks/useKeyboardInset";

type ListProps<T> = {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: ListRenderItem<T>;
  ListEmptyComponent?: ReactNode;
};

type Props<T> = {
  visible: boolean;
  onClose: () => void;
  title: string;
  dismissLabel: string;
  isRTL?: boolean;
  backdropAccessibilityLabel?: string;
  /** Renders above the search field (e.g. quick-add panel). */
  headerExtra?: ReactNode;
  search: ReactNode;
  loading?: boolean;
  /** Fraction of window height for the sheet (default 0.85). */
  sheetHeightPct?: number;
  cardStyle?: StyleProp<ViewStyle>;
} & (
  | ({ results: ReactNode } & Partial<Record<keyof ListProps<T>, never>>)
  | ({ results?: undefined } & ListProps<T>)
);

export function AppSearchSheet<T>({
  visible,
  onClose,
  title,
  dismissLabel,
  isRTL,
  backdropAccessibilityLabel,
  headerExtra,
  search,
  loading = false,
  sheetHeightPct = 0.85,
  cardStyle,
  results,
  data,
  keyExtractor,
  renderItem,
  ListEmptyComponent,
}: Props<T>) {
  const insets = useSafeAreaInsets();
  const keyboardInset = useKeyboardInset();
  const { height: windowHeight } = useWindowDimensions();

  const sheetHeight = useMemo(() => {
    const cap = Math.round(windowHeight * sheetHeightPct);
    const topRoom = Math.max(insets.top, 8) + 12;
    const withKeyboard = keyboardInset > 0 ? windowHeight - keyboardInset - topRoom : cap;
    return Math.max(280, Math.min(cap, withKeyboard));
  }, [windowHeight, sheetHeightPct, insets.top, keyboardInset]);

  const bottomPad = keyboardInset > 0 ? 8 : Math.max(insets.bottom, theme.spacing.md);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable
          style={styles.backdropTouch}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={backdropAccessibilityLabel ?? dismissLabel}
        />
        <View style={[styles.sheet, { height: sheetHeight, paddingBottom: bottomPad }, cardStyle]}>
          <View style={[styles.header, isRTL && styles.headerRtl]}>
            <Text style={[styles.title, isRTL && styles.rtlText]} numberOfLines={2}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={dismissLabel}>
              <Text style={styles.dismiss}>{dismissLabel}</Text>
            </Pressable>
          </View>

          {headerExtra ? <View style={styles.headerExtra}>{headerExtra}</View> : null}

          <View style={styles.searchWrap}>{search}</View>

          <View style={styles.resultsArea}>
            {loading ? (
              <ActivityIndicator
                size="large"
                color={theme.colors.cta}
                style={styles.loader}
                accessibilityLabel="Loading"
              />
            ) : results != null ? (
              results
            ) : data != null && keyExtractor != null && renderItem != null ? (
              <FlatList
                style={styles.list}
                contentContainerStyle={styles.listContent}
                data={data}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator
                ListEmptyComponent={
                  ListEmptyComponent != null
                    ? () => <>{ListEmptyComponent}</>
                    : undefined
                }
              />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  backdropTouch: { ...StyleSheet.absoluteFillObject },
  sheet: {
    width: "100%",
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: theme.colors.borderMuted,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
    flexShrink: 0,
  },
  headerRtl: { flexDirection: "row-reverse" },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.2,
    color: theme.colors.text,
    marginEnd: theme.spacing.sm,
  },
  dismiss: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "800" },
  rtlText: { textAlign: "right" },
  headerExtra: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  searchWrap: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  resultsArea: {
    flex: 1,
    minHeight: 140,
    ...(Platform.OS === "web" ? { minHeight: 160 } : {}),
  },
  loader: { flex: 1, justifyContent: "center", paddingVertical: theme.spacing.xl },
  list: { flex: 1 },
  listContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing.sm,
  },
});
