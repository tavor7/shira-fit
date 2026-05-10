import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useManagerAthletePreview } from "../context/ManagerAthletePreviewContext";
import {
  ROUTE_RESTORE_DEBUG_KEY_INDEX,
  ROUTE_RESTORE_DEBUG_KEY_TRACKER,
  ROUTE_RESTORE_DEBUG_PANEL,
} from "../lib/routeRestoreDebug";
import { canRoleAccessWebPath, peekWebLastRouteRaw, readWebLastRoute } from "../lib/webLastRoute";

/**
 * Temporary web overlay for diagnosing route restore (localStorage + index + tracker).
 */
export function RouteRestoreDebugPanel() {
  if (Platform.OS !== "web" || !ROUTE_RESTORE_DEBUG_PANEL) return null;
  return <RouteRestoreDebugPanelInner />;
}

function RouteRestoreDebugPanelInner() {
  const { session, profile, loading } = useAuth();
  const { enabled: managerAthletePreview } = useManagerAthletePreview();
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 400);
    return () => clearInterval(id);
  }, []);

  const uid = session?.user?.id ?? null;
  const role = profile?.role ?? null;
  const winPath = typeof window !== "undefined" ? window.location.pathname : "";
  const winSearch = typeof window !== "undefined" ? window.location.search : "";
  const winFull = winPath + winSearch;

  const rawSaved = peekWebLastRouteRaw(uid);
  const normSaved = readWebLastRoute(uid);
  const canSaved =
    normSaved && role ? canRoleAccessWebPath(role, normSaved, { managerAthletePreview }) : false;

  let indexSnap: Record<string, unknown> | null = null;
  try {
    const s = sessionStorage.getItem(ROUTE_RESTORE_DEBUG_KEY_INDEX);
    if (s) indexSnap = JSON.parse(s) as Record<string, unknown>;
  } catch {
    indexSnap = null;
  }

  let trackerSnap: { t?: string; savedPath?: string } | null = null;
  try {
    const s = sessionStorage.getItem(ROUTE_RESTORE_DEBUG_KEY_TRACKER);
    if (s) trackerSnap = JSON.parse(s) as { t?: string; savedPath?: string };
  } catch {
    trackerSnap = null;
  }

  const indexDecision = indexSnap?.decision != null ? String(indexSnap.decision) : "—";
  const indexSavedVal =
    indexSnap && Object.prototype.hasOwnProperty.call(indexSnap, "saved")
      ? indexSnap.saved === null
        ? "null"
        : String(indexSnap.saved as string)
      : "—";
  const indexChoseSaved = indexDecision === "index_chose_saved_route";
  const indexChoseDefault = indexDecision === "index_chose_role_default";

  const trackerPath = trackerSnap?.savedPath ?? "—";
  const trackerMatchesCurrent = trackerSnap?.savedPath === winFull;

  const indexSnapStale =
    indexSnap?.indexLocationPathname != null && String(indexSnap.indexLocationPathname) !== winPath;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Route restore debug (temporary)</Text>
      <Text style={styles.line} selectable>
        1) window.location: {winFull || "—"}
      </Text>
      <Text style={styles.line} selectable>
        2) localStorage raw (last route key): {rawSaved ?? "(null)"}
      </Text>
      <Text style={styles.line} selectable>
        3) userId: {uid ?? "—"}
      </Text>
      <Text style={styles.line} selectable>
        4) role: {role ?? "—"}
      </Text>
      <Text style={styles.line} selectable>
        5) auth loading: {String(loading)}
      </Text>
      <Text style={styles.line} selectable>
        6) profile loaded: {String(!!profile)}
      </Text>
      <Text style={styles.line} selectable>
        7) canRoleAccessWebPath(normalized saved): {normSaved ? String(canSaved) : "N/A (no normalized saved)"}
        {"\n"}
        normalized: {normSaved ?? "—"}
      </Text>
      <Text style={styles.line} selectable>
        8) index.tsx: decision={indexDecision}
        {indexChoseSaved ? " → used SAVED route" : ""}
        {indexChoseDefault ? " → used ROLE DEFAULT" : ""}
        {"\n"}
        snapshot saved: {indexSavedVal}
        {indexSnapStale ? "\n(note: snapshot pathname was " + String(indexSnap?.indexLocationPathname) + " — may be stale if you did not open /)" : ""}
      </Text>
      <Text style={styles.line} selectable>
        9) WebLastRouteTracker last write: {trackerPath} @ {trackerSnap?.t ?? "—"}
        {"\n"}
        matches current URL: {String(trackerMatchesCurrent)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    maxHeight: "42%",
    padding: 10,
    backgroundColor: "rgba(10,10,14,0.92)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#6a5acd",
    zIndex: 999999,
  },
  title: { color: "#b8a9ff", fontWeight: "900", fontSize: 11, marginBottom: 6 },
  line: {
    color: "#e6e6ea",
    fontSize: 9,
    lineHeight: 13,
    fontFamily: Platform.OS === "web" ? "monospace" : undefined,
    marginBottom: 5,
  },
});
