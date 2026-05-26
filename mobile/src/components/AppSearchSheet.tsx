import { ReactNode, useEffect, useMemo, useState } from "react";
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
import { SearchSheetFocusContext } from "../context/SearchSheetFocusContext";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { theme } from "../theme";

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
  /** Optional line under the title (stays visible while typing). */
  subtitle?: string;
  dismissLabel: string;
  isRTL?: boolean;
  backdropAccessibilityLabel?: string;
  /** Renders above the search field (e.g. quick-add panel). Hidden while typing. */
  headerExtra?: ReactNode;
  search?: ReactNode;
  loading?: boolean;
  /** Fraction of window height for the sheet (default 0.85). */
  sheetHeightPct?: number;
  /** Hide {@link headerExtra} while the keyboard is open to leave room for search + results. */
  hideHeaderExtraOnKeyboard?: boolean;
  cardStyle?: StyleProp<ViewStyle>;
} & (
  | ({ results: ReactNode } & Partial<Record<keyof ListProps<T>, never>>)
  | ({ results?: undefined } & ListProps<T>)
);

export function AppSearchSheet<T>({
  visible,
  onClose,
  title,
  subtitle,
  dismissLabel,
  isRTL,
  backdropAccessibilityLabel,
  headerExtra,
  search,
  loading = false,
  sheetHeightPct = 0.85,
  hideHeaderExtraOnKeyboard = true,
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
  const [searchFocused, setSearchFocused] = useState(false);

  useEffect(() => {
    if (!visible) setSearchFocused(false);
  }, [visible]);

  const keyboardOpen = keyboardInset > 0 || searchFocused;

  const layoutKeyboardInset = useMemo(() => {
    if (keyboardInset > 0) return keyboardInset;
    if (!searchFocused) return 0;
    return Math.min(Math.round(windowHeight * 0.42) + 52, 600);
  }, [keyboardInset, searchFocused, windowHeight]);

  const sheetHeight = useMemo(() => {
    const topRoom = Math.max(insets.top, 8) + 8;
    const cap = Math.round(windowHeight * sheetHeightPct);
    const available = windowHeight - layoutKeyboardInset - topRoom;
    if (keyboardOpen) {
      return Math.max(220, Math.min(cap, available));
    }
    return Math.min(cap, windowHeight - topRoom);
  }, [windowHeight, sheetHeightPct, insets.top, layoutKeyboardInset, keyboardOpen]);

  const bottomPad = keyboardOpen ? 8 : Math.max(insets.bottom, theme.spacing.md);
  const showHeaderExtra = headerExtra != null && !(hideHeaderExtraOnKeyboard && keyboardOpen);
  const searchInResults = keyboardOpen && search != null;

  const focusContext = useMemo(
    () => ({
      registerFocus: () => setSearchFocused(true),
      /** Clears focus latch only; layout stays compact while {@link keyboardInset} &gt; 0. */
      registerBlur: () => setSearchFocused(false),
      isCompact: keyboardOpen,
    }),
    [keyboardOpen]
  );

  const searchInList = searchInResults ? <View style={styles.searchInList}>{search}</View> : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <SearchSheetFocusContext.Provider value={focusContext}>
        <View style={styles.backdrop}>
          <Pressable
            style={styles.backdropTouch}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={backdropAccessibilityLabel ?? dismissLabel}
          />
          <View
            style={[
              styles.sheet,
              { height: sheetHeight, paddingBottom: bottomPad, marginBottom: layoutKeyboardInset },
              cardStyle,
            ]}
          >
            <View style={[styles.header, isRTL && styles.headerRtl]}>
              <View style={styles.headerText}>
                <Text style={[styles.title, isRTL && styles.rtlText]} numberOfLines={2}>
                  {title}
                </Text>
                {subtitle?.trim() ? (
                  <Text style={[styles.subtitle, isRTL && styles.rtlText]} numberOfLines={2}>
                    {subtitle.trim()}
                  </Text>
                ) : null}
              </View>
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={dismissLabel}>
                <Text style={styles.dismiss}>{dismissLabel}</Text>
              </Pressable>
            </View>

            {showHeaderExtra ? <View style={styles.headerExtra}>{headerExtra}</View> : null}

            {!searchInResults && search != null ? <View style={styles.searchWrap}>{search}</View> : null}

            <View style={[styles.resultsArea, keyboardOpen && styles.resultsAreaKeyboard]}>
              {loading ? (
                <ActivityIndicator
                  size="large"
                  color={theme.colors.cta}
                  style={styles.loader}
                  accessibilityLabel="Loading"
                />
              ) : results != null ? (
                <View style={styles.resultsFlex}>
                  {searchInList}
                  <View style={styles.resultsFlexInner}>{results}</View>
                </View>
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
                  ListHeaderComponent={searchInList ?? undefined}
                  ListEmptyComponent={
                    ListEmptyComponent != null ? () => <>{ListEmptyComponent}</> : undefined
                  }
                />
              ) : null}
            </View>
          </View>
        </View>
      </SearchSheetFocusContext.Provider>
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
    flexDirection: "column",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderMuted,
    flexShrink: 0,
    gap: theme.spacing.sm,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerText: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.2,
    color: theme.colors.text,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 18,
  },
  dismiss: { fontSize: 16, color: theme.colors.textMuted, fontWeight: "800" },
  rtlText: { textAlign: "right", writingDirection: "rtl" },
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
  searchInList: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  resultsArea: {
    flex: 1,
    minHeight: 0,
  },
  resultsAreaKeyboard: {
    minHeight: 120,
    ...(Platform.OS === "web" ? { minHeight: 100 } : {}),
  },
  resultsFlex: {
    flex: 1,
    minHeight: 0,
  },
  resultsFlexInner: {
    flex: 1,
    minHeight: 0,
  },
  loader: { flex: 1, justifyContent: "center", paddingVertical: theme.spacing.xl },
  list: { flex: 1 },
  listContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing.sm,
  },
});
