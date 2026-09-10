import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RepositoryContext } from '../github/repository-context';
import { env } from '../config/env';

export type PendingChangeStatus =
  | 'awaiting_approval'
  | 'implementing'
  | 'implemented'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export interface PendingChange {
  request: string;
  plan: string;
  status: PendingChangeStatus;
  branch?: string;
  baseBranch?: string;
  implementation?: string;
  changedFiles?: string[];
  commitSha?: string;
  failure?: string;
  updatedAt?: string;
}

export interface AgentContext {
  user?: {
    id: string;
    phoneNumber?: string;
    name?: string;
  };
  repository?: string;
  currentTask?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  memory: Record<string, unknown>;
  permissions: string[];
  state: 'conversation' | 'analysis';
  currentRepository?: string;
  repositoryContext?: RepositoryContext;
  selectedBranch?: string;
  pendingChange?: PendingChange;
}

export function createAgentContext(): AgentContext {
  return {
    history: [],
    memory: {},
    permissions: [],
    state: 'conversation',
  };
}

const MAX_HISTORY_ITEMS = 20;

export function trimAgentContext(context: AgentContext): AgentContext {
  context.history = context.history.slice(-MAX_HISTORY_ITEMS);
  return context;
}

export interface AgentContextStore {
  load(): Map<string, AgentContext>;
  save(contexts: Map<string, AgentContext>): void;
}

export class FileAgentContextStore implements AgentContextStore {
  constructor(private readonly filePath = env.agentMemoryFile) {}

  load(): Map<string, AgentContext> {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, AgentContext>;
      return new Map(Object.entries(raw).map(([userId, context]) => [userId, trimAgentContext(context)]));
    } catch {
      return new Map();
    }
  }

  save(contexts: Map<string, AgentContext>): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const serializable = Object.fromEntries(
      [...contexts.entries()].map(([userId, context]) => [userId, trimAgentContext(context)]),
    );
    writeFileSync(temporaryPath, JSON.stringify(serializable, null, 2), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}