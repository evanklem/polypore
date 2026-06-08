export type AgentId = 'claude' | 'codex' | 'cursor';

export type Capability =
  | 'memory-dir'
  | 'slash-commands'
  | 'tool-servers'
  | 'compaction'
  | 'phase-reporting'
  | 'permission-flow'
  | 'subagent-spawn'
  | 'streaming'
  | 'tool-use';

export type AgentImpl = {
  agent: AgentId;
  description: string;
  available: boolean;
  docsUrl?: string;
};

export type AgentCapabilityMap = Record<Capability, AgentImpl | null>;

export type TimelineEvent = {
  id: string;
  ts: number;
  taskId: string;
  source: 'agent' | 'human';
  kind: 'tool-call' | 'file-write' | 'file-edit' | 'message' | 'phase-change';
  agentId?: AgentId;
  toolName?: string;
  phase?: string;
  affectedFiles: string[];
  summary: string;
  payload?: Record<string, unknown>;
  snapshotId?: number;
};

export type VerifyRun = {
  id: string;
  label: 'typecheck' | 'tests' | 'lint' | string;
  command: string;
  exitCode: number | null;
  ranAt: number | null;
  required: boolean;
  output: string;
};

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed';

export type WorkflowNode = {
  id: string;
  label: string;
  level: 'phase' | 'sub';
  status: WorkflowNodeStatus;
  parentId?: string;
  todoItems?: Array<{ id: string; label: string; done: boolean }>;
};

/* PanelType is a free-form slot id contributed by each plugin's index.ts
   (see `BuiltinPlugin.slot`). it is *not* an enum of named panels — every
   built-in or third-party plugin under plugins/ adds its own slot at glob
   time. workspace presets reference slots by string. */
export type PanelType = string;

export type PanelDefinition = {
  id: PanelType;
  title: string;
  requiredCapabilities: Capability[];
  defaultArea: 'left' | 'top' | 'center' | 'right' | 'bottom';
};

export type WorkspaceName = 'Default';

export type WorkspaceLayoutItem = {
  slot: PanelType;
  position?: 'left' | 'right' | 'center';
  size?: number;
  tabIndex?: number;
};

export type WorkspacePreset = {
  schemaVersion: 1;
  name: WorkspaceName;
  panels: PanelType[];
  emphasis: PanelType[];
  layout: WorkspaceLayoutItem[];
};

export type OperatorState = {
  activeAgent: AgentId;
  workspace: WorkspaceName;
  contextUsedPct: number;
  branch: string;
  agentConnected: boolean;
};
