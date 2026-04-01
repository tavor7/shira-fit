import React, { type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

type Props = { children: ReactNode };

type State = { err: Error | null };

/**
 * Catches render errors so a single bad screen does not white-screen the whole tree.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (__DEV__) {
      console.error("[AppErrorBoundary]", error, info.componentStack);
    }
  }

  private reload = () => {
    this.setState({ err: null });
  };

  render() {
    if (this.state.err) {
      return (
        <View style={styles.box}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body} numberOfLines={4}>
            {this.state.err.message || "Unexpected error"}
          </Text>
          <Pressable onPress={this.reload} style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}>
            <Text style={styles.btnTxt}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: {
    flex: 1,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  title: { color: theme.colors.text, fontSize: 20, fontWeight: "800" },
  body: { color: theme.colors.textMuted, fontSize: 14, textAlign: "center" },
  btn: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.cta,
  },
  btnPressed: { opacity: 0.9 },
  btnTxt: { color: theme.colors.ctaText, fontWeight: "800", fontSize: 15 },
});
