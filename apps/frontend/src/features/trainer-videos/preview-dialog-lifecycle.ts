interface PreviewFocusTarget {
  readonly isConnected: boolean;
  focus: () => void;
}
interface PreviewDialog {
  readonly open: boolean;
  showModal: () => void;
  close: () => void;
}

export const openPreviewDialog = (
  dialog: PreviewDialog,
  closeButton: Pick<PreviewFocusTarget, 'focus'> | null,
  trigger: PreviewFocusTarget | null,
): (() => void) => {
  if (!dialog.open) dialog.showModal();
  closeButton?.focus();
  return () => {
    if (dialog.open) dialog.close();
    if (trigger?.isConnected) trigger.focus();
  };
};
