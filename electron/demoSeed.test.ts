import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDemoExecution } from './demoSeed.js';
import { emptyExecutionSnapshot } from './executionTracker.js';
import { TaskStore } from './taskStore.js';

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('demo seed execution audit', () => {
  it('records exactly one start for each seeded active turn and does not reconstruct duplicates on restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workboard-demo-seed-'));
    testDirs.push(dir);
    const store = new TaskStore(path.join(dir, 'taskboard.sqlite'));
    const approval = store.create({ title: '在关联对话中继续执行', lane: 'execution', threadId: 'demo-live-thread' });
    const steer = store.create({ title: '执行中可随时引导', lane: 'execution', threadId: 'demo-steer-thread' });
    saveDemoExecution(store, {
      ...emptyExecutionSnapshot({ taskId: approval.id, threadId: 'demo-live-thread', turnId: 'demo-turn' }),
      status: 'waiting_approval',
    });
    saveDemoExecution(store, {
      ...emptyExecutionSnapshot({ taskId: steer.id, threadId: 'demo-steer-thread', turnId: 'demo-steer-turn' }),
      status: 'running',
    });
    expect(store.expireLiveExecutions()).toBe(2);
    for (const [taskId, turnId] of [[approval.id, 'demo-turn'], [steer.id, 'demo-steer-turn']]) {
      const starts = store.listEvents(taskId).filter((event) => event.action === 'execution_started');
      expect(starts).toHaveLength(1);
      expect(starts[0].note).toBe(`Codex 回合 ${turnId} 已启动`);
      expect(store.listEvents(taskId).filter((event) => event.action === 'execution_interrupted_on_restart')).toHaveLength(1);
    }
    store.close();
  });
});
