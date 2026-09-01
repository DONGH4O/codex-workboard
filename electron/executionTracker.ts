export type RequestId = string | number;
export type ExecutionStatus = 'idle' | 'running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'failed' | 'interrupted';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type ExecutionPermissionPreset = 'untrusted' | 'on-request' | 'full-access';

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

export interface BridgeEvent {
  method: string;
  params: Record<string, unknown>;
  requestId?: RequestId;
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
    pendingUserInput: null,
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
  } else if ((method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' || method === 'execCommandApproval') && (typeof event.requestId === 'number' || typeof event.requestId === 'string')) {
    const context = params.networkApprovalContext && typeof params.networkApprovalContext === 'object'
      ? params.networkApprovalContext as Record<string, unknown>
      : null;
    const rawDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
    const decisions: ApprovalDecision[] = rawDecisions
      ? rawDecisions.filter((value): value is ApprovalDecision => value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel')
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
      networkProtocol: context ? text(context.protocol) : '',
      availableDecisions: decisions,
      unsupportedDecisionCount: rawDecisions ? rawDecisions.length - decisions.length : 0,
      unsupportedDecisions: rawDecisions
        ? rawDecisions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
        : [],
      responseSubmitted: false,
    };
  } else if (method === 'item/tool/requestUserInput' && (typeof event.requestId === 'number' || typeof event.requestId === 'string')) {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (params.isBlocking !== false) next.status = 'waiting_input';
    next.pendingUserInput = {
      requestId: event.requestId,
      threadId: idFrom(params.threadId) || next.threadId,
      turnId: idFrom(params.turnId) || next.turnId || '',
      itemId: idFrom(params.itemId),
      isBlocking: params.isBlocking !== false,
      questions: questions.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const question = raw as Record<string, unknown>;
        const id = idFrom(question.id);
        if (!id) return [];
        const options = Array.isArray(question.options) ? question.options : [];
        return [{
          id,
          header: text(question.header),
          question: text(question.question),
          isOther: question.isOther === true,
          isSecret: question.isSecret === true,
          options: options.flatMap((rawOption) => {
            if (!rawOption || typeof rawOption !== 'object') return [];
            const option = rawOption as Record<string, unknown>;
            const label = text(option.label);
            return label ? [{ label, description: text(option.description) }] : [];
          }),
        }];
      }),
    };
  } else if (method === 'serverRequest/resolved' || method === 'workboard/serverRequestClosed') {
    const requestId = typeof params.requestId === 'number' || typeof params.requestId === 'string' ? params.requestId : null;
    const resolvesApproval = requestId === null || next.pendingApproval?.requestId === requestId;
    const resolvesUserInput = requestId === null || next.pendingUserInput?.requestId === requestId;
    if (resolvesApproval) next.pendingApproval = null;
    if (resolvesUserInput) next.pendingUserInput = null;
    if (next.status === 'waiting_approval' && resolvesApproval) next.status = 'running';
    if (next.status === 'waiting_input' && resolvesUserInput) next.status = 'running';
  } else if (method === 'workboard/serverRequestResponseSubmitted') {
    const requestId = typeof params.requestId === 'number' || typeof params.requestId === 'string' ? params.requestId : null;
    if (requestId !== null && next.pendingApproval?.requestId === requestId) {
      next.pendingApproval = { ...next.pendingApproval, responseSubmitted: true };
    }
  } else if (method === 'workboard/serverRequestUnsupported') {
    next.error = `不支持的 Codex 服务端请求：${text(params.method) || 'unknown'}`;
  } else if (method === 'error') {
    const error = params.error && typeof params.error === 'object' ? params.error as Record<string, unknown> : null;
    next.error = text(error?.message) || text(params.message) || 'Codex 执行失败';
  } else if (method === 'turn/completed') {
    const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
    const status = text(turn.status);
    next.status = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
    next.completedAt = now;
    next.pendingApproval = null;
    next.pendingUserInput = null;
    if (turn.error && typeof turn.error === 'object') next.error = text((turn.error as Record<string, unknown>).message);
  }
  return next;
}
