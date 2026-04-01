import { StyleSheet, View } from "react-native";
import { HeaderBackPill } from "./HeaderBackPill";
import { theme } from "../theme";

/** Auth stack: back only (no menu). Empty when there is no stack history. */
export function AuthHeaderLeft() {
  return (
    <View style={styles.wrap}>
      <HeaderBackPill />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingLeft: theme.spacing.sm,
    flexDirection: "row",
    alignItems: "center",
  },
});
