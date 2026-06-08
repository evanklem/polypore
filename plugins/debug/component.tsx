import React, { useEffect, useRef, useState } from 'react';
import type { VerifyRun } from '../../packages/sdk/src';
import type { BuiltinPluginProps, ChatTarget, DiagnosticProblem } from '../shared';
import {
  deliverPromptToTarget,
  diagnosticsToProblems,
  PanelHeader,
  ResizeHandle,
  scheduleAfterPaint,
  perfPoint,
  useResizableSplit,
  openChatPanelTargets,
} from '../shared';
import {
  FIX_ITEM_MIME,
  QUEUE_ITEM_MIME,
  type CheckItem,
  type QueueItem,
} from './data';

type ProblemItem = Pick<DiagnosticProblem, 'id' | 'severity' | 'file' | 'line' | 'msg'> & {
  origin: 'host' | 'deep' | 'custom';
};

function diagnosticsToVerifyProblems(
  diagnostics: Parameters<typeof diagnosticsToProblems>[0],
  origin: ProblemItem['origin'] = 'host',
): ProblemItem[] {
  return diagnosticsToProblems(diagnostics).map(({ id, severity, file, line, msg }) => ({
    id,
    severity,
    file,
    line,
    msg,
    origin,
  }));
}

function replaceProblemsByOrigin(
  current: ProblemItem[],
  origin: ProblemItem['origin'],
  next: ProblemItem[],
): ProblemItem[] {
  const byId = new Map<string, ProblemItem>();
  for (const item of current) {
    if (item.origin !== origin) byId.set(item.id, item);
  }
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

function runsToChecks(runs: VerifyRun[]): CheckItem[] {
  return runs.map((run) => ({
    id: run.id,
    label: run.label,
    cmd: run.command,
    status: run.status,
    ms: run.durationMs ?? null,
  }));
}

function queuePrompt(items: QueueItem[]) {
  return [
    'Please work through this verify queue.',
    '',
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.source === 'problem' ? 'Fix' : 'Run/check'}: ${item.label}`,
      item.detail ? `   ${item.source === 'problem' ? 'Location' : 'Command'}: ${item.detail}` : '',
    ].filter(Boolean)),
    '',
    'Apply any needed fixes, run the relevant checks, and report what changed.',
    'If a problem needs runtime investigation (a bug you cannot pin down from the code alone), use the polypore.debug.* tools — start a session, set breakpoints, run to a stop, inspect variables, and evaluate — instead of guessing. Capture a screenshot/console when the symptom is visual.',
  ].join('\n');
}

export function DebugPanel({ header, host }: BuiltinPluginProps) {
  perfPoint('verify:render');
  const [sourceWidth, onSourceResize] = useResizableSplit({ axis: 'x', initial: 55, min: 38, max: 70 });
  const [problemsHeight, onProblemsResize] = useResizableSplit({ axis: 'y', initial: 50, min: 30, max: 70 });
  const [problems, setProblems] = useState<ProblemItem[]>([]);
  const [hostChecks, setHostChecks] = useState<CheckItem[]>([]);
  const [customChecks, setCustomChecks] = useState<CheckItem[]>([]);
  const checks = [...hostChecks, ...customChecks];

  useEffect(() => {
    let cancelled = false;
    /* defer the cold-path host calls past the first paint — without this
       the entire diagnostics.list + verify.runs synchronous setup chain
       (envelope validation, tauri-invoke arg serialize × N, postMessage
       queueing) runs in the useEffect immediately after commit and pushes
       the panel's first paint back by ~1s. with the yield, the skeleton
       lands in one frame and the host calls fire on the next task. */
    let unsubscribeDiagnostics: (() => void) | undefined;
    let unsubscribeVerify: (() => void) | undefined;
    const cancelSchedule = scheduleAfterPaint(() => {
      if (cancelled) return;
      perfPoint('verify:effect-fires');
      /* pull the same list the problems panel sees so they stay in sync. */
      host.diagnostics.list().then((result) => {
        if (cancelled) return;
        setProblems((current) => replaceProblemsByOrigin(
          current,
          'host',
          diagnosticsToVerifyProblems(result.diagnostics, 'host'),
        ));
      }).catch(() => setProblems((current) => replaceProblemsByOrigin(current, 'host', [])));
      unsubscribeDiagnostics = host.diagnostics.onChange?.((event) => {
        if (cancelled) return;
        setProblems((current) => replaceProblemsByOrigin(
          current,
          'host',
          diagnosticsToVerifyProblems(event.diagnostics, 'host'),
        ));
      });
      host.verify.runs().then((result) => {
        if (cancelled) return;
        setHostChecks(runsToChecks(result.runs));
      }).catch(() => setHostChecks([]));
      unsubscribeVerify = host.verify.onChange?.((event) => {
        if (cancelled) return;
        setHostChecks(runsToChecks(event.runs));
      });
    });
    return () => {
      cancelled = true;
      cancelSchedule();
      unsubscribeDiagnostics?.();
      unsubscribeVerify?.();
    };
  }, [host]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [problemDraft, setProblemDraft] = useState('');
  const [checkDraft, setCheckDraft] = useState('');
  const [addingProblem, setAddingProblem] = useState(false);
  const [addingCheck, setAddingCheck] = useState(false);
  const [queueHover, setQueueHover] = useState(false);
  const [draggedQueueId, setDraggedQueueId] = useState<string | null>(null);
  const [loopStatus, setLoopStatus] = useState('idle');
  const [deepScanning, setDeepScanning] = useState(false);
  const deepScanAbortRef = useRef(false);
  const [chatTargets, setChatTargets] = useState<ChatTarget[]>([]);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);

  const cancelDeepScan = () => {
    deepScanAbortRef.current = true;
    setDeepScanning(false);
    setLoopStatus('scan cancelled');
  };

  const runDeepScan = async () => {
    if (deepScanning) return;
    deepScanAbortRef.current = false;
    setDeepScanning(true);
    setLoopStatus('deep scan running');
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = await host.diagnostics.deepScan();
      if (deepScanAbortRef.current) return;
      const deepProblems = diagnosticsToVerifyProblems(result.diagnostics, 'deep');
      setProblems((current) => replaceProblemsByOrigin(current, 'deep', deepProblems));
      /* VS Code-style severity breakdown: "3 errors · 5 warnings" rather than
         a raw count — makes it immediately clear whether findings are blocking. */
      const errors = deepProblems.filter((p) => p.severity === 'error').length;
      const warnings = deepProblems.filter((p) => p.severity === 'warn').length;
      const parts: string[] = ['deep scan'];
      if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
      if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
      if (errors === 0 && warnings === 0) parts.push('clean');
      setLoopStatus(parts.join(' · '));
    } catch (err) {
      if (deepScanAbortRef.current) return;
      setLoopStatus(`deep scan failed: ${err instanceof Error ? err.message : String(err)}`.toLowerCase());
    } finally {
      if (!deepScanAbortRef.current) setDeepScanning(false);
    }
  };

  const enqueue = (
    source: 'problem' | 'check',
    sourceId: string,
    label: string,
    detail?: string,
  ) => {
    setQueue((current) => {
      if (current.some((item) => item.source === source && item.sourceId === sourceId)) return current;
      return [
        ...current,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source,
          sourceId,
          label,
          detail,
          status: 'pending',
        },
      ];
    });
  };

  const removeQueueItem = (id: string) => setQueue((q) => q.filter((item) => item.id !== id));

  const removeCustomProblem = (id: string) => {
    setProblems((p) => p.filter((item) => item.id !== id || item.origin !== 'custom'));
    setQueue((q) => q.filter((item) => item.source !== 'problem' || item.sourceId !== id));
  };

  const removeCustomCheck = (id: string) => {
    setCustomChecks((c) => c.filter((item) => item.id !== id));
    setQueue((q) => q.filter((item) => item.source !== 'check' || item.sourceId !== id));
  };

  const reorderQueue = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setQueue((prev) => {
      const fromIdx = prev.findIndex((item) => item.id === fromId);
      const toIdx = prev.findIndex((item) => item.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const pendingQueueItems = queue.filter((item) => item.status === 'pending');

  const loadChatTargets = async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return openChatPanelTargets();
  };

  const sendQueueToChat = async (target: ChatTarget) => {
    if (running) return;
    const pending = pendingQueueItems;
    if (pending.length === 0) return;
    setRunning(true);
    setTargetPickerOpen(false);
    setLoopStatus('sending');
    try {
      for (const item of pending) {
        setQueue((q) => q.map((i) => (i.id === item.id ? { ...i, status: 'fixing' } : i)));
      }
      await deliverPromptToTarget(target, queuePrompt(pending));
      setLoopStatus(`sent to ${target.title || target.agent} · awaiting agent`);
      setQueue((q) => q.map((i) => (pending.some((item) => item.id === i.id) ? { ...i, status: 'sent' } : i)));
    } catch (err) {
      setLoopStatus(`failed: ${err instanceof Error ? err.message : String(err)}`.toLowerCase());
      setQueue((q) => q.map((i) => (pending.some((item) => item.id === i.id) ? { ...i, status: 'failed' } : i)));
    } finally {
      setRunning(false);
    }
  };

  const chooseQueueChatTarget = async () => {
    if (running || pendingQueueItems.length === 0) return;
    setLoopStatus('loading chats');
    try {
      const targets = await loadChatTargets();
      setChatTargets(targets);
      if (targets.length === 1) {
        await sendQueueToChat(targets[0]);
        return;
      }
      if (targets.length > 1) {
        setTargetPickerOpen(true);
        setLoopStatus('pick chat');
        return;
      }
      setLoopStatus('no open chats');
    } catch (err) {
      setTargetPickerOpen(false);
      setLoopStatus(`failed: ${err instanceof Error ? err.message : String(err)}`.toLowerCase());
    }
  };

  const addCustomProblem = () => {
    const text = problemDraft.trim();
    if (!text) return;
    const id = `p-custom-${Date.now()}`;
    setProblems((p) => [...p, { id, severity: 'warn', file: 'custom', line: 0, msg: text, origin: 'custom' }]);
    setProblemDraft('');
    setAddingProblem(false);
  };

  const addCustomCheck = () => {
    const text = checkDraft.trim();
    if (!text) return;
    const id = `c-custom-${Date.now()}`;
    setCustomChecks((c) => [...c, { id, label: 'custom', cmd: text, status: 'pending', ms: null }]);
    setCheckDraft('');
    setAddingCheck(false);
  };

  const moveAllChecksToQueue = () => {
    setQueue((current) => {
      const existing = new Set(
        current.filter((i) => i.source === 'check').map((i) => i.sourceId),
      );
      const additions: QueueItem[] = checks
        .filter((c) => !existing.has(c.id))
        .map((c) => ({
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${c.id}`,
          source: 'check',
          sourceId: c.id,
          label: c.label,
          detail: c.cmd,
          status: 'pending',
        }));
      return [...current, ...additions];
    });
  };

  const moveAllProblemsToQueue = () => {
    setQueue((current) => {
      const existing = new Set(
        current.filter((i) => i.source === 'problem').map((i) => i.sourceId),
      );
      const additions: QueueItem[] = problems
        .filter((p) => !existing.has(p.id))
        .map((p) => ({
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${p.id}`,
          source: 'problem',
          sourceId: p.id,
          label: p.msg,
          detail: p.line ? `${p.file}:${p.line}` : p.file,
          status: 'pending',
        }));
      return [...current, ...additions];
    });
  };

  return (
    <div className="verify-shell">
      <PanelHeader {...header}>
        <span className="panel-header__title">debug</span>
        <span className="panel-header__sep" aria-hidden="true" />
        <span className="panel-header__meta">problems {problems.length}</span>
        <span className="panel-header__meta">checks {checks.length}</span>
        <span className="panel-header__meta">queue {queue.length}</span>
        <span className="panel-header__meta">{loopStatus}</span>
        {running && <span className="panel-header__meta panel-header__meta--live">running</span>}
      </PanelHeader>
      <div
        className="verify-grid verify-grid--queue"
        style={{ '--verify-source-width': `${sourceWidth}%` } as React.CSSProperties}
      >
        <div
          className="verify-stack"
          style={{ '--verify-problems-height': `${problemsHeight}%` } as React.CSSProperties}
        >
          <section className="verify-section">
            <header>
              <div className="verify-section__heading">
                <h2>problems</h2>
                <small>{problems.length} {problems.length === 1 ? 'item' : 'items'}</small>
              </div>
              <div className="verify-section__actions">
                <button
                  className="verify-move-all verify-move-all--primary"
                  onClick={runDeepScan}
                  disabled={deepScanning}
                  title="run deep project scan"
                >
                  {deepScanning ? 'scanning...' : 'deep scan'}
                </button>
                <button
                  className="verify-move-all"
                  onClick={moveAllProblemsToQueue}
                  disabled={problems.length === 0 || deepScanning}
                  title="move all problems to queue"
                >
                  queue all
                </button>
              </div>
            </header>
            {deepScanning && (
              <div className="verify-scan-progress" role="status" aria-live="polite">
                <span>running project scan</span>
                <div className="verify-scan-progress__bar" aria-hidden="true" />
                <button
                  className="verify-scan-progress__cancel"
                  onClick={cancelDeepScan}
                  aria-label="cancel deep scan"
                  title="cancel deep scan"
                >
                  ×
                </button>
              </div>
            )}
            <div className="problems-list" aria-busy={deepScanning}>
              {deepScanning ? null : problems.length === 0 ? (
                <span className="verify-empty">no problems · clean</span>
              ) : (
                problems.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    className={`problem-row problem-row--${item.severity}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData(
                        FIX_ITEM_MIME,
                        JSON.stringify({
                          source: 'problem',
                          sourceId: item.id,
                          label: item.msg,
                          detail: item.line ? `${item.file}:${item.line}` : item.file,
                        }),
                      );
                    }}
                  >
                    <span className="problem-row__severity">{item.severity}</span>
                    <span className="problem-row__file">{item.file}{item.line ? `:${item.line}` : ''}</span>
                    <span className="problem-row__msg">{item.msg}</span>
                    <button
                      className="verify-row-action verify-row-action--primary"
                      aria-label={`queue ${item.msg}`}
                      onClick={() => enqueue('problem', item.id, item.msg, item.line ? `${item.file}:${item.line}` : item.file)}
                    >
                      +
                    </button>
                    {item.origin === 'custom' && (
                      <button
                        className="verify-row-action verify-row-action--secondary verify-row-action--danger"
                        aria-label={`remove ${item.msg}`}
                        onClick={() => removeCustomProblem(item.id)}
                      >
                        x
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            {addingProblem && (
              <div className="verify-add-form">
                <input
                  placeholder="problem to enqueue"
                  value={problemDraft}
                  autoFocus
                  onChange={(event) => setProblemDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addCustomProblem();
                    if (event.key === 'Escape') setAddingProblem(false);
                  }}
                />
                <button onClick={addCustomProblem}>add</button>
              </div>
            )}
            <div className="verify-section__footer">
              <button className="verify-add" onClick={() => setAddingProblem((v) => !v)}>create +</button>
            </div>
          </section>
          <ResizeHandle axis="y" label="resize problems and checks" onDrag={onProblemsResize} />

          <section className="verify-section">
            <header>
              <div className="verify-section__heading">
                <h2>checks</h2>
                <small>{checks.length} {checks.length === 1 ? 'item' : 'items'}</small>
              </div>
              <div className="verify-section__actions">
                <button
                  className="verify-move-all"
                  onClick={moveAllChecksToQueue}
                  disabled={checks.length === 0}
                  title="move all checks to queue"
                >
                  queue all
                </button>
              </div>
            </header>
            <div className="checks-list">
              {checks.map((check) => {
                const isCustom = customChecks.some((item) => item.id === check.id);
                return (
                  <article
                    key={check.id}
                    draggable
                    className={`check-row check-row--${check.status}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData(
                        FIX_ITEM_MIME,
                        JSON.stringify({
                          source: 'check',
                          sourceId: check.id,
                          label: check.label,
                          detail: check.cmd,
                        }),
                      );
                    }}
                    >
                      <span className="check-row__label">{check.label}</span>
                      <code>{check.cmd}</code>
                    <button
                      className="verify-row-action verify-row-action--primary"
                      aria-label={`queue ${check.label}`}
                      onClick={() => enqueue('check', check.id, check.label, check.cmd)}
                    >
                      +
                    </button>
                    {isCustom && (
                      <button
                        className="verify-row-action verify-row-action--secondary verify-row-action--danger"
                        aria-label={`remove ${check.label} check`}
                        onClick={() => removeCustomCheck(check.id)}
                      >
                        x
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
            {addingCheck && (
              <div className="verify-add-form">
                <input
                  placeholder="custom command"
                  value={checkDraft}
                  autoFocus
                  onChange={(event) => setCheckDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addCustomCheck();
                    if (event.key === 'Escape') setAddingCheck(false);
                  }}
                />
                <button onClick={addCustomCheck}>add</button>
              </div>
            )}
            <div className="verify-section__footer">
              <button className="verify-add" onClick={() => setAddingCheck((v) => !v)}>create +</button>
            </div>
          </section>
        </div>
        <ResizeHandle axis="x" label="resize verify sources and queue" onDrag={onSourceResize} />

        <section className="verify-queue">
          <header>
            <h2>queue</h2>
            <small>{queue.length} queued</small>
          </header>
          <div
            className={`queue-list ${queueHover ? 'queue-list--drop' : ''}`}
            onDragOver={(event) => {
              const types = Array.from(event.dataTransfer.types);
              if (types.includes(FIX_ITEM_MIME) || types.includes(QUEUE_ITEM_MIME)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = types.includes(QUEUE_ITEM_MIME) ? 'move' : 'copy';
                setQueueHover(true);
              }
            }}
            onDragLeave={() => setQueueHover(false)}
            onDrop={(event) => {
              event.preventDefault();
              setQueueHover(false);
              const fixData = event.dataTransfer.getData(FIX_ITEM_MIME);
              if (fixData) {
                const item = JSON.parse(fixData) as { source: 'problem' | 'check'; sourceId: string; label: string; detail?: string };
                enqueue(item.source, item.sourceId, item.label, item.detail);
              }
            }}
          >
            {queue.length === 0 ? (
              <span className="verify-empty queue-empty">drag problems and checks here to assemble a fix list</span>
            ) : (
              queue.map((item, index) => (
                <article
                  key={item.id}
                  draggable={!running}
                  className={`queue-item queue-item--${item.status} ${draggedQueueId === item.id ? 'queue-item--dragging' : ''}`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(QUEUE_ITEM_MIME, item.id);
                    setDraggedQueueId(item.id);
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(QUEUE_ITEM_MIME)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setQueueHover(false);
                    const fromId = event.dataTransfer.getData(QUEUE_ITEM_MIME);
                    if (fromId) reorderQueue(fromId, item.id);
                    setDraggedQueueId(null);
                  }}
                  onDragEnd={() => setDraggedQueueId(null)}
                >
                  <span className="queue-item__index">{index + 1}</span>
                  <div className="queue-item__body">
                    <strong>{item.label}</strong>
                    {item.detail && <small>{item.detail}</small>}
                  </div>
                  <span className="queue-item__status">{item.status}</span>
                  <button
                    className="queue-item__close"
                    aria-label={`remove ${item.label} from queue`}
                    disabled={running && item.status === 'fixing'}
                    onClick={() => removeQueueItem(item.id)}
                  >
                    x
                  </button>
                </article>
              ))
            )}
          </div>
          <div className="queue-actions">
            <div className="queue-send">
              {targetPickerOpen && (
                <div className="queue-target-picker" role="menu" aria-label="send queue to chat">
                  {chatTargets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      role="menuitem"
                      onClick={() => void sendQueueToChat(target)}
                    >
                      {target.title || target.agent}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="queue-run"
                disabled={running || pendingQueueItems.length === 0}
                onClick={() => void chooseQueueChatTarget()}
              >
                {running ? 'sending...' : 'send to chat'}
              </button>
            </div>
            <button
              disabled={running || queue.length === 0}
              onClick={() => setQueue([])}
            >
              clear
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
