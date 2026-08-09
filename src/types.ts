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
}

export interface CodexThreadDetail extends CodexThreadSummary {
  turns?: Array<Record<string, unknown>>;
}

export interface BootstrapData {
  tasks: Task[];
  threads: CodexThreadSummary[];
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

export interface DesktopApi {
  bootstrap(): Promise<BootstrapData>;
  listThreads(): Promise<CodexThreadSummary[]>;
  readThread(threadId: string): Promise<CodexThreadDetail>;
  sendToThread(threadId: string, text: string): Promise<unknown>;
  openThreadInCodex(threadId: string): Promise<void>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  listAuditEvents(taskId: string): Promise<AuditEvent[]>;
  reviewTask(id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note: string }): Promise<Task>;
}

declare global {
  interface Window {
    codexTaskboard: DesktopApi;
  }
}

