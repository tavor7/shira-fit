import { useEffect, useRef } from "react";
import { Platform } from "react-native";

/**
 * Browser Back closes the open dialog first (Phase 5 / Q, web only).
 *
 * Each open dialog adds one history entry (same URL, same router id, plus a `__dlg` marker). Back pops it:
 * a capture-phase popstate listener runs before expo-router's and stops the event, so the router never
 * sees that pop, and the dialog's own onClose runs. When a dialog closes normally its entry is removed
 * again (history.back(), likewise hidden from the router). When the app navigates while a dialog entry is
 * on top (an action inside the dialog), the dialog entry is popped first and the router's push/replace
 * is applied after it — so history ends up exactly as it would without the dialog: no stray entries.
 */

type Open = { token: string; close: () => void };
const DLG = "__dlg";

const open: Open[] = [];
let suppress = 0;
let queued: (() => void)[] = [];
let fallback: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let seq = 0;

type H = History & { __dlgPatched?: boolean };

function currentToken(): string | undefined {
  const s = window.history.state as Record<string, unknown> | null;
  return typeof s?.[DLG] === "string" ? (s[DLG] as string) : undefined;
}

let origPush: History["pushState"];
let origReplace: History["replaceState"];

function flush() {
  if (fallback) clearTimeout(fallback);
  fallback = null;
  const q = queued;
  queued = [];
  q.forEach((fn) => fn());
}

/** Pop the dialog entry on top without the router noticing; then run `after` (if any). */
function popSilently(after?: () => void) {
  if (after) queued.push(after);
  if (suppress > 0) return; // a silent pop is already under way; `after` runs with it
  suppress += 1;
  window.history.back();
  // Safety net: if the browser never fires popstate, don't hold the router's navigation hostage.
  fallback = setTimeout(() => {
    suppress = 0;
    flush();
  }, 400);
}

function install() {
  if (installed || Platform.OS !== "web" || typeof window === "undefined") return;
  installed = true;
  const h = window.history as H;
  origPush = h.pushState.bind(h);
  origReplace = h.replaceState.bind(h);
  if (!h.__dlgPatched) {
    h.__dlgPatched = true;
    // Router navigation while a dialog entry is on top: drop the dialog entry first.
    h.pushState = (data, unused, url) => {
      if (currentToken() && !(data && typeof data === "object" && DLG in data)) {
        popSilently(() => origPush(data, unused, url));
        return;
      }
      origPush(data, unused, url);
    };
    h.replaceState = (data, unused, url) => {
      if (currentToken() && !(data && typeof data === "object" && DLG in data)) {
        popSilently(() => origReplace(data, unused, url));
        return;
      }
      origReplace(data, unused, url);
    };
  }
  window.addEventListener(
    "popstate",
    (e) => {
      if (suppress > 0) {
        suppress -= 1;
        e.stopImmediatePropagation();
        flush();
        return;
      }
      const top = open[open.length - 1];
      if (top && currentToken() !== top.token) {
        // Back while this dialog's entry was on top: close the dialog, keep the page.
        e.stopImmediatePropagation();
        open.pop();
        top.close();
      }
    },
    { capture: true }
  );
}

/** While `visible`, browser Back calls `onClose` instead of leaving the page. No-op on native. */
export function useWebBackDismiss(visible: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !visible) return;
    install();
    const token = `d${++seq}`;
    const entry: Open = { token, close: () => closeRef.current() };
    open.push(entry);
    const base = (window.history.state as Record<string, unknown> | null) ?? {};
    origPush({ ...base, [DLG]: token }, "", window.location.href);

    return () => {
      const i = open.indexOf(entry);
      if (i >= 0) open.splice(i, 1);
      // Closed normally (or unmounted): remove its entry if it is still the one on top. Deferred one tick so
      // a navigation fired by the same tap is handled by the push/replace patch instead.
      setTimeout(() => {
        if (currentToken() === token) popSilently();
      }, 0);
    };
  }, [visible]);
}

/** Test hook. */
export function __webBackDismissState() {
  return { open: open.length, suppress, queued: queued.length };
}
