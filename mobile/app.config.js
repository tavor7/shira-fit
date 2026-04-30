export default ({ config }) => ({
  ...config,
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    // For Supabase auth emails (confirm + recovery). Set to your deployed web origin (NOT localhost),
    // e.g. https://app.example.com
    authRedirectOrigin: process.env.EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN,
  },
});
