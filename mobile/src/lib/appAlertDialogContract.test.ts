/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories and late requires of the mocked modules */
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockModalProps: { current: Record<string, unknown> | null } = { current: null };
jest.mock("../components/AppModal", () => ({
  AppModal: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    mockModalProps.current = props;
    return null;
  },
}));
jest.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => ({ "common.close": "Close" })[k] ?? k, isRTL: false, language: "en" }),
}));

const { AppAlertDialog } = require("../components/AppAlertDialog") as typeof import("../components/AppAlertDialog");

describe("AppAlertDialog accessibility contract", () => {
  it("labels the backdrop neutrally (never with an action) and scrolls its content", () => {
    act(() => {
      TestRenderer.create(
        React.createElement(AppAlertDialog, {
          visible: true,
          title: "Resolve this issue?",
          message: "m",
          onRequestClose: () => {},
          actions: [
            { label: "It's fixed", variant: "primary", onPress: () => {} },
            { label: "It's expected behavior", variant: "secondary", onPress: () => {} },
            { label: "Cancel", variant: "secondary", onPress: () => {} },
          ],
        })
      );
    });
    const p = mockModalProps.current!;
    expect(p.backdropAccessibilityLabel).toBe("Close"); // not "It's fixed"
    expect(p.scrollContent).toBe(true); // five mute durations / long copy / short windows must stay reachable
    expect(p.variant).toBe("dialog");
  });
});
