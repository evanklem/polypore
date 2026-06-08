import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ManualSurface } from './ManualSurface';
import { buildManualCorpus } from './manualCorpus';

function corpus() {
  return buildManualCorpus({
    docs: [
      {
        path: 'docs/manual/the-ide/getting-started.md',
        body: '---\ntitle: Getting started\ngroup: The IDE\norder: 1\n---\nOpen a project to begin.',
      },
      {
        path: 'docs/manual/agent-mcp/secrets.md',
        body: '---\ntitle: Secrets & safety\ngroup: The Agent & MCP\norder: 1\n---\nA secret value never returns through a tool.',
      },
    ],
    panels: [
      {
        manifest: { id: 'polypore.editor', title: 'editor', permissions: ['fs.read'] },
        body: '# Editor\n\nMonaco-backed editor.',
      },
    ],
  });
}

describe('ManualSurface', () => {
  test('renders manual chrome in lowercase without changing prose', () => {
    render(<ManualSurface corpus={corpus()} initialSlug="agent-mcp/secrets" onClose={() => {}} />);

    const reader = screen.getByLabelText('secrets & safety manual');
    expect(within(reader).getByRole('heading', { level: 1, name: 'secrets & safety' })).toBeTruthy();
    expect(screen.getAllByText('the agent & mcp')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'getting started' })).toBeTruthy();
    expect(within(reader).getByText('A secret value never returns through a tool.')).toBeTruthy();
  });

  test('opens to the initial section and renders its prose', () => {
    render(<ManualSurface corpus={corpus()} initialSlug="agent-mcp/secrets" onClose={() => {}} />);
    const reader = screen.getByLabelText('secrets & safety manual');
    expect(within(reader).getByText(/secret value never returns/i)).toBeTruthy();
  });

  test('clicking a contents entry switches the reader to that page', () => {
    render(<ManualSurface corpus={corpus()} initialSlug="the-ide/getting-started" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'editor' }));
    const reader = screen.getByLabelText('editor manual');
    expect(within(reader).getByText(/Monaco-backed editor/i)).toBeTruthy();
    // panel pages surface derived facts, not restated prose
    expect(within(reader).getByText('fs.read')).toBeTruthy();
  });

  test('panel prose does not render a duplicate title heading', () => {
    render(<ManualSurface corpus={corpus()} initialSlug="panels/polypore.editor" onClose={() => {}} />);
    const reader = screen.getByLabelText('editor manual');
    expect(within(reader).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(reader).getByText(/Monaco-backed editor/i)).toBeTruthy();
  });

  test('ask-the-agent hands the active section to the caller', () => {
    const onAskAgent = vi.fn();
    render(
      <ManualSurface
        corpus={corpus()}
        initialSlug="agent-mcp/secrets"
        onAskAgent={onAskAgent}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /ask the agent about this/i }));
    expect(onAskAgent).toHaveBeenCalledTimes(1);
    expect(onAskAgent.mock.calls[0][0].slug).toBe('agent-mcp/secrets');
  });

  test('search filters the contents tree', () => {
    render(<ManualSurface corpus={corpus()} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('search the manual'), { target: { value: 'secret' } });
    expect(screen.queryByRole('button', { name: 'editor' })).toBeNull();
    expect(screen.getByRole('button', { name: 'secrets & safety' })).toBeTruthy();
  });
});
