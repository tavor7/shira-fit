import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { theme } from "../theme";
import { surface } from "../theme/surfaces";
import { PrimaryButton } from "../components/PrimaryButton";
import { AppTextField } from "../components/AppTextField";
import { Skeleton } from "../components/Skeleton";
import { ManagerMessageCard } from "../components/ManagerMessageCard";
import { ManagerStudioSetupTabs } from "../components/ManagerOverviewTabs";
import { useI18n } from "../context/I18nContext";
import { useAppAlert } from "../context/AppAlertContext";
import { useToast } from "../context/ToastContext";
import {
  DEFAULT_BIRTHDAY_MESSAGE_EN,
  DEFAULT_BIRTHDAY_MESSAGE_HE,
  fetchBirthdayMessageSettings,
  saveBirthdayMessageSettings,
} from "../lib/birthdayMessages";
import {
  MANAGER_MESSAGE_THEMES,
  getManagerMessageThemeStyle,
  managerMessageThemeLabelKey,
  type ManagerMessageTheme,
} from "../lib/managerMessageThemes";
import { formatISODateDayMonthWithWeekday, parseInstantIso } from "../lib/dateFormat";
import { appLocale } from "../lib/appLocale";

const STUDIO_TZ = "Asia/Jerusalem";

function previewBody(template: string, sampleName: string): string {
  const first = sampleName.trim().split(/\s+/)[0] || sampleName || "there";
  return template.replaceAll("{name}", first);
}

function formatUpdatedWhen(iso: string, language: "en" | "he"): string {
  const d = parseInstantIso(iso);
  if (!d) return iso;
  const datePart = d.toLocaleDateString("en-CA", { timeZone: STUDIO_TZ });
  const dateFormatted = formatISODateDayMonthWithWeekday(datePart, language);
  const timeStudio = d.toLocaleTimeString(appLocale(language), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: STUDIO_TZ,
  });
  return `${dateFormatted} · ${timeStudio}`;
}

export default function BirthdayMessagesScreen() {
  const { t, isRTL, language } = useI18n();
  const { showOk } = useAppAlert();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [messageTheme, setMessageTheme] = useState<ManagerMessageTheme>("happy");
  const [savedTheme, setSavedTheme] = useState<ManagerMessageTheme>("happy");
  const [senderName, setSenderName] = useState("Shira");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedByName, setUpdatedByName] = useState<string | null>(null);

  const defaultBody = language === "he" ? DEFAULT_BIRTHDAY_MESSAGE_HE : DEFAULT_BIRTHDAY_MESSAGE_EN;
  const sampleName = language === "he" ? "דנה" : "Dana";
  const previewSenderName = senderName;

  const toggleDirty = enabled !== savedEnabled;
  const contentDirty = body.trim() !== savedBody.trim() || messageTheme !== savedTheme;

  const canSave = useMemo(() => {
    if (!toggleDirty && !contentDirty) return false;
    const bodyForSave = body.trim() || (enabled ? defaultBody : savedBody.trim());
    if (enabled && !bodyForSave) return false;
    if (bodyForSave.length > 2000) return false;
    return true;
  }, [toggleDirty, contentDirty, enabled, body, savedBody, defaultBody]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchBirthdayMessageSettings();
    setLoading(false);
    if (!res.ok) {
      showOk(t("common.error"), res.error);
      return;
    }
    const serverBody = res.settings.body ?? "";
    setEnabled(res.settings.enabled);
    setSavedEnabled(res.settings.enabled);
    setBody(serverBody);
    setSavedBody(serverBody);
    setMessageTheme(res.settings.theme);
    setSavedTheme(res.settings.theme);
    setSenderName(res.settings.senderName);
    setUpdatedAt(res.settings.updatedAt);
    setUpdatedByName(res.settings.updatedByName);
  }, [defaultBody, showOk, t]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function save() {
    const bodyForSave = body.trim() || (enabled ? defaultBody : "");
    if (enabled && !bodyForSave) {
      showOk(t("common.error"), t("birthdayMessages.bodyRequired"));
      return;
    }
    setSaving(true);
    const res = await saveBirthdayMessageSettings(enabled, bodyForSave, messageTheme);
    setSaving(false);
    if (!res.ok) {
      const detail =
        res.error === "body_required"
          ? t("birthdayMessages.bodyRequired")
          : res.error === "invalid_body"
            ? t("birthdayMessages.bodyTooLong")
            : res.error;
      showOk(t("common.error"), detail);
      return;
    }
    setSavedEnabled(enabled);
    setSavedBody(bodyForSave);
    setSavedTheme(messageTheme);
    showToast({
      message: enabled ? t("birthdayMessages.savedOn") : t("birthdayMessages.savedOff"),
      variant: "success",
    });
    void load();
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      <ManagerStudioSetupTabs />

      <Text style={[styles.title, isRTL && styles.rtl]}>{t("birthdayMessages.title")}</Text>
      {updatedAt ? (
        <Text style={[styles.updatedMeta, isRTL && styles.rtl]}>
          {updatedByName
            ? t("birthdayMessages.lastUpdated")
                .replace("{name}", updatedByName)
                .replace("{when}", formatUpdatedWhen(updatedAt, language))
            : t("birthdayMessages.lastUpdatedDateOnly").replace("{when}", formatUpdatedWhen(updatedAt, language))}
        </Text>
      ) : null}

      {loading ? (
        <View style={styles.skeletonList}>
          <Skeleton height={100} radius={theme.radius.lg} />
          <Skeleton height={160} radius={theme.radius.lg} />
        </View>
      ) : (
        <>
          <View style={[styles.card, surface.card]}>
            <View style={[styles.toggleRow, isRTL && styles.toggleRowRtl]}>
              <View style={styles.toggleCopy}>
                <Text style={[styles.toggleLabel, isRTL && styles.rtl]}>{t("birthdayMessages.toggleLabel")}</Text>
                <Text style={[styles.toggleHint, isRTL && styles.rtl]}>{t("birthdayMessages.toggleHint")}</Text>
              </View>
              <Switch
                value={enabled}
                onValueChange={setEnabled}
                trackColor={{ false: theme.colors.borderMuted, true: theme.colors.cta }}
                thumbColor="#fff"
              />
            </View>
          </View>

          <View style={[styles.card, surface.card]}>
            <Text style={[styles.sectionEyebrow, isRTL && styles.rtl]}>{t("birthdayMessages.messageSection")}</Text>
            <Text style={[styles.sectionHint, isRTL && styles.rtl]}>{t("birthdayMessages.namePlaceholderHint")}</Text>

            <Text style={[styles.themeLabel, isRTL && styles.rtl]}>{t("managerMessage.themeLabel")}</Text>
            <View style={[styles.themeRow, isRTL && styles.themeRowRtl]}>
              {MANAGER_MESSAGE_THEMES.map((key) => {
                const active = messageTheme === key;
                const palette = getManagerMessageThemeStyle(key);
                return (
                  <Pressable
                    key={key}
                    onPress={() => setMessageTheme(key)}
                    style={({ pressed }) => [
                      styles.themeChip,
                      active && { borderColor: palette.avatarBg, backgroundColor: palette.bubbleBg },
                      pressed && { opacity: 0.9 },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={styles.themeEmoji}>{palette.emoji}</Text>
                    <Text
                      style={[
                        styles.themeChipTxt,
                        active && { color: palette.bubbleText, fontWeight: "800" },
                      ]}
                    >
                      {t(managerMessageThemeLabelKey(key))}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <AppTextField
              isRTL={isRTL}
              value={body}
              onChangeText={setBody}
              placeholder={defaultBody}
              multiline
              variant="dark"
              containerStyle={styles.field}
              style={styles.messageInput}
            />
            <Text style={[styles.charCount, body.length > 2000 && styles.charCountOver]}>{body.length}/2000</Text>

            <View style={styles.previewShell}>
              <ManagerMessageCard
                messageTheme={messageTheme}
                senderName={previewSenderName}
                body={previewBody(body.trim() || defaultBody, sampleName)}
                inboxKicker={t("managerMessage.inboxKicker")}
                isRTL={isRTL}
                previewLabel={t("managerMessage.livePreview")}
              />
            </View>
          </View>

          <View style={styles.saveWrap}>
            <PrimaryButton
              label={saving ? t("common.loading") : t("common.save")}
              onPress={() => void save()}
              disabled={!canSave}
              loading={saving}
              loadingLabel={t("common.loading")}
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt },
  content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl + theme.spacing.md },
  title: {
    fontSize: 22,
    fontWeight: "900",
    color: theme.colors.text,
    letterSpacing: -0.3,
    lineHeight: 28,
  },
  updatedMeta: {
    marginTop: 8,
    color: theme.colors.textMuted,
    lineHeight: 18,
    fontSize: 12,
    fontWeight: "500",
  },
  rtl: { textAlign: "right" },
  skeletonList: { marginTop: theme.spacing.xl, gap: theme.spacing.md },
  card: {
    marginTop: theme.spacing.lg,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    gap: theme.spacing.md,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  toggleRowRtl: { flexDirection: "row-reverse" },
  toggleCopy: { flex: 1, gap: 4 },
  toggleLabel: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  toggleHint: { fontSize: 13, fontWeight: "500", color: theme.colors.textMuted, lineHeight: 18 },
  sectionEyebrow: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  sectionHint: { fontSize: 13, fontWeight: "500", color: theme.colors.textMuted, lineHeight: 18 },
  themeLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.textSoft },
  themeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  themeRowRtl: { flexDirection: "row-reverse" },
  themeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    backgroundColor: theme.colors.backgroundAlt,
  },
  themeEmoji: { fontSize: 16 },
  themeChipTxt: { fontSize: 13, fontWeight: "600", color: theme.colors.textMuted },
  field: { marginTop: 4 },
  messageInput: { minHeight: 96, textAlignVertical: "top" },
  charCount: { marginTop: 4, fontSize: 11, fontWeight: "600", color: theme.colors.textSoft, textAlign: "right" },
  charCountOver: { color: theme.colors.error },
  previewShell: { marginTop: 4 },
  saveWrap: { marginTop: theme.spacing.lg },
});
