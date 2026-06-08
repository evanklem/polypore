import { buildDebugDecorations, nextBreakpointAction } from './debug-decorations';
import type { DebugState } from '../../packages/sdk/src/host';

function state(partial: Partial<DebugState>): DebugState {
  return {
    session: null,
    sessions: [],
    timeline: [],
    roadblock: null,
    status: 'paused',
    stop: null,
    breakpoints: [],
    rootCause: null,
    capabilities: { webAutoNav: false },
    ...partial,
  };
}

test('an agent breakpoint shows a distinct gutter glyph at the right line', () => {
  const decorations = buildDebugDecorations(
    state({ breakpoints: [{ file: 'src/UserCard.tsx', line: 18, setBy: 'agent', verified: true }] }),
    'src/UserCard.tsx',
  );
  expect(decorations).toHaveLength(1);
  expect(decorations[0].line).toBe(18);
  expect(decorations[0].glyphMarginClassName).toBe('debug-glyph-bp-agent');
});

test('human breakpoints use a distinct glyph from agent breakpoints', () => {
  const decorations = buildDebugDecorations(
    state({
      breakpoints: [
        { file: 'UserCard.tsx', line: 18, setBy: 'agent' },
        { file: 'UserCard.tsx', line: 22, setBy: 'human' },
      ],
    }),
    'src/UserCard.tsx',
  );
  const agent = decorations.find((d) => d.line === 18);
  const human = decorations.find((d) => d.line === 22);
  expect(agent?.glyphMarginClassName).toBe('debug-glyph-bp-agent');
  expect(human?.glyphMarginClassName).toBe('debug-glyph-bp-human');
  expect(agent?.glyphMarginClassName).not.toBe(human?.glyphMarginClassName);
});

test('the current stop renders a gutter arrow and a line highlight', () => {
  const decorations = buildDebugDecorations(
    state({ stop: { reason: 'breakpoint', file: 'src/UserCard.tsx', line: 18, initiatedBy: 'agent' } }),
    'src/UserCard.tsx',
  );
  expect(decorations).toHaveLength(1);
  expect(decorations[0].glyphMarginClassName).toBe('debug-glyph-stop');
  expect(decorations[0].className).toBe('debug-stopline');
});

test('breakpoints in other files do not decorate the active file', () => {
  const decorations = buildDebugDecorations(
    state({ breakpoints: [{ file: 'src/Other.tsx', line: 5, setBy: 'agent' }] }),
    'src/UserCard.tsx',
  );
  expect(decorations).toHaveLength(0);
});

test('gutter click adds a breakpoint on an empty line and removes an existing one', () => {
  const breakpoints = [{ file: 'src/UserCard.tsx', line: 18, setBy: 'human' as const }];
  expect(nextBreakpointAction(breakpoints, 'src/UserCard.tsx', 9)).toBe('add');
  expect(nextBreakpointAction(breakpoints, 'src/UserCard.tsx', 18)).toBe('remove');
  expect(nextBreakpointAction([], 'src/UserCard.tsx', 1)).toBe('add');
});
