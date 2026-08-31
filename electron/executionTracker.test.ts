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
});
