import React, { useEffect, useRef, useState } from 'react';
import type { GitDiffResult } from '../../packages/sdk/src/host';
import type { BuiltinPluginProps } from '../shared';
import { PanelHeader, ResizeHandle, scheduleAfterPaint, useResizableSplit } from '../shared';
import { applyGlassTheme, colorizeLines, loadMonaco, monacoLanguageForPath } from '../shared/monaco-highlight';
import { collectSideLines, type SideRow } from './collect-side-lines';

type CompareMode = 'working' | 'branch';

const COMPARE_OPTIONS: Array<{
  mode: CompareMode;
  label: string;
  detail: string;
}> = [
  { mode: 'working', label: 'head vs working tree', detail: 'local uncommitted changes' },
  { mode: 'branch', label: 'upstream vs current branch', detail: 'commits on this branch' },
];

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
  /* row index -> Monaco-colorized HTML for that line, one map per column.
     missing entries (plaintext, unloaded monaco) fall back to plain text. */
  const [baseHtml, setBaseHtml] = useState<Record<number, string>>({});
  const [targetHtml, setTargetHtml] = useState<Record<number, string>>({});
  /* apply the Monaco theme once — it's global + accent-independent for token
     colors, so re-applying on every file switch would needlessly recolor any
     live editor. */
  const themeAppliedRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<string>('');
  const [compareMode, setCompareMode] = useState<CompareMode>('working');
  const [compareOpen, setCompareOpen] = useState(false);
  const compareButtonRef = useRef<HTMLButtonElement>(null);
  const compareMenuRef = useRef<HTMLDivElement>(null);
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
    compareButtonRef.current?.focus();
  };

  useEffect(() => {
    if (!compareOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (compareMenuRef.current?.contains(target)) return;
      if (compareButtonRef.current?.contains(target)) return;
      setCompareOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    /* focus the active mode so the menu is keyboard-reachable as soon as it
       opens; the trigger keeps focus otherwise and arrows would be dead. */
    const items = compareMenuRef.current?.querySelectorAll<HTMLElement>('.diff-compare-popover__item');
    const checked = compareMenuRef.current?.querySelector<HTMLElement>('.diff-compare-popover__item[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [compareOpen]);

  const onCompareMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = compareMenuRef.current
      ? [...compareMenuRef.current.querySelectorAll<HTMLElement>('.diff-compare-popover__item')]
      : [];
    const index = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setCompareOpen(false);
        compareButtonRef.current?.focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      default:
        break;
    }
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

  /* syntax-highlight each column with the same Monaco tokenizer/theme the
     editor uses. Colorize the contiguous per-side text once, then thread each
     resulting line back to its row index. Diff-status tints stay dominant —
     these are foreground token colors over the row background. Falls back to
     plain text for plaintext/unknown languages or if Monaco fails to load. */
  useEffect(() => {
    let cancelled = false;
    setBaseHtml({});
    setTargetHtml({});
    if (sideRows.length === 0 || !activeFile) return () => { cancelled = true; };
    loadMonaco()
      .then((monaco) => {
        if (cancelled) return;
        if (!themeAppliedRef.current) {
          applyGlassTheme(monaco);
          themeAppliedRef.current = true;
        }
        const language = monacoLanguageForPath(monaco, activeFile);
        if (language === 'plaintext') return;
        const baseLines = collectSideLines(sideRows, 'base');
        const targetLines = collectSideLines(sideRows, 'target');
        return Promise.all([
          colorizeLines(monaco, baseLines.map((line) => line.text).join('\n'), language),
          colorizeLines(monaco, targetLines.map((line) => line.text).join('\n'), language),
        ]).then(([baseColored, targetColored]) => {
          if (cancelled) return;
          const baseMap: Record<number, string> = {};
          baseLines.forEach((line, i) => {
            if (baseColored[i] != null) baseMap[line.index] = baseColored[i];
          });
          const targetMap: Record<number, string> = {};
          targetLines.forEach((line, i) => {
            if (targetColored[i] != null) targetMap[line.index] = targetColored[i];
          });
          setBaseHtml(baseMap);
          setTargetHtml(targetMap);
        });
      })
      .catch(() => { /* leave the plain-text fallback in place */ });
    return () => { cancelled = true; };
  }, [sideRows, activeFile]);

  const renderCode = (html: Record<number, string>, index: number, fallback: string) => {
    const colored = html[index];
    if (colored != null) return <code dangerouslySetInnerHTML={{ __html: colored || ' ' }} />;
    return <code>{fallback || ' '}</code>;
  };

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
              <button
                type="button"
                ref={compareButtonRef}
                aria-expanded={compareOpen}
                aria-haspopup="menu"
                onClick={() => setCompareOpen((open) => !open)}
              >
                compare
              </button>
            </div>
          </header>
          {openNotice && <div className="diff-historical-banner"><span>{openNotice}</span></div>}
          {compareNotice && <div className="diff-historical-banner"><span>{compareNotice}</span></div>}

          {compareOpen && (
            <div
              className="diff-compare-popover"
              ref={compareMenuRef}
              role="menu"
              aria-label="compare refs"
              onKeyDown={onCompareMenuKeyDown}
            >
              {COMPARE_OPTIONS.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  className="diff-compare-popover__item"
                  aria-checked={compareMode === option.mode}
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
                      {renderCode(baseHtml, index, row.text)}
                    </div>
                  );
                }
                if (row.kind === 'delete') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--remove">
                      <span>{row.baseLn}</span>
                      {renderCode(baseHtml, index, row.text)}
                    </div>
                  );
                }
                if (row.kind === 'change') {
                  return (
                    <div key={`L-${index}`} className="diff-line diff-line--remove">
                      <span>{row.baseLn}</span>
                      {renderCode(baseHtml, index, row.baseText)}
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
                      {renderCode(targetHtml, index, row.text)}
                    </div>
                  );
                }
                if (row.kind === 'add') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--add">
                      <span>{row.targetLn}</span>
                      {renderCode(targetHtml, index, row.text)}
                    </div>
                  );
                }
                if (row.kind === 'change') {
                  return (
                    <div key={`R-${index}`} className="diff-line diff-line--add">
                      <span>{row.targetLn}</span>
                      {renderCode(targetHtml, index, row.targetText)}
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
