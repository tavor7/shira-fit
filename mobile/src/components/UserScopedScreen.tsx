import { Fragment, type ReactNode } from "react";
import { useAuth } from "../context/AuthContext";

/**
 * Remounts its screen when the signed-in user changes (Performance Phase 1 / step 5). Screens now keep loaded content
 * through refreshes, so this guarantees one account's data is never shown, even briefly, to another account that signs
 * in on the same device: the new user starts from an empty screen and a first-load skeleton.
 */
export function UserScopedScreen({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return <Fragment key={session?.user?.id ?? "signed-out"}>{children}</Fragment>;
}
