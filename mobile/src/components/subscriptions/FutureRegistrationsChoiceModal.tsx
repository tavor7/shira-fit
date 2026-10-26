import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../../theme";
import { useI18n } from "../../context/I18nContext";
import { AppModal } from "../AppModal";
import { PrimaryButton } from "../PrimaryButton";
import { formatISODateFull } from "../../lib/dateFormat";
import { displayMoney } from "../../lib/displayFormat";
import { tierLabelKey, type FutureRegistrationAction, type FutureRegistrationItem } from "../../lib/subscriptions";
import { rowFlipFor } from "../../lib/layoutDirection";
import { pluralKey } from "../../lib/pluralKey";
import { fetchImpactSessionDetails, groupImpactByDate, impactItemKey, type ImpactSessionDetail } from "../../lib/subscriptionImpactDetails";

const EMPTY_DETAILS = new Map<string, ImpactSessionDetail>();

type Props = {
  visible: boolean;
  items: FutureRegistrationItem[];
  busy?: boolean;
  /** Shown as a persistent banner above the message, e.g. when the list was just refreshed after a
   * future_registrations_changed/future_registrations_expectation_required rejection -- the manager
   * must see why they're being asked to re-review, not just that the list silently updated. */
  notice?: string;
  onCancel: () => void;
  onConfirm: (action: FutureRegistrationAction) => void;
};

/**
 * Stop/delete subscription's "what happens to upcoming sessions" choice dialog. Shown only when the
 * backend preview (stop_subscription / delete_subscription's action="preview" response) lists at
 * least one future, currently-covered registration -- the caller never renders this otherwise, so a
 * stop/delete with nothing upcoming keeps its original one-step flow unchanged.
 *
 * A prior selection is never carried over to a refreshed list: whenever `items` changes (a fresh
 * preview, including after a staleness rejection) the manager must explicitly re-pick and re-confirm
 * -- this component never resubmits on their behalf.
 */
export function FutureRegistrationsChoiceModal({ visible, items, busy, notice, onCancel, onConfirm }: Props) {
  const { t, language, isRTL } = useI18n();
  const [selected, setSelected] = useState<FutureRegistrationAction | null>(null);

  useEffect(() => {
    setSelected(null);
  }, [visible, items]);

  const count = items.length;

  const [fetched, setFetched] = useState<{ for: FutureRegistrationItem[]; map: Map<string, ImpactSessionDetail> } | null>(null);
  const details = fetched && fetched.for === items ? fetched.map : EMPTY_DETAILS;
  useEffect(() => {
    if (!visible || items.length === 0) return;
    let cancelled = false;
    fetchImpactSessionDetails(items)
      .then((map) => {
        if (!cancelled) setFetched({ for: items, map });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, items]);

  const timeOf = (it: FutureRegistrationItem) => details.get(impactItemKey(it))?.time ?? null;
  const all = groupImpactByDate(items, timeOf);
  const flat = all.flatMap((g) => g.items);
  const shown = flat.slice(0, 8);
  const remaining = flat.length - shown.length;
  const groups = groupImpactByDate(shown, timeOf);
  const dayCount = (date: string) => flat.filter((it) => it.session_date === date).length;

  return (
    <AppModal visible={visible} onClose={onCancel} variant="dialog" scrollContent="short" backdropAccessibilityLabel={t("subscriptions.futureRegs.cancel")}>
      <View style={styles.card}>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, isRTL && styles.rtl]} accessibilityRole="header">
            {t("subscriptions.futureRegs.title")}
          </Text>
          {notice ? (
            <Text style={[styles.notice, isRTL && styles.rtl]} accessibilityRole="alert">
              {notice}
            </Text>
          ) : null}
          <Text style={[styles.message, isRTL && styles.rtl]}>
            {pluralKey(t, "subscriptions.futureRegs.message", count).replace("{n}", String(count))}
          </Text>

          <View style={styles.options} accessibilityRole="radiogroup">
            <OptionCard
              action="remove"
              title={t("subscriptions.futureRegs.optionRemoveTitle")}
              description={t("subscriptions.futureRegs.optionRemoveDesc")}
              selected={selected}
              onSelect={setSelected}
              isRTL={isRTL}
            />
            <OptionCard
              action="charge_regular_price"
              title={t("subscriptions.futureRegs.optionChargeTitle")}
              description={t("subscriptions.futureRegs.optionChargeDesc")}
              selected={selected}
              onSelect={setSelected}
              isRTL={isRTL}
            />
          </View>

          {shown.length > 0 ? (
            <View style={styles.detailBox}>
              <Text style={[styles.detailHeader, isRTL && styles.rtl]}>{t("subscriptions.futureRegs.detailHeader")}</Text>
              <View style={styles.detailList}>
                {groups.map((g) => (
                  <View key={g.date} style={styles.dayGroup}>
                    <View style={[styles.dayHead, rowFlipFor(isRTL) && styles.detailRowRtl]}>
                      <Text style={[styles.detailDate, isRTL && styles.rtl]}>{formatISODateFull(g.date, language)}</Text>
                      {dayCount(g.date) > 1 ? <Text style={styles.dayCount}>{dayCount(g.date)}</Text> : null}
                    </View>
                    {g.items.map((item, idx) => {
                      const d = details.get(impactItemKey(item));
                      const when = [d?.time, d?.coach].filter(Boolean).join(" · ");
                      return (
                        <View
                          key={`${item.registration_id ?? item.manual_participant_id ?? idx}`}
                          style={[styles.detailRow, rowFlipFor(isRTL) && styles.detailRowRtl]}
                        >
                          <Text style={[styles.detailWhen, isRTL && styles.rtl]} numberOfLines={1}>
                            {when || " "}
                          </Text>
                          <Text style={[styles.detailTier, isRTL && styles.rtl]} numberOfLines={1}>
                            {t(tierLabelKey(item.tier))} · {t("subscriptions.futureRegs.regularPrice").replace("{price}", displayMoney(item.regular_price_ils))}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ))}
                {remaining > 0 ? (
                  <Text style={[styles.moreLine, isRTL && styles.rtl]}>
                    {t("subscriptions.futureRegs.moreItems").replace("{n}", String(remaining))}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          {!selected ? (
            <Text style={[styles.selectPrompt, isRTL && styles.rtl]}>{t("subscriptions.futureRegs.selectPrompt")}</Text>
          ) : null}
        </ScrollView>

        <View style={[styles.actions, rowFlipFor(isRTL) && styles.actionsRtl]}>
          <PrimaryButton label={t("subscriptions.futureRegs.cancel")} onPress={onCancel} variant="ghost" style={styles.btn} />
          <PrimaryButton
            label={t("subscriptions.futureRegs.confirm")}
            onPress={() => selected && onConfirm(selected)}
            loading={busy}
            disabled={!selected}
            variant="danger"
            style={styles.btn}
          />
        </View>
      </View>
    </AppModal>
  );
}

function OptionCard({
  action,
  title,
  description,
  selected,
  onSelect,
  isRTL,
}: {
  action: FutureRegistrationAction;
  title: string;
  description: string;
  selected: FutureRegistrationAction | null;
  onSelect: (action: FutureRegistrationAction) => void;
  isRTL: boolean;
}) {
  const active = selected === action;
  return (
    <Pressable
      onPress={() => onSelect(action)}
      style={[styles.option, active && styles.optionActive]}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      accessibilityLabel={title}
    >
      <View style={[styles.optionRow, rowFlipFor(isRTL) && styles.optionRowRtl]}>
        <View style={[styles.radio, active && styles.radioActive]}>{active ? <View style={styles.radioDot} /> : null}</View>
        <View style={styles.optionBody}>
          <Text style={[styles.optionTitle, isRTL && styles.rtl]}>{title}</Text>
          <Text style={[styles.optionDesc, isRTL && styles.rtl]}>{description}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: theme.spacing.lg, flexShrink: 1, minHeight: 0 },
  body: { flexShrink: 1 },
  bodyContent: { flexGrow: 0 },
  title: { ...theme.typography.headline, color: theme.colors.text, marginBottom: theme.spacing.sm },
  notice: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
    color: theme.colors.text,
    backgroundColor: theme.colors.warningBg,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  message: { fontSize: 15, fontWeight: "500", lineHeight: 22, color: theme.colors.textMuted, marginBottom: theme.spacing.md },
  options: { gap: theme.spacing.sm, marginBottom: theme.spacing.md },
  option: {
    borderWidth: 1.5,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
  },
  optionActive: { borderColor: theme.colors.cta, backgroundColor: theme.colors.surfaceElevated },
  optionRow: { flexDirection: "row", gap: theme.spacing.sm, alignItems: "flex-start" },
  optionRowRtl: { flexDirection: "row-reverse" },
  optionBody: { flex: 1, minWidth: 0 },
  optionTitle: { fontSize: 14, fontWeight: "800", color: theme.colors.text, marginBottom: 2 },
  optionDesc: { fontSize: 12.5, fontWeight: "500", lineHeight: 17, color: theme.colors.textMuted },
  radio: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.full,
    borderWidth: 2,
    borderColor: theme.colors.borderMuted,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  radioActive: { borderColor: theme.colors.cta },
  radioDot: { width: 10, height: 10, borderRadius: theme.radius.full, backgroundColor: theme.colors.cta },
  selectPrompt: { fontSize: 12.5, fontWeight: "600", color: theme.colors.textSoft, marginBottom: theme.spacing.sm },
  detailBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  detailHeader: { fontSize: 12, fontWeight: "800", color: theme.colors.textSoft, textTransform: "uppercase", marginBottom: 6 },
  detailList: {},
  dayGroup: { paddingVertical: 4 },
  dayHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 },
  dayCount: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: "hidden",
  },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4, gap: 8 },
  detailWhen: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: "600", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  detailRowRtl: { flexDirection: "row-reverse" },
  detailDate: { fontSize: 13, fontWeight: "700", color: theme.colors.text },
  detailTier: { fontSize: 12, fontWeight: "600", color: theme.colors.textMuted },
  moreLine: { fontSize: 12, fontWeight: "600", color: theme.colors.textSoft, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, justifyContent: "flex-end" },
  actionsRtl: { flexDirection: "row-reverse" },
  btn: { flexGrow: 1, flexShrink: 1, minWidth: 120 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
