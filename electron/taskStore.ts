import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertReviewSeparation, defaultSubstatus, laneForDecision, type Lane, type Substatus } from './stateMachine.js';

export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  lane: Lane;
  substatus: Substatus;
  priority: Priority;
  projectPath: string | null;
  threadId: string | null;
  executor: string | null;
  auditor: string | null;
  acceptanceCriteria: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput {
  title: string;
  description?: string;
  lane?: Lane;
  substatus?: Substatus;
  priority?: Priority;
  projectPath?: string | null;
  threadId?: string | null;
  executor?: string | null;
  auditor?: string | null;
  acceptanceCriteria?: string;
}

type Row = Record<string, string | null>;

export class TaskStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        lane TEXT NOT NULL CHECK (lane IN ('plan','execution','review')),
        substatus TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('low','medium','high')),
        project_path TEXT,
        thread_id TEXT,
        executor TEXT,
        auditor TEXT,
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_role TEXT NOT NULL CHECK (actor_role IN ('system','executor','auditor')),
        action TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_lane_updated ON tasks(lane, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_task_created ON audit_events(task_id, created_at DESC);
    `);
  }

  private fromRow(row: Row): Task {
    return {
      id: row.id!,
      title: row.title!,
      description: row.description ?? '',
      lane: row.lane as Lane,
      substatus: row.substatus as Substatus,
      priority: row.priority as Priority,
      projectPath: row.project_path,
      threadId: row.thread_id,
      executor: row.executor,
      auditor: row.auditor,
      acceptanceCriteria: row.acceptance_criteria ?? '',
      createdAt: row.created_at!,
      updatedAt: row.updated_at!,
    };
  }

  list(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  get(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('任务不存在');
    return this.fromRow(row);
  }

  create(input: TaskInput): Task {
    const title = input.title.trim();
    if (!title) throw new Error('任务标题不能为空');
    const id = randomUUID();
    const now = new Date().toISOString();
    const lane = input.lane ?? 'plan';
    const substatus = input.substatus ?? defaultSubstatus(lane);
    this.db
      .prepare(`INSERT INTO tasks (
        id,title,description,lane,substatus,priority,project_path,thread_id,executor,auditor,acceptance_criteria,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        title,
        input.description?.trim() ?? '',
        lane,
        substatus,
        input.priority ?? 'medium',
        input.projectPath ?? null,
        input.threadId ?? null,
        input.executor?.trim() || null,
        input.auditor?.trim() || null,
        input.acceptanceCriteria?.trim() ?? '',
        now,
        now,
      );
    this.addEvent(id, 'system', 'created', `创建于${lane}`);
    return this.get(id);
  }

  update(id: string, patch: Partial<TaskInput>): Task {
    const current = this.get(id);
    const lane = patch.lane ?? current.lane;
    const laneChanged = patch.lane !== undefined && patch.lane !== current.lane;
    const next: Task = {
      ...current,
      ...patch,
      title: patch.title?.trim() || current.title,
      description: patch.description?.trim() ?? current.description,
      lane,
      substatus: patch.substatus ?? (laneChanged ? defaultSubstatus(lane) : current.substatus),
      executor: patch.executor === undefined ? current.executor : patch.executor?.trim() || null,
      auditor: patch.auditor === undefined ? current.auditor : patch.auditor?.trim() || null,
      acceptanceCriteria: patch.acceptanceCriteria?.trim() ?? current.acceptanceCriteria,
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`UPDATE tasks SET
      title=?,description=?,lane=?,substatus=?,priority=?,project_path=?,thread_id=?,executor=?,auditor=?,acceptance_criteria=?,updated_at=?
      WHERE id=?`).run(
      next.title,
      next.description,
      next.lane,
      next.substatus,
      next.priority,
      next.projectPath,
      next.threadId,
      next.executor,
      next.auditor,
      next.acceptanceCriteria,
      next.updatedAt,
      id,
    );
    if (laneChanged) this.addEvent(id, 'system', 'lane_changed', `${current.lane} → ${next.lane}`);
    return this.get(id);
  }

  review(id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note: string }): Task {
    const current = this.get(id);
    if (current.lane !== 'review') throw new Error('任务必须先进入“验收和回顾”');
    assertReviewSeparation(current.executor, input.auditor);
    const note = input.note.trim();
    if (!note) throw new Error('请填写验收或回顾说明');
    const updated = this.update(id, {
      lane: laneForDecision(input.decision),
      substatus: input.decision,
      auditor: input.auditor,
    });
    this.addEvent(id, 'auditor', input.decision, note);
    return updated;
  }

  listEvents(taskId: string): Array<Record<string, string>> {
    return this.db
      .prepare(`SELECT id, task_id AS taskId, actor_role AS actorRole, action, note, created_at AS createdAt
        FROM audit_events WHERE task_id = ? ORDER BY created_at DESC`)
      .all(taskId) as Array<Record<string, string>>;
  }

  private addEvent(taskId: string, actorRole: 'system' | 'executor' | 'auditor', action: string, note: string): void {
    this.db
      .prepare('INSERT INTO audit_events (id,task_id,actor_role,action,note,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), taskId, actorRole, action, note, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

