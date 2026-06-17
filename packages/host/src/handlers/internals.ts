/* The slice of HostRpcServer state that the extracted handler modules
 * operate on. The server passes itself (cast) to each register function;
 * this interface is the contract that documents exactly which internals
 * each handler domain may touch — keeping the fields private to every
 * other consumer of the class. */

import type {
  BrowserDirectoryHandle,
  ConfirmDecision,
  ConfirmRequest,
  DebugCard,
  DebugCardKind,
  DebugDriveRunner,
  DebugRunner,
  DebugScenario,
  DebugScrubber,
  DebugSessionInfo,
  DebugState,
  DebugStopResult,
  DebugTrust,
  KnowledgeAdapter,
  KnowledgeBaseRef,
  McpDiscoverer,
  McpInstaller,
  McpServerRecord,
  McpTester,
  PluginStoreAdapter,
  RpcHandler,
  SecretDeleter,
  SecretRevealer,
  SecretUser,
  SecretWriter,
  SkillPublisher,
  SkillRecord,
  SkillsetRecord,
} from '../rpc-server';
import type { PluginRef } from '../../../sdk/src';
import type { SecretStore } from '../secret-store';

export interface HostInternals {
  /* core facilities */
  registerHandler(method: string, handler: RpcHandler): void;
  publish(topic: string, payload: unknown): void;
  handlers: Map<string, RpcHandler>;
  confirmDecider: (request: ConfirmRequest) => ConfirmDecision | Promise<ConfirmDecision>;

  /* knowledge */
  knowledgeAdapter: KnowledgeAdapter | null;
  knowledge: Map<string, string>;
  knowledgeBases: KnowledgeBaseRef[];
  browserKnowledgeHandles: Map<string, BrowserDirectoryHandle>;
  readKnowledgeRaw(path: string, baseId?: string): Promise<string>;
  writeKnowledgeRaw(path: string, content: string, baseId?: string): Promise<void>;

  /* secrets */
  secretStore: SecretStore | null;
  secretUser: SecretUser | null;
  secretWriter: SecretWriter | null;
  secretRevealer: SecretRevealer | null;
  secretDeleter: SecretDeleter | null;

  /* plugins */
  plugins: PluginRef[];
  pluginStore: PluginStoreAdapter | null;

  /* skills + skillsets */
  skills: SkillRecord[];
  skillsets: SkillsetRecord[];
  skillPublisher: SkillPublisher | null;

  /* mcp */
  mcpServers: McpServerRecord[];
  mcpDiscoverer: McpDiscoverer | null;
  mcpTester: McpTester | null;
  mcpInstaller: McpInstaller | null;

  /* debug suite */
  debug: DebugState;
  debugRunner: DebugRunner | null;
  debugScrubber: DebugScrubber | null;
  requireDebugRunner(): DebugRunner;
  activeDebugSession(): DebugSessionInfo;
  dapSessionId(session: DebugSessionInfo): string;
  openDebugSession(adapter: string, scenario: DebugScenario, trust: DebugTrust, dapSessionId: string): DebugSessionInfo;
  newDebugCard(kind: DebugCardKind, title: string, initiatedBy?: 'agent' | 'human'): DebugCard;
  finishDebugCard(card: DebugCard, patch: Partial<DebugCard>): DebugCard;
  raiseRoadblock(ask: string): void;
  debugSnapshot(): DebugState;
  publishDebug(): void;
  execDebugStop(
    kind: DebugCardKind,
    params: unknown,
    exec: (args: { sessionId: string; threadId?: number }) => Promise<DebugStopResult>,
  ): Promise<unknown>;
  execDrive(
    kind: DebugCardKind,
    title: string,
    roadblockAsk: string,
    cardPayload: Record<string, unknown>,
    run: (drive: DebugDriveRunner, session: DebugSessionInfo) => Promise<unknown>,
  ): Promise<unknown>;
  syncBreakpointsForFile(file: string): Promise<void>;
  replayBreakpoints(runner: DebugRunner, dapSessionId: string): Promise<void>;
}
