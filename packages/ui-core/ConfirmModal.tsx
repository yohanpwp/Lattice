import { useState } from "react";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  confirmVariant = "danger",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  async function handleConfirm() {
    try {
      setSubmitting(true);
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div className="lattice-modal-dialog" style={{ maxWidth: "440px" }}>
        <header className="lattice-modal-header">
          <h2 id="confirm-modal-title">{title}</h2>
          <button type="button" className="lattice-modal-close" onClick={onCancel} aria-label="Close" disabled={submitting}>
            ✕
          </button>
        </header>

        <div style={{ padding: "1.25rem 1.5rem" }}>
          <p style={{ margin: 0, color: "var(--lattice-text)", lineHeight: 1.6 }}>{message}</p>
        </div>

        <footer className="lattice-modal-footer">
          <button type="button" className="lattice-btn-secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className={confirmVariant === "danger" ? "lattice-btn-danger" : "lattice-btn-primary"}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? "Processing…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
