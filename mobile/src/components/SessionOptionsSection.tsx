import type { ReactNode } from "react";
import { View, Text, Pressable, StyleSheet, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { sessionFormStyles as sf } from "./sessionFormStyles";
import { KICKBOX_SESSION_ACCENT, KICKBOX_SESSION_BG } from "../lib/kickboxSessionStyle";
import { AnimatedOptionExpand } from "./AnimatedOptionExpand";
import { AppSwitch } from "./AppSwitch";

/** Visual cue when the toggle is on (off rows share the same neutral look). */
export type SessionOptionTone = "open" | "hidden" | "kickbox" | "repeat";

export type SessionOptionItem = {
  key: string;
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  tone?: SessionOptionTone;
  /** Shown under the row while the switch is on */
  detailWhenOn?: string;
  expandedWhenOn?: ReactNode;
};

function rowToneStyle(tone: SessionOptionTone | undefined, value: boolean): ViewStyle | null {
  if (!tone || !value) return null;
  if (tone === "open") return styles.rowOpenOn;
  if (tone === "hidden") return styles.rowHiddenOn;
  if (tone === "kickbox") return styles.rowKickboxOn;
  if (tone === "repeat") return styles.rowRepeatOn;
  return null;
}

const switchTrackOff = theme.colors.border;

function switchTrackColor(tone: SessionOptionTone | undefined, value: boolean) {
  if (!value) return { false: switchTrackOff, true: theme.colors.success };
  if (tone === "hidden") return { false: switchTrackOff, true: theme.colors.error };
  if (tone === "kickbox") return { false: switchTrackOff, true: KICKBOX_SESSION_ACCENT };
  if (tone === "open") return { false: switchTrackOff, true: theme.colors.success };
  return { false: switchTrackOff, true: theme.colors.cta };
}

type Props = {
  options: SessionOptionItem[];
  isRTL?: boolean;
  /** When true, only renders the option rows (parent supplies card + title). */
  embedded?: boolean;
};

function OptionList({ options, isRTL }: Pick<Props, "options" | "isRTL">) {
  return (
      <View style={styles.list}>
        {options.map((opt, index) => {
          const toneStyle = rowToneStyle(opt.tone, opt.value);
          return (
          <View key={opt.key}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <View style={[styles.rowShell, toneStyle]}>
            <View style={[styles.row, isRTL && styles.rowRtl]}>
              <Pressable
                style={({ pressed }) => [styles.labelBlock, pressed && { opacity: 0.7 }]}
                onPress={() => opt.onValueChange(!opt.value)}
                accessibilityRole="switch"
                accessibilityState={{ checked: opt.value }}
                accessibilityLabel={opt.label}
              >
                <Text style={[styles.label, isRTL && styles.rtl, toneStyle && styles.labelEmphasis]}>{opt.label}</Text>
                {opt.hint ? <Text style={[styles.hint, isRTL && styles.rtl]}>{opt.hint}</Text> : null}
              </Pressable>
              <AppSwitch
                value={opt.value}
                onValueChange={opt.onValueChange}
                onColor={switchTrackColor(opt.tone, opt.value).true}
                offColor={switchTrackOff}
                accessibilityLabel={opt.label}
              />
            </View>
            </View>
            {opt.value && opt.detailWhenOn ? (
              <Text style={[styles.detail, isRTL && styles.rtl]}>{opt.detailWhenOn}</Text>
            ) : null}
            {opt.expandedWhenOn ? (
              <View style={styles.expandWrap}>
                <AnimatedOptionExpand open={opt.value}>{opt.expandedWhenOn}</AnimatedOptionExpand>
              </View>
            ) : null}
          </View>
        );
        })}
      </View>
  );
}

export function SessionOptionsSection({ options, isRTL, embedded = false }: Props) {
  const list = <OptionList options={options} isRTL={isRTL} />;
  if (embedded) return list;
  return <View style={sf.card}>{list}</View>;
}

const rowAccent = {
  borderStartWidth: 3,
  paddingStart: 10,
  marginStart: -2,
  borderRadius: theme.radius.sm,
} as const;

const styles = StyleSheet.create({
  list: {},
  rowShell: {
    marginVertical: 2,
    borderRadius: theme.radius.sm,
  },
  rowOpenOn: {
    ...rowAccent,
    backgroundColor: theme.colors.successBg,
    borderStartColor: theme.colors.success,
  },
  rowHiddenOn: {
    ...rowAccent,
    backgroundColor: theme.colors.errorBg,
    borderStartColor: theme.colors.error,
  },
  rowKickboxOn: {
    ...rowAccent,
    backgroundColor: KICKBOX_SESSION_BG,
    borderStartColor: KICKBOX_SESSION_ACCENT,
  },
  rowRepeatOn: {
    ...rowAccent,
    backgroundColor: theme.colors.surfaceElevated,
    borderStartColor: theme.colors.cta,
    borderWidth: 0,
    borderStartWidth: 3,
  },
  expandWrap: {
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    minHeight: 52,
  },
  rowRtl: {
    flexDirection: "row-reverse",
  },
  labelBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  label: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
    lineHeight: 20,
  },
  labelEmphasis: {
    fontWeight: "800",
  },
  hint: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSoft,
    lineHeight: 16,
  },
  detail: {
    marginTop: -4,
    marginBottom: 10,
    paddingHorizontal: 2,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textMuted,
    lineHeight: 17,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderMuted,
  },
  rtl: {
    textAlign: "right",
  },
});
