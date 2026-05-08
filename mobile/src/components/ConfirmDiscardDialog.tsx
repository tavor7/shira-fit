import { AppAlertDialog } from "./AppAlertDialog";

type Props = {
  visible: boolean;
  title: string;
  message: string;
  cancelLabel: string;
  discardLabel: string;
  onCancel: () => void;
  onDiscard: () => void;
  isRTL?: boolean;
};

/**
 * On-brand confirmation for leaving with unsaved work (mobile + web).
 * Thin preset over {@link AppAlertDialog}.
 */
export function ConfirmDiscardDialog({
  visible,
  title,
  message,
  cancelLabel,
  discardLabel,
  onCancel,
  onDiscard,
  isRTL,
}: Props) {
  return (
    <AppAlertDialog
      visible={visible}
      title={title}
      message={message}
      isRTL={isRTL}
      onRequestClose={onCancel}
      actions={[
        { label: cancelLabel, variant: "secondary", onPress: onCancel },
        { label: discardLabel, variant: "danger", onPress: onDiscard },
      ]}
    />
  );
}
