import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { CreateSessionForm } from "../../../src/components/CreateSessionForm";
import { AppText } from "../../../src/components/AppText";
import { ActionButton } from "../../../src/components/ActionButton";
import { Skeleton } from "../../../src/components/Skeleton";
import { useI18n } from "../../../src/context/I18nContext";

export default function CoachCreateSessionScreen() {
  const { t, isRTL } = useI18n();
  const { date } = useLocalSearchParams<{ date?: string | string[] }>();
  const initialDate = Array.isArray(date) ? date[0] : date;
  const [uid, setUid] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const u = (await supabase.auth.getUser()).data.user?.id ?? null;
      if (!u) {
        setLoadError(true);
        return;
      }
      const { data } = await supabase.from("profiles").select("full_name").eq("user_id", u).maybeSingle();
      setUid(u);
      setName(data?.full_name ?? null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Skeleton width="60%" height={20} />
        <Skeleton width="100%" height={52} radius={theme.radius.md} style={{ marginTop: theme.spacing.md }} />
        <Skeleton width="100%" height={52} radius={theme.radius.md} style={{ marginTop: theme.spacing.sm }} />
      </View>
    );
  }

  if (loadError || !uid) {
    return (
      <View style={[styles.center, styles.centerAligned]}>
        <AppText muted isRTL={isRTL}>
          {t("common.error")}
        </AppText>
        <ActionButton label={t("auth.retryConnection")} onPress={() => void load()} style={{ marginTop: theme.spacing.sm }} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t("screen.coachCreateSession"), animation: "slide_from_bottom" }} />
      <CreateSessionForm initialDate={initialDate} fixedCoachId={uid} fixedCoachLabel={name ?? undefined} />
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.colors.backgroundAlt,
    padding: theme.spacing.lg,
  },
  centerAligned: { alignItems: "center" },
});
