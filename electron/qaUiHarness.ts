import path from 'node:path';
import type { CodexBridgeEvent } from './codexBridge.js';

const ALLOWED_EVENT_METHODS = new Set([
  'turn/started',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/requestApproval',
  'item/tool/requestUserInput',
  'serverRequest/resolved',
  'workboard/serverRequestClosed',
  'workboard/serverRequestResponseSubmitted',
  'workboard/serverRequestUnsupported',
  'turn/completed',
]);

const DEMO_THREADS = new Set(['demo-live-thread', 'demo-steer-thread']);
const WINDOW_MATRIX = new Set(['1050x680@0.8', '1280x800@1', '1540x940@1.25']);

export interface QaUiHarnessContext {
  env: NodeJS.ProcessEnv;
  userData: string;
  isPackaged: boolean;
}

export interface QaWindowProfile {
  width: number;
  height: number;
  zoomFactor: number;
}

export function isQaUiHarnessEnabled(context: QaUiHarnessContext): boolean {
  if (!context.isPackaged || context.env.WORKBOARD_QA_UI_HARNESS !== '1') return false;
  if (context.env.WORKBOARD_SKIP_CODEX_SYNC !== '1' || context.env.WORKBOARD_SKIP_LEGACY_MIGRATION !== '1') return false;
  if (context.env.WORKBOARD_SEED_DEMO !== '1' && context.env.TASKBOARD_SEED_DEMO !== '1') return false;
  if (!path.isAbsolute(context.userData)) return false;
  return path.basename(path.dirname(path.resolve(context.userData))).startsWith('governed-ui-');
}

export function validateQaBridgeEvent(value: unknown): CodexBridgeEvent {
  if (!value || typeof value !== 'object') throw new Error('QA 事件必须是对象');
  const event = value as Partial<CodexBridgeEvent>;
  if (typeof event.method !== 'string' || !ALLOWED_EVENT_METHODS.has(event.method)) throw new Error('QA 事件方法不受允许');
  if (!event.params || typeof event.params !== 'object' || Array.isArray(event.params)) throw new Error('QA 事件参数无效');
  const threadId = typeof event.params.threadId === 'string' ? event.params.threadId : '';
  if (threadId && !DEMO_THREADS.has(threadId)) throw new Error('QA 事件只能作用于演示会话');
  if (event.requestId !== undefined && typeof event.requestId !== 'string' && typeof event.requestId !== 'number') throw new Error('QA 请求标识无效');
  return { method: event.method, params: event.params, ...(event.requestId === undefined ? {} : { requestId: event.requestId }) };
}

export function validateQaWindowProfile(value: unknown): QaWindowProfile {
  if (!value || typeof value !== 'object') throw new Error('QA 窗口配置必须是对象');
  const profile = value as Partial<QaWindowProfile>;
  const key = `${profile.width}x${profile.height}@${profile.zoomFactor}`;
  if (!WINDOW_MATRIX.has(key)) throw new Error('QA 窗口配置不在批准矩阵中');
  return { width: profile.width!, height: profile.height!, zoomFactor: profile.zoomFactor! };
}
