import { useStore } from '../store';

interface EmoteBubbleProps {
  seat: number | null;
  playerId: string | null;
  /** next to a name in a list (spectators) instead of floating over a seat */
  inline?: boolean;
}

/** The most recent emote bubble for a seat (or a spectator by playerId), if any. */
export function EmoteBubble({ seat, playerId, inline = false }: EmoteBubbleProps) {
  const bubble = useStore((state) =>
    state.emotes.find(
      (emote) =>
        (seat !== null && emote.seat === seat) ||
        (playerId !== null && emote.playerId === playerId),
    ),
  );
  if (!bubble) return null;
  return (
    <span className={inline ? 'emote-bubble emote-bubble-inline' : 'emote-bubble'} role="status">
      {bubble.emote}
    </span>
  );
}
