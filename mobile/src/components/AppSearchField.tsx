import { useRef } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { theme } from "../theme";

type Props = {
  value: string;
  onChangeText: (next: string) => void;
  /** Called after debounce when the user edits the query (not on mount). */
  onSearch: (term: string) => void | Promise<void>;
  placeholder?: string;
  debounceMs?: number;
  isRTL?: boolean;
  loading?: boolean;
  editable?: boolean;
  accessibilityLabel?: string;
  autoFocus?: boolean;
  /** Keep the field visible above the keyboard (mobile web). */
  scrollOnFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  onFocus?: () => void;
  onBlur?: () => void;
};

function scrollWebInputIntoView(ref: { current: TextInput | null }) {
  if (Platform.OS !== "web" || typeof document === "undefined") return;

  requestAnimationFrame(() => {
    const target = ref.current as unknown as HTMLElement | null;
    if (!target) return;

    const input =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target
        : (target.querySelector?.("input, textarea") as HTMLElement | null);

    input?.scrollIntoView?.({ block: "center", inline: "nearest" });
  });
}

export function AppSearchField({
  value,
  onChangeText,
  onSearch,
  placeholder,
  debounceMs = 280,
  isRTL,
  loading = false,
  editable = true,
  accessibilityLabel,
  autoFocus,
  scrollOnFocus = Platform.OS === "web",
  style,
  onFocus,
  onBlur,
}: Props) {
  const inputRef = useRef<TextInput>(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSearch(term: string) {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void onSearchRef.current(term);
    }, debounceMs);
  }

  function handleChangeText(next: string) {
    onChangeText(next);
    scheduleSearch(next);
  }

  function handleClear() {
    onChangeText("");
    scheduleSearch("");
  }

  function handleFocus() {
    if (scrollOnFocus) scrollWebInputIntoView(inputRef);
    onFocus?.();
  }

  return (
    <View style={[styles.shell, isRTL && styles.shellRtl, style]} accessibilityRole="search">
      <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">
        ⌕
      </Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textSoft}
        style={[styles.input, isRTL && styles.inputRtl]}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        autoFocus={autoFocus}
        returnKeyType="search"
        onFocus={handleFocus}
        onBlur={onBlur}
        onSubmitEditing={() => void onSearchRef.current(value)}
      />
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.cta} style={styles.trail} />
      ) : value.length > 0 ? (
        <Pressable
          onPress={handleClear}
          hitSlop={10}
          style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Text style={styles.clearTxt}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderInput,
    backgroundColor: theme.colors.surfaceElevated,
  },
  shellRtl: { flexDirection: "row-reverse" },
  glyph: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.textMuted,
    lineHeight: 20,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: "600",
    color: theme.colors.text,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
  },
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  trail: { marginStart: 2 },
  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  clearTxt: { color: theme.colors.textMuted, fontWeight: "800", fontSize: 12, lineHeight: 14 },
});
