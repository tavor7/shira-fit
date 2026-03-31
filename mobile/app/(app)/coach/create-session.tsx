import { useEffect, useState } from "react";
import { View, ActivityIndicator, Text, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { supabase } from "../../../src/lib/supabase";
import { theme } from "../../../src/theme";
import { CreateSessionForm } from "../../../src/components/CreateSessionForm";
import { useI18n } from "../../../src/context/I18nContext";

export default function CoachCreateSessionScreen() {
  const { t, isRTL } = useI18n();
  const { date } = useLocalSearchParams<{ date?: string | string[] }>();
  const initialDate = Array.isArray(date) ? date[0] : date;
  const [uid, setUid] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const u = (await supabase.auth.getUser()).data.user?.id ?? null;
      setUid(u);
      if (u) {
        const { data } = await supabase.from("profiles").select("full_name").eq("user_id", u).maybeSingle();
        setName(data?.full_name ?? null);
      }
    })();
  }, []);

  if (!uid) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.colors.cta} />
        <Text style={[styles.muted, isRTL && { textAlign: "right" }]}>{t("common.loading")}</Text>
      </View>
    );
  }

  return <CreateSessionForm initialDate={initialDate} fixedCoachId={uid} fixedCoachLabel={name ?? undefined} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: theme.colors.backgroundAlt },
  muted: { marginTop: 12, color: theme.colors.textMuted },
});
