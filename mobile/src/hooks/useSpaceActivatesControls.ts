import { useEffect } from "react";
import { Platform } from "react-native";

// Roles whose native counterparts toggle/select on Space. react-native-web's Pressable only
// responds to Enter for them, so keyboard users pressing Space got nothing (or a page scroll).
const SPACE_ROLES = new Set(["checkbox", "radio", "switch", "tab", "menuitemcheckbox", "menuitemradio"]);

/** Web: Space activates focused custom checkboxes, radios, switches and tabs (as Enter already does). */
export function useSpaceActivatesControls() {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return;
      const role = el.getAttribute("role");
      if (!role || !SPACE_ROLES.has(role) || el.getAttribute("aria-disabled") === "true") return;
      e.preventDefault();
      el.click();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
