import type { RandomSource } from './clock';

/** Bot display names, handed out in order to the first free name in a room. */
export const BOT_NAMES = ['Bot Ada', 'Bot Bo', 'Bot Cy', 'Bot Di'] as const;

export const BOT_MIN_DELAY_MS = 700;
export const BOT_MAX_DELAY_MS = 1500;

/** How long a bot "thinks" before acting: a random 700..1500 ms so play feels natural. */
export function botDelay(random: RandomSource): number {
  const span = BOT_MAX_DELAY_MS - BOT_MIN_DELAY_MS + 1;
  return BOT_MIN_DELAY_MS + Math.min(span - 1, Math.floor(random() * span));
}

/** The first bot name not already used by another bot in the room. */
export function pickBotName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (const name of BOT_NAMES) {
    if (!used.has(name)) return name;
  }
  let n = BOT_NAMES.length + 1;
  while (used.has(`Bot ${n}`)) n++;
  return `Bot ${n}`;
}

/** Stable pseudo player id for a bot seat, so clients never see null on an occupied seat. */
export function botPlayerId(name: string): string {
  return `bot-${name.replace(/^Bot\s+/i, '').toLowerCase()}`;
}
