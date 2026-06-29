export type SideRow =
  | { kind: 'header'; text: string }
  | { kind: 'context'; baseLn: number; targetLn: number; text: string }
  | { kind: 'delete'; baseLn: number; text: string }
  | { kind: 'add'; targetLn: number; text: string }
  | { kind: 'change'; baseLn: number; baseText: string; targetLn: number; targetText: string };

export type DiffSide = 'base' | 'target';

export type SideLine = { index: number; text: string };

/* pull out the code-bearing lines for one column, paired with their index in
   the original row list. The index is what lets a colorized line be threaded
   back to its row during render. Headers carry no code; each diff side only
   shows its own half of a change. */
export function collectSideLines(rows: SideRow[], side: DiffSide): SideLine[] {
  const lines: SideLine[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'context') {
      lines.push({ index, text: row.text });
    } else if (row.kind === 'delete' && side === 'base') {
      lines.push({ index, text: row.text });
    } else if (row.kind === 'add' && side === 'target') {
      lines.push({ index, text: row.text });
    } else if (row.kind === 'change') {
      lines.push({ index, text: side === 'base' ? row.baseText : row.targetText });
    }
  });
  return lines;
}
