import React, { useEffect, useMemo, useState } from 'react';
import type { BuiltinPluginProps } from '../shared';
import { diagnosticToProblem, PanelHeader, scheduleAfterPaint, type DiagnosticProblem } from '../shared';

type SeverityFilter = 'all' | 'error' | 'warn' | 'info';

/* the panel sources its problem list from host.diagnostics.list(). the
   `source` field tells us which tool emitted the diagnostic (language
   server or an explicit deep scan source) so rows can label it. */
export function ProblemsPanel({ header, host }: BuiltinPluginProps) {
  const [problems, setProblems] = useState<DiagnosticProblem[]>([]);
  const [filter, setFilter] = useState<SeverityFilter>('all');

  useEffect(() => {
    /* defer cold-path host calls past first paint — see scheduleAfterPaint
       in plugins/shared. without this the panel freezes on first click
       while the diagnostics provider's synchronous setup runs. */
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const cancelSchedule = scheduleAfterPaint(() => {
      if (cancelled) return;
      host.diagnostics.list().then((result) => {
        if (cancelled) return;
        setProblems(result.diagnostics.map(diagnosticToProblem));
      }).catch(() => {
        setProblems([]);
      });
      unsubscribe = host.diagnostics.onChange?.((event) => {
        if (cancelled) return;
        setProblems(event.diagnostics.map(diagnosticToProblem));
      });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
      unsubscribe?.();
    };
  }, [host]);

  const errorCount = useMemo(() => problems.filter((p) => p.severity === 'error').length, [problems]);
  const warnCount = useMemo(() => problems.filter((p) => p.severity === 'warn').length, [problems]);

  const visible = useMemo(
    () => (filter === 'all' ? problems : problems.filter((p) => p.severity === filter)),
    [problems, filter],
  );

  return (
    <section className="surface-card">
      <PanelHeader {...header}>
        <span className="panel-header__title">problems</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{problems.length} items</span>
      </PanelHeader>
      <div className="problems-filter" role="toolbar" aria-label="filter by severity">
        {(['all', 'error', 'warn', 'info'] as SeverityFilter[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`problems-filter__btn${filter === s ? ' problems-filter__btn--active' : ''}`}
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
          >
            {s === 'all' ? `all (${problems.length})` : s === 'error' ? `errors (${errorCount})` : s === 'warn' ? `warnings (${warnCount})` : 'info'}
          </button>
        ))}
      </div>
      <div className="problems-list">
        {visible.length === 0 && (
          <div className="verify-empty" role="status">
            {problems.length === 0 ? 'no problems reported' : `no ${filter} items`}
          </div>
        )}
        {visible.map((item) => (
          <button
            key={item.id}
            className={`problem-row problem-row--${item.severity}`}
            onClick={() => host.editor.open(item.file, { line: item.line }).catch(() => {})}
          >
            <span className="problem-row__severity">{item.severity}</span>
            <span className="problem-row__file">{item.file}:{item.line}</span>
            <span className="problem-row__msg">{item.msg}</span>
            <span className="problem-row__source">{item.code ? `${item.source} ${item.code}` : item.source}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
