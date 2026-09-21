import { fmt } from '../lib/format';
import { useStore } from '../store';
import { strings } from '../strings';

interface TopBarProps {
  code: string;
  onLeave: () => void;
}

export function TopBar({ code, onLeave }: TopBarProps) {
  const muted = useStore((state) => state.muted);
  const setMuted = useStore((state) => state.setMuted);
  const chatOpen = useStore((state) => state.chatOpen);
  const setChatOpen = useStore((state) => state.setChatOpen);
  const unread = useStore((state) => state.unreadChat);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-title">{strings.appName}</span>
        <span className="topbar-code" data-testid="room-code">
          {fmt(strings.roomCode, { code })}
        </span>
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className={chatOpen ? 'icon-button icon-button-active' : 'icon-button'}
          aria-label={chatOpen ? strings.closeChat : strings.openChat}
          aria-pressed={chatOpen}
          onClick={() => setChatOpen(!chatOpen)}
        >
          <span aria-hidden="true">💬</span>
          {unread > 0 && !chatOpen && (
            <span className="badge-count" aria-label={fmt(strings.unread, { count: unread })}>
              {unread}
            </span>
          )}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={muted ? strings.soundOff : strings.soundOn}
          aria-pressed={!muted}
          onClick={() => setMuted(!muted)}
        >
          <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span>
        </button>
        <button type="button" className="button button-small" onClick={onLeave}>
          {strings.leave}
        </button>
      </div>
    </header>
  );
}
