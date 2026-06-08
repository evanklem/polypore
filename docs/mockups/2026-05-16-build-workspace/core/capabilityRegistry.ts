import { AgentCapabilityMap, AgentId, Capability } from './types';

const capabilities: Capability[] = [
  'memory-dir',
  'slash-commands',
  'tool-servers',
  'compaction',
  'phase-reporting',
  'permission-flow',
  'subagent-spawn',
  'streaming',
  'tool-use',
];

const baseDescriptions: Record<Capability, string> = {
  'memory-dir': 'Agent-readable project and user memory locations',
  'slash-commands': 'Task shortcuts and reusable operator commands',
  'tool-servers': 'External tool servers or plugin equivalents',
  compaction: 'Context compaction while preserving task continuity',
  'phase-reporting': 'Workflow graph phase progress reporting',
  'permission-flow': 'Inline approval prompts from the active agent',
  'subagent-spawn': 'Parent-agent managed subtask delegation',
  streaming: 'Live text and tool-call streaming',
  'tool-use': 'Structured tool-call execution events',
};

const availability: Record<AgentId, Partial<Record<Capability, boolean>>> = {
  claude: {
    'memory-dir': true,
    'slash-commands': true,
    'tool-servers': true,
    compaction: true,
    'phase-reporting': true,
    'permission-flow': true,
    'subagent-spawn': true,
    streaming: true,
    'tool-use': true,
  },
  codex: {
    'memory-dir': true,
    'slash-commands': true,
    'tool-servers': true,
    compaction: true,
    'phase-reporting': false,
    'permission-flow': true,
    'subagent-spawn': true,
    streaming: true,
    'tool-use': true,
  },
  cursor: {
    'memory-dir': true,
    'slash-commands': false,
    'tool-servers': true,
    compaction: false,
    'phase-reporting': false,
    'permission-flow': true,
    'subagent-spawn': false,
    streaming: true,
    'tool-use': true,
  },
};

export function getCapabilityMap(agent: AgentId): AgentCapabilityMap {
  return capabilities.reduce((map, capability) => {
    const available = availability[agent][capability] === true;
    map[capability] = available
      ? {
          agent,
          available,
          description: baseDescriptions[capability],
        }
      : null;
    return map;
  }, {} as AgentCapabilityMap);
}

export function missingCapabilities(agent: AgentId, required: Capability[]) {
  const map = getCapabilityMap(agent);
  return required.filter((capability) => !map[capability]);
}
