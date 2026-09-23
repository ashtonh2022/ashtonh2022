import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

function Page({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Leave
      </button>
      <button type="button">Red Joker</button>
      {open && (
        <ConfirmDialog
          message="Leave the table?"
          confirmLabel="Yes, leave"
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        />
      )}
    </main>
  );
}

describe('ConfirmDialog', () => {
  it('keeps Tab and Shift+Tab inside the dialog and puts the page behind it out of reach', () => {
    const view = render(<Page onConfirm={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Leave' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Yes, leave' });
    expect(cancel).toHaveFocus();
    // The page behind the dialog is inert while it is open.
    expect(view.container).toHaveAttribute('inert');
    expect(dialog.closest('[inert]')).toBeNull();

    confirm.focus();
    // Tab on the last button wraps to the first one instead of leaving the dialog...
    expect(fireEvent.keyDown(confirm, { key: 'Tab' })).toBe(false);
    expect(cancel).toHaveFocus();
    // ...and Shift+Tab on the first one wraps to the last.
    expect(fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(confirm).toHaveFocus();
    // Focus that got out somehow (a click on the backdrop) is brought back by the next Tab.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.container).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });
});
