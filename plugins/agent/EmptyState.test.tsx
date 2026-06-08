import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from './EmptyState';

test('empty_state_renders_message_and_cta_button', () => {
  render(
    <EmptyState
      message="no remote MCPs configured"
      ctaLabel="discover from ~/.claude.json"
      onAction={() => {}}
    />
  );
  expect(screen.getByText('no remote MCPs configured')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /discover from ~\/.claude\.json/i })).toBeInTheDocument();
});

test('empty_state_cta_calls_onaction', async () => {
  const onAction = vi.fn();
  render(
    <EmptyState
      message="no secret handles configured"
      ctaLabel="add a project secret"
      onAction={onAction}
    />
  );
  const btn = screen.getByRole('button', { name: /add a project secret/i });
  await userEvent.click(btn);
  expect(onAction).toHaveBeenCalledTimes(1);
});
