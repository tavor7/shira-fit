import Constants from "expo-constants";
import * as Linking from "expo-linking";

/**
 * Build an auth redirect URL for Supabase emails (confirm + recovery).
 *
 * In dev / Expo Go, `Linking.createURL()` may produce a localhost URL which is
 * unusable from an email on real devices. This helper avoids localhost by:
 * - Preferring an explicit web origin (EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN)
 * - Falling back to the app scheme deep link (e.g. shirafit:///(auth)/reset-password)
 */
export function buildAuthRedirectUrl(pathname: string): string {
  const origin =
    process.env.EXPO_PUBLIC_AUTH_REDIRECT_ORIGIN ??
    (Constants.expoConfig?.extra as any)?.authRedirectOrigin;

  if (origin) {
    const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${base}${path}`;
  }

  const url = Linking.createURL(pathname);
  if (/\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
    const scheme = Constants.expoConfig?.scheme ?? "shirafit";
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${scheme}://${path}`;
  }
  return url;
}

