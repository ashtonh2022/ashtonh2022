import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { strings } from '../strings';

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A small modal asking the player to confirm a step that cannot be undone. Cancel has the focus,
 * Escape and a click on the backdrop cancel. It is modal for keyboards and screen readers too: the
 * page behind it is inert and Tab cycles through the dialog's own buttons.
 */
export function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const messageId = useId();
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Everything else on the page (the dialog is portalled straight into <body>) is out of reach.
    const behind = [...document.body.children].filter(
      (element) => element !== backdrop.current && !element.hasAttribute('inert'),
    );
    for (const element of behind) element.setAttribute('inert', '');
    cancelButton.current?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const buttons = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.current.contains(active);
      // Wrap around at either end, and bring back focus that got out (a click on the backdrop).
      let target: HTMLElement | null = null;
      if (!inside) target = first;
      else if (event.shiftKey && active === first) target = last;
      else if (!event.shiftKey && active === last) target = first;
      if (target !== null) {
        event.preventDefault();
        target.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      ref={backdrop}
      className="modal-backdrop confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialog}
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={messageId}
      >
        <p id={messageId} className="confirm-text">
          {message}
        </p>
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="button" onClick={onCancel}>
            {strings.cancel}
          </button>
          <button type="button" className="button button-danger-solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
