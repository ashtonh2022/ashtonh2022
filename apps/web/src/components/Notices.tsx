import { useEffect } from 'react';

import type { ConnectionStatus } from '../net/client';
import { useStore } from '../store';
import { strings } from '../strings';

const TOAST_MS = 4000;

/** "Reconnecting..." banner while the socket is down. */
export function StatusBanner({ status }: { status: ConnectionStatus }) {
  if (status === 'open') return null;
  return (
    <div className="banner" role="status">
      {status === 'connecting' ? strings.connecting : strings.reconnecting}
    </div>
  );
}

/**
 * The last server error, hidden four seconds after it arrived. An older error (one that arrived
 * while no toast was on screen) is never shown.
 */
export function Toast() {
  const error = useStore((state) => state.lastError);
  const dismiss = useStore((state) => state.dismissError);
  const expired = error !== null && Date.now() - error.at >= TOAST_MS;
  useEffect(() => {
    if (!error) return;
    const left = TOAST_MS - (Date.now() - error.at);
    if (left <= 0) {
      dismiss();
      return;
    }
    const timer = setTimeout(dismiss, left);
    return () => clearTimeout(timer);
  }, [error, dismiss]);
  if (!error || expired) return null;
  return (
    <div className="toast" role="alert">
      <span className="toast-text">{error.message || strings.errorTitle}</span>
      <button type="button" className="toast-close" onClick={dismiss} aria-label={strings.dismiss}>
        ×
      </button>
    </div>
  );
}
