import { NAME_MAX } from '@landlord/protocol';

import { client } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';

/**
 * "Your name", on Home and in the lobby (where players who came straight from a share link name
 * themselves). The client persists every change and sends it once typing pauses; leaving the
 * field sends it at once.
 */
export function NameField({ id }: { id: string }) {
  const name = useStore((state) => state.name);

  const onChange = (value: string) => {
    const typed = value.slice(0, NAME_MAX);
    useStore.getState().setName(typed);
    client.setName(typed);
  };

  return (
    <>
      <label className="field-label" htmlFor={id}>
        {strings.yourName}
      </label>
      <input
        id={id}
        className="input"
        type="text"
        value={name}
        maxLength={NAME_MAX}
        placeholder={strings.namePlaceholder}
        autoComplete="nickname"
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => client.flushName()}
      />
    </>
  );
}
