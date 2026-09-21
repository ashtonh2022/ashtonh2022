/**
 * Sound effects. Files live in public/audio (silent placeholders by default, see the README
 * there). Playback respects the mute flag and swallows every error (autoplay policies, missing
 * files, test environments without an Audio implementation).
 */
export const SOUND_NAMES = [
  'deal',
  'your-turn',
  'play',
  'pass',
  'bomb',
  'rocket',
  'landlord',
  'win',
  'lose',
  'spring',
  'chat',
  'tick',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

const MUTED_KEY = 'landlord.muted';

const clips = new Map<SoundName, HTMLAudioElement>();
let muted = false;
let preloaded = false;

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTED_KEY, value ? 'true' : 'false');
  } catch {
    // storage may be unavailable (private mode, tests)
  }
}

export function isMuted(): boolean {
  return muted;
}

export function preload(): void {
  if (preloaded || typeof Audio === 'undefined') return;
  preloaded = true;
  for (const name of SOUND_NAMES) {
    try {
      const audio = new Audio(`/audio/${name}.wav`);
      audio.preload = 'auto';
      clips.set(name, audio);
    } catch {
      // ignore: sounds are optional
    }
  }
}

export function play(name: SoundName): void {
  if (muted) return;
  if (!preloaded) preload();
  const clip = clips.get(name);
  if (!clip) return;
  try {
    clip.currentTime = 0;
    const result = clip.play();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // autoplay policy or unsupported: ignore
  }
}

export function playAll(names: readonly SoundName[]): void {
  for (const name of names) play(name);
}
