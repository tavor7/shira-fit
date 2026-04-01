import { StyleSheet, View } from "react-native";
import { GlobalQuickMenu } from "./GlobalQuickMenu";
import { HeaderBackPill } from "./HeaderBackPill";
import { theme } from "../theme";

/**
 * Stack header left: back (when history exists) + quick menu.
 */
export function AppHeaderLeft() {
  return (
    <View style={styles.row}>
      <HeaderBackPill />
      <GlobalQuickMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: theme.spacing.sm,
  },
});
