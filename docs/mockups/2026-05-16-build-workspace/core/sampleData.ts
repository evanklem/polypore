import { OperatorState, TimelineEvent, VerifyRun, WorkflowNode } from './types';

export const initialOperatorState: OperatorState = {
  activeAgent: 'claude',
  workspace: 'Build',
  contextUsedPct: 47,
  branch: 'main',
  agentConnected: true,
};

export const workflowNodes: WorkflowNode[] = [
  { id: 'brainstorm', label: 'Brainstorm', level: 'phase', status: 'done' },
  { id: 'plan', label: 'Plan', level: 'phase', status: 'done' },
  {
    id: 'green',
    label: 'Green',
    level: 'phase',
    status: 'running',
    todoItems: [
      { id: 'spine', label: 'Stand up typed event-bus and capability registry', done: true },
      { id: 'layout', label: 'Render registered MVP panels in a workspace shell', done: false },
      { id: 'verify', label: 'Wire a first verify result surface', done: false },
    ],
  },
  { id: 'iterate', label: 'Iterate', level: 'phase', status: 'pending' },
  { id: 'ship', label: 'Ship', level: 'phase', status: 'pending' },
];

export const timelineEvents: TimelineEvent[] = [
  {
    id: 't1',
    ts: Date.now() - 1000 * 60 * 12,
    taskId: 'operator-ide-slice-1',
    source: 'human',
    kind: 'message',
    affectedFiles: ['docs/specs/2026-05-14-operator-ide-prd.md'],
    summary: 'prd created and selected as source of truth.',
  },
  {
    id: 't2',
    ts: Date.now() - 1000 * 60 * 7,
    taskId: 'operator-ide-slice-1',
    source: 'agent',
    kind: 'phase-change',
    agentId: 'claude',
    toolName: 'report_phase',
    phase: 'green',
    affectedFiles: ['src/core/types.ts', 'src/core/eventBus.ts'],
    summary: 'entered implementation phase for the integration spine.',
  },
  {
    id: 't3',
    ts: Date.now() - 1000 * 60 * 3,
    taskId: 'operator-ide-slice-1',
    source: 'agent',
    kind: 'file-write',
    agentId: 'claude',
    affectedFiles: ['src/workspaces/presets.ts'],
    summary: 'registered the build workspace and left custom layouts for users.',
    snapshotId: 1,
  },
];

export const verifyRuns: VerifyRun[] = [
  {
    id: 'v1',
    label: 'typecheck',
    command: 'npm run build',
    exitCode: null,
    ranAt: null,
    required: true,
    output: 'pending first local run.',
  },
  {
    id: 'v2',
    label: 'tests',
    command: 'npm test -- --watchAll=false',
    exitCode: null,
    ranAt: null,
    required: true,
    output: 'pending first local run.',
  },
];
