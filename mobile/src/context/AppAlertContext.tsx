import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AppAlertDialog, type AppAlertAction } from "../components/AppAlertDialog";
import { useI18n } from "./I18nContext";

export type ShowAppAlertOptions = {
  title: string;
  message: string;
  actions: AppAlertAction[];
};

type Ctx = {
  showAlert: (opts: ShowAppAlertOptions) => void;
  /** Single primary OK — common for errors and info */
  showOk: (title: string, message: string, okLabel?: string) => void;
  /** Confirm with cancel (secondary) + confirm (danger or primary) */
  showConfirm: (opts: {
    title: string;
    message: string;
    cancelLabel: string;
    confirmLabel: string;
    /** danger = destructive confirm; primary = neutral confirm */
    confirmVariant?: "danger" | "primary";
    onConfirm: () => void;
  }) => void;
};

const AppAlertContext = createContext<Ctx | null>(null);

export function AppAlertProvider({ children }: { children: ReactNode }) {
  const { t, isRTL } = useI18n();
  const [opts, setOpts] = useState<ShowAppAlertOptions | null>(null);
  const [instanceKey, setInstanceKey] = useState(0);

  const close = useCallback(() => setOpts(null), []);

  const showAlert = useCallback((o: ShowAppAlertOptions) => {
    setInstanceKey((k) => k + 1);
    setOpts({
      ...o,
      actions: o.actions.map((a) => ({
        ...a,
        onPress: () => {
          close();
          a.onPress();
        },
      })),
    });
  }, [close]);

  const showOk = useCallback(
    (title: string, message: string, okLabel = t("common.ok")) => {
      showAlert({
        title,
        message,
        actions: [{ label: okLabel, variant: "primary", onPress: () => {} }],
      });
    },
    [showAlert, t]
  );

  const showConfirm = useCallback(
    ({
      title,
      message,
      cancelLabel,
      confirmLabel,
      confirmVariant = "primary",
      onConfirm,
    }: {
      title: string;
      message: string;
      cancelLabel: string;
      confirmLabel: string;
      confirmVariant?: "danger" | "primary";
      onConfirm: () => void;
    }) => {
      showAlert({
        title,
        message,
        actions: [
          { label: cancelLabel, variant: "secondary", onPress: () => {} },
          { label: confirmLabel, variant: confirmVariant, onPress: onConfirm },
        ],
      });
    },
    [showAlert]
  );

  const onRequestClose = useCallback(() => {
    if (!opts) return;
    if (opts.actions.length === 1) {
      opts.actions[0].onPress();
      return;
    }
    const secondary = opts.actions.find((a) => a.variant === "secondary");
    if (secondary) secondary.onPress();
    else close();
  }, [opts, close]);

  const value = useMemo(() => ({ showAlert, showOk, showConfirm }), [showAlert, showOk, showConfirm]);

  return (
    <AppAlertContext.Provider value={value}>
      {children}
      <AppAlertDialog
        visible={!!opts}
        title={opts?.title ?? ""}
        message={opts?.message ?? ""}
        actions={opts?.actions ?? []}
        onRequestClose={onRequestClose}
        isRTL={isRTL}
        instanceKey={instanceKey}
      />
    </AppAlertContext.Provider>
  );
}

export function useAppAlert(): Ctx {
  const ctx = useContext(AppAlertContext);
  if (!ctx) throw new Error("useAppAlert must be used within AppAlertProvider");
  return ctx;
}
