export type Lane = 'plan' | 'execution' | 'review';
export type Substatus = 'idea' | 'ready' | 'claimed' | 'running' | 'blocked' | 'pending_review' | 'rework' | 'accepted' | 'closed';
export type Priority = 'low' | 'medium' | 'high';
export type RequestId = string | number;
export type ExecutionStatus = 'idle' | 'running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'failed' | 'interrupted';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type ExecutionPermissionPreset = 'untrusted' | 'on-request' | 'full-access';

export interface Task {
  id: string;
  title: string;
  description: string;
  lane: Lane;
  substatus: Substatus;
  priority: Priority;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  executor: string | null;
  auditor: string | null;
  acceptanceCriteria: string;
  startAt: string;
  endAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  conversationLaunchError?: string;
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

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
}

export interface ExecutionPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface PendingApproval {
  requestId: RequestId;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string;
  command: string;
  cwd: string;
  networkHost: string;
  networkProtocol: string;
  availableDecisions: ApprovalDecision[];
  unsupportedDecisionCount: number;
  unsupportedDecisions: Array<Record<string, unknown>>;
  responseSubmitted: boolean;
}

export interface PendingUserInput {
  requestId: RequestId;
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
}

export interface ExecutionSnapshot {
  taskId: string;
  threadId: string;
  turnId: string | null;
  status: ExecutionStatus;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  permissionPreset: ExecutionPermissionPreset;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  plan: ExecutionPlanStep[];
  lastMessage: string;
  output: string;
  diff: string;
  currentItem: Record<string, unknown> | null;
  pendingApproval: PendingApproval | null;
  pendingUserInput: PendingUserInput | null;
  error: string;
}

export interface ComposerImage {
  path: string;
  name: string;
  preview: string;
}

export interface BootstrapData {
  tasks: Task[];
  executions: ExecutionSnapshot[];
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
    archivedTaskCount: number;
  };
  codex: {
    connected: boolean;
    state: 'idle' | 'starting' | 'ready' | 'version_incompatible' | 'auth_required' | 'protocol_incompatible' | 'error';
    version: string;
    expectedVersion: string;
    source?: 'explicit' | 'desktopApp' | 'systemPath' | 'bundled';
    executablePath?: string;
    codexHome?: string;
    platformFamily?: string;
    platformOs?: string;
    accountChecked: boolean;
    modelListChecked: boolean;
    windowsSandbox?: { state: 'unknown' | 'ready' | 'needs_setup' | 'unavailable'; detail?: string };
    error?: string;
  };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  lane?: Lane;
  substatus?: Substatus;
  priority?: Priority;
  projectName?: string | null;
  projectPath?: string | null;
  threadId?: string | null;
  executor?: string | null;
  auditor?: string | null;
  acceptanceCriteria?: string;
  startAt?: string;
  endAt?: string | null;
  createConversation?: boolean;
  conversationModel?: string;
  conversationEffort?: string;
  conversationServiceTier?: string | null;
  conversationPermissionPreset?: ExecutionPermissionPreset;
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
  platform: string;
  bootstrap(): Promise<BootstrapData>;
  listThreads(): Promise<CodexThreadSummary[]>;
  readThread(threadId: string): Promise<CodexThreadDetail>;
  listModels(): Promise<CodexModelOption[]>;
  pickImages(): Promise<ComposerImage[]>;
  savePastedImage(input: { bytes: Uint8Array; mimeType: string }): Promise<ComposerImage>;
  sendToThread(input: { taskId: string; threadId: string; text: string; images?: Array<{ path: string }>; model?: string; effort?: string; serviceTier?: string | null; permissionPreset?: ExecutionPermissionPreset }): Promise<{ turn: Record<string, unknown>; snapshot: ExecutionSnapshot; task: Task; conversationRecovered?: boolean }>;
  steerTurn(input: { taskId: string; threadId: string; turnId: string; text: string; images?: Array<{ path: string }> }): Promise<{ result: { turnId: string }; snapshot: ExecutionSnapshot; task: Task }>;
  getExecution(taskId: string): Promise<ExecutionSnapshot | null>;
  respondToApproval(input: { taskId: string; requestId: RequestId; decision: ApprovalDecision }): Promise<ExecutionSnapshot>;
  respondToUserInput(input: { taskId: string; requestId: RequestId; answers: Record<string, { answers: string[] }> }): Promise<ExecutionSnapshot>;
  cancelUserInput(input: { taskId: string; requestId: RequestId }): Promise<ExecutionSnapshot>;
  onExecutionEvent(callback: (payload: { snapshot: ExecutionSnapshot; task: Task }) => void): () => void;
  openThreadInCodex(threadId: string): Promise<void>;
  handoffToCodex(input: { taskId: string; threadId: string }): Promise<{ task: Task; interrupted: boolean }>;
  updateConversation(threadId: string, input: { category?: string; tags?: string[]; note?: string }): Promise<CodexThreadSummary>;
  createTask(input: CreateTaskInput): Promise<Task>;
  bulkCreateTasks(): Promise<BulkTaskResult>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  archiveTask(id: string): Promise<Task>;
  restoreTask(id: string): Promise<Task>;
  listAuditEvents(taskId: string): Promise<AuditEvent[]>;
  reviewTask(id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note?: string; reviewerType?: 'independent' | 'user' | 'ai' }): Promise<Task>;
  aiReviewTask(id: string, input: { focus?: string }): Promise<{ task: Task; decision: 'accepted' | 'rework'; note: string; reviewThreadId: string }>;
  runDailyMaintenance(): Promise<{ created: number; stagedByLane: Record<Lane, number>; archived: number; archivedTaskIds: string[]; activeTasks: number; ranAt: string }>;
  archiveCompletedTasks(): Promise<{ archived: number; archivedTaskIds: string[]; activeTasks: number; ranAt: string }>;
}

declare global {
  interface Window {
    codexTaskboard: DesktopApi;
  }
}
