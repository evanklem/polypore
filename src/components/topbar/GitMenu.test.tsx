import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { GitMenu } from './GitMenu';
import type { TauriInvoke } from './types';

const status = {
  path: '/workspace/repo',
  name: 'repo',
  branch: 'main',
  upstream: 'origin/main',
  dirty: false,
};

const invokeWith = (gitRun: Record<string, unknown>): TauriInvoke =>
  vi.fn((command: string) =>
    Promise.resolve(command === 'git_run' ? gitRun : status),
  ) as unknown as TauriInvoke;

test('a failed git action surfaces an error banner alongside the git output', async () => {
  const tauriInvoke = invokeWith({
    action: 'push',
    command: ['push'],
    exitCode: 1,
    output: 'error: failed to push some refs',
  });

  render(<GitMenu status={status} onStatusChange={vi.fn()} isOpen onToggle={vi.fn()} tauriInvoke={tauriInvoke} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /^push/i }));

  expect(await screen.findByText('git push failed (exit 1)')).toBeInTheDocument();
  expect(screen.getByText('error: failed to push some refs')).toBeInTheDocument();
});

test('a successful git action shows output without an error banner', async () => {
  const tauriInvoke = invokeWith({
    action: 'fetch',
    command: ['fetch', '--prune'],
    exitCode: 0,
    output: 'From origin\n   abc123..def456  main -> origin/main',
  });

  render(<GitMenu status={status} onStatusChange={vi.fn()} isOpen onToggle={vi.fn()} tauriInvoke={tauriInvoke} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /^fetch/i }));

  expect(await screen.findByText(/main -> origin\/main/)).toBeInTheDocument();
  expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
});

test('a successful push surfaces a success confirmation', async () => {
  const tauriInvoke = invokeWith({
    action: 'push',
    command: ['push'],
    exitCode: 0,
    output: 'Everything up-to-date',
  });

  render(<GitMenu status={status} onStatusChange={vi.fn()} isOpen onToggle={vi.fn()} tauriInvoke={tauriInvoke} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /^push/i }));

  expect(await screen.findByText('git push succeeded')).toBeInTheDocument();
  expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
});

test('a query action does not show a success banner', async () => {
  const tauriInvoke = invokeWith({
    action: 'status',
    command: ['status'],
    exitCode: 0,
    output: 'On branch main',
  });

  render(<GitMenu status={status} onStatusChange={vi.fn()} isOpen onToggle={vi.fn()} tauriInvoke={tauriInvoke} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /^status/i }));

  expect(await screen.findByText('On branch main')).toBeInTheDocument();
  expect(screen.queryByText(/succeeded/)).not.toBeInTheDocument();
});

test('a successful action refreshes the project status', async () => {
  const onStatusChange = vi.fn();
  const tauriInvoke = invokeWith({
    action: 'pull',
    command: ['pull', '--ff-only'],
    exitCode: 0,
    output: 'Already up to date.',
  });

  render(<GitMenu status={status} onStatusChange={onStatusChange} isOpen onToggle={vi.fn()} tauriInvoke={tauriInvoke} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /pull --ff-only/i }));

  expect(await screen.findByText('Already up to date.')).toBeInTheDocument();
  expect(onStatusChange).toHaveBeenCalledWith(status);
});
