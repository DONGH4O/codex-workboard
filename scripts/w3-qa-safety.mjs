import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

export const W3_APPROVED_CODEX_CLI = 'C:\\Users\\dongh\\AppData\\Local\\OpenAI\\Codex\\bin\\b99306303521e97e\\codex.exe';
export const W3_APPROVED_CODEX_HOME = 'C:\\Users\\dongh\\.codex';
export const W3_WORKSPACE = 'F:\\Project\\workboard\\runtime\\w3-acceptance\\workspace';
export const W3_USER_DATA = 'F:\\Project\\workboard\\runtime\\w3-acceptance\\workboard-user-data';

export const W3_SCENARIOS = Object.freeze([
  'basic-create',
  'list-sync',
  'read-existing',
  'steer',
  'interrupt',
  'approval-decline',
  'approval-once',
  'approval-session',
  'user-input-answer',
  'user-input-cancel',
  'user-input-timeout',
  'unknown-request',
]);

const W3_SCENARIO_SET = new Set(W3_SCENARIOS);
const W3_PERMISSION_PRESETS = new Set(['untrusted', 'on-request']);
const W3_EVIDENCE_STAGES = new Set(['preflight', 'connected', 'thread-created', 'turn-started', 'completed', 'failed']);

function canonicalWindowsPath(value) {
  return path.win32.normalize(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}

function defaultRealpath(value) {
  return realpathSync.native(value);
}

function requireApprovedPath(label, actual, expected, runtime, kind) {
  if (typeof actual !== 'string' || !path.win32.isAbsolute(actual)) {
    throw new Error(`${label} 必须是已批准的绝对路径`);
  }
  if (!runtime.exists(actual)) throw new Error(`${label} 不存在`);
  const resolved = runtime.realpath(actual);
  if (canonicalWindowsPath(resolved) !== canonicalWindowsPath(expected)) {
    throw new Error(`${label} 与 W2 已批准实例不一致`);
  }
  if (kind && runtime.kind(resolved) !== kind) {
    throw new Error(`${label} 类型不正确`);
  }
  return resolved;
}

export function parseW3Scenario(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--scenario') {
      values.push(argv[index + 1] ?? '');
      index += 1;
    } else if (argument.startsWith('--scenario=')) {
      values.push(argument.slice('--scenario='.length));
    }
  }
  if (values.length !== 1 || !values[0]) throw new Error('W3 真实执行必须且只能指定一个 --scenario');
  if (!W3_SCENARIO_SET.has(values[0])) throw new Error(`不支持的 W3 场景：${values[0]}`);
  return values[0];
}

function isNonEmptyThreadId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidRequestId(value) {
  return isNonEmptyThreadId(value)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

export function validateW3ScenarioPrerequisites(scenario, prerequisites = {}) {
  if (!W3_SCENARIO_SET.has(scenario)) throw new Error(`不支持的 W3 场景：${scenario}`);
  const required = {
    'basic-create': [],
    'list-sync': [],
    'read-existing': ['existingThreadId'],
    steer: ['threadId'],
    interrupt: ['threadId'],
    'approval-decline': ['threadId'],
    'approval-once': ['threadId'],
    'approval-session': ['threadId'],
    'user-input-answer': ['threadId'],
    'user-input-cancel': ['threadId'],
    'user-input-timeout': ['threadId'],
    'unknown-request': ['threadId'],
  }[scenario];
  const missing = required.filter((key) => !isNonEmptyThreadId(prerequisites[key]));
  if (missing.length) throw new Error(`W3 场景缺少先决条件：${missing.join(', ')}`);
  return scenario;
}

export function bindW3TurnStart(threadId, response) {
  const turnId = response?.turn?.id;
  if (!isNonEmptyThreadId(threadId) || !isNonEmptyThreadId(turnId)) {
    throw new Error('W3 目标回合未返回可绑定标识');
  }
  return { threadId, turnId };
}

export function isW3BoundTurnEvent(event, binding) {
  const params = event?.params ?? {};
  const eventTurnId = typeof params.turnId === 'string'
    ? params.turnId
    : params.turn && typeof params.turn === 'object' && typeof params.turn.id === 'string'
      ? params.turn.id
      : '';
  return params.threadId === binding.threadId && eventTurnId === binding.turnId;
}

export function bindW3ServerRequest(event, binding, allowedMethods) {
  if (!isW3BoundTurnEvent(event, binding)) throw new Error('W3 服务端请求不属于目标回合');
  if (!isValidRequestId(event.requestId)) throw new Error('W3 服务端请求缺少有效 requestId');
  if (!Array.isArray(allowedMethods) || !allowedMethods.includes(event.method)) {
    throw new Error('W3 服务端请求方法与目标场景不一致');
  }
  return { threadId: binding.threadId, turnId: binding.turnId, requestId: event.requestId, method: event.method };
}

export function dispatchW3Scenario(scenario, handlers) {
  if (!W3_SCENARIO_SET.has(scenario)) throw new Error(`不支持的 W3 场景：${scenario}`);
  const handler = handlers?.[scenario];
  if (typeof handler !== 'function') throw new Error(`W3 场景处理器缺失：${scenario}`);
  return handler();
}

export function validateW3ExecutionGate(input, dependencies = {}) {
  const argv = input.argv ?? [];
  const env = input.env ?? {};
  const runtime = {
    exists: dependencies.exists ?? existsSync,
    realpath: dependencies.realpath ?? defaultRealpath,
    kind: dependencies.kind ?? ((value) => {
      const stats = statSync(value);
      return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
    }),
  };
  if (!argv.includes('--execute-real') || env.WORKBOARD_W3_REAL_INTERACTION !== '1') {
    throw new Error('W3 真实交互未获双重执行门授权');
  }
  const scenario = parseW3Scenario(argv);
  if (env.WORKBOARD_W3_ALLOWED_SCENARIO !== scenario) {
    throw new Error('W3 场景与本次授权不一致');
  }
  validateW3ScenarioPrerequisites(scenario, input.prerequisites);
  if (env.WORKBOARD_SKIP_LEGACY_MIGRATION !== '1') {
    throw new Error('必须设置 WORKBOARD_SKIP_LEGACY_MIGRATION=1');
  }
  const workspace = requireApprovedPath('WORKBOARD_W3_WORKSPACE', env.WORKBOARD_W3_WORKSPACE, W3_WORKSPACE, runtime, 'directory');
  const userData = requireApprovedPath('WORKBOARD_USER_DATA_DIR', env.WORKBOARD_USER_DATA_DIR, W3_USER_DATA, runtime, 'directory');
  const codexCliPath = requireApprovedPath('CODEX_CLI_PATH', env.CODEX_CLI_PATH, W3_APPROVED_CODEX_CLI, runtime, 'file');
  const codexHome = requireApprovedPath('CODEX_HOME', env.CODEX_HOME, W3_APPROVED_CODEX_HOME, runtime, 'directory');
  return { scenario, workspace, userData, codexCliPath, codexHome };
}

export function validateW3PermissionPreset(permissionPreset) {
  if (!W3_PERMISSION_PRESETS.has(permissionPreset)) {
    throw new Error('W3 只允许 untrusted 或 on-request 普通权限');
  }
  return permissionPreset;
}

export function summarizeW3TurnParams(params, expectedWorkspace) {
  validateW3PermissionPreset(params.approvalPolicy);
  if (params.sandboxPolicy?.type !== 'workspaceWrite') throw new Error('W3 必须使用 workspaceWrite 沙箱');
  const writableRoots = params.sandboxPolicy.writableRoots;
  if (!Array.isArray(writableRoots) || writableRoots.length !== 1 || canonicalWindowsPath(writableRoots[0]) !== canonicalWindowsPath(expectedWorkspace)) {
    throw new Error('W3 唯一显式 writableRoot 必须是隔离项目目录');
  }
  if (canonicalWindowsPath(params.cwd ?? '') !== canonicalWindowsPath(expectedWorkspace)) {
    throw new Error('W3 cwd 必须是隔离项目目录');
  }
  if (typeof params.sandboxPolicy.networkAccess !== 'boolean'
    || typeof params.sandboxPolicy.excludeTmpdirEnvVar !== 'boolean'
    || typeof params.sandboxPolicy.excludeSlashTmp !== 'boolean') {
    throw new Error('W3 沙箱参数摘要不完整');
  }
  return {
    approvalPolicy: params.approvalPolicy,
    sandboxType: params.sandboxPolicy.type,
    networkAccess: params.sandboxPolicy.networkAccess,
    writableRoots: [...writableRoots],
    excludeTmpdirEnvVar: params.sandboxPolicy.excludeTmpdirEnvVar,
    excludeSlashTmp: params.sandboxPolicy.excludeSlashTmp,
    cwd: params.cwd,
  };
}

export function buildW3Evidence(input) {
  if (!W3_EVIDENCE_STAGES.has(input.stage)) throw new Error('W3 证据阶段无效');
  return {
    result: input.ok ? 'PASS' : 'FAIL',
    script: input.script,
    scenario: input.scenario,
    stage: input.stage,
    eventMethods: [...new Set(input.eventMethods ?? [])].filter((item) => typeof item === 'string').sort(),
    permission: input.permission ?? null,
    modelConfigured: Boolean(input.modelConfigured),
    effortConfigured: Boolean(input.effortConfigured),
    serviceTierConfigured: Boolean(input.serviceTierConfigured),
    createdQaThread: input.createdQaThread ? 'retained' : 'not-created',
    resumedAfterRestart: Boolean(input.resumedAfterRestart),
    listSyncCompleted: Boolean(input.listSyncCompleted),
    cleanupFailed: Boolean(input.cleanupFailed),
    errorKind: input.error ? (input.error instanceof Error ? input.error.name : 'Error') : null,
  };
}

export function w3ExecutionSummary(input) {
  const allowedScenario = W3_SCENARIO_SET.has(input.env?.WORKBOARD_W3_ALLOWED_SCENARIO)
    ? input.env.WORKBOARD_W3_ALLOWED_SCENARIO
    : null;
  return {
    authorization: 'required',
    executeFlag: input.argv?.includes('--execute-real') ?? false,
    environmentGate: input.env?.WORKBOARD_W3_REAL_INTERACTION === '1',
    requestedScenario: (() => {
      try { return parseW3Scenario(input.argv ?? []); } catch { return null; }
    })(),
    allowedScenario,
    realInteractionStarted: false,
  };
}
