import { selectionA11y } from "./a11ySelection";

describe("selectionA11y", () => {
  it("marks the selected tab with aria-selected", () => {
    expect(selectionA11y("tab", true)).toEqual({
      accessibilityRole: "tab",
      accessibilityState: { selected: true },
      "aria-selected": true,
    });
  });

  it("uses checked semantics for single-choice options", () => {
    const p = selectionA11y("radio", false);
    expect(p.accessibilityRole).toBe("radio");
    expect(p["aria-checked"]).toBe(false);
    expect(p.accessibilityState).toEqual({ checked: false });
  });

  it("uses checked semantics for independent choices", () => {
    expect(selectionA11y("checkbox", true)["aria-checked"]).toBe(true);
  });

  it("uses pressed semantics for toggle buttons", () => {
    const p = selectionA11y("toggle", true);
    expect(p.accessibilityRole).toBe("button");
    expect(p["aria-pressed"]).toBe(true);
  });

  it("carries the disabled state", () => {
    expect(selectionA11y("radio", true, true).accessibilityState).toEqual({ disabled: true, checked: true });
  });
});
