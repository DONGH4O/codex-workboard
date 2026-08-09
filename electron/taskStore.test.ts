import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from './taskStore.js';

const testDirs: string[] = [];

function store(): TaskStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-taskboard-test-'));
  testDirs.push(dir);
  return new TaskStore(path.join(dir, 'tasks.sqlite'));
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('creates and moves a task while preserving an audit trail', () => {
    const db = store();
    const created = db.create({ title: '支持新增任务', substatus: 'idea' });
    expect(created.lane).toBe('plan');
    expect(db.update(created.id, { lane: 'execution' }).substatus).toBe('claimed');
    expect(db.listEvents(created.id).map((event) => event.action)).toContain('lane_changed');
    db.close();
  });

  it('enforces independent acceptance and routes rework', () => {
    const db = store();
    const task = db.create({ title: '验收 Demo', lane: 'review', executor: '执行角色' });
    expect(() => db.review(task.id, { auditor: '执行角色', decision: 'accepted', note: '通过' })).toThrow('验收人必须独立于执行人');
    const rework = db.review(task.id, { auditor: '审计角色', decision: 'rework', note: '缺少验证证据' });
    expect(rework.lane).toBe('execution');
    expect(rework.substatus).toBe('rework');
    db.close();
  });
});
