import { describe, expect, it, vi } from 'vitest';
import {
  W3_APPROVED_CODEX_CLI,
  W3_APPROVED_CODEX_HOME,
  W3_USER_DATA,
  W3_WORKSPACE,
} from './w3-qa-safety.mjs';
import { main } from './qa-create-thread.mjs';

const env = {
  WORKBOARD_W3_REAL_INTERACTION: '1',
  WORKBOARD_W3_ALLOWED_SCENARIO: 'basic-create',
  WORKBOARD_W3_WORKSPACE: W3_WORKSPACE,
  WORKBOARD_USER_DATA_DIR: W3_USER_DATA,
  WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
  CODEX_CLI_PATH: W3_APPROVED_CODEX_CLI,
  CODEX_HOME: W3_APPROVED_CODEX_HOME,
};
const argv = ['--execute-real', '--scenario=basic-create'];
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

function model() {
  return {
    id: 'model-test', isDefault: true, defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'priority', name: 'Priority' }],
  };
}

describe('qa-create-thread import-safe isolated flow', () => {
  it('refuses missing execution gates before creating a bridge', async () => {
    const createBridge = vi.fn();
    const output = vi.fn();
    await expect(main({ argv: [], env: {}, createBridge, output })).rejects.toThrow('双重执行门');
    expect(createBridge).not.toHaveBeenCalled();
    expect(output.mock.calls[0][0]).toMatchObject({ result: 'REFUSED', realInteractionStarted: false });
  });

  it('handles completion emitted before turn/start returns, restarts read-only, and retains the thread', async () => {
    let listener = () => {};
    const unsubscribe = vi.fn();
    const first = {
      listModels: vi.fn(async () => [model()]),
      createThread: vi.fn(async () => 'thread-secret'),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-secret', turn: { id: 'turn-secret', status: 'completed' } } });
        return { turn: { id: 'turn-secret' } };
      }),
      stop: vi.fn(async () => {}),
      deleteThread: vi.fn(),
    };
    const second = {
      readThread: vi.fn(async () => ({ turns: [{ id: 'turn-secret', status: 'completed', text: 'private reply' }] })),
      stop: vi.fn(async () => {}),
      deleteThread: vi.fn(),
    };
    const createBridge = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const output = vi.fn();
    const terminal = vi.fn();
    const evidence = await main({
      argv, env, safetyRuntime, createBridge, buildTurnStartParams, output, terminal,
      now: () => new Date('2026-09-01T00:00:00.000Z'), timeoutMs: 50,
    });
    expect(evidence).toMatchObject({ result: 'PASS', createdQaThread: 'retained', resumedAfterRestart: true });
    expect(first.createThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: W3_WORKSPACE, title: expect.stringContaining('Windows Workboard 验收') }));
    expect(first.sendToThread).toHaveBeenCalledWith(expect.objectContaining({ permissionPreset: 'untrusted', cwd: W3_WORKSPACE }));
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.deleteThread).not.toHaveBeenCalled();
    expect(second.deleteThread).not.toHaveBeenCalled();
    const machineEvidence = JSON.stringify(output.mock.calls.at(-1)[0]);
    expect(machineEvidence).not.toContain('thread-secret');
    expect(machineEvidence).not.toContain('turn-secret');
    expect(machineEvidence).not.toContain('private reply');
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('thread-secret'));
    expect(first.sendToThread.mock.calls[0][0].text).toContain('不要使用工具');
    expect(output.mock.invocationCallOrder[0]).toBeLessThan(createBridge.mock.invocationCallOrder[0]);
    expect(output.mock.calls[0][0]).toMatchObject({ result: 'READY_FOR_REAL_EXECUTION', permission: { approvalPolicy: 'untrusted', sandboxType: 'workspaceWrite' } });
  });

  it('reports the service tier as not configured when the selected model has none', async () => {
    let listener = () => {};
    const noTierModel = { ...model(), serviceTiers: [] };
    const first = {
      listModels: vi.fn(async () => [noTierModel]),
      createThread: vi.fn(async (input) => {
        expect(input.serviceTier).toBeNull();
        return 'thread-no-tier';
      }),
      onEvent: vi.fn((next) => { listener = next; return vi.fn(); }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-no-tier', turn: { id: 'turn-no-tier', status: 'completed' } } });
        return { turn: { id: 'turn-no-tier' } };
      }),
      stop: vi.fn(async () => {}),
    };
    const second = {
      readThread: vi.fn(async () => ({ turns: [{ id: 'turn-no-tier', status: 'completed' }] })),
      stop: vi.fn(async () => {}),
    };
    const output = vi.fn();
    const createBridge = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const evidence = await main({
      argv, env, safetyRuntime, createBridge, buildTurnStartParams, output,
      terminal: vi.fn(), timeoutMs: 50,
    });
    expect(evidence).toMatchObject({ result: 'PASS', serviceTierConfigured: false });
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ serviceTierConfigured: false });
  });

  it('ignores completion for another turn and stops without deleting on failure', async () => {
    let listener = () => {};
    const unsubscribe = vi.fn();
    const bridge = {
      listModels: vi.fn(async () => [model()]),
      createThread: vi.fn(async () => 'thread-target'),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-target', turn: { id: 'turn-other' } } });
        return { turn: { id: 'turn-target' } };
      }),
      stop: vi.fn(async () => {}),
      deleteThread: vi.fn(),
    };
    const output = vi.fn();
    const terminal = vi.fn();
    await expect(main({ argv, env, safetyRuntime, createBridge: () => bridge, buildTurnStartParams, output, terminal, timeoutMs: 5 })).rejects.toThrow('等待超时');
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(bridge.deleteThread).not.toHaveBeenCalled();
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', createdQaThread: 'retained', errorKind: 'Error' });
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('thread-target'));
  });

  it.each(['failed', 'interrupted'])('rejects a fast terminal %s status and retains the thread', async (status) => {
    let listener = () => {};
    const unsubscribe = vi.fn();
    const bridge = {
      listModels: vi.fn(async () => [model()]),
      createThread: vi.fn(async () => 'thread-terminal'),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-terminal', turn: { id: 'turn-terminal', status } } });
        return { turn: { id: 'turn-terminal' } };
      }),
      stop: vi.fn(async () => {}),
      deleteThread: vi.fn(),
    };
    const output = vi.fn();
    const terminal = vi.fn();
    await expect(main({ argv, env, safetyRuntime, createBridge: () => bridge, buildTurnStartParams, output, terminal, timeoutMs: 50 })).rejects.toThrow('状态不是 completed');
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(bridge.deleteThread).not.toHaveBeenCalled();
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', stage: 'failed', createdQaThread: 'retained' });
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('thread-terminal'));
  });

  it('does not return PASS when the restarted bridge cannot stop', async () => {
    let listener = () => {};
    const unsubscribe = vi.fn();
    const first = {
      listModels: vi.fn(async () => [model()]),
      createThread: vi.fn(async () => 'thread-cleanup'),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-cleanup', turn: { id: 'turn-cleanup', status: 'completed' } } });
        return { turn: { id: 'turn-cleanup' } };
      }),
      stop: vi.fn(async () => {}),
    };
    const second = {
      readThread: vi.fn(async () => ({ turns: [{ id: 'turn-cleanup' }] })),
      stop: vi.fn(async () => { throw new Error('stop failed'); }),
    };
    const output = vi.fn();
    const terminal = vi.fn();
    const createBridge = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    await expect(main({ argv, env, safetyRuntime, createBridge, buildTurnStartParams, output, terminal, timeoutMs: 50 })).rejects.toThrow('stop failed');
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', cleanupFailed: true, createdQaThread: 'retained' });
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('thread-cleanup'));
  });

  it('attempts the first bridge stop only once and does not restart after that stop fails', async () => {
    let listener = () => {};
    const unsubscribe = vi.fn();
    const first = {
      listModels: vi.fn(async () => [model()]),
      createThread: vi.fn(async () => 'thread-first-stop'),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe; }),
      sendToThread: vi.fn(async () => {
        listener({ method: 'turn/completed', params: { threadId: 'thread-first-stop', turn: { id: 'turn-first-stop', status: 'completed' } } });
        return { turn: { id: 'turn-first-stop' } };
      }),
      stop: vi.fn(async () => { throw new Error('first stop failed'); }),
    };
    const createBridge = vi.fn(() => first);
    const output = vi.fn();
    const terminal = vi.fn();
    await expect(main({ argv, env, safetyRuntime, createBridge, buildTurnStartParams, output, terminal, timeoutMs: 50 })).rejects.toThrow('first stop failed');
    expect(createBridge).toHaveBeenCalledTimes(1);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', cleanupFailed: true, createdQaThread: 'retained' });
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining('thread-first-stop'));
  });

  it('keeps the primary business error when stopping the same bridge also fails', async () => {
    const primary = new Error('primary model failure');
    const bridge = {
      listModels: vi.fn(async () => { throw primary; }),
      stop: vi.fn(async () => { throw new Error('cleanup stop failure'); }),
    };
    const output = vi.fn();
    let thrown;
    try {
      await main({ argv, env, safetyRuntime, createBridge: () => bridge, buildTurnStartParams, output, timeoutMs: 50 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(primary);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.at(-1)[0]).toMatchObject({ result: 'FAIL', cleanupFailed: true, createdQaThread: 'not-created' });
  });
});
