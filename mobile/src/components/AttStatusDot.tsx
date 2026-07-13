import { View, StyleSheet } from "react-native";
import { theme } from "../theme";
import type { AttStatus } from "../lib/participantHistoryHelpers";

function attStatusColor(status: AttStatus): string {
  if (status === "arrived") return theme.colors.success;
  if (status === "absent") return theme.colors.error;
  return theme.colors.textSoft;
}

export function AttStatusDot({ status }: { status: AttStatus }) {
  return <View style={[styles.dot, { backgroundColor: attStatusColor(status) }]} />;
}

const styles = StyleSheet.create({
  dot: { width: 6, height: 6, borderRadius: 3 },
});
