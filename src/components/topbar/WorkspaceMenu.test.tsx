import { fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { WorkspaceMenu } from './WorkspaceMenu';

const baseProps = {
  defaultWorkspace: 'Default',
  panelLabel: (slot: string) => slot,
  isOpen: true,
  onToggle: vi.fn(),
  onWorkspaceChange: vi.fn(),
  onResetWorkspace: vi.fn(),
  onDeletePreset: vi.fn(),
};

test('save current layout opens a name dialog and submits the trimmed name', () => {
  const onToggle = vi.fn();
  const onSaveAsPreset = vi.fn(() => null);

  render(
    <WorkspaceMenu
      {...baseProps}
      workspace="Default"
      userPresets={[]}
      onToggle={onToggle}
      onSaveAsPreset={onSaveAsPreset}
    />,
  );

  fireEvent.click(screen.getByRole('menuitem', { name: 'save current layout' }));

  expect(onToggle).toHaveBeenCalledOnce();
  const dialog = screen.getByRole('dialog', { name: 'save current layout' });
  const input = within(dialog).getByLabelText('workspace name');
  expect(input).toHaveFocus();

  fireEvent.change(input, {
    target: { value: '  Review  ' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));

  expect(onSaveAsPreset).toHaveBeenCalledWith('Review');
  expect(screen.queryByRole('dialog', { name: 'save current layout' })).not.toBeInTheDocument();
});

test('workspace menu rejects built-in and existing preset names case-insensitively', () => {
  const onSaveAsPreset = vi.fn(() => null);
  render(
    <WorkspaceMenu
      {...baseProps}
      workspace="Default"
      userPresets={[{ name: 'Review', savedAt: 1 }]}
      onSaveAsPreset={onSaveAsPreset}
    />,
  );

  fireEvent.click(screen.getByRole('menuitem', { name: 'save current layout' }));
  const dialog = screen.getByRole('dialog', { name: 'save current layout' });
  const input = within(dialog).getByLabelText('workspace name');
  const save = within(dialog).getByRole('button', { name: 'save' });

  fireEvent.change(input, { target: { value: 'default' } });
  fireEvent.click(save);
  expect(within(dialog).getByRole('alert')).toHaveTextContent('already exists');

  fireEvent.change(input, { target: { value: 'review' } });
  fireEvent.click(save);
  expect(within(dialog).getByRole('alert')).toHaveTextContent('already exists');
  expect(onSaveAsPreset).not.toHaveBeenCalled();
});

test('user presets use the same interactive row styling as built-in presets', () => {
  render(
    <WorkspaceMenu
      {...baseProps}
      workspace="Review"
      userPresets={[{ name: 'Review', savedAt: 1 }]}
      onSaveAsPreset={vi.fn(() => null)}
    />,
  );

  const builtinPreset = screen.getByRole('menuitemradio', { name: /default 9 panels/i });
  const userPreset = screen.getByRole('menuitemradio', { name: 'review' });

  expect(builtinPreset).toHaveClass('topbar-menu__item');
  expect(userPreset).toHaveClass('topbar-menu__item', 'topbar-menu__item--active');
});

test('deleting the active user preset requires confirmation and returns to default', () => {
  const onDeletePreset = vi.fn();
  const onWorkspaceChange = vi.fn();

  render(
    <WorkspaceMenu
      {...baseProps}
      workspace="Review"
      userPresets={[{ name: 'Review', savedAt: 1 }]}
      onSaveAsPreset={vi.fn(() => null)}
      onDeletePreset={onDeletePreset}
      onWorkspaceChange={onWorkspaceChange}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'delete review preset' }));

  expect(onDeletePreset).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog', { name: 'delete review preset' });
  expect(within(dialog).getByText('Review')).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));

  expect(onDeletePreset).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'delete review preset' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'delete review preset' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'delete review preset' }))
    .getByRole('button', { name: 'delete' }));

  expect(onDeletePreset).toHaveBeenCalledWith('Review');
  expect(onWorkspaceChange).toHaveBeenCalledWith('Default');
  expect(screen.queryByRole('dialog', { name: 'delete review preset' })).not.toBeInTheDocument();
});
