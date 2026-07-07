import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useReceiptRequirements } from "../hooks/useReceiptRequirements";
import { recordUserConsent } from "../lib/consent";
import { supabase } from "../lib/supabase";
import { ReceiptRequirementsGateCard } from "./ReceiptRequirementsGateCard";

export function ReceiptRequirementsGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const { loading, mode, consent, blocksApp, reload } = useReceiptRequirements();

  if (!session || loading || !blocksApp || mode === "none") return null;

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboard}
      >
        <ScrollView
          contentContainerStyle={styles.overlayScroll}
          keyboardShouldPersistTaps="handled"
          bounces={false}
          centerContent={Platform.OS === "ios"}
        >
          <ReceiptRequirementsGateCard
            mode={mode}
            consent={consent}
            language={language}
            isRTL={isRTL}
            addressLabel={t("profile.address")}
            zipLabel={t("profile.zipCode")}
            initialAddress={profile?.address?.trim() ?? ""}
            initialZipCode={profile?.zip_code?.trim() ?? ""}
            onSave={async ({ address, zipCode, acceptConsent, declineConsent }) => {
              const showConsent = mode === "consent_only" || mode === "both";
              const showAddress = mode === "address_only" || mode === "both";

              if (showConsent && consent) {
                await recordUserConsent({
                  consent_type: "electronic_receipts",
                  status: declineConsent ? "declined" : "accepted",
                  consent_version: consent.version,
                });
                if (declineConsent) return;
              }

              if (showAddress) {
                const { error } = await supabase
                  .from("profiles")
                  .update({ address, zip_code: zipCode })
                  .eq("user_id", session.user.id);
                if (error) throw error;
              }

              if (!acceptConsent && !declineConsent && !showAddress) return;

              await refreshProfile();
              await reload();
            }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.overlay.backdrop,
    zIndex: 9999,
  },
  keyboard: { flex: 1 },
  overlayScroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
});
