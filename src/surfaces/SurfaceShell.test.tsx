import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SurfaceShell } from './SurfaceShell';

function renderShell(overrides: Partial<Parameters<typeof SurfaceShell>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <SurfaceShell
      label="settings"
      title="settings"
      subtitle="overview"
      closeLabel="close settings"
      navLabel="settings sections"
      nav={<button type="button">panels</button>}
      onClose={onClose}
      {...overrides}
    >
      <section className="surface__content" aria-label="settings content">body</section>
    </SurfaceShell>,
  );
  return { onClose };
}

describe('SurfaceShell', () => {
  test('renders a labelled dialog with the title, nav landmark, and content', () => {
    renderShell();
    const dialog = screen.getByRole('dialog', { name: 'settings' });
    expect(within(dialog).getByText('settings')).toBeTruthy();
    expect(within(dialog).getByText('overview')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'settings sections' });
    expect(within(nav).getByRole('button', { name: 'panels' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'settings content' })).toBeTruthy();
  });

  test('the close button and Escape both invoke onClose', () => {
    const { onClose } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'close settings' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('the trailing slot renders alongside the close button', () => {
    renderShell({ trailing: <button type="button">ask</button> });
    expect(screen.getByRole('button', { name: 'ask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'close settings' })).toBeTruthy();
  });
});
