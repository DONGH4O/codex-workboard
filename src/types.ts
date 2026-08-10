export type Lane = 'plan' | 'execution' | 'review';
export type Substatus = 'idea' | 'ready' | 'claimed' | 'running' | 'blocked' | 'pending_review' | 'rework' | 'accepted' | 'closed';
export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  lane: Lane;
  substatus: Substatus;
  priority: Priority;
  projectPath: string | null;
  threadId: string | null;
  executor: string | null;
  auditor: string | null;
  acceptanceCriteria: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  taskId: string;
  actorRole: 'system' | 'executor' | 'auditor';
  action: string;
  note: string;
  createdAt: string;
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: { type?: string } | string;
  createdAt?: number;
  updatedAt?: number;
  isPinned?: boolean;
  archived: boolean;
  runtimeStatus: string;
  modelProvider?: string | null;
  sourceKind?: string | null;
  category: string;
  classificationSource: 'auto' | 'manual';
  tags: string[];
  note: string;
  linkedTaskCount: number;
  syncedAt: string;
}

export interface CodexThreadDetail extends CodexThreadSummary {
  turns?: Array<Record<string, unknown>>;
}

export interface BootstrapData {
  tasks: Task[];
  threads: CodexThreadSummary[];
  categories: string[];
  sync: {
    total: number;
    active: number;
    unarchived: number;
    archived: number;
    lastSyncedAt: string | null;
    stale: boolean;
    migratedTaskCount: number;
  };
  codex: { connected: boolean; version: string; error?: string };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  lane?: Lane;
  substatus?: Substatus;
  priority?: Priority;
  projectPath?: string | null;
  threadId?: string | null;
  executor?: string | null;
  auditor?: string | null;
  acceptanceCriteria?: string;
}

export interface TaskPatch extends Partial<CreateTaskInput> {
  lane?: Lane;
  substatus?: Substatus;
}

export interface BulkTaskResult {
  tasks: Task[];
  created: number;
  skipped: number;
  byLane: Record<Lane, number>;
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapData>;
  listThreads(): Promise<CodexThreadSummary[]>;
  readThread(threadId: string): Promise<CodexThreadDetail>;
  sendToThread(threadId: string, text: string): Promise<unknown>;
  openThreadInCodex(threadId: string): Promise<void>;
  updateConversation(threadId: string, input: { category?: string; tags?: string[]; note?: string }): Promise<CodexThreadSummary>;
  createTask(input: CreateTaskInput): Promise<Task>;
  bulkCreateTasks(): Promise<BulkTaskResult>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  listAuditEvents(taskId: string): Promise<AuditEvent[]>;
  reviewTask(id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note: string }): Promise<Task>;
}

declare global {
  interface Window {
    codexTaskboard: DesktopApi;
  }
}
