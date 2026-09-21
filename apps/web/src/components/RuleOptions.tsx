import { useId } from 'react';

import {
  DEFAULT_RULES,
  MAX_TURN_SECONDS,
  MIN_TURN_SECONDS,
  defaultKittySize,
  kittySizeOptions,
  type PlayerCount,
  type RuleSettings,
} from '@landlord/engine';

import { fmt } from '../lib/format';
import { strings } from '../strings';

interface RuleOptionsProps {
  value: RuleSettings;
  onChange: (rules: RuleSettings) => void;
}

/** Snaps a raw kitty value to the nearest allowed option for the player count. */
export function snapKittySize(playerCount: PlayerCount, raw: number): number {
  const options = kittySizeOptions(playerCount);
  let best = options[0] ?? defaultKittySize(playerCount);
  for (const option of options) {
    if (Math.abs(option - raw) < Math.abs(best - raw)) best = option;
  }
  return best;
}

export function withPlayerCount(rules: RuleSettings, playerCount: PlayerCount): RuleSettings {
  if (rules.playerCount === playerCount) return rules;
  return { ...rules, playerCount, kittySize: defaultKittySize(playerCount) };
}

function Segmented<T extends string | number>({
  label,
  help,
  options,
  value,
  onChange,
}: {
  label: string;
  help: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="option">
      <div className="option-label" id={`${id}-label`}>
        {label}
      </div>
      <div className="segmented" role="group" aria-labelledby={`${id}-label`}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={option.value === value ? 'segment segment-active' : 'segment'}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="option-help">{help}</p>
    </div>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="option option-toggle">
      <div className="option-toggle-row">
        <label className="option-label" htmlFor={id}>
          {label}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          className={checked ? 'switch switch-on' : 'switch'}
          onClick={() => onChange(!checked)}
        >
          <span className="switch-knob" />
          <span className="switch-text">{checked ? strings.on : strings.off}</span>
        </button>
      </div>
      <p className="option-help">{help}</p>
    </div>
  );
}

export function RuleOptions({ value, onChange }: RuleOptionsProps) {
  const kittyId = useId();
  const timerId = useId();
  const kittyOptions = kittySizeOptions(value.playerCount);
  const kittyIndex = Math.max(0, kittyOptions.indexOf(value.kittySize));

  return (
    <div className="rule-options">
      <Segmented<PlayerCount>
        label={strings.optPlayerCount}
        help={strings.optPlayerCountHelp}
        options={[
          { value: 3, label: fmt(strings.players, { n: 3 }) },
          { value: 4, label: fmt(strings.players, { n: 4 }) },
        ]}
        value={value.playerCount}
        onChange={(playerCount) => onChange(withPlayerCount(value, playerCount))}
      />

      <div className="option">
        <label className="option-label" htmlFor={kittyId}>
          {strings.optKittySize}
          <span className="option-value">{fmt(strings.cards, { n: value.kittySize })}</span>
        </label>
        <input
          id={kittyId}
          type="range"
          min={0}
          max={kittyOptions.length - 1}
          step={1}
          value={kittyIndex}
          aria-valuetext={fmt(strings.cards, { n: value.kittySize })}
          onChange={(event) => {
            const option = kittyOptions[Number(event.target.value)];
            if (option !== undefined) onChange({ ...value, kittySize: option });
          }}
        />
        <div className="range-ticks" aria-hidden="true">
          {kittyOptions.map((option) => (
            <span key={option}>{option}</span>
          ))}
        </div>
        <p className="option-help">{strings.optKittySizeHelp}</p>
      </div>

      <Segmented
        label={strings.optBiddingMode}
        help={strings.optBiddingModeHelp}
        options={[
          { value: 'call', label: strings.optBiddingCall },
          { value: 'points', label: strings.optBiddingPoints },
        ]}
        value={value.biddingMode}
        onChange={(biddingMode) => onChange({ ...value, biddingMode })}
      />

      <Segmented
        label={strings.optAllPass}
        help={strings.optAllPassHelp}
        options={[
          { value: 'force', label: strings.optAllPassForce },
          { value: 'redeal', label: strings.optAllPassRedeal },
        ]}
        value={value.allPass}
        onChange={(allPass) => onChange({ ...value, allPass })}
      />

      <Toggle
        label={strings.optDoubling}
        help={strings.optDoublingHelp}
        checked={value.doublingRound}
        onChange={(doublingRound) => onChange({ ...value, doublingRound })}
      />

      <Toggle
        label={strings.optKittyBonus}
        help={strings.optKittyBonusHelp}
        checked={value.kittyBonus}
        onChange={(kittyBonus) => onChange({ ...value, kittyBonus })}
      />

      <Segmented
        label={strings.optFirstBidder}
        help={strings.optFirstBidderHelp}
        options={[
          { value: 'winner', label: strings.optFirstBidderWinner },
          { value: 'rotate', label: strings.optFirstBidderRotate },
          { value: 'random', label: strings.optFirstBidderRandom },
        ]}
        value={value.firstBidder}
        onChange={(firstBidder) => onChange({ ...value, firstBidder })}
      />

      <Toggle
        label={strings.optChains}
        help={strings.optChainsHelp}
        checked={value.chainsThroughTwos}
        onChange={(chainsThroughTwos) => onChange({ ...value, chainsThroughTwos })}
      />

      <div className="option">
        <label className="option-label" htmlFor={timerId}>
          {strings.optTurnSeconds}
          <span className="option-value">{fmt(strings.seconds, { n: value.turnSeconds })}</span>
        </label>
        <input
          id={timerId}
          type="range"
          min={MIN_TURN_SECONDS}
          max={MAX_TURN_SECONDS}
          step={5}
          value={value.turnSeconds}
          aria-valuetext={fmt(strings.seconds, { n: value.turnSeconds })}
          onChange={(event) => onChange({ ...value, turnSeconds: Number(event.target.value) })}
        />
        <p className="option-help">{strings.optTurnSecondsHelp}</p>
      </div>
    </div>
  );
}

export function defaultRules(): RuleSettings {
  return { ...DEFAULT_RULES };
}
