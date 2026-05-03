import Constants from "expo-constants";

/** Shira Fit studio — links shown in the app footer. */
export const STUDIO_CONTACT = {
  instagramUrl: "https://www.instagram.com/shira.fit.studio/?hl=en",
  /** Clean site URL (UTM params not needed in-app). */
  websiteUrl: "https://get-marketing.co.il/shira-fit/",
  /** Fallback if `EXPO_PUBLIC_PRIVACY_POLICY_URL` is unset — prefer deploying `/privacy-policy` on your Expo web host (Render). */
  privacyPolicyUrl: "https://get-marketing.co.il/shira-fit/privacy-policy",
  phoneDisplay: "052-959-3297",
  phoneTel: "tel:+972529593297",
} as const;

/** Resolved policy URL: env (`EXPO_PUBLIC_PRIVACY_POLICY_URL` → app.config extra) overrides marketing fallback. */
export function getPrivacyPolicyUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.privacyPolicyUrl as string | undefined;
  if (typeof fromExtra === "string" && fromExtra.trim().length > 0) return fromExtra.trim();
  return STUDIO_CONTACT.privacyPolicyUrl;
}
