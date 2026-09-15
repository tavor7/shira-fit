import { useEffect } from "react";
import { Platform } from "react-native";
import { useAccessibilityPrefs } from "../context/AccessibilityContext";

const STYLE_TAG_ID = "shirafit-a11y-overrides";

/**
 * Web-only: translates AccessibilityContext prefs into a single injected <style> tag.
 * Deliberately CSS-only (no per-component rewiring) so it can't diverge from what's
 * actually applied, and is trivial to verify by inspecting the tag.
 *
 * `reduceMotion` here covers CSS transitions/animations directly. This app's JS-driven
 * Animated-API motion (FadeSlideIn, checkmarks, etc.) already reads OS-level
 * prefers-reduced-motion via useReduceMotion/useReduceMotionRef (src/hooks/useReduceMotion.ts);
 * that hook additionally ORs in this same AccessibilityContext preference, so toggling
 * "reduce motion" here also disables the JS-driven animations app-wide, not just CSS ones.
 */
export function AccessibilityStyleInjector() {
  const { prefs } = useAccessibilityPrefs();

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
    if (!tag) {
      tag = document.createElement("style");
      tag.id = STYLE_TAG_ID;
      document.head.appendChild(tag);
    }

    const rules: string[] = [];

    if (prefs.textScale !== 1) {
      // #root is the Expo web export's fixed mount point (public/index.html).
      rules.push(`#root { zoom: ${prefs.textScale}; }`);
    }
    if (prefs.highContrast) {
      rules.push(`html { filter: contrast(1.28) saturate(1.15); }`);
    }
    if (prefs.enhancedFocus) {
      rules.push(
        `*:focus-visible { outline: 3px solid #ffffff !important; outline-offset: 2px !important; border-radius: 4px; }`
      );
    }
    if (prefs.reduceMotion) {
      rules.push(
        `*, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }`
      );
    }
    if (prefs.underlineLinks) {
      rules.push(`a, [role="link"] { text-decoration: underline !important; }`);
    }

    tag.textContent = rules.join("\n");
  }, [prefs]);

  return null;
}
