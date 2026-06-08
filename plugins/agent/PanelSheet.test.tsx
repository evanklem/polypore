import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelSheet } from './PanelSheet';

test('panel_sheet_renders_nothing_when_closed', () => {
  render(
    <PanelSheet open={false} label="connect node" onDismiss={() => {}}>
      <p>body</p>
    </PanelSheet>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('body')).toBeNull();
});

test('panel_sheet_renders_dialog_with_label_title_and_children_when_open', () => {
  render(
    <PanelSheet open label="connect node" title="from researcher" onDismiss={() => {}}>
      <p>body content</p>
    </PanelSheet>,
  );
  const dialog = screen.getByRole('dialog', { name: /connect node/i });
  expect(dialog).toBeInTheDocument();
  expect(screen.getByText('from researcher')).toBeInTheDocument();
  expect(screen.getByText('body content')).toBeInTheDocument();
});

test('panel_sheet_escape_calls_on_dismiss_once', async () => {
  const onDismiss = vi.fn();
  render(
    <PanelSheet open label="connect node" onDismiss={onDismiss}>
      <p>body</p>
    </PanelSheet>,
  );
  await userEvent.keyboard('{Escape}');
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('panel_sheet_backdrop_click_dismisses_but_inside_click_does_not', async () => {
  const onDismiss = vi.fn();
  render(
    <PanelSheet open label="connect node" onDismiss={onDismiss}>
      <button type="button">inside</button>
    </PanelSheet>,
  );
  // clicking a control inside the sheet must not dismiss
  await userEvent.click(screen.getByRole('button', { name: /inside/i }));
  expect(onDismiss).not.toHaveBeenCalled();

  // clicking the backdrop (the dialog's parent overlay) dismisses
  const backdrop = screen.getByTestId('panel-sheet-backdrop');
  await userEvent.click(backdrop);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('panel_sheet_close_button_dismisses', async () => {
  const onDismiss = vi.fn();
  render(
    <PanelSheet open label="connect node" onDismiss={onDismiss}>
      <p>body</p>
    </PanelSheet>,
  );
  await userEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

function FocusHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open sheet
      </button>
      <PanelSheet open={open} label="connect node" onDismiss={() => setOpen(false)}>
        <button type="button">first focusable</button>
      </PanelSheet>
    </div>
  );
}

test('panel_sheet_moves_focus_in_on_open_and_returns_it_on_close', async () => {
  render(<FocusHarness />);
  const trigger = screen.getByRole('button', { name: /open sheet/i });
  trigger.focus();
  expect(trigger).toHaveFocus();

  await userEvent.click(trigger);
  // focus must land inside the sheet, not stay on the trigger
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);

  await userEvent.keyboard('{Escape}');
  // focus returns to whatever opened the sheet
  expect(trigger).toHaveFocus();
});
