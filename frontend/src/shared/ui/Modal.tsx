import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./primitives";

/**
 * A modal dialog. Escape and the backdrop close it; focus moves into the dialog on open and back
 * to the previously focused element on close.
 */
export function Modal({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Buttons shown at the bottom (e.g. Cancelar / Aceptar). */
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([data-modal-close]), [href], [tabindex]:not([tabindex='-1'])",
    );
    (first ?? dialog)?.focus();

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="au-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="au-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="au-modal__header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Cerrar" data-modal-close>
            ✕
          </Button>
        </div>
        {children}
        {footer && <div className="au-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
