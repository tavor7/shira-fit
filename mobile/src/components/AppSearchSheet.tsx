import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { useVisualViewport } from "../hooks/useVisualViewport";
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
  /** Hide headerExtra while the search field is focused (keeps quick-add fields visible when editing them). */
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
  const visualViewport = useVisualViewport();
  const { height: windowHeight } = useWindowDimensions();
  const [searchFocused, setSearchFocused] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLockBodyScroll(visible);

  useEffect(() => {
    if (!visible) {
      setSearchFocused(false);
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    }
  }, [visible]);

  function handleSearchFocus() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    setSearchFocused(true);
  }

  function handleSearchBlur() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => setSearchFocused(false), 150);
  }

  useEffect(() => {
    if (!visible || !searchConfig) return;
    void searchConfig.onSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when sheet opens
  }, [visible]);

  const isWeb = Platform.OS === "web";
  const webKeyboardInset = isWeb ? Math.max(0, windowHeight - visualViewport.height) : 0;
  const keyboardOpen = isWeb
    ? webKeyboardInset > 48 || visualViewport.height < windowHeight * 0.88 || searchFocused
    : keyboardInset > 0;

  const topRoom = Math.max(insets.top, 8) + 8;

  const availableHeight = useMemo(() => {
    if (isWeb) {
      return Math.max(220, visualViewport.height - 4);
    }
    return Math.max(220, windowHeight - keyboardInset - topRoom);
  }, [isWeb, visualViewport.height, windowHeight, keyboardInset, topRoom]);

  const sheetHeight = useMemo(() => {
    const pct = keyboardOpen ? Math.min(sheetHeightPct, 0.94) : sheetHeightPct;
    const cap = Math.round((isWeb ? visualViewport.height : windowHeight) * pct);
    return Math.max(220, Math.min(cap, availableHeight));
  }, [availableHeight, isWeb, keyboardOpen, sheetHeightPct, visualViewport.height, windowHeight]);

  const bottomPad = Math.max(insets.bottom, theme.spacing.md);
  const showHeaderExtra = headerExtra != null && !(hideHeaderExtraOnKeyboard && searchFocused);
  const showCompactHeader = keyboardOpen && searchFocused;

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
        scrollOnFocus={false}
        onFocus={handleSearchFocus}
        onBlur={handleSearchBlur}
      />
    </>
  ) : (
    search
  );

  const listLoading = searchConfig?.loading ?? false;

  const backdropStyle = isWeb
    ? ({
        position: "absolute",
        top: visualViewport.offsetTop,
        left: visualViewport.offsetLeft,
        width: visualViewport.width,
        height: visualViewport.height,
      } as ViewStyle)
    : undefined;

  const sheetBody = (
    <View
      style={[
        styles.sheet,
        {
          height: sheetHeight,
          maxHeight: availableHeight,
          paddingBottom: bottomPad,
          ...(isWeb ? {} : { marginBottom: keyboardInset }),
        },
        cardStyle,
      ]}
    >
      <View style={[styles.header, showCompactHeader && styles.headerCompact, isRTL && styles.headerRtl]}>
        <View style={styles.headerText}>
          <Text style={[styles.title, showCompactHeader && styles.titleCompact, isRTL && styles.rtlText]} numberOfLines={2}>
            {title}
          </Text>
          {!showCompactHeader && subtitle?.trim() ? (
            <Text style={[styles.subtitle, isRTL && styles.rtlText]} numberOfLines={2}>
              {subtitle.trim()}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          style={({ pressed }) => [pressed && { opacity: 0.7 }]}
        >
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
            ListEmptyComponent={ListEmptyComponent != null ? () => <>{ListEmptyComponent}</> : undefined}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <SearchSheetFocusContext.Provider value={focusContext}>
        <View style={[styles.backdropRoot, isWeb && styles.backdropRootWeb]}>
          <View style={[styles.backdrop, backdropStyle]}>
            <Pressable
              style={styles.backdropTouch}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={backdropAccessibilityLabel ?? dismissLabel}
            />
            {sheetBody}
          </View>
        </View>
      </SearchSheetFocusContext.Provider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropRoot: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  backdropRootWeb: {
    position: "relative",
    overflow: "hidden",
  },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
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
  headerCompact: {
    paddingVertical: theme.spacing.sm,
  },
  headerRtl: { flexDirection: "row-reverse" },
  headerText: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.2,
    color: theme.colors.text,
  },
  titleCompact: {
    fontSize: 15,
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
    backgroundColor: theme.colors.surface,
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
    minHeight: 120,
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
