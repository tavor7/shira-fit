import { View, StyleSheet } from "react-native";
import { theme } from "../theme";
import { NotificationSettingsPanel } from "../components/NotificationSettingsPanel";

export default function NotificationSettingsScreen() {
  return (
    <View style={styles.screen}>
      <NotificationSettingsPanel variant="screen" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.backgroundAlt, padding: theme.spacing.md },
});
