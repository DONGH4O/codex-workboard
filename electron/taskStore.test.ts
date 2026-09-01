import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from './taskStore.js';
import { emptyExecutionSnapshot } from './executionTracker.js';

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
  it('sets a schema version and reopens idempotently', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-workboard-store-'));
    const databasePath = path.join(dir, 'versioned.sqlite');
    const first = new TaskStore(databasePath);
    first.close();
    const raw = new DatabaseSync(databasePath);
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: TaskStore.SCHEMA_VERSION });
    raw.close();
    const second = new TaskStore(databasePath);
    second.close();
  });

  it('rejects future schemas and rolls back a failed legacy migration transaction', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-workboard-store-'));
    const futurePath = path.join(dir, 'future.sqlite');
    const future = new DatabaseSync(futurePath);
    future.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=999; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('unchanged');");
    future.close();
    expect(() => new TaskStore(futurePath)).toThrow('高于当前支持版本');
    const futureReadback = new DatabaseSync(futurePath);
    expect(futureReadback.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    expect(futureReadback.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 999 });
    expect(futureReadback.prepare('SELECT value FROM marker').get()).toMatchObject({ value: 'unchanged' });
    futureReadback.close();

    const brokenPath = path.join(dir, 'broken.sqlite');
    const broken = new DatabaseSync(brokenPath);
    broken.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES ('kept','before');");
    broken.close();
    expect(() => new TaskStore(brokenPath)).toThrow();
    const readback = new DatabaseSync(brokenPath);
    expect(readback.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 });
    expect(readback.prepare("SELECT title FROM tasks WHERE id='kept'").get()).toMatchObject({ title: 'before' });
    expect(readback.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get()).toBeUndefined();
    readback.close();
  });
  it('creates and moves a task while preserving an audit trail', () => {
    const db = store();
    const created = db.create({ title: '支持新增任务', substatus: 'idea', projectName: '人民币利率', projectPath: '/projects/rmb' });
    expect(created.lane).toBe('plan');
    expect(created).toMatchObject({ projectName: '人民币利率', projectPath: '/projects/rmb' });
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

  it('allows user acceptance without a separate identity or typed note', () => {
    const db = store();
    const task = db.create({ title: '用户自行执行并验收', lane: 'review', executor: '用户' });
    expect(task.endAt).toBeNull();
    const accepted = db.review(task.id, { auditor: '用户', reviewerType: 'user', decision: 'accepted' });
    expect(accepted).toMatchObject({ substatus: 'accepted', auditor: '用户' });
    expect(accepted.endAt).toBeTruthy();
    expect(db.listEvents(task.id).find((event) => event.action === 'accepted')?.note).toContain('用户');
    db.close();
  });

  it('returns an AI-rejected task to execution without requiring user text', () => {
    const db = store();
    const task = db.create({ title: 'AI 验收', lane: 'review', executor: '执行角色' });
    const rework = db.review(task.id, { auditor: 'AI审计 · Codex', reviewerType: 'ai', decision: 'rework' });
    expect(rework).toMatchObject({ lane: 'execution', substatus: 'rework', auditor: 'AI审计 · Codex', endAt: null });
    db.close();
  });

  it('rejects acceptance bypasses and requires an executor', () => {
    const db = store();
    expect(() => db.create({ title: '绕过验收', lane: 'review', substatus: 'accepted' })).toThrow('只能通过验收入口');
    const unassigned = db.create({ title: '无人执行', lane: 'review' });
    expect(() => db.review(unassigned.id, { auditor: '审计角色', decision: 'accepted', note: '通过' })).toThrow('必须先指定执行人');
    const assigned = db.create({ title: '锁定结果', lane: 'review', executor: '执行角色' });
    const accepted = db.review(assigned.id, { auditor: '审计角色', decision: 'accepted', note: '证据齐全' });
    expect(() => db.update(accepted.id, { executor: '审计角色' })).toThrow('任务已锁定');
    expect(() => db.update(accepted.id, { lane: 'execution', substatus: 'rework' })).toThrow('任务已锁定');
    db.close();
  });

  it('archives only terminal tasks during daily maintenance', () => {
    const db = store();
    db.syncConversations([{ id: 'new-thread', name: '制定自动维护计划', archived: false }]);
    const pending = db.create({ title: '等待验收', lane: 'review', executor: '执行角色' });
    const acceptedSource = db.create({ title: '已通过', lane: 'review', executor: '执行角色' });
    const accepted = db.review(acceptedSource.id, { auditor: '审计角色', decision: 'accepted', note: '证据齐全' });
    const result = db.runDailyMaintenance();
    expect(result).toMatchObject({ created: 1, stagedByLane: { plan: 1, execution: 0, review: 0 }, archived: 1, activeTasks: 2 });
    expect(result.archivedTaskIds).toEqual([accepted.id]);
    expect(db.listActive().map((task) => task.id)).toContain(pending.id);
    expect(db.listActive().some((task) => task.threadId === 'new-thread')).toBe(true);
    expect(db.get(accepted.id).archivedAt).toBeTruthy();
    expect(db.listEvents(accepted.id).map((event) => event.action)).toContain('archived');
    expect(db.runDailyMaintenance().archived).toBe(0);
    db.close();
  });

  it('archives any task from the card menu and restores it to the same state', () => {
    const db = store();
    const task = db.create({ title: '可撤销归档', lane: 'execution', priority: 'high' });
    const archived = db.archiveTask(task.id);
    expect(archived).toMatchObject({ lane: 'execution', substatus: 'claimed', priority: 'high' });
    expect(archived.archivedAt).toBeTruthy();
    expect(db.listActive().some((item) => item.id === task.id)).toBe(false);
    const restored = db.restoreTask(task.id);
    expect(restored).toMatchObject({ lane: 'execution', substatus: 'claimed', priority: 'high', archivedAt: null });
    expect(db.listEvents(task.id).map((event) => event.action)).toEqual(expect.arrayContaining(['archived', 'restored']));
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

  it('bulk converts every unlinked conversation into an idempotent staged task', () => {
    const db = store();
    db.syncConversations([
      { id: 'plan-thread', name: '制定迁移计划', archived: false, cwd: '/projects/a' },
      { id: 'run-thread', name: '修复页面错误', archived: false, cwd: '/projects/b' },
      { id: 'review-thread', name: '历史工作', archived: true, cwd: '/projects/c' },
    ]);
    const first = db.bulkCreateFromConversations();
    expect(first).toMatchObject({ created: 3, skipped: 0, byLane: { plan: 1, execution: 1, review: 1 } });
    expect(new Set(first.tasks.map((task) => task.threadId))).toEqual(new Set(['plan-thread', 'run-thread', 'review-thread']));
    const categoryByThread = new Map(db.listConversations().map((thread) => [thread.id, thread.category]));
    expect(first.tasks.every((task) => task.projectName === categoryByThread.get(task.threadId!))).toBe(true);
    expect(first.tasks.every((task) => task.endAt === null)).toBe(true);
    expect(first.tasks.every((task) => db.listEvents(task.id).some((event) => event.action === 'created'))).toBe(true);
    expect(db.bulkCreateFromConversations()).toMatchObject({ created: 0, skipped: 3 });
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

  it('persists live execution evidence and moves a completed turn into review', () => {
    const db = store();
    const task = db.create({ title: '实时执行任务', lane: 'plan', threadId: 'thread-live', executor: 'Codex' });
    const snapshot = db.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: task.id, threadId: 'thread-live', turnId: 'turn-live', model: 'gpt-5.6-terra', effort: 'high', serviceTier: 'priority', permissionPreset: 'full-access' }),
      plan: [{ step: '运行测试', status: 'inProgress' }],
      output: 'testing',
    });
    expect(snapshot).toMatchObject({ taskId: task.id, turnId: 'turn-live', status: 'running', output: 'testing', serviceTier: 'priority', permissionPreset: 'full-access' });
    expect(db.findRunnableTaskByThreadId('thread-live')?.id).toBe(task.id);
    expect(db.markExecutionStarted(task.id, 'turn-live')).toMatchObject({ lane: 'execution', substatus: 'running' });
    expect(db.markExecutionFinished(task.id, 'completed', 'turn-live')).toMatchObject({ lane: 'review', substatus: 'pending_review' });
    expect(db.listEvents(task.id).map((event) => event.action)).toEqual(expect.arrayContaining(['execution_started', 'execution_completed']));
    db.close();
  });

  it('recovers a missing task conversation link from its execution snapshot', () => {
    const db = store();
    const task = db.create({ title: '恢复执行对话', lane: 'execution' });
    db.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: task.id, threadId: 'thread-recovered', turnId: 'turn-recovered' }),
      status: 'completed',
      completedAt: '2026-08-13T02:00:00.000Z',
    });
    expect(db.get(task.id).threadId).toBe('thread-recovered');
    expect(db.listEvents(task.id).map((event) => event.action)).toContain('thread_link_recovered');
    db.close();
  });

  it('relinks an unavailable conversation and records the recovery', () => {
    const db = store();
    const task = db.create({ title: '续作任务', lane: 'execution', threadId: 'thread-old' });
    const updated = db.relinkThread(task.id, 'thread-new', '原对话不可用，创建续作对话');
    expect(updated.threadId).toBe('thread-new');
    expect(db.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'thread_relinked', note: '原对话不可用，创建续作对话' }),
    ]));
    db.close();
  });

  it('marks unfinished execution as interrupted after restart while retaining evidence', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-taskboard-restart-'));
    testDirs.push(dir);
    const databasePath = path.join(dir, 'tasks.sqlite');
    const first = new TaskStore(databasePath);
    const task = first.create({ title: '恢复执行证据', lane: 'execution', threadId: 'thread-restart' });
    first.markExecutionStarted(task.id, 'turn-restart');
    first.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: task.id, threadId: 'thread-restart', turnId: 'turn-restart' }),
      status: 'waiting_approval',
      plan: [{ step: '保留计划', status: 'inProgress' }],
      lastMessage: '保留的最新进展',
      output: '保留的终端输出',
      diff: '+ 保留的文件变化',
      currentItem: { type: 'commandExecution', command: 'npm test' },
      pendingApproval: {
        requestId: 7,
        method: 'item/commandExecution/requestApproval',
        threadId: 'thread-restart',
        turnId: 'turn-restart',
        itemId: 'item-restart',
        reason: '审批',
        command: 'npm test',
        cwd: '/tmp/project',
        networkHost: '',
        networkProtocol: '',
        availableDecisions: ['accept', 'decline'],
        unsupportedDecisionCount: 0,
        unsupportedDecisions: [],
        responseSubmitted: false,
      },
    });
    first.close();

    const recovered = new TaskStore(databasePath);
    expect(recovered.expireLiveExecutions()).toBe(1);
    recovered.close();

    const readback = new TaskStore(databasePath);
    expect(readback.getExecutionSnapshot(task.id)).toMatchObject({
      status: 'interrupted',
      plan: [{ step: '保留计划', status: 'inProgress' }],
      lastMessage: '保留的最新进展',
      output: '保留的终端输出',
      diff: '+ 保留的文件变化',
      currentItem: { type: 'commandExecution', command: 'npm test' },
      pendingApproval: null,
      pendingUserInput: null,
      error: 'Workboard 已重启，保留上次执行记录；继续任务将创建新回合。',
    });
    expect(readback.get(task.id)).toMatchObject({ lane: 'execution', substatus: 'blocked' });
    expect(readback.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorRole: 'system', action: 'execution_interrupted_on_restart', note: expect.stringContaining('执行证据已保留') }),
    ]));
    expect(readback.expireLiveExecutions()).toBe(0);
    expect(readback.listEvents(task.id).filter((event) => event.action === 'execution_interrupted_on_restart')).toHaveLength(1);
    readback.close();
  });

  it('persists string-id user input requests and clears them after restart', () => {
    const db = store();
    const task = db.create({ title: '等待回答', lane: 'execution', threadId: 'thread-input' });
    db.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: task.id, threadId: 'thread-input', turnId: 'turn-input' }),
      status: 'waiting_input',
      pendingUserInput: {
        requestId: 'request-input',
        threadId: 'thread-input',
        turnId: 'turn-input',
        itemId: 'item-input',
        isBlocking: true,
        questions: [{ id: 'q', header: '选择', question: '选择方案', isOther: false, isSecret: false, options: [] }],
      },
    });
    expect(db.getExecutionSnapshot(task.id)?.pendingUserInput?.requestId).toBe('request-input');
    expect(db.expireLiveExecutions()).toBe(1);
    expect(db.getExecutionSnapshot(task.id)).toMatchObject({ status: 'interrupted', pendingUserInput: null });
    db.close();
  });

  it('interrupts stale snapshots without reopening terminal or archived tasks', () => {
    const db = store();
    const review = db.create({ title: '已验收任务', lane: 'review', threadId: 'thread-accepted', executor: '执行角色' });
    const accepted = db.review(review.id, { auditor: '审计角色', decision: 'accepted', note: '已经验收' });
    const archiveCandidate = db.create({ title: '已归档任务', lane: 'execution', threadId: 'thread-archived' });
    const archived = db.archiveTask(archiveCandidate.id);
    db.saveExecutionSnapshot({ ...emptyExecutionSnapshot({ taskId: accepted.id, threadId: 'thread-accepted' }), status: 'running' });
    db.saveExecutionSnapshot({ ...emptyExecutionSnapshot({ taskId: archived.id, threadId: 'thread-archived' }), status: 'waiting_input' });

    expect(db.expireLiveExecutions()).toBe(2);
    expect(db.get(accepted.id)).toMatchObject({ lane: 'review', substatus: 'accepted', archivedAt: null });
    expect(db.get(archived.id)).toMatchObject({ lane: 'execution', substatus: 'claimed' });
    expect(db.get(archived.id).archivedAt).not.toBeNull();
    expect(db.getExecutionSnapshot(accepted.id)?.status).toBe('interrupted');
    expect(db.getExecutionSnapshot(archived.id)?.status).toBe('interrupted');
    expect(db.listEvents(accepted.id).some((event) => event.action === 'execution_interrupted_on_restart')).toBe(false);
    expect(db.listEvents(archived.id).some((event) => event.action === 'execution_interrupted_on_restart')).toBe(false);
    db.close();
  });

  it('records each active-turn guidance message in the audit trail', () => {
    const db = store();
    const task = db.create({ title: '引导执行', lane: 'execution', threadId: 'thread-steer' });
    db.recordExecutionGuidance(task.id, 'turn-steer', '  先核对输入数据，再继续生成结果。  ');
    expect(db.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorRole: 'executor',
        action: 'execution_steered',
        note: '已引导 Codex 回合 turn-steer：先核对输入数据，再继续生成结果。',
      }),
    ]));
    db.close();
  });

  it('records an explicit handoff when Workboard releases a live conversation', () => {
    const db = store();
    const task = db.create({ title: '转到 Codex', lane: 'execution', threadId: 'thread-handoff' });
    db.recordConversationHandoff(task.id, 'thread-handoff');
    expect(db.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'conversation_handed_off', note: expect.stringContaining('释放对话 thread-handoff') }),
    ]));
    db.close();
  });

});
