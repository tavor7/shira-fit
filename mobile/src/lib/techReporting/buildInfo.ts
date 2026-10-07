/**
 * App/build metadata for reports, read from the Expo runtime. Never throws; any unavailable field is simply omitted
 * (nothing is invented).
 *
 *   production native build : appVersion = expoConfig.version (app.json), build = native build number / version code
 *   development build       : same, env = "dev"
 *   Expo Go                 : appVersion = the project's version, build = Expo Go's OWN native build, env = "expogo"
 *   web                     : appVersion = the project's version, build omitted (no native build), platform = "web"
 */
import Constants from "expo-constants";
import { Platform } from "react-native";

export interface BuildInfo {
  appVersion?: string;
  build?: string;
  platform?: "ios" | "android" | "web";
  env?: string;
}

const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

function pick(v: unknown): string | undefined {
  return typeof v === "string" && VERSION_RE.test(v) ? v : undefined;
}

export function getBuildInfo(): BuildInfo {
  const info: BuildInfo = {};
  try {
    info.appVersion = pick(Constants.expoConfig?.version) ?? pick(Constants.nativeAppVersion);
  } catch {
    /* omitted */
  }
  try {
    info.build = pick(Constants.nativeBuildVersion);
  } catch {
    /* omitted */
  }
  try {
    const os = Platform.OS;
    if (os === "ios" || os === "android" || os === "web") info.platform = os;
  } catch {
    /* omitted */
  }
  try {
    const exec = (Constants as { executionEnvironment?: string }).executionEnvironment;
    info.env = exec === "storeClient" ? "expogo" : typeof __DEV__ !== "undefined" && __DEV__ ? "dev" : "prod";
  } catch {
    /* omitted */
  }
  return info;
}
