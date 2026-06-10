import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { useI18n } from "../context/I18nContext";
import {
  fetchGoLiveStats,
  listGoLiveGaps,
  type GoLiveGapRow,
  type GoLiveGapType,
  type GoLiveStats,
} from "../lib/documents";

type Props = {
  isRTL: boolean;
  language: "he" | "en";
};

function gapTitle(gap: GoLiveGapType, language: "he" | "en"): string {
  if (gap === "address") return language === "he" ? "חסרה כתובת" : "Missing address";
  if (gap === "zip") return language === "he" ? "חסר מיקוד" : "Missing zip";
  return language === "he" ? "חסרה הסכמה" : "Missing consent";
}

export function GoLiveReadinessSection({ isRTL, language }: Props) {
  const router = useRouter();
  const [stats, setStats] = useState<GoLiveStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeGap, setActiveGap] = useState<GoLiveGapType | null>(null);
  const [gapRows, setGapRows] = useState<GoLiveGapRow[]>([]);
  const [gapLoading, setGapLoading] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      setStats(await fetchGoLiveStats());
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function openGap(gap: GoLiveGapType) {
    setActiveGap(gap);
    setGapLoading(true);
    try {
      setGapRows(await listGoLiveGaps(gap));
    } catch {
      setGapRows([]);
    } finally {
      setGapLoading(false);
    }
  }

  function closeGap() {
    setActiveGap(null);
    setGapRows([]);
  }

  if (loading) {
    return (
      <View style={styles.card}>
        <ActivityIndicator color={theme.colors.cta} />
      </View>
    );
  }

  if (!stats) return null;

  const items: { key: GoLiveGapType; label: string; count: number }[] = [
    { key: "address", label: language === "he" ? "כתובת" : "Address", count: stats.missing_address_count },
    { key: "zip", label: language === "he" ? "מיקוד" : "Zip", count: stats.missing_zip_count },
    { key: "consent", label: language === "he" ? "הסכמה" : "Consent", count: stats.missing_consent_count },
  ];

  return (
    <>
      <View style={styles.card}>
        <Text style={[styles.cardLabel, isRTL && styles.rtl]}>
          {language === "he" ? "מוכנות לעלייה לאוויר" : "Go-live readiness"}
        </Text>
        <Text style={[styles.hint, isRTL && styles.rtl]}>
          {language === "he"
            ? "ספורת מתאמנים פעילים שחסרים פרטים. לחצו על מספר לרשימה."
            : "Active athletes missing details. Tap a count to see the list."}
        </Text>
        <View style={[styles.statsRow, isRTL && styles.statsRowRtl]}>
          {items.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => void openGap(item.key)}
              style={({ pressed }) => [styles.statBox, pressed && styles.statBoxPressed]}
            >
              <Text style={[styles.statCount, item.count > 0 && styles.statCountWarn]}>{item.count}</Text>
              <Text style={[styles.statLabel, isRTL && styles.rtl]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <AppModal
        visible={activeGap != null}
        onClose={closeGap}
        variant="sheet"
        backdropAccessibilityLabel={language === "he" ? "סגור" : "Close"}
      >
        <View style={styles.modalHead}>
          <Text style={[styles.modalTitle, isRTL && styles.rtl]}>
            {activeGap ? gapTitle(activeGap, language) : ""}
          </Text>
        </View>
        {gapLoading ? (
          <ActivityIndicator color={theme.colors.cta} style={styles.modalLoader} />
        ) : (
          <FlatList
            data={gapRows}
            keyExtractor={(x) => x.user_id}
            contentContainerStyle={styles.modalList}
            ListEmptyComponent={
              <Text style={[styles.empty, isRTL && styles.rtl]}>
                {language === "he" ? "אין מתאמנים ברשימה" : "No athletes in this list"}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  closeGap();
                  router.push(`/(app)/staff/profile/${item.user_id}` as never);
                }}
                style={({ pressed }) => [styles.gapRow, pressed && styles.gapRowPressed]}
              >
                <Text style={[styles.gapName, isRTL && styles.rtl]}>{item.full_name}</Text>
                {item.username ? (
                  <Text style={[styles.gapMeta, isRTL && styles.rtl]}>@{item.username}</Text>
                ) : null}
                {item.phone ? (
                  <Text style={[styles.gapMeta, isRTL && styles.rtl]}>{item.phone}</Text>
                ) : null}
                {item.email ? (
                  <Text style={[styles.gapMeta, isRTL && styles.rtl]}>{item.email}</Text>
                ) : null}
              </Pressable>
            )}
          />
        )}
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.35,
  },
  hint: { fontSize: 13, fontWeight: "500", color: theme.colors.textSoft, lineHeight: 19 },
  statsRow: { flexDirection: "row", gap: theme.spacing.sm, marginTop: 4 },
  statsRowRtl: { flexDirection: "row-reverse" },
  statBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  statBoxPressed: { opacity: 0.85 },
  statCount: { fontSize: 24, fontWeight: "900", color: theme.colors.text },
  statCountWarn: { color: theme.colors.error },
  statLabel: { marginTop: 4, fontSize: 12, fontWeight: "700", color: theme.colors.textMuted },
  modalHead: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.colors.text },
  modalLoader: { marginVertical: 32 },
  modalList: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.xl, gap: theme.spacing.sm },
  gapRow: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    gap: 2,
  },
  gapRowPressed: { opacity: 0.9 },
  gapName: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  gapMeta: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  empty: { textAlign: "center", color: theme.colors.textMuted, paddingVertical: 24, fontWeight: "600" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
