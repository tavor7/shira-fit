export default ({ config }) => ({
  ...config,
  extra: {
    ...config?.extra,
    eas: {
      // Set once via `npx eas-cli init` (writes project ID into app.json) or EAS_PROJECT_ID at build time.
      projectId:
        process.env.EAS_PROJECT_ID ??
        process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
        config?.extra?.eas?.projectId,
    },
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    // For Supabase auth emails (confirm + recovery). Set to your deployed web origin (NOT localhost),
    // e.g. https://app.example.com
    authRedirectOrigin: process.env.EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN,
    /** Full URL to hosted privacy policy — set after deploy, e.g. https://<your-service>.onrender.com/privacy-policy */
    privacyPolicyUrl: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  },
});
