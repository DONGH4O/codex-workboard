export type ExecutionStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type ExecutionPermissionPreset = 'untrusted' | 'on-request' | 'full-access';

export interface ExecutionPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface PendingApproval {
  requestId: number;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string;
  command: string;
  cwd: string;
  networkHost: string;
  availableDecisions: ApprovalDecision[];
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
  error: string;
}

export interface BridgeEvent {
  method: string;
  params: Record<string, unknown>;
  requestId?: number;
}

const MAX_MESSAGE = 60_000;
const MAX_OUTPUT = 80_000;
const MAX_DIFF = 160_000;

function tail(value: string, max: number): string {
  return value.length > max ? value.slice(-max) : value;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function eventTurnId(event: BridgeEvent): string {
  const turn = event.params.turn;
  return idFrom(event.params.turnId)
    || (turn && typeof turn === 'object' ? idFrom((turn as Record<string, unknown>).id) : '');
}

export function eventThreadId(event: BridgeEvent): string {
  return idFrom(event.params.threadId);
}

export function emptyExecutionSnapshot(input: {
  taskId: string;
  threadId: string;
  turnId?: string | null;
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  permissionPreset?: ExecutionPermissionPreset;
  now?: string;
}): ExecutionSnapshot {
  const now = input.now ?? new Date().toISOString();
  return {
    taskId: input.taskId,
    threadId: input.threadId,
    turnId: input.turnId ?? null,
    status: 'running',
    model: input.model ?? null,
    effort: input.effort ?? null,
    serviceTier: input.serviceTier ?? null,
    permissionPreset: input.permissionPreset ?? 'untrusted',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    plan: [],
    lastMessage: '',
    output: '',
    diff: '',
    currentItem: null,
    pendingApproval: null,
    error: '',
  };
}

export function reduceExecutionSnapshot(current: ExecutionSnapshot, event: BridgeEvent, now = new Date().toISOString()): ExecutionSnapshot {
  const next: ExecutionSnapshot = { ...current, updatedAt: now };
  const method = event.method;
  const params = event.params;
  const turnId = eventTurnId(event);
  if (turnId) next.turnId = turnId;

  if (method === 'turn/started') {
    next.status = 'running';
    next.startedAt = next.startedAt ?? now;
    next.completedAt = null;
    next.error = '';
  } else if (method === 'turn/plan/updated') {
    const plan = Array.isArray(params.plan) ? params.plan : [];
    next.plan = plan.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const step = text(item.step);
      const status = item.status === 'inProgress' || item.status === 'completed' ? item.status : 'pending';
      return step ? [{ step, status }] : [];
    });
  } else if (method === 'turn/diff/updated') {
    next.diff = tail(text(params.diff), MAX_DIFF);
  } else if (method === 'item/started' || method === 'item/completed') {
    if (params.item && typeof params.item === 'object') {
      const item = params.item as Record<string, unknown>;
      next.currentItem = item;
      if (item.type === 'agentMessage' && typeof item.text === 'string') next.lastMessage = tail(item.text, MAX_MESSAGE);
      if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') next.output = tail(item.aggregatedOutput, MAX_OUTPUT);
    }
  } else if (method === 'item/agentMessage/delta') {
    next.lastMessage = tail(next.lastMessage + text(params.delta), MAX_MESSAGE);
  } else if (method === 'item/commandExecution/outputDelta') {
    next.output = tail(next.output + text(params.delta), MAX_OUTPUT);
  } else if (method.endsWith('/requestApproval') && typeof event.requestId === 'number') {
    const context = params.networkApprovalContext && typeof params.networkApprovalContext === 'object'
      ? params.networkApprovalContext as Record<string, unknown>
      : null;
    const decisions: ApprovalDecision[] = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((value): value is ApprovalDecision => value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel')
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const rawCommand = params.command;
    next.status = 'waiting_approval';
    next.pendingApproval = {
      requestId: event.requestId,
      method,
      threadId: idFrom(params.threadId) || next.threadId,
      turnId: idFrom(params.turnId) || next.turnId || '',
      itemId: idFrom(params.itemId),
      reason: text(params.reason),
      command: Array.isArray(rawCommand) ? rawCommand.map(String).join(' ') : text(rawCommand),
      cwd: text(params.cwd),
      networkHost: context ? text(context.host) : '',
      availableDecisions: decisions,
    };
  } else if (method === 'serverRequest/resolved') {
    const requestId = typeof params.requestId === 'number' ? params.requestId : null;
    if (!requestId || next.pendingApproval?.requestId === requestId) next.pendingApproval = null;
    if (next.status === 'waiting_approval') next.status = 'running';
  } else if (method === 'error') {
    const error = params.error && typeof params.error === 'object' ? params.error as Record<string, unknown> : null;
    next.error = text(error?.message) || text(params.message) || 'Codex 执行失败';
  } else if (method === 'turn/completed') {
    const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
    const status = text(turn.status);
    next.status = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
    next.completedAt = now;
    next.pendingApproval = null;
    if (turn.error && typeof turn.error === 'object') next.error = text((turn.error as Record<string, unknown>).message);
  }
  return next;
}
