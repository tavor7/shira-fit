import { useRef } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { useReceiptRequirements } from "../hooks/useReceiptRequirements";
import { recordUserConsent } from "../lib/consent";
import { supabase } from "../lib/supabase";
import { ReceiptRequirementsGateCard, receiptGateTitle } from "./ReceiptRequirementsGateCard";
import { useInertSiblings } from "../hooks/useInertSiblings";

export function ReceiptRequirementsGateModal() {
  const { session, profile, refreshProfile } = useAuth();
  const { language, t, isRTL } = useI18n();
  const { loading, mode, consent, blocksApp, reload } = useReceiptRequirements();

  const overlayRef = useRef<View>(null);
  const shown = !!session && !loading && blocksApp && mode !== "none";
  useInertSiblings(overlayRef, shown);

  if (!shown) return null;

  return (
    <View
      ref={overlayRef}
      style={styles.overlay}
      accessibilityViewIsModal
      {...(Platform.OS === "web" ? { role: "dialog", "aria-modal": true, "aria-label": receiptGateTitle(mode, consent, language) } : null)}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboard}
      >
        <View style={styles.cardWrap}>
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
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: theme.overlay.backdrop,
    zIndex: 9999,
  },
  keyboard: {
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  cardWrap: {
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
});
