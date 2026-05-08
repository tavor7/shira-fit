import { useCallback, useRef, useState } from "react";
import { ConfirmDiscardDialog } from "../components/ConfirmDiscardDialog";

type Labels = { cancel: string; discard: string };

/**
 * Stateful discard confirmation using {@link ConfirmDiscardDialog} (same UX on iOS, Android, web).
 */
export function useDiscardChangesPrompt(isRTL: boolean) {
  const [visible, setVisible] = useState(false);
  const [copy, setCopy] = useState<{ title: string; message: string }>({ title: "", message: "" });
  const [labels, setLabels] = useState<Labels>({ cancel: "", discard: "" });
  const onDiscardRef = useRef<(() => void) | null>(null);

  const promptDiscardChanges = useCallback((title: string, message: string, lbl: Labels, onDiscard: () => void) => {
    onDiscardRef.current = onDiscard;
    setCopy({ title, message });
    setLabels(lbl);
    setVisible(true);
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
    onDiscardRef.current = null;
  }, []);

  const handleDiscard = useCallback(() => {
    const fn = onDiscardRef.current;
    setVisible(false);
    onDiscardRef.current = null;
    fn?.();
  }, []);

  const discardDialog = (
    <ConfirmDiscardDialog
      visible={visible}
      title={copy.title}
      message={copy.message}
      cancelLabel={labels.cancel}
      discardLabel={labels.discard}
      onCancel={handleCancel}
      onDiscard={handleDiscard}
      isRTL={isRTL}
    />
  );

  return { promptDiscardChanges, discardDialog };
}
