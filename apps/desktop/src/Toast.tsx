import { useEffect } from "react";

const AUTO_DISMISS_MS = 5000;

// A bottom-of-window notification pill — replaces silent state updates for
// actions worth confirming happened (e.g. "moved to Recycle Bin"), with an
// optional action (e.g. Undo) alongside the message. Generic on purpose so
// other flows can reuse it rather than each growing its own toast.
export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
    // Only the toast's own identity should restart the timer, not `onDismiss`
    // identity changes from a parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  return (
    <div className="toast" role="status">
      <span className="toast-message">{message}</span>
      {actionLabel && onAction && (
        <button
          className="toast-action"
          onClick={() => {
            onAction();
            onDismiss();
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
