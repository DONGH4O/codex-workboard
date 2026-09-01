import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  W3_APPROVED_CODEX_CLI,
  W3_APPROVED_CODEX_HOME,
  W3_USER_DATA,
  W3_WORKSPACE,
} from './w3-qa-safety.mjs';
import { createLiveScenarioHandlers, createW3EventQueue, main } from './qa-live-appserver.mjs';

const baseEnv = {
  WORKBOARD_W3_REAL_INTERACTION: '1',
  WORKBOARD_W3_WORKSPACE: W3_WORKSPACE,
  WORKBOARD_USER_DATA_DIR: W3_USER_DATA,
  WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
  CODEX_CLI_PATH: W3_APPROVED_CODEX_CLI,
  CODEX_HOME: W3_APPROVED_CODEX_HOME,
  WORKBOARD_W3_QA_THREAD_ID: 'thread-qa',
  WORKBOARD_W3_EXISTING_THREAD_ID: 'thread-existing',
};
const safetyRuntime = {
  exists: () => true,
  realpath: (value) => value,
  kind: (value) => value.toLowerCase().endsWith('.exe') ? 'file' : 'directory',
};
const buildTurnStartParams = (input) => ({
  approvalPolicy: input.permissionPreset,
  sandboxPolicy: {
    type: 'workspaceWrite', writableRoots: [input.cwd], networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  },
  cwd: input.cwd,
});
const model = { id: 'model-test', isDefault: true, defaultReasoningEffort: 'low', serviceTiers: [] };

function invocation(scenario) {
  return {
    argv: ['--execute-real', `--scenario=${scenario}`],
    env: { ...baseEnv, WORKBOARD_W3_ALLOWED_SCENARIO: scenario },
  };
}

function fakeBridge(overrides = {}) {
  let listener = () => {};
  const unsubscribe = vi.fn();
  return {
    bridge: {
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      listModels: vi.fn(async () => [model]),
      status: vi.fn(() => ({ platformFamily: 'windows', platformOs: 'windows' })),
      stop: vi.fn(async () => {}),
      ...overrides,
    },
    emit: (event) => listener(event),
    unsubscribe,
  };
}

function productionHandlers(fake, overrides = {}) {
  const queue = createW3EventQueue(fake.bridge, overrides.queueTimeoutMs ?? 80);
  const handlers = createLiveScenarioHandlers({
    bridge: fake.bridge,
    queue,
    threadId: 'thread-qa',
    model,
    serviceTier: null,
    permissionPreset: 'untrusted',
    workspace: W3_WORKSPACE,
    fallbackUserInputTimeoutMs: overrides.fallbackUserInputTimeoutMs ?? 5,
    timeoutMarginMs: overrides.timeoutMarginMs ?? 20,
  });
  return { queue, handlers };
}

describe('qa-live-appserver isolated safety', () => {
  it('refuses before bridge creation when real gates are absent', async () => {
    const createBridge = vi.fn();
    const output = vi.fn();
    await expect(main({ argv: [], env: {}, createBridge, output })).rejects.toThrow('双重执行门');
    expect(createBridge).not.toHaveBeenCalled();
    expect(output.mock.calls[0][0]).toMatchObject({ result: 'REFUSED', realInteractionStarted: false });
  });

  it('reads the explicitly selected existing thread without turn mutation', async () => {
    const fake = fakeBridge({ readThread: vi.fn(async () => ({ id: 'thread-existing', turns: [{ text: 'private' }] })) });
    const output = vi.fn();
    const evidence = await main({ ...invocation('read-existing'), safetyRuntime, createBridge: () => fake.bridge, buildTurnStartParams, output, terminal: vi.fn() });
    expect(evidence.result).toBe('PASS');
    expect(fake.bridge.readThread).toHaveBeenCalledWith('thread-existing');
    expect(fake.bridge.listModels).not.toHaveBeenCalled();
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.mock.calls.at(-1)[0])).not.toContain('private');
  });

  it('lists current and archived conversations without models, turns, identifiers, or permission mutation', async () => {
    const fake = fakeBridge({
      listThreads: vi.fn(async () => [
        { id: 'active-private', archived: false },
        { id: 'archived-private', archived: true },
      ]),
      readThread: vi.fn(),
      sendToThread: vi.fn(),
    });
    const output = vi.fn();
    const terminal = vi.fn();
    const evidence = await main({
      ...invocation('list-sync'), safetyRuntime, createBridge: () => fake.bridge,
      buildTurnStartParams, output, terminal,
    });
    expect(evidence).toMatchObject({ result: 'PASS', listSyncCompleted: true, permission: null, platformFamily: 'windows', platformOs: 'windows' });
    expect(fake.bridge.status).toHaveBeenCalledTimes(1);
    expect(fake.bridge.listThreads).toHaveBeenCalledTimes(1);
    expect(fake.bridge.listModels).not.toHaveBeenCalled();
    expect(fake.bridge.readThread).not.toHaveBeenCalled();
    expect(fake.bridge.sendToThread).not.toHaveBeenCalled();
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('没有修改任何会话'));
    const machineEvidence = JSON.stringify(output.mock.calls.at(-1)[0]);
    expect(machineEvidence).not.toContain('active-private');
    expect(machineEvidence).not.toContain('archived-private');
  });

  it('fails list-sync when the bridge does not preserve current/archive provenance', async () => {
    const fake = fakeBridge({ listThreads: vi.fn(async () => [{ id: 'private-without-origin' }]) });
    const output = vi.fn();
    await expect(main({
      ...invocation('list-sync'), safetyRuntime, createBridge: () => fake.bridge,
      buildTurnStartParams, output, terminal: vi.fn(),
    })).rejects.toThrow('缺少当前或归档来源标记');
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', listSyncCompleted: false });
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ platformFamily: 'windows', platformOs: 'windows' });
    expect(JSON.stringify(output.mock.calls.at(-1)[0])).not.toContain('private-without-origin');
  });

  it('does not replace a successful read-only result when platform status collection throws', async () => {
    const fake = fakeBridge({
      listThreads: vi.fn(async () => []),
      status: vi.fn(() => { throw new Error('status unavailable'); }),
    });
    const output = vi.fn();
    const evidence = await main({
      ...invocation('list-sync'), safetyRuntime, createBridge: () => fake.bridge,
      buildTurnStartParams, output, terminal: vi.fn(),
    });
    expect(evidence).toMatchObject({ result: 'PASS', listSyncCompleted: true, platformFamily: null, platformOs: null });
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('dispatches exactly the selected authorized handler and prints permission before bridge creation', async () => {
    const scenarios = ['steer', 'interrupt', 'approval-decline', 'approval-once', 'approval-session', 'user-input-answer', 'user-input-cancel', 'user-input-timeout'];
    for (const scenario of scenarios) {
      const calls = Object.fromEntries(scenarios.map((name) => [name, 0]));
      const handlers = Object.fromEntries(scenarios.map((name) => [name, vi.fn(async () => { calls[name] += 1; })]));
      const fake = fakeBridge();
      const createBridge = vi.fn(() => fake.bridge);
      const output = vi.fn();
      const evidence = await main({ ...invocation(scenario), safetyRuntime, createBridge, buildTurnStartParams, scenarioHandlers: handlers, output, terminal: vi.fn() });
      expect(evidence.result).toBe('PASS');
      expect(calls[scenario]).toBe(1);
      expect(Object.entries(calls).filter(([name]) => name !== scenario).every(([, count]) => count === 0)).toBe(true);
      expect(output.mock.invocationCallOrder[0]).toBeLessThan(createBridge.mock.invocationCallOrder[0]);
      expect(output.mock.calls[0][0].permission.sandboxType).toBe('workspaceWrite');
      expect(output.mock.calls[0][0].permission.approvalPolicy).toBe('untrusted');
      expect(output.mock.calls.at(-1)[0].serviceTierConfigured).toBe(false);
    }
  });

  it('binds a fast approval request to the target turn and submits only the chosen decision', async () => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => {
      fake.emit({ method: 'item/commandExecution/requestApproval', requestId: 0, params: { threadId: 'thread-qa', turnId: 'turn-target' } });
      return { turn: { id: 'turn-target' } };
    });
    fake.bridge.respondToApproval = vi.fn(() => {
      fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-target', status: 'completed' } } });
    });
    const queue = createW3EventQueue(fake.bridge, 50);
    const handlers = createLiveScenarioHandlers({ bridge: fake.bridge, queue, threadId: 'thread-qa', model, serviceTier: null, permissionPreset: 'on-request', workspace: W3_WORKSPACE });
    await handlers['approval-decline']();
    expect(fake.bridge.respondToApproval).toHaveBeenCalledWith(0, 'decline');
    queue.close();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('runs the production steer handler against only the target turn', async () => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => ({ turn: { id: 'turn-steer' } }));
    fake.bridge.steerTurn = vi.fn(async (input) => {
      fake.emit({ method: 'turn/completed', params: { threadId: 'thread-other', turn: { id: 'turn-steer', status: 'completed' } } });
      fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-steer', status: 'completed' } } });
      return { turnId: input.turnId };
    });
    const { queue, handlers } = productionHandlers(fake);
    await handlers.steer();
    expect(fake.bridge.steerTurn).toHaveBeenCalledWith({ threadId: 'thread-qa', turnId: 'turn-steer', text: expect.stringContaining('STEER_FLOW_OK') });
    queue.close();
  });

  it('runs the production interrupt handler and requires interrupted status', async () => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => ({ turn: { id: 'turn-interrupt' } }));
    fake.bridge.interruptTurn = vi.fn(async (threadId, turnId) => {
      fake.emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
    });
    const { queue, handlers } = productionHandlers(fake);
    await handlers.interrupt();
    expect(fake.bridge.interruptTurn).toHaveBeenCalledWith('thread-qa', 'turn-interrupt');
    queue.close();
  });

  it.each([
    ['approval-decline', 'decline'],
    ['approval-once', 'accept'],
    ['approval-session', 'acceptForSession'],
  ])('submits %s decision before the production approval handler can complete', async (scenario, decision) => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => {
      fake.emit({ method: 'item/commandExecution/requestApproval', requestId: 'request-other', params: { threadId: 'thread-qa', turnId: 'turn-other' } });
      fake.emit({ method: 'item/commandExecution/requestApproval', requestId: 'request-target', params: { threadId: 'thread-qa', turnId: 'turn-approval' } });
      return { turn: { id: 'turn-approval' } };
    });
    fake.bridge.respondToApproval = vi.fn((requestId, actualDecision) => {
      expect(requestId).toBe('request-target');
      expect(actualDecision).toBe(decision);
      fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-approval', status: 'completed' } } });
    });
    const { queue, handlers } = productionHandlers(fake);
    await handlers[scenario]();
    expect(fake.bridge.respondToApproval).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('rejects approval completion with a non-completed target status', async () => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => {
      fake.emit({ method: 'item/commandExecution/requestApproval', requestId: 1, params: { threadId: 'thread-qa', turnId: 'turn-failed' } });
      return { turn: { id: 'turn-failed' } };
    });
    fake.bridge.respondToApproval = vi.fn(() => {
      fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-failed', status: 'failed' } } });
    });
    const { queue, handlers } = productionHandlers(fake);
    await expect(handlers['approval-once']()).rejects.toThrow('状态不符合');
    queue.close();
  });

  it.each(['answer', 'cancel'])('runs the production user-input %s path and then completes', async (action) => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => {
      fake.emit({
        method: 'item/tool/requestUserInput', requestId: 'input-target',
        params: { threadId: 'thread-qa', turnId: 'turn-input', questions: [{ id: 'question-1' }], autoResolutionMs: null },
      });
      return { turn: { id: 'turn-input' } };
    });
    const finish = () => fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-input', status: 'completed' } } });
    fake.bridge.respondToUserInput = vi.fn((requestId, answers) => {
      expect(requestId).toBe('input-target');
      expect(answers).toEqual({ 'question-1': { answers: ['W3 QA'] } });
      finish();
    });
    fake.bridge.cancelUserInput = vi.fn((requestId) => { expect(requestId).toBe('input-target'); finish(); });
    const { queue, handlers } = productionHandlers(fake);
    await handlers[`user-input-${action}`]();
    if (action === 'answer') expect(fake.bridge.respondToUserInput).toHaveBeenCalledTimes(1);
    else expect(fake.bridge.cancelUserInput).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('waits for production user-input timeout closure before accepting turn convergence', async () => {
    const fake = fakeBridge();
    fake.bridge.sendToThread = vi.fn(async () => {
      fake.emit({
        method: 'item/tool/requestUserInput', requestId: 'input-timeout',
        params: { threadId: 'thread-qa', turnId: 'turn-timeout', questions: [{ id: 'question-1' }], autoResolutionMs: null },
      });
      setTimeout(() => {
        fake.emit({ method: 'workboard/serverRequestClosed', requestId: 'input-timeout', params: { requestId: 'input-timeout', reason: 'timeout' } });
        fake.emit({ method: 'turn/completed', params: { threadId: 'thread-qa', turn: { id: 'turn-timeout', status: 'completed' } } });
      }, 5);
      return { turn: { id: 'turn-timeout' } };
    });
    const { queue, handlers } = productionHandlers(fake, { fallbackUserInputTimeoutMs: 10, timeoutMarginMs: 30 });
    await handlers['user-input-timeout']();
    expect(queue.events.map((event) => event.method)).toContain('workboard/serverRequestClosed');
    queue.close();
  });

  it('closes a pending event waiter, clears it, and unsubscribes exactly once', async () => {
    const fake = fakeBridge();
    const queue = createW3EventQueue(fake.bridge, 1_000);
    const pending = queue.waitFor(() => false, 'never');
    queue.close();
    await expect(pending).rejects.toThrow('事件队列已关闭');
    queue.close();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports stop failure and preserves the primary handler error when both occur', async () => {
    const fake = fakeBridge({ stop: vi.fn(async () => { throw new Error('stop failed'); }) });
    const primary = new Error('handler failed');
    const output = vi.fn();
    let thrown;
    try {
      await main({
        ...invocation('steer'), safetyRuntime, createBridge: () => fake.bridge, buildTurnStartParams,
        scenarioHandlers: { steer: async () => { throw primary; } }, output, terminal: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(primary);
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', cleanupFailed: true });
  });

  it('does not return PASS when stop alone fails after a successful handler', async () => {
    const fake = fakeBridge({ stop: vi.fn(async () => { throw new Error('stop only failed'); }) });
    const output = vi.fn();
    await expect(main({
      ...invocation('steer'), safetyRuntime, createBridge: () => fake.bridge, buildTurnStartParams,
      scenarioHandlers: { steer: async () => {} }, output, terminal: vi.fn(),
    })).rejects.toThrow('stop only failed');
    expect(fake.bridge.stop).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', cleanupFailed: true });
  });

  it('refuses unknown-request as a real CLI scenario without creating a bridge', async () => {
    const createBridge = vi.fn();
    const output = vi.fn();
    await expect(main({ ...invocation('unknown-request'), safetyRuntime, createBridge, output })).rejects.toThrow('固定 CodexBridge 隔离契约测试');
    expect(createBridge).not.toHaveBeenCalled();
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', scenario: 'unknown-request' });
  });

  it('contains none of the prohibited legacy actions in the real script', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'qa-live-appserver.mjs'), 'utf8');
    for (const prohibited of ['dangerFullAccess', 'deleteThread(', 'thread/delete']) expect(source).not.toContain(prohibited);
    expect(source).not.toMatch(/permissionPreset:\s*['"]full-access['"]/);
    expect(source).not.toMatch(/\bsleep\s+5\b/);
  });
});
