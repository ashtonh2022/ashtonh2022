import { useStore } from '../store';

/** The most recent emote bubble for a seat (or a spectator by playerId), if any. */
export function EmoteBubble({ seat, playerId }: { seat: number | null; playerId: string | null }) {
  const bubble = useStore((state) =>
    state.emotes.find(
      (emote) =>
        (seat !== null && emote.seat === seat) ||
        (playerId !== null && emote.playerId === playerId),
    ),
  );
  if (!bubble) return null;
  return (
    <span className="emote-bubble" role="status">
      {bubble.emote}
    </span>
  );
}
