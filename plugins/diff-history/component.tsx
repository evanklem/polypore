import React, { useEffect, useState } from 'react';
import type { GitDiffResult } from '../../packages/sdk/src/host';
import type { BuiltinPluginProps } from '../shared';
import { PanelHeader, ResizeHandle, scheduleAfterPaint, useResizableSplit } from '../shared';

type CompareMode = 'working' | 'branch';

const COMPARE_OPTIONS: Array<{
  mode: CompareMode;
  label: string;
  detail: string;
}> = [
  { mode: 'working', label: 'head vs working tree', detail: 'local uncommitted changes' },
  { mode: 'branch', label: 'upstream vs current branch', detail: 'commits on this branch' },
];

type SideRow =
  | { kind: 'header'; text: string }
  | { kind: 'context'; baseLn: number; targetLn: number; text: string }
  | { kind: 'delete'; baseLn: number; text: string }
  | { kind: 'add'; targetLn: number; text: string }
  | { kind: 'change'; baseLn: number; baseText: string; targetLn: number; targetText: string };

function parseUnifiedDiff(unified: string): SideRow[] {
  if (!unified.trim()) return [];
  const rows: SideRow[] = [];
  const lines = unified.split('\n');
  let baseLn = 0;
  let targetLn = 0;
  let pendingDeletes: Array<{ baseLn: number; text: string }> = [];
  let pendingAdds: Array<{ targetLn: number; text: string }> = [];
  const flushPending = () => {
    const paired = Math.min(pendingDeletes.length, pendingAdds.length);
    for (let i = 0; i < paired; i += 1) {
      rows.push({
        kind: 'change',
        baseLn: pendingDeletes[i].baseLn,
        baseText: pendingDeletes[i].text,
        targetLn: pendingAdds[i].targetLn,
        targetText: pendingAdds[i].text,
      });
    }
    for (let i = paired; i < pendingDeletes.length; i += 1) {
      rows.push({ kind: 'delete', baseLn: pendingDeletes[i].baseLn, text: pendingDeletes[i].text });
    }
    for (let i = paired; i < pendingAdds.length; i += 1) {
      rows.push({ kind: 'add', targetLn: pendingAdds[i].targetLn, text: pendingAdds[i].text });
    }
    pendingDeletes = [];
    pendingAdds = [];
  };
  for (const raw of lines) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      flushPending();
      rows.push({ kind: 'header', text: raw });
      continue;
    }
    if (raw.startsWith('@@')) {
      flushPending();
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        baseLn = Number(match[1]);
        targetLn = Number(match[2]);
      }
      rows.push({ kind: 'header', text: raw });
      continue;
    }
    if (raw.startsWith('-')) {
      pendingDeletes.push({ baseLn, text: raw.slice(1) });
      baseLn += 1;
      continue;
    }
    if (raw.startsWith('+')) {
      pendingAdds.push({ targetLn, text: raw.slice(1) });
      targetLn += 1;
      continue;
    }
    flushPending();
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ kind: 'context', baseLn, targetLn, text });
    baseLn += 1;
    targetLn += 1;
  }
  flushPending();
  return rows;
}

export function DiffHistoryPanel({ header, host }: BuiltinPluginProps) {
  const [railWidth, onRailResize] = useResizableSplit({ axis: 'x', initial: 27, min: 20, max: 46 });
  const [baseWidth, onBaseResize] = useResizableSplit({ axis: 'x', initial: 50, min: 30, max: 70 });
  const [gitDiff, setGitDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffParsing, setDiffParsing] = useState(false);
  const [sideRows, setSideRows] = useState<SideRow[]>([]);
  const [visibleRowCount, setVisibleRowCount] = useState(0);

  const [selectedFile, setSelectedFile] = useState<string>('');
  const [compareMode, setCompareMode] = useState<CompareMode>('working');
  const [compareOpen, setCompareOpen] = useState(false);
  const [openNotice, setOpenNotice] = useState('');
  const [compareNotice, setCompareNotice] = useState('');

  const branchBaseLabel = gitDiff?.baseRef ?? 'upstream';
  const branchTargetLabel = gitDiff?.targetRef ?? 'current branch';
  const comparisonLabel = compareMode === 'working' ? 'head vs working tree' : `${branchBaseLabel} vs ${branchTargetLabel}`;
  const baseLabel = compareMode === 'working' ? 'head' : branchBaseLabel;
  const targetLabel = compareMode === 'branch' ? branchTargetLabel : 'working tree';
  const changedFiles = gitDiff?.changedFiles ?? [];
  const activeFile = changedFiles.includes(selectedFile) ? selectedFile : changedFiles[0] ?? '';
  const canRenderDiff = !activeFile || gitDiff?.file === activeFile;
  const visibleRows = sideRows.slice(0, visibleRowCount);
  const rowsStillRendering = visibleRowCount < sideRows.length;
  const emptyDiffText = activeFile
    ? 'no tracked changes for this file in the selected comparison.'
    : 'no tracked file changes in this comparison.';
  const diffSummaryText = gitDiff
    ? `${gitDiff.mode} comparison${gitDiff.exitCode && gitDiff.exitCode !== 0 ? ` exited ${gitDiff.exitCode}` : ''}`
    : 'live git diff is available in the desktop shell.';

  const applyCompareMode = (nextMode: CompareMode) => {
    setCompareMode(nextMode);
    setCompareNotice('');
    setCompareOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    setDiffLoading(true);
    const cancelSchedule = scheduleAfterPaint(() => {
      host.history.diff({ mode: compareMode, file: selectedFile || undefined }).then((result) => {
        if (cancelled) return;
        setGitDiff(result.diff);
        if (!selectedFile && result.diff.changedFiles.length > 0) {
          setSelectedFile(result.diff.changedFiles[0]);
        }
      }).catch(() => {
        if (!cancelled) {
          setGitDiff(null);
          setCompareNotice('compare failed');
        }
      }).finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [host, compareMode, selectedFile]);

  useEffect(() => {
    let cancelled = false;
    setSideRows([]);
    setVisibleRowCount(0);
    if (!canRenderDiff || !gitDiff?.diff.trim()) {
      setDiffParsing(false);
      return () => { cancelled = true; };
    }
    setDiffParsing(true);
    const cancelSchedule = scheduleAfterPaint(() => {
      const rows = parseUnifiedDiff(gitDiff.diff);
      if (cancelled) return;
      setSideRows(rows);
      setVisibleRowCount(Math.min(rows.length, 220));
      setDiffParsing(false);
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [canRenderDiff, gitDiff?.diff]);

  useEffect(() => {
    if (visibleRowCount >= sideRows.length) return undefined;
    const frame = window.requestAnimationFrame(() => {
      setVisibleRowCount((count) => Math.min(sideRows.length, count + 260));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sideRows.length, visibleRowCount]);

  return (
    <div className="diff-history-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">diff</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{comparisonLabel}</span>
        <span className="panel-header__meta">{changedFiles.length} files</span>
      </PanelHeader>
      <div
        className="diff-history-grid"
        style={{ '--diff-rail-width': `${railWidth}%` } as React.CSSProperties}
      >
        <aside className="diff-review-rail">
          <div className="diff-scope" aria-label="git comparison mode">
            {(['working', 'branch'] as const).map((item) => (
              <button
                key={item}
                className={compareMode === item ? 'diff-scope__chip diff-scope__chip--active' : 'diff-scope__chip'}
                onClick={() => {
                  setCompareMode(item);
                  setCompareNotice('');
                }}
              >
                {item === 'working' ? 'working tree' : 'branch'}
              </button>
            ))}
          </div>

          <nav className="diff-files" aria-label="changed files">
            <header>
              <strong>changed files</strong>
              <small>{changedFiles.length}</small>
            </header>
            <div className="diff-files__list">
              {changedFiles.length === 0 && <span className="verify-empty">no recorded file changes</span>}
              {changedFiles.map((file) => (
                <button
                  key={file}
                  className={file === activeFile ? 'diff-files__entry diff-files__entry--active' : 'diff-files__entry'}
                  onClick={() => setSelectedFile(file)}
                >
                  <i className="diff-files__status">diff</i>
                  <span>{file}</span>
                  <em>tracked diff</em>
                </button>
              ))}
            </div>
          </nav>
        </aside>
        <ResizeHandle axis="x" label="resize diff history rail and diff viewer" onDrag={onRailResize} />

        <section className="diff-pane-region">
          <header className="diff-pane-region__bar">
            <div className="diff-file-title">
              <strong>{activeFile || 'no file selected'}</strong>
              <span>git</span>
            </div>
            <div className="diff-pane-region__actions">
              <button
                disabled={!activeFile}
                onClick={() => {
                  if (!activeFile) return;
                  host.editor.open(activeFile).then(() => {
                    setOpenNotice(`opened ${activeFile}`);
                  }).catch(() => {
                    setOpenNotice(`could not open ${activeFile}`);
                  });
                }}
              >
                open in editor
              </button>
              <button onClick={() => setCompareOpen((open) => !open)}>compare</button>
            </div>
          </header>
          {openNotice && <div className="diff-historical-banner"><span>{openNotice}</span></div>}
          {compareNotice && <div className="diff-historical-banner"><span>{compareNotice}</span></div>}

          {compareOpen && (
            <div className="diff-compare-popover" role="dialog" aria-label="compare refs">
              {COMPARE_OPTIONS.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  aria-pressed={compareMode === option.mode}
                  onClick={() => applyCompareMode(option.mode)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.detail}</span>
                </button>
              ))}
            </div>
          )}

          {rowsStillRendering && (
            <div className="diff-historical-banner">
              <span>rendering full diff</span>
              <small>{visibleRowCount} of {sideRows.length} rows ready</small>
            </div>
          )}

          <div
            className="diff-split"
            aria-label={`diff for ${activeFile}`}
            style={{ '--diff-base-width': `${baseWidth}%` } as React.CSSProperties}
          >
            <div className="diff-column">
              <header>{baseLabel}</header>
              {visibleRows.length === 0 && (
                <div className="diff-line diff-line--same">
                  <span />
                  <code>{diffLoading || diffParsing ? 'loading diff...' : emptyDiffText}</code>
                </div>
              )}
              {visibleRows.map((row, index) => {
                if (row.kind === 'header') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--change">
                      <span />
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'context') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--same">
                      <span>{row.baseLn}</span>
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'delete') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--remove">
                      <span>{row.baseLn}</span>
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'change') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--remove">
                      <span>{row.baseLn}</span>
                      <code>{row.baseText || ' '}</code>
                    </div>
                  );
                }
                return (
                  <div key={`L-${index}`} className="diff-line diff-line--empty">
                    <span />
                    <code> </code>
                  </div>
                );
              })}
            </div>
            <ResizeHandle axis="x" label="resize base and target diff columns" onDrag={onBaseResize} />
            <div className="diff-column">
              <header>{targetLabel}</header>
              {visibleRows.length === 0 && (
                <div className="diff-line diff-line--same">
                  <span />
                  <code>{diffLoading || diffParsing ? 'preparing selected file...' : activeFile ? diffSummaryText : 'select a changed file from the rail.'}</code>
                </div>
              )}
              {visibleRows.map((row, index) => {
                if (row.kind === 'header') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--change">
                      <span />
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'context') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--same">
                      <span>{row.targetLn}</span>
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'add') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--add">
                      <span>{row.targetLn}</span>
                      <code>{row.text || ' '}</code>
                    </div>
                  );
                }
                if (row.kind === 'change') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--add">
                      <span>{row.targetLn}</span>
                      <code>{row.targetText || ' '}</code>
                    </div>
                  );
                }
                return (
                  <div key={`R-${index}`} className="diff-line diff-line--empty">
                    <span />
                    <code> </code>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
