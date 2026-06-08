import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SectionHeader } from './SectionHeader';

test('section_header_renders_title_and_count_when_provided', () => {
  render(<SectionHeader title="mcp" count={3} />);
  expect(screen.getByRole('heading', { name: /mcp/i })).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
});

test('section_header_omits_count_when_undefined', () => {
  const { container } = render(<SectionHeader title="skills" />);
  expect(screen.getByRole('heading', { name: /skills/i })).toBeInTheDocument();
  // No count badge element should exist
  expect(container.querySelector('.section-header__count')).toBeNull();
});

test('section_header_renders_add_button_when_label_and_handler_provided', async () => {
  const onAdd = vi.fn();
  render(<SectionHeader title="mcp" addLabel="+ server" onAdd={onAdd} />);
  const btn = screen.getByRole('button', { name: /\+ server/i });
  expect(btn).toBeInTheDocument();
  await userEvent.click(btn);
  expect(onAdd).toHaveBeenCalledTimes(1);
});
