import { useCallback } from "react";
import { router, useNavigationContainerRef, type Href } from "expo-router";

/**
 * Performance Phase 3 (PROTOTYPE, needs UX approval): staff menu destinations are sections, not drill-ins.
 *
 * The menu used router.push for every item, so each tap added another copy of a screen on top of the stack; after 12
 * taps a manager had 13 mounted screens (three copies each of Sessions, Overview, Money, Roster calendar), 91 MB of JS
 * heap, and Back retraced every menu tap. Here a destination that is already in the stack is returned to (the screens
 * above it are closed, so their own "discard changes?" guards still run); a destination that is not in the stack is
 * pushed exactly as before.
 */

type NavState = { routes: { name: string; state?: NavState }[] };

/** Route name of an (app)-stack destination, e.g. "/(app)/manager/sessions" -> "manager/sessions". */
export function appStackRouteName(href: string): string {
  return href.replace(/^\/\(app\)\//, "").replace(/^\//, "");
}

/** The (app) stack's state; expo-router nests it under its own root route ("__root"). */
function findAppStack(state: NavState | undefined | null): NavState | undefined {
  for (const r of state?.routes ?? []) {
    if (r.name === "(app)") return r.state;
    const nested = findAppStack(r.state);
    if (nested) return nested;
  }
  return undefined;
}

/** Whether `href` names a screen already in the (app) stack (so the menu returns to it instead of pushing a copy). */
export function isInAppStack(root: NavState | undefined | null, href: string): boolean {
  const app = findAppStack(root);
  const name = appStackRouteName(href);
  return !!app?.routes?.some((r) => r.name === name);
}

export function useMenuNavigate(): (href: string) => void {
  const ref = useNavigationContainerRef();
  return useCallback(
    (href: string) => {
      const root = (ref.isReady?.() ? ref.getRootState?.() : null) as NavState | null;
      if (isInAppStack(root, href)) router.dismissTo(href as Href);
      else router.push(href as Href);
    },
    [ref]
  );
}
