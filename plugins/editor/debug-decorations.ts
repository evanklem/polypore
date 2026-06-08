import type { DebugState } from '../../packages/sdk/src/host';

/* Pure mapping from debug host-state → editor gutter decorations. Kept free of
   Monaco types so it is unit-testable (the component turns these descriptors
   into IModelDeltaDecoration). Agent-set and human-set breakpoints render with
   distinct glyphs; the current stop gets a gutter arrow + a line highlight. */
export type DebugDecoration = {
  line: number;
  glyphMarginClassName?: string;
  className?: string;
  hoverMessage?: string;
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/* breakpoint/stop file paths may be absolute (from the adapter) while the open
   editor file is project-relative — match leniently on suffix/basename. */
function sameFile(candidate: string | undefined, activeFile: string): boolean {
  if (!candidate) return false;
  if (candidate === activeFile) return true;
  if (basename(candidate) === basename(activeFile)) return true;
  return candidate.endsWith(activeFile) || activeFile.endsWith(candidate);
}

/* clicking the gutter toggles a human breakpoint: remove it if one is already
   on that line of this file, otherwise add one. Pure so it is unit-testable;
   the editor wires the result to host.debug.add/removeBreakpoint. */
export function nextBreakpointAction(
  breakpoints: DebugState['breakpoints'] | undefined,
  activeFile: string,
  line: number,
): 'add' | 'remove' {
  const exists = (breakpoints ?? []).some(
    (breakpoint) => sameFile(breakpoint.file, activeFile) && breakpoint.line === line,
  );
  return exists ? 'remove' : 'add';
}

export function buildDebugDecorations(debug: DebugState | null, activeFile: string): DebugDecoration[] {
  if (!debug || !activeFile) return [];
  const decorations: DebugDecoration[] = [];

  for (const breakpoint of debug.breakpoints ?? []) {
    if (!sameFile(breakpoint.file, activeFile)) continue;
    const condition = breakpoint.condition ? ` (if ${breakpoint.condition})` : '';
    decorations.push({
      line: breakpoint.line,
      glyphMarginClassName:
        breakpoint.setBy === 'agent' ? 'debug-glyph-bp-agent' : 'debug-glyph-bp-human',
      hoverMessage: `${breakpoint.setBy} breakpoint${condition}`,
    });
  }

  const stop = debug.stop;
  if (stop && stop.line && sameFile(stop.file, activeFile)) {
    decorations.push({
      line: stop.line,
      glyphMarginClassName: 'debug-glyph-stop',
      className: 'debug-stopline',
      hoverMessage: `stopped here (${stop.reason}${stop.initiatedBy ? `, ${stop.initiatedBy}` : ''})`,
    });
  }

  return decorations;
}
