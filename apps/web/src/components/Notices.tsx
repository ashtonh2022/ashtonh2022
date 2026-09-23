import { useEffect } from 'react';

import type { NoticeCode } from '@landlord/protocol';

import { fmt } from '../lib/format';
import type { ConnectionStatus } from '../net/client';
import { useStore } from '../store';
import { strings } from '../strings';

const TOAST_MS = 4000;

/** "Connecting..." / "Reconnecting..." banner until the server has welcomed us. */
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

/** A message that stays until the player closes it (unlike Toast). */
function DismissibleNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="notice notice-dismissible" role="alert">
      <span className="notice-text">{text}</span>
      <button
        type="button"
        className="notice-close"
        onClick={onDismiss}
        aria-label={strings.dismiss}
      >
        ×
      </button>
    </div>
  );
}

/** Home: the host removed the player from a room. */
export function KickedBanner() {
  const kicked = useStore((state) => state.kickedFrom);
  const dismiss = useStore((state) => state.dismissKicked);
  if (!kicked) return null;
  const text =
    kicked.code === null
      ? strings.kickedFromUnknownRoom
      : fmt(strings.kickedFromRoom, { code: kicked.code });
  return <DismissibleNotice text={text} onDismiss={dismiss} />;
}

const NOTICE_TEXT: Record<NoticeCode, string> = {
  moved_to_spectators: strings.movedToSpectators,
};

/** Room: a one-off notice the server sent about room `code`. */
export function RoomNoticeBanner({ code }: { code: string }) {
  const notice = useStore((state) => state.roomNotice);
  const dismiss = useStore((state) => state.dismissRoomNotice);
  if (!notice || notice.code !== code) return null;
  return <DismissibleNotice text={NOTICE_TEXT[notice.notice]} onDismiss={dismiss} />;
}
