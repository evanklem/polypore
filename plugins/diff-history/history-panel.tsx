import React, { useEffect, useState } from 'react';
import type { HistoryEvent } from '../../packages/sdk/src';
import type { BuiltinPluginProps } from '../shared';
import { PanelHeader } from '../shared';

export function HistoryPanel({ header, host }: BuiltinPluginProps) {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      host.history.events().then((result) => {
        if (cancelled) return;
        setEvents(result.events);
      }).catch(() => setEvents([]));
    };
    load();
    /* keep the rail live as the agent appends snapshots */
    const unsubscribe = host.history.onEvent(() => load());
    return () => { cancelled = true; unsubscribe(); };
  }, [host]);

  const fork = (event: HistoryEvent) => {
    setBusyId(event.id);
    host.history.fork(event.id).then((result) => {
      setNotice(`forked a worktree at ${result.worktree.branch ?? result.worktree.path}`);
    }).catch((err) => {
      setNotice(`fork failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => setBusyId(null));
  };

  const revert = async (event: HistoryEvent) => {
    const fileCount = event.affectedFiles?.length ?? 0;
    const { confirmed } = await host.ui.confirm(
      `revert to this restore point? this discards changes to ${fileCount || 'the'} affected file${fileCount === 1 ? '' : 's'}.`,
    );
    if (!confirmed) return;
    setBusyId(event.id);
    host.history.revert({ eventId: event.id }).then((result) => {
      setNotice(`reverted ${result.reverted.files.length} file${result.reverted.files.length === 1 ? '' : 's'}`);
    }).catch((err) => {
      setNotice(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => setBusyId(null));
  };

  return (
    <section className="surface-card">
      <PanelHeader {...header}>
        <span className="panel-header__title">history</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">{events.length} events</span>
      </PanelHeader>
      {notice && <div className="diff-historical-banner"><span>{notice}</span></div>}
      <div className="history-list">
        {events.length === 0 && <span className="verify-empty">no history events recorded</span>}
        {events.map((event) => (
          <section key={event.id}>
            <time>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <strong>{event.source} / {event.kind}</strong>
            <div className="history-actions">
              <button type="button" disabled={busyId === event.id} onClick={() => fork(event)}>
                fork from here
              </button>
              <button type="button" disabled={busyId === event.id} onClick={() => revert(event)}>
                revert...
              </button>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
