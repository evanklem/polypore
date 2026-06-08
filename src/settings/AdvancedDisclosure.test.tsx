import { describe, expect, test } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdvancedDisclosure } from './AdvancedDisclosure';

describe('AdvancedDisclosure', () => {
  test('hides its body until opened, then reveals it', () => {
    render(
      <AdvancedDisclosure summary="install by id">
        <input placeholder="plugin id" />
      </AdvancedDisclosure>,
    );

    expect(screen.queryByPlaceholderText('plugin id')).toBeNull();
    const toggle = screen.getByRole('button', { name: /advanced/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(screen.getByPlaceholderText('plugin id')).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
