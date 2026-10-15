import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { isPerfEnabled } from "../lib/perf/perfFlag";
import { perfClear, perfSnapshot, type PerfSnapshot } from "../lib/perf/perfStore";

/**
 * Developer overlay for the performance instrumentation (docs/performance/README.md). Renders nothing unless
 * instrumentation is enabled on this device (web only). English-only on purpose: it is a measurement tool, not product UI.
 */
export function PerfPanel() {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const [copied, setCopied] = useState(false);

  if (Platform.OS !== "web" || !isPerfEnabled()) return null;

  const refresh = () => setSnap(perfSnapshot());
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(perfSnapshot(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (!open) {
    return (
      <Pressable
        accessibilityLabel="Performance panel"
        onPress={() => {
          refresh();
          setOpen(true);
        }}
        style={styles.fab}
      >
        <Text style={styles.fabText}>⏱</Text>
      </Pressable>
    );
  }

  const rows = (snap?.summaries ?? []).slice(-12).reverse();
  return (
    <View style={styles.panel}>
      <View style={styles.actions}>
        <Pressable onPress={refresh} style={styles.btn}><Text style={styles.btnText}>Refresh</Text></Pressable>
        <Pressable onPress={() => void copy()} style={styles.btn}><Text style={styles.btnText}>{copied ? "Copied" : "Copy JSON"}</Text></Pressable>
        <Pressable onPress={() => { perfClear(); refresh(); }} style={styles.btn}><Text style={styles.btnText}>Clear</Text></Pressable>
        <Pressable onPress={() => setOpen(false)} style={styles.btn}><Text style={styles.btnText}>Close</Text></Pressable>
      </View>
      <ScrollView style={styles.list}>
        {snap ? (
          <Text style={styles.line}>
            startup: {snap.startup.requests} req · depth {snap.startup.depth} · settled {snap.startup.settledMs ?? "–"} ms
          </Text>
        ) : null}
        {rows.map((s) => (
          <Text key={s.visitId} style={styles.line}>
            {s.screen}: tap→content {s.tapToContentMs ?? "–"} · focus→content {s.focusToContentMs ?? "–"} ms · {s.requestsBeforeContent} req / depth{" "}
            {s.depthBeforeContent} before content · {s.requestsInWindow} req / depth {s.depthInWindow} in 5 s · settled {s.settledMs ?? "–"} ms ·
            hidden {s.notReadyMs} ms
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    left: 8,
    bottom: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  fabText: { color: "#fff", fontSize: 18 },
  panel: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    maxHeight: "60%",
    backgroundColor: "rgba(0,0,0,0.88)",
    borderRadius: 10,
    padding: 8,
    zIndex: 9999,
  },
  actions: { flexDirection: "row", gap: 8, marginBottom: 6, flexWrap: "wrap" },
  btn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "#333" },
  btnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  list: { flexGrow: 0 },
  line: { color: "#ddd", fontSize: 11, marginBottom: 4, fontFamily: "monospace" },
});
