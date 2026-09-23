import { rankLabel, type Card as CardData } from '@landlord/engine';

import { fmt } from '../lib/format';
import { strings } from '../strings';

export type CardSize = 'hand' | 'table' | 'mini';

const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME: Record<string, string> = {
  S: strings.suitSpades,
  H: strings.suitHearts,
  D: strings.suitDiamonds,
  C: strings.suitClubs,
};

export function cardAriaLabel(card: CardData): string {
  if (card.rank === 17) return strings.redJoker;
  if (card.rank === 16) return strings.blackJoker;
  return fmt(strings.cardLabel, { rank: rankLabel(card.rank), suit: SUIT_NAME[card.suit] ?? '' });
}

interface CardProps {
  card: CardData;
  size?: CardSize;
  selected?: boolean;
  dimmed?: boolean;
  /** when given the card renders as a toggle button */
  onToggle?: (id: string) => void;
}

export function Card({
  card,
  size = 'hand',
  selected = false,
  dimmed = false,
  onToggle,
}: CardProps) {
  const joker = card.rank >= 16;
  const red = card.suit === 'H' || card.suit === 'D' || card.rank === 17;
  const className = [
    'card',
    `card-${size}`,
    joker ? 'card-joker' : '',
    red ? 'card-red' : 'card-black',
    selected ? 'card-selected' : '',
    dimmed ? 'card-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const label = cardAriaLabel(card);

  const body = joker ? (
    <span className="card-joker-label" aria-hidden="true">
      {strings.joker}
    </span>
  ) : (
    <>
      <span className="card-rank" aria-hidden="true">
        {rankLabel(card.rank)}
      </span>
      <span className="card-suit" aria-hidden="true">
        {SUIT_GLYPH[card.suit] ?? ''}
      </span>
    </>
  );

  if (onToggle) {
    return (
      <button
        type="button"
        className={className}
        aria-pressed={selected}
        aria-label={label}
        data-card-id={card.id}
        onClick={() => onToggle(card.id)}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={className} role="img" aria-label={label} data-card-id={card.id}>
      {body}
    </span>
  );
}

export function CardBack({ size = 'table' }: { size?: CardSize }) {
  return (
    <span className={`card card-back card-${size}`} role="img" aria-label={strings.cardBack} />
  );
}

/** A row of overlapping cards (a played combination, the kitty, a hint preview). */
export function CardRow({
  cards,
  size = 'table',
  className = '',
}: {
  cards: CardData[];
  size?: CardSize;
  className?: string;
}) {
  return (
    <span className={`card-row card-row-${size} ${className}`.trim()}>
      {cards.map((card) => (
        <Card key={card.id} card={card} size={size} />
      ))}
    </span>
  );
}
