import { ReactNode, useEffect, useMemo } from "react";
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
import { useLockBodyScroll } from "../hooks/useLockBodyScroll";
import { useVisibleViewportHeight } from "../hooks/useVisibleViewportHeight";
import { theme } from "../theme";
import { AppSearchField } from "./AppSearchField";

export type AppSearchSheetSearchConfig = {
  value: string;
  onChangeText: (next: string) => void;
  onSearch: (term: string) => void | Promise<void>;
  placeholder?: string;
  debounceMs?: number;
  loading?: boolean;
  editable?: boolean;
  accessibilityLabel?: string;
  autoFocus?: boolean;
};

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
  subtitle?: string;
  dismissLabel: string;
  isRTL?: boolean;
  backdropAccessibilityLabel?: string;
  headerExtra?: ReactNode;
  searchConfig?: AppSearchSheetSearchConfig;
  searchLabel?: string;
  search?: ReactNode;
  sheetHeightPct?: number;
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
  searchConfig,
  searchLabel,
  search,
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
  const visibleHeight = useVisibleViewportHeight();
  const { height: windowHeight } = useWindowDimensions();

  useLockBodyScroll(visible);

  useEffect(() => {
    if (!visible || !searchConfig) return;
    void searchConfig.onSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when sheet opens
  }, [visible]);

  const layoutHeight = Platform.OS === "web" ? visibleHeight : windowHeight;
  const keyboardOpen =
    Platform.OS === "web" ? visibleHeight < windowHeight * 0.92 : keyboardInset > 0;

  const sheetHeight = useMemo(() => {
    const topRoom = Math.max(insets.top, 8) + 8;
    const cap = Math.round(layoutHeight * sheetHeightPct);
    return Math.max(260, Math.min(cap, layoutHeight - topRoom));
  }, [layoutHeight, sheetHeightPct, insets.top]);

  const bottomPad = Math.max(insets.bottom, theme.spacing.md);
  const showHeaderExtra = headerExtra != null && !(hideHeaderExtraOnKeyboard && keyboardOpen);

  const focusContext = useMemo(() => ({ isCompact: keyboardOpen }), [keyboardOpen]);

  const searchNode = searchConfig ? (
    <>
      {searchLabel?.trim() ? (
        <Text style={[styles.searchLabel, isRTL && styles.rtlText]}>{searchLabel.trim()}</Text>
      ) : null}
      <AppSearchField
        value={searchConfig.value}
        onChangeText={searchConfig.onChangeText}
        onSearch={searchConfig.onSearch}
        placeholder={searchConfig.placeholder}
        debounceMs={searchConfig.debounceMs}
        isRTL={isRTL}
        loading={searchConfig.loading}
        editable={searchConfig.editable}
        accessibilityLabel={searchConfig.accessibilityLabel ?? searchConfig.placeholder}
        autoFocus={searchConfig.autoFocus}
      />
    </>
  ) : (
    search
  );

  const listLoading = searchConfig?.loading ?? false;

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
              {
                height: sheetHeight,
                paddingBottom: bottomPad,
                marginBottom: Platform.OS === "web" ? 0 : keyboardInset,
              },
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

            {searchNode != null ? <View style={styles.searchWrap}>{searchNode}</View> : null}

            <View style={styles.resultsArea}>
              {listLoading ? (
                <ActivityIndicator
                  size="small"
                  color={theme.colors.cta}
                  style={styles.loadingBar}
                  accessibilityLabel="Loading"
                />
              ) : null}
              {results != null ? (
                <View style={styles.resultsFlexInner}>{results}</View>
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
    zIndex: 2,
    ...(Platform.OS === "web"
      ? ({
          position: "sticky",
          top: 0,
          backgroundColor: theme.colors.surface,
        } as object)
      : {}),
  },
  searchLabel: {
    fontWeight: "800",
    color: theme.colors.textMuted,
    letterSpacing: 0.3,
    fontSize: 12,
    textTransform: "uppercase",
  },
  resultsArea: {
    flex: 1,
    minHeight: 0,
  },
  resultsFlexInner: {
    flex: 1,
    minHeight: 0,
  },
  loadingBar: {
    alignSelf: "center",
    marginVertical: theme.spacing.xs,
  },
  list: { flex: 1 },
  listContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing.sm,
  },
});
