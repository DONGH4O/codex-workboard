import { describe, expect, it } from 'vitest';
import { emptyExecutionSnapshot, reduceExecutionSnapshot } from './executionTracker.js';

describe('execution tracker', () => {
  it('collects plan, agent messages, command output and diffs for one turn', () => {
    let state = emptyExecutionSnapshot({
      taskId: 'task-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      model: 'gpt-5.6-terra',
      effort: 'high',
      serviceTier: 'priority',
      now: '2026-08-10T10:00:00.000Z',
    });
    state = reduceExecutionSnapshot(state, {
      method: 'turn/plan/updated',
      params: { turnId: 'turn-1', plan: [{ step: '检查项目', status: 'completed' }, { step: '运行测试', status: 'inProgress' }] },
    });
    state = reduceExecutionSnapshot(state, { method: 'item/agentMessage/delta', params: { turnId: 'turn-1', delta: '正在运行验证。' } });
    state = reduceExecutionSnapshot(state, { method: 'item/commandExecution/outputDelta', params: { turnId: 'turn-1', delta: '12 tests passed\n' } });
    state = reduceExecutionSnapshot(state, { method: 'turn/diff/updated', params: { turnId: 'turn-1', diff: '+ live execution panel' } });

    expect(state).toMatchObject({
      status: 'running',
      turnId: 'turn-1',
      model: 'gpt-5.6-terra',
      effort: 'high',
      serviceTier: 'priority',
      lastMessage: '正在运行验证。',
      output: '12 tests passed\n',
      diff: '+ live execution panel',
    });
    expect(state.plan).toEqual([
      { step: '检查项目', status: 'completed' },
      { step: '运行测试', status: 'inProgress' },
    ]);
  });

  it('pauses for approval, resumes after a decision and completes', () => {
    let state = emptyExecutionSnapshot({ taskId: 'task-2', threadId: 'thread-2', turnId: 'turn-2' });
    state = reduceExecutionSnapshot(state, {
      method: 'item/commandExecution/requestApproval',
      requestId: 42,
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        itemId: 'item-1',
        reason: '需要运行测试',
        command: ['npm', 'test'],
        cwd: '/tmp/project',
        availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    });
    expect(state.status).toBe('waiting_approval');
    expect(state.pendingApproval).toMatchObject({ requestId: 42, command: 'npm test', cwd: '/tmp/project' });

    state = reduceExecutionSnapshot(state, { method: 'workboard/serverRequestResponseSubmitted', params: { requestId: 42 } });
    expect(state.status).toBe('waiting_approval');
    expect(state.pendingApproval?.responseSubmitted).toBe(true);

    state = reduceExecutionSnapshot(state, { method: 'serverRequest/resolved', params: { requestId: 42 } });
    expect(state.status).toBe('running');
    expect(state.pendingApproval).toBeNull();

    state = reduceExecutionSnapshot(state, {
      method: 'turn/completed',
      params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' } },
    }, '2026-08-10T10:05:00.000Z');
    expect(state.status).toBe('completed');
    expect(state.completedAt).toBe('2026-08-10T10:05:00.000Z');
  });

  it('tracks string request ids, user input answers and local cancellation', () => {
    let state = emptyExecutionSnapshot({ taskId: 'task-3', threadId: 'thread-3', turnId: 'turn-3' });
    state = reduceExecutionSnapshot(state, {
      method: 'item/tool/requestUserInput',
      requestId: 'request-a',
      params: {
        threadId: 'thread-3',
        turnId: 'turn-3',
        itemId: 'item-3',
        isBlocking: true,
        questions: [{ id: 'choice', header: '方案', question: '选择方案', isOther: false, isSecret: false, options: [{ label: 'A', description: '推荐' }] }],
      },
    });
    expect(state).toMatchObject({
      status: 'waiting_input',
      pendingUserInput: { requestId: 'request-a', questions: [{ id: 'choice', options: [{ label: 'A', description: '推荐' }] }] },
    });
    state = reduceExecutionSnapshot(state, { method: 'workboard/serverRequestClosed', params: { requestId: 'request-a', reason: 'cancelled' } });
    expect(state.status).toBe('running');
    expect(state.pendingUserInput).toBeNull();
  });

  it('keeps execution running for a non-blocking user input request', () => {
    const state = reduceExecutionSnapshot(emptyExecutionSnapshot({ taskId: 'task-nonblocking', threadId: 'thread-nonblocking' }), {
      method: 'item/tool/requestUserInput',
      requestId: 'request-nonblocking',
      params: { threadId: 'thread-nonblocking', turnId: 'turn-nonblocking', itemId: 'item', isBlocking: false, questions: [] },
    });
    expect(state.status).toBe('running');
    expect(state.pendingUserInput).toMatchObject({ requestId: 'request-nonblocking', isBlocking: false });
  });

  it('does not mistake permissions requests for decision approvals and preserves network protocol', () => {
    let state = emptyExecutionSnapshot({ taskId: 'task-4', threadId: 'thread-4', turnId: 'turn-4' });
    state = reduceExecutionSnapshot(state, {
      method: 'item/permissions/requestApproval',
      requestId: 'permissions-1',
      params: { threadId: 'thread-4', turnId: 'turn-4', permissions: {} },
    });
    expect(state.pendingApproval).toBeNull();

    state = reduceExecutionSnapshot(state, {
      method: 'item/commandExecution/requestApproval',
      requestId: 'network-1',
      params: {
        threadId: 'thread-4',
        turnId: 'turn-4',
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
        availableDecisions: ['accept', { applyNetworkPolicyAmendment: {} }, 'decline'],
      },
    });
    expect(state.pendingApproval).toMatchObject({ requestId: 'network-1', networkHost: 'example.com', networkProtocol: 'https', unsupportedDecisionCount: 1, unsupportedDecisions: [{ applyNetworkPolicyAmendment: {} }] });
    state = reduceExecutionSnapshot(state, { method: 'workboard/serverRequestUnsupported', requestId: 'unrelated', params: { requestId: 'unrelated', method: 'unknown/method' } });
    expect(state.status).toBe('waiting_approval');
    expect(state.pendingApproval?.requestId).toBe('network-1');
    state = reduceExecutionSnapshot(state, { method: 'serverRequest/resolved', params: { requestId: 'different-request' } });
    expect(state.status).toBe('waiting_approval');
    expect(state.pendingApproval?.requestId).toBe('network-1');
  });
});
