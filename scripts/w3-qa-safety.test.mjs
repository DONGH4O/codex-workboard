import { describe, expect, it } from 'vitest';
import {
  W3_APPROVED_CODEX_CLI,
  W3_APPROVED_CODEX_HOME,
  W3_USER_DATA,
  W3_WORKSPACE,
  bindW3ServerRequest,
  bindW3TurnStart,
  buildW3Evidence,
  dispatchW3Scenario,
  isW3BoundTurnEvent,
  parseW3Scenario,
  summarizeW3TurnParams,
  validateW3ExecutionGate,
  validateW3PermissionPreset,
  validateW3ScenarioPrerequisites,
} from './w3-qa-safety.mjs';

const approvedEnv = {
  WORKBOARD_W3_REAL_INTERACTION: '1',
  WORKBOARD_W3_ALLOWED_SCENARIO: 'basic-create',
  WORKBOARD_W3_WORKSPACE: W3_WORKSPACE,
  WORKBOARD_USER_DATA_DIR: W3_USER_DATA,
  WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
  CODEX_CLI_PATH: W3_APPROVED_CODEX_CLI,
  CODEX_HOME: W3_APPROVED_CODEX_HOME,
};
const approvedArgv = ['--execute-real', '--scenario', 'basic-create'];
const approvedRuntime = {
  exists: () => true,
  realpath: (value) => value,
  kind: (value) => value.toLowerCase().endsWith('.exe') ? 'file' : 'directory',
};

describe('W3 real execution safety gate', () => {
  it('rejects missing or partial double gates before path resolution', () => {
    let pathChecks = 0;
    const runtime = { ...approvedRuntime, exists: () => { pathChecks += 1; return true; } };
    expect(() => validateW3ExecutionGate({ argv: [], env: {} }, runtime)).toThrow('双重执行门');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_W3_REAL_INTERACTION: '0' } }, runtime)).toThrow('双重执行门');
    expect(pathChecks).toBe(0);
  });

  it('requires exactly one known scenario and a matching scenario gate', () => {
    expect(() => parseW3Scenario([])).toThrow('只能指定一个');
    expect(() => parseW3Scenario(['--scenario', 'basic-create', '--scenario=steer'])).toThrow('只能指定一个');
    expect(() => parseW3Scenario(['--scenario=not-real'])).toThrow('不支持');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_W3_ALLOWED_SCENARIO: 'steer' } }, approvedRuntime)).toThrow('场景与本次授权不一致');
  });

  it('requires each scenario-specific identifier before path or driver checks', () => {
    const cases = {
      'basic-create': {},
      'list-sync': {},
      'read-existing': { existingThreadId: 'thread-existing' },
      steer: { threadId: 'thread-1' },
      interrupt: { threadId: 'thread-1' },
      'approval-decline': { threadId: 'thread-1' },
      'approval-once': { threadId: 'thread-1' },
      'approval-session': { threadId: 'thread-1' },
      'user-input-answer': { threadId: 'thread-1' },
      'user-input-cancel': { threadId: 'thread-1' },
      'user-input-timeout': { threadId: 'thread-1' },
      'unknown-request': { threadId: 'thread-1' },
    };
    for (const [scenario, prerequisites] of Object.entries(cases)) {
      expect(validateW3ScenarioPrerequisites(scenario, prerequisites)).toBe(scenario);
      if (!['basic-create', 'list-sync'].includes(scenario)) expect(() => validateW3ScenarioPrerequisites(scenario, {})).toThrow('缺少先决条件');
    }
  });

  it('binds dynamic turn and server-request ids only after the target turn starts', () => {
    const binding = bindW3TurnStart('thread-1', { turn: { id: 'turn-target' } });
    const target = { method: 'item/tool/requestUserInput', requestId: 0, params: { threadId: 'thread-1', turnId: 'turn-target' } };
    const wrongTurn = { ...target, params: { ...target.params, turnId: 'turn-other' } };
    const wrongThread = { ...target, params: { ...target.params, threadId: 'thread-other' } };
    expect(isW3BoundTurnEvent(target, binding)).toBe(true);
    expect(isW3BoundTurnEvent(wrongTurn, binding)).toBe(false);
    expect(isW3BoundTurnEvent(wrongThread, binding)).toBe(false);
    expect(bindW3ServerRequest(target, binding, ['item/tool/requestUserInput'])).toEqual({
      threadId: 'thread-1', turnId: 'turn-target', requestId: 0, method: 'item/tool/requestUserInput',
    });
    expect(() => bindW3ServerRequest(wrongTurn, binding, ['item/tool/requestUserInput'])).toThrow('不属于目标回合');
    expect(() => bindW3ServerRequest(wrongThread, binding, ['item/tool/requestUserInput'])).toThrow('不属于目标回合');
    expect(() => bindW3ServerRequest({ ...target, method: 'item/commandExecution/requestApproval' }, binding, ['item/tool/requestUserInput'])).toThrow('方法与目标场景不一致');
    expect(() => bindW3ServerRequest({ ...target, requestId: -1 }, binding, ['item/tool/requestUserInput'])).toThrow('有效 requestId');
  });

  it('rejects missing dynamic turn ids instead of accepting a fabricated precondition', () => {
    expect(() => bindW3TurnStart('thread-1', { turn: {} })).toThrow('目标回合');
    expect(() => bindW3TurnStart('', { turn: { id: 'turn-1' } })).toThrow('目标回合');
    expect(() => bindW3TurnStart('   ', { turn: { id: 'turn-1' } })).toThrow('目标回合');
    expect(() => bindW3TurnStart(123, { turn: { id: 'turn-1' } })).toThrow('目标回合');
    expect(() => validateW3ScenarioPrerequisites('read-existing', { existingThreadId: 123 })).toThrow('缺少先决条件');
    expect(() => validateW3ScenarioPrerequisites('steer', { threadId: '   ' })).toThrow('缺少先决条件');
  });

  it('dispatches exactly one selected scenario handler for every allowed scenario', () => {
    const scenarios = [
      'basic-create', 'list-sync', 'read-existing', 'steer', 'interrupt', 'approval-decline', 'approval-once',
      'approval-session', 'user-input-answer', 'user-input-cancel', 'user-input-timeout', 'unknown-request',
    ];
    for (const selected of scenarios) {
      const calls = Object.fromEntries(scenarios.map((scenario) => [scenario, 0]));
      const handlers = Object.fromEntries(scenarios.map((scenario) => [scenario, () => { calls[scenario] += 1; return scenario; }]));
      expect(dispatchW3Scenario(selected, handlers)).toBe(selected);
      expect(calls[selected]).toBe(1);
      expect(Object.entries(calls).filter(([scenario]) => scenario !== selected).every(([, count]) => count === 0)).toBe(true);
    }
  });

  it('rejects relative, unexpected, or wrong-kind paths', () => {
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_W3_WORKSPACE: '.\\workspace' } }, approvedRuntime)).toThrow('绝对路径');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_W3_WORKSPACE: 'F:\\Project\\workboard\\source' } }, approvedRuntime)).toThrow('W2 已批准实例');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_USER_DATA_DIR: 'F:\\Project\\workboard\\runtime\\other-data' } }, approvedRuntime)).toThrow('W2 已批准实例');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, CODEX_CLI_PATH: '.\\codex.exe' } }, approvedRuntime)).toThrow('绝对路径');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, CODEX_HOME: '.\\.codex' } }, approvedRuntime)).toThrow('绝对路径');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, CODEX_CLI_PATH: W3_APPROVED_CODEX_HOME } }, approvedRuntime)).toThrow('W2 已批准实例');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: approvedEnv }, { ...approvedRuntime, kind: () => 'directory' })).toThrow('类型不正确');
  });

  it.each([
    ['WORKBOARD_W3_WORKSPACE', W3_WORKSPACE],
    ['WORKBOARD_USER_DATA_DIR', W3_USER_DATA],
    ['CODEX_HOME', W3_APPROVED_CODEX_HOME],
  ])('rejects %s when the approved path is a file', (key, target) => {
    const kind = (value) => value === target ? 'file' : value.toLowerCase().endsWith('.exe') ? 'file' : 'directory';
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: approvedEnv }, { ...approvedRuntime, kind })).toThrow('类型不正确');
  });

  it('rejects the approved CLI path when it is a directory', () => {
    const kind = (value) => value === W3_APPROVED_CODEX_CLI ? 'directory' : 'directory';
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: approvedEnv }, { ...approvedRuntime, kind })).toThrow('类型不正确');
  });

  it('binds both the driver and Codex home to the W2-approved instances', () => {
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, CODEX_CLI_PATH: 'C:\\Other\\codex.exe' } }, approvedRuntime)).toThrow('W2 已批准实例');
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, CODEX_HOME: 'C:\\Other\\.codex' } }, approvedRuntime)).toThrow('W2 已批准实例');
    expect(validateW3ExecutionGate({ argv: approvedArgv, env: approvedEnv }, approvedRuntime)).toMatchObject({ scenario: 'basic-create', workspace: W3_WORKSPACE });
  });

  it('requires legacy migration isolation', () => {
    expect(() => validateW3ExecutionGate({ argv: approvedArgv, env: { ...approvedEnv, WORKBOARD_SKIP_LEGACY_MIGRATION: '0' } }, approvedRuntime)).toThrow('WORKBOARD_SKIP_LEGACY_MIGRATION=1');
  });
});

describe('W3 permission and evidence boundary', () => {
  const ordinaryParams = (approvalPolicy) => ({
    approvalPolicy,
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [W3_WORKSPACE],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    cwd: W3_WORKSPACE,
  });

  it('allows only the two ordinary approval policies', () => {
    expect(validateW3PermissionPreset('untrusted')).toBe('untrusted');
    expect(validateW3PermissionPreset('on-request')).toBe('on-request');
    expect(() => validateW3PermissionPreset('full-access')).toThrow('只允许');
    expect(() => validateW3PermissionPreset('never')).toThrow('只允许');
  });

  it.each(['untrusted', 'on-request'])('reports every real sandbox field for %s', (policy) => {
    expect(summarizeW3TurnParams(ordinaryParams(policy), W3_WORKSPACE)).toEqual({
      approvalPolicy: policy,
      sandboxType: 'workspaceWrite',
      networkAccess: true,
      writableRoots: [W3_WORKSPACE],
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
      cwd: W3_WORKSPACE,
    });
  });

  it('rejects dangerous, incomplete, or non-isolated sandbox params', () => {
    expect(() => summarizeW3TurnParams({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, cwd: W3_WORKSPACE }, W3_WORKSPACE)).toThrow();
    expect(() => summarizeW3TurnParams({ ...ordinaryParams('untrusted'), sandboxPolicy: { ...ordinaryParams('untrusted').sandboxPolicy, writableRoots: ['F:\\Other'] } }, W3_WORKSPACE)).toThrow('writableRoot');
    const incomplete = ordinaryParams('untrusted');
    delete incomplete.sandboxPolicy.excludeSlashTmp;
    expect(() => summarizeW3TurnParams(incomplete, W3_WORKSPACE)).toThrow('参数摘要不完整');
  });

  it('produces allowlisted evidence without identifiers, text, paths, or error messages', () => {
    const evidence = buildW3Evidence({
      ok: false,
      script: 'qa-create-thread',
      scenario: 'basic-create',
      stage: 'failed',
      eventMethods: ['turn/completed', 'turn/started', 'turn/completed'],
      permission: summarizeW3TurnParams(ordinaryParams('untrusted'), W3_WORKSPACE),
      createdQaThread: true,
      listSyncCompleted: true,
      error: new Error('thread-123 C:\\Users\\dongh secret reply'),
      threadId: 'thread-123',
      message: 'secret reply',
    });
    const serialized = JSON.stringify(evidence);
    expect(evidence.createdQaThread).toBe('retained');
    expect(evidence.listSyncCompleted).toBe(true);
    expect(evidence.eventMethods).toEqual(['turn/completed', 'turn/started']);
    expect(serialized).not.toContain('thread-123');
    expect(serialized).not.toContain('secret reply');
    expect(serialized).not.toContain('C:\\Users\\dongh');
  });

  it('rejects an unknown evidence stage and suppresses an unknown allowed scenario', async () => {
    expect(() => buildW3Evidence({ ok: false, script: 'qa', scenario: 'basic-create', stage: 'other' })).toThrow('证据阶段无效');
    const { w3ExecutionSummary } = await import('./w3-qa-safety.mjs');
    expect(w3ExecutionSummary({ argv: ['--scenario=not-real'], env: { WORKBOARD_W3_ALLOWED_SCENARIO: 'arbitrary-secret' } }).allowedScenario).toBeNull();
  });
});
