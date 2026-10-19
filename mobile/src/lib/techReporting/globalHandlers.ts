/**
 * Global crash/rejection capture (monitoring completion pass - closes the "Global crash handling
 * (later)" follow-up noted in this directory's README). Covers what AppErrorBoundary cannot:
 * unhandled JS exceptions and unhandled promise rejections that occur outside a React render,
 * and app-initialization failures that happen before any screen mounts.
 *
 * Both handlers CHAIN to whatever handler was already installed (React Native's own fatal-error
 * handling, Expo's, a previous call to installGlobalErrorHandlers) rather than replacing it -
 * reporting a crash must never change what happens to the crash itself.
 */
import { reportTechnicalError } from "./reporter";

type ErrorUtilsLike = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

function getErrorUtils(): ErrorUtilsLike | undefined {
  try {
    return (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  } catch {
    return undefined;
  }
}

let installed = false;

/** Idempotent: safe to call more than once (e.g. after a fast-refresh reload in development). */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  try {
    const errorUtils = getErrorUtils();
    const previous = errorUtils?.getGlobalHandler?.();
    if (errorUtils?.setGlobalHandler) {
      errorUtils.setGlobalHandler((error, isFatal) => {
        try {
          reportTechnicalError({
            operation: "client/unhandled_exception",
            error,
            severity: isFatal ? "error" : "warning",
            context: { phase: isFatal ? "fatal" : "non_fatal" },
          });
        } catch {
          /* never block the previous handler */
        }
        previous?.(error, isFatal);
      });
    }
  } catch {
    /* never affects app startup */
  }

  try {
    // Supported by Hermes/React Native (global.addEventListener for 'unhandledrejection') and by
    // the web build (window inherits addEventListener). No-ops silently where unsupported.
    const target = globalThis as unknown as {
      addEventListener?: (type: string, cb: (event: unknown) => void) => void;
    };
    target.addEventListener?.("unhandledrejection", (event) => {
      try {
        const reason = (event as { reason?: unknown } | undefined)?.reason;
        reportTechnicalError({
          operation: "client/unhandled_rejection",
          error: reason,
          severity: "warning",
          context: { phase: "unhandled_rejection" },
        });
      } catch {
        /* never propagate */
      }
    });
  } catch {
    /* never affects app startup */
  }
}

/** Test-only: allow re-installing within the same process. */
export function resetGlobalErrorHandlersForTests(): void {
  installed = false;
}

/**
 * Reports an application-initialization failure (a caller-identified category, since there is no
 * single generic hook for "startup failed" - initNotificationHandler, auth bootstrap, etc. each
 * catch their own failures and should call this from their own catch block).
 */
export function reportInitializationFailure(phase: string, error: unknown): void {
  try {
    reportTechnicalError({
      operation: "client/init_failure",
      error,
      severity: "error",
      context: { phase },
    });
  } catch {
    /* never propagate */
  }
}
