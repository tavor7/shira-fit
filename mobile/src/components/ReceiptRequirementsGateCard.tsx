import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { theme } from "../theme";
import type { RequiredConsent } from "../lib/documents";
import type { ReceiptRequirementsMode } from "../lib/receiptRequirements";
import { PrimaryButton } from "./PrimaryButton";

type Props = {
  mode: ReceiptRequirementsMode;
  consent: RequiredConsent | null;
  language: "he" | "en";
  isRTL: boolean;
  addressLabel: string;
  zipLabel: string;
  initialAddress?: string;
  initialZipCode?: string;
  preview?: boolean;
  onComplete?: () => void;
  onSave: (input: { address: string; zipCode: string; acceptConsent: boolean; declineConsent: boolean }) => Promise<void>;
};

export function ReceiptRequirementsGateCard({
  mode,
  consent,
  language,
  isRTL,
  addressLabel,
  zipLabel,
  initialAddress = "",
  initialZipCode = "",
  preview = false,
  onComplete,
  onSave,
}: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const addressSectionRef = useRef<View>(null);
  const outerScrollRef = useRef<ScrollView>(null);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [address, setAddress] = useState(initialAddress);
  const [zipCode, setZipCode] = useState(initialZipCode);
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    setAddress(initialAddress);
    setZipCode(initialZipCode);
  }, [initialAddress, initialZipCode, mode, consent?.version]);

  useEffect(() => {
    setDeclined(false);
    setFieldError("");
  }, [mode, consent?.version]);

  const showConsent = mode === "consent_only" || mode === "both";
  const showAddress = mode === "address_only" || mode === "both";
  const addressFirst = mode === "both";
  const consentScrollMax = Math.max(120, Math.min(200, Math.round(windowHeight * 0.22)));

  const title =
    mode === "both"
      ? language === "he"
        ? "השלימו את הפרטים"
        : "Complete your details"
      : mode === "consent_only"
        ? consent?.title ?? (language === "he" ? "הסכמה לקבלות" : "Receipt consent")
        : language === "he"
          ? "עדכון כתובת"
          : "Update your address";

  const intro =
    mode === "both"
      ? language === "he"
        ? "כדי להמשיך להשתמש באפליקציה, יש לאשר את הסכמת קבלת המסמכים האלקטרוניים ולמלא כתובת ומיקוד."
        : "To continue using the app, please accept electronic receipt consent and provide your address and zip code."
      : mode === "address_only"
        ? language === "he"
          ? "נדרשת כתובת ומיקוד לצורך הפקת קבלות. אנא מלא/י את הפרטים להמשך."
          : "A street address and zip code are required for receipts. Please fill them in to continue."
        : null;

  function focusAddressSection() {
    outerScrollRef.current?.scrollTo({ y: 0, animated: true });
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const node = addressSectionRef.current as unknown as { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void };
      node?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }

  async function saveAll() {
    if (showAddress) {
      const addr = address.trim();
      const zip = zipCode.trim();
      if (!addr || !zip) {
        setFieldError(
          language === "he" ? "יש למלא כתובת ומיקוד לפני המשך." : "Please enter your address and zip code to continue.",
        );
        focusAddressSection();
        return;
      }
    }
    setFieldError("");
    setBusy(true);
    try {
      await onSave({ address: address.trim(), zipCode: zipCode.trim(), acceptConsent: true, declineConsent: false });
      onComplete?.();
    } catch {
      if (showConsent) setDeclined(true);
      else setFieldError(language === "he" ? "לא ניתן לשמור. נסו שוב." : "Could not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await onSave({ address: address.trim(), zipCode: zipCode.trim(), acceptConsent: false, declineConsent: true });
      setDeclined(true);
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel =
    mode === "consent_only"
      ? language === "he"
        ? "אני מסכים/ה"
        : "I agree"
      : language === "he"
        ? "שמירה והמשך"
        : "Save and continue";

  function renderAddressBlock(withSectionLabel: boolean) {
    return (
      <View
        ref={addressSectionRef}
        style={[styles.addressBlock, withSectionLabel && styles.section]}
        collapsable={false}
      >
        {withSectionLabel ? (
          <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>
            {language === "he" ? "כתובת למשלוח מסמכים" : "Billing address"}
          </Text>
        ) : null}
        <Text style={[styles.fieldLabel, isRTL && styles.rtl]}>{addressLabel}</Text>
        <TextInput
          style={[styles.input, isRTL && styles.inputRtl]}
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            setFieldError("");
          }}
          placeholder={addressLabel}
          placeholderTextColor={theme.colors.textSoft}
          autoComplete="street-address"
          textContentType="streetAddressLine1"
        />
        <Text style={[styles.fieldLabel, isRTL && styles.rtl]}>{zipLabel}</Text>
        <TextInput
          style={[styles.input, isRTL && styles.inputRtl]}
          value={zipCode}
          onChangeText={(v) => {
            setZipCode(v);
            setFieldError("");
          }}
          placeholder={zipLabel}
          placeholderTextColor={theme.colors.textSoft}
          keyboardType="number-pad"
          autoComplete="postal-code"
          textContentType="postalCode"
        />
      </View>
    );
  }

  function renderConsentBlock(cappedScroll: boolean) {
    if (!showConsent || !consent) return null;

    const content = (
      <>
        {mode === "both" ? (
          <Text style={[styles.sectionLabel, isRTL && styles.rtl]}>
            {language === "he" ? "הסכמה לקבלת מסמכים" : "Electronic receipt consent"}
          </Text>
        ) : null}
        {mode === "consent_only" ? null : (
          <Text style={[styles.consentTitle, isRTL && styles.rtl]}>{consent.title}</Text>
        )}
        <Text style={[styles.body, isRTL && styles.rtl]}>{consent.body_text}</Text>
      </>
    );

    if (cappedScroll) {
      return (
        <View style={styles.section}>
          <ScrollView
            style={[styles.consentScroll, { maxHeight: consentScrollMax }]}
            contentContainerStyle={styles.consentScrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {content}
          </ScrollView>
        </View>
      );
    }

    return <View style={mode === "both" ? styles.section : undefined}>{content}</View>;
  }

  return (
    <View style={[styles.card, { maxHeight: Math.round(windowHeight * 0.9) }]}>
      {preview ? (
        <Text style={[styles.previewBanner, isRTL && styles.rtl]}>
          {language === "he" ? "תצוגה מקדימה בלבד — לא נשמר" : "Preview only — nothing is saved"}
        </Text>
      ) : null}
      <Text style={[styles.title, isRTL && styles.rtl]}>{title}</Text>
      <ScrollView
        ref={outerScrollRef}
        style={styles.bodyScroll}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {intro ? <Text style={[styles.body, isRTL && styles.rtl]}>{intro}</Text> : null}
        {addressFirst && showAddress ? renderAddressBlock(true) : null}
        {!addressFirst ? renderConsentBlock(false) : renderConsentBlock(true)}
        {!addressFirst && showAddress ? renderAddressBlock(mode === "both") : null}
      </ScrollView>
      {declined ? (
        <Text style={[styles.declined, isRTL && styles.rtl]}>
          {language === "he"
            ? "הסכמה לקבלת מסמכים אלקטרוניים נדרשת לשימוש במערכת. אנא אשר/י את ההסכמה כדי להמשיך."
            : "Electronic receipt consent is required to use the app. Please accept to continue."}
        </Text>
      ) : null}
      {fieldError ? <Text style={[styles.fieldError, isRTL && styles.rtl]}>{fieldError}</Text> : null}
      <View style={[styles.actions, isRTL && styles.actionsRtl]}>
        <PrimaryButton label={primaryLabel} onPress={() => void saveAll()} disabled={busy || declined} />
        {showConsent ? (
          <Pressable
            onPress={() => void decline()}
            disabled={busy}
            style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.declineText}>{language === "he" ? "לא מסכים/ה" : "Decline"}</Text>
          </Pressable>
        ) : null}
      </View>
      {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={theme.colors.cta} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
  previewBanner: {
    marginBottom: theme.spacing.sm,
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.warning,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.text, marginBottom: theme.spacing.md },
  bodyScroll: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingBottom: theme.spacing.sm, gap: theme.spacing.md },
  body: { fontSize: 15, lineHeight: 22, color: theme.colors.textMuted },
  section: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderMuted,
    gap: theme.spacing.sm,
  },
  sectionLabel: { fontSize: 13, fontWeight: "800", color: theme.colors.text, textTransform: "uppercase", letterSpacing: 0.3 },
  consentTitle: { fontSize: 16, fontWeight: "800", color: theme.colors.text },
  consentScroll: { borderRadius: theme.radius.md },
  consentScrollContent: { paddingBottom: theme.spacing.xs },
  addressBlock: { gap: theme.spacing.xs },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.text, marginTop: theme.spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.borderMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 12,
    minHeight: 48,
    fontSize: 16,
    color: theme.colors.text,
    backgroundColor: theme.colors.backgroundAlt,
  },
  inputRtl: { textAlign: "right" },
  fieldError: { marginTop: theme.spacing.sm, color: theme.colors.error, fontSize: 13, fontWeight: "600" },
  declined: { marginTop: theme.spacing.md, color: theme.colors.warning, fontSize: 14, fontWeight: "600" },
  actions: { marginTop: theme.spacing.lg, gap: theme.spacing.sm },
  actionsRtl: { alignItems: "stretch" },
  declineBtn: { paddingVertical: 12, alignItems: "center" },
  declineText: { color: theme.colors.textMuted, fontWeight: "700" },
  rtl: { textAlign: "right", writingDirection: "rtl" },
});
