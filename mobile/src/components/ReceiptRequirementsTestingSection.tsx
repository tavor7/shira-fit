import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { AppModal } from "./AppModal";
import { ReceiptRequirementsGateCard } from "./ReceiptRequirementsGateCard";
import { PrimaryButton } from "./PrimaryButton";
import { useAuth } from "../context/AuthContext";
import { useAppAlert } from "../context/AppAlertContext";
import { supabase } from "../lib/supabase";
import type { RequiredConsent } from "../lib/documents";
import type { ReceiptRequirementsMode } from "../lib/receiptRequirements";
import { resetOwnReceiptRequirementsForTesting } from "../lib/receiptRequirementsTesting";

type Props = {
  language: "he" | "en";
  isRTL: boolean;
  addressLabel: string;
  zipLabel: string;
  consentEnabled: boolean;
  addressEnabled: boolean;
};

type PreviewMode = ReceiptRequirementsMode | null;

export function ReceiptRequirementsTestingSection({
  language,
  isRTL,
  addressLabel,
  zipLabel,
  consentEnabled,
  addressEnabled,
}: Props) {
  const { refreshProfile } = useAuth();
  const { showConfirm } = useAppAlert();
  const [previewMode, setPreviewMode] = useState<PreviewMode>(null);
  const [previewConsent, setPreviewConsent] = useState<RequiredConsent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const openPreview = useCallback(
    async (mode: Exclude<PreviewMode, null>) => {
      setPreviewLoading(true);
      setPreviewMode(mode);
      try {
        if (mode === "consent_only" || mode === "both") {
          const { data, error } = await supabase.rpc("get_current_legal_document", {
            p_consent_type: "electronic_receipts",
          });
          if (error) throw error;
          const row = data as {
            ok?: boolean;
            title?: string;
            body_text?: string;
            version?: number;
          } | null;
          if (!row?.ok) throw new Error("consent_doc_unavailable");
          setPreviewConsent({
            consent_type: "electronic_receipts",
            title: row.title ?? "",
            body_text: row.body_text ?? "",
            version: row.version ?? 1,
          });
        } else {
          setPreviewConsent(null);
        }
      } catch {
        setPreviewConsent(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [],
  );

  function resetForLiveTest() {
    showConfirm({
      title: language === "he" ? "לאפס לבדיקה?" : "Reset for testing?",
      message:
        language === "he"
          ? "הכתובת, המיקוד וההסכמה שלכם יימחקו מהפרופיל. בכניסה הבאה תופיע חסימה אמיתית — תוכלו למלא מחדש כרגיל."
          : "Your address, zip, and consent will be cleared. The real blocking screen will appear until you fill them in again.",
      confirmLabel: language === "he" ? "איפוס" : "Reset",
      cancelLabel: language === "he" ? "ביטול" : "Cancel",
      confirmVariant: "primary",
      onConfirm: () => {
        void (async () => {
          setResetBusy(true);
          try {
            await resetOwnReceiptRequirementsForTesting({ resetConsent: true, resetAddress: true });
            await refreshProfile();
          } finally {
            setResetBusy(false);
          }
        })();
      },
    });
  }

  const previewButtons: { mode: Exclude<PreviewMode, null>; label: string }[] = [
    {
      mode: "both",
      label: language === "he" ? "תצוגה: הסכמה + כתובת" : "Preview: consent + address",
    },
    {
      mode: "consent_only",
      label: language === "he" ? "תצוגה: הסכמה בלבד" : "Preview: consent only",
    },
    {
      mode: "address_only",
      label: language === "he" ? "תצוגה: כתובת בלבד" : "Preview: address only",
    },
  ];

  return (
    <>
      <View style={styles.card}>
        <Text style={[styles.label, isRTL && styles.rtl]}>
          {language === "he" ? "בדיקת חסימת כניסה" : "Requirement gate testing"}
        </Text>
        <Text style={[styles.hint, isRTL && styles.rtl]}>
          {language === "he"
            ? "תצוגה מקדימה מציגה את המסך כפי שמשתמשים רואים אותו. איפוס מפעיל את החסימה האמיתית בחשבון שלכם."
            : "Preview shows the screen users see. Reset triggers the real gate on your account."}
        </Text>
        {!consentEnabled || !addressEnabled ? (
          <Text style={[styles.warn, isRTL && styles.rtl]}>
            {language === "he"
              ? "הפעילו גם «בקשת הסכמה» וגם «בקשת כתובת» למעלה כדי לבדוק את אותה חוויה כמו למשתמשים."
              : "Turn on both “Request consent” and “Request address” above to match what users experience."}
          </Text>
        ) : null}
        <View style={styles.previewRow}>
          {previewButtons.map((btn) => (
            <Pressable
              key={btn.mode}
              onPress={() => void openPreview(btn.mode)}
              style={({ pressed }) => [styles.previewBtn, pressed && styles.previewBtnPressed]}
            >
              <Text style={[styles.previewBtnText, isRTL && styles.rtl]}>{btn.label}</Text>
            </Pressable>
          ))}
        </View>
        <PrimaryButton
          label={
            resetBusy
              ? language === "he"
                ? "מאפס..."
                : "Resetting..."
              : language === "he"
                ? "איפוס הפרטים שלי ובדיקה חיה"
                : "Reset my details & test live"
          }
          onPress={() => void resetForLiveTest()}
          disabled={resetBusy}
        />
      </View>

      <AppModal
        visible={previewMode != null}
        onClose={() => setPreviewMode(null)}
        variant="dialog"
        maxHeightPct={0.92}
        backdropAccessibilityLabel={language === "he" ? "סגור" : "Close"}
      >
        {previewLoading ? (
          <ActivityIndicator color={theme.colors.cta} style={styles.loader} />
        ) : previewMode ? (
          <ReceiptRequirementsGateCard
            mode={previewMode}
            consent={previewConsent}
            language={language}
            isRTL={isRTL}
            addressLabel={addressLabel}
            zipLabel={zipLabel}
            preview
            onComplete={() => setPreviewMode(null)}
            onSave={async () => {
              await new Promise((r) => setTimeout(r, 250));
            }}
          />
        ) : null}
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
  label: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.35,
  },
  hint: { fontSize: 13, fontWeight: "500", color: theme.colors.textSoft, lineHeight: 19 },
  warn: { fontSize: 13, fontWeight: "700", color: theme.colors.warning, lineHeight: 19 },
  previewRow: { gap: theme.spacing.xs, marginTop: 4 },
  previewBtn: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
  },
  previewBtnPressed: { opacity: 0.88 },
  previewBtnText: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  loader: { marginVertical: 40 },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
