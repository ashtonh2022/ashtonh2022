import type { RoomView, SeatView } from '@landlord/protocol';

export type TablePosition = 'bottom' | 'left' | 'top' | 'right';

/**
 * Places every seat around the table from the viewer's point of view: the viewer (or seat 0 for
 * spectators) at the bottom, then clockwise: left, top (4 players only), right.
 */
export function seatPositions(room: RoomView): Array<{ seat: SeatView; position: TablePosition }> {
  const count = room.seats.length;
  const anchor = room.you.seat ?? 0;
  const order: TablePosition[] =
    count === 4 ? ['bottom', 'left', 'top', 'right'] : ['bottom', 'left', 'right'];
  const out: Array<{ seat: SeatView; position: TablePosition }> = [];
  for (let offset = 0; offset < count; offset++) {
    const seat = room.seats[(anchor + offset) % count];
    const position = order[offset];
    if (seat && position) out.push({ seat, position });
  }
  return out;
}

export function seatName(room: RoomView, seat: number | null, fallback = '?'): string {
  if (seat === null) return fallback;
  const view = room.seats[seat];
  return view?.name ?? fallback;
}
