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

  it('rejects acceptance bypasses and requires an executor', () => {
    const db = store();
    expect(() => db.create({ title: '绕过验收', lane: 'review', substatus: 'accepted' })).toThrow('只能通过独立审计');
    const unassigned = db.create({ title: '无人执行', lane: 'review' });
    expect(() => db.review(unassigned.id, { auditor: '审计角色', decision: 'accepted', note: '通过' })).toThrow('必须先指定执行人');
    const assigned = db.create({ title: '锁定结果', lane: 'review', executor: '执行角色' });
    const accepted = db.review(assigned.id, { auditor: '审计角色', decision: 'accepted', note: '证据齐全' });
    expect(() => db.update(accepted.id, { executor: '审计角色' })).toThrow('任务已锁定');
    expect(() => db.update(accepted.id, { lane: 'execution', substatus: 'rework' })).toThrow('任务已锁定');
    db.close();
  });

  it('syncs active and archived conversations without overwriting manual classification', () => {
    const db = store();
    db.syncConversations([
      { id: 'thread-active', name: '升级 Codex 工作面板', archived: false, updatedAt: 20, status: { type: 'active' } },
      { id: 'thread-archive', preview: '美元 SOFR 历史研究', archived: true, updatedAt: 10, status: { type: 'notLoaded' }, source: { subAgent: { thread_spawn: { depth: 1 } } } },
    ]);
    expect(db.listConversations().map((thread) => [thread.id, thread.category, thread.archived])).toEqual([
      ['thread-active', 'Codex 工作流', false],
      ['thread-archive', '外币利率', true],
    ]);
    expect(db.listConversations().find((thread) => thread.id === 'thread-archive')?.sourceKind).toBe('subAgentThreadSpawn');

    db.updateConversation('thread-active', { category: '我的重点', tags: ['正式版'], note: '人工维护' });
    db.syncConversations([{ id: 'thread-active', name: '普通项目', archived: false, updatedAt: 30 }]);
    const updated = db.listConversations().find((thread) => thread.id === 'thread-active');
    expect(updated).toMatchObject({ category: '我的重点', classificationSource: 'manual', tags: ['正式版'], note: '人工维护' });
    expect(db.listConversations()).toHaveLength(1);
    expect(db.getSyncState()).toMatchObject({ lastTotal: 1 });
    db.close();
  });

  it('makes subagents inherit the parent conversation category', () => {
    const db = store();
    const parent = { id: 'parent-thread', name: '升级 Codex 工作面板', archived: false, updatedAt: 20 };
    const child = {
      id: 'child-thread',
      preview: '分析人民币利率预测模型',
      archived: false,
      updatedAt: 21,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-thread' } } },
    };
    db.syncConversations([parent, child]);
    expect(db.listConversations().find((thread) => thread.id === 'child-thread')?.category).toBe('Codex 工作流');

    db.updateConversation('parent-thread', { category: '我的重点' });
    db.syncConversations([parent, child]);
    expect(db.listConversations().find((thread) => thread.id === 'child-thread')?.category).toBe('我的重点');
    db.close();
  });

  it('migrates tasks and audit events from a valid legacy database', () => {
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'codex-taskboard-legacy-'));
    const targetDir = mkdtempSync(path.join(tmpdir(), 'codex-workboard-target-'));
    testDirs.push(legacyDir, targetDir);
    const legacyPath = path.join(legacyDir, 'taskboard.sqlite');
    const legacy = new TaskStore(legacyPath);
    const task = legacy.create({ title: '旧版任务', lane: 'execution', executor: '执行角色' });
    legacy.close();

    const target = new TaskStore(path.join(targetDir, 'taskboard.sqlite'));
    expect(target.importLegacy(legacyPath)).toBe(1);
    expect(target.get(task.id).title).toBe('旧版任务');
    expect(target.listEvents(task.id).map((event) => event.action)).toContain('created');
    expect(target.importLegacy(legacyPath)).toBe(0);
    target.close();
  });
});
