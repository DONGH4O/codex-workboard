import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CATEGORIES, inferConversationCategory, parentConversationId } from './classifier.js';
import { assertReviewSeparation, assertWritableSubstatus, defaultSubstatus, laneForDecision, type Lane, type Substatus } from './stateMachine.js';
import { conversationTaskTitle, inferConversationStage } from './taskStage.js';

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

export interface Conversation {
  id: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  runtimeStatus: string;
  archived: boolean;
  isPinned: boolean;
  modelProvider: string | null;
  sourceKind: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  category: string;
  classificationSource: 'auto' | 'manual';
  tags: string[];
  note: string;
  linkedTaskCount: number;
  syncedAt: string;
}

export interface SyncState {
  lastCompletedAt: string | null;
  lastTotal: number;
}

export interface BulkTaskResult {
  tasks: Task[];
  created: number;
  skipped: number;
  byLane: Record<Lane, number>;
}

type Row = Record<string, string | number | null>;

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
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        name TEXT,
        preview TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        runtime_status TEXT NOT NULL DEFAULT 'notLoaded',
        archived INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        model_provider TEXT,
        source_kind TEXT,
        created_at_epoch INTEGER,
        updated_at_epoch INTEGER,
        category TEXT NOT NULL,
        classification_source TEXT NOT NULL DEFAULT 'auto' CHECK (classification_source IN ('auto','manual')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        available INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_archived_updated ON conversations(archived, updated_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_category ON conversations(category);
      CREATE TABLE IF NOT EXISTS sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_completed_at TEXT,
        last_total INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO sync_state (singleton,last_completed_at,last_total) VALUES (1,NULL,0);
    `);
    const columns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'available')) this.db.exec('ALTER TABLE conversations ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }

  importLegacy(path: string): number {
    if (!existsSync(path) || this.list().length > 0) return 0;
    const before = this.list().length;
    const escaped = path.replaceAll("'", "''");
    this.db.exec(`ATTACH DATABASE '${escaped}' AS legacy`);
    try {
      const integrity = this.db.prepare('PRAGMA legacy.quick_check').get() as { quick_check?: string } | undefined;
      if (integrity?.quick_check !== 'ok') throw new Error('旧版任务数据库完整性检查失败');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(`
        INSERT OR IGNORE INTO tasks (
          id,title,description,lane,substatus,priority,project_path,thread_id,executor,auditor,acceptance_criteria,created_at,updated_at
        ) SELECT id,title,description,lane,substatus,priority,project_path,thread_id,executor,auditor,acceptance_criteria,created_at,updated_at FROM legacy.tasks;
        INSERT OR IGNORE INTO audit_events (id,task_id,actor_role,action,note,created_at)
        SELECT id,task_id,actor_role,action,note,created_at FROM legacy.audit_events;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    } finally {
      this.db.exec('DETACH DATABASE legacy');
    }
    return this.list().length - before;
  }

  private fromRow(row: Row): Task {
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description ?? ''),
      lane: row.lane as Lane,
      substatus: row.substatus as Substatus,
      priority: row.priority as Priority,
      projectPath: typeof row.project_path === 'string' ? row.project_path : null,
      threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
      executor: typeof row.executor === 'string' ? row.executor : null,
      auditor: typeof row.auditor === 'string' ? row.auditor : null,
      acceptanceCriteria: String(row.acceptance_criteria ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  list(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  bulkCreateFromConversations(): BulkTaskResult {
    const rows = this.db.prepare(`SELECT c.* FROM conversations c
      WHERE c.available=1
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.thread_id=c.id)
      ORDER BY COALESCE(c.updated_at_epoch,c.created_at_epoch,0) DESC`).all() as Row[];
    const totalConversations = Number((this.db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE available=1').get() as Row).count ?? 0);
    const ids: string[] = [];
    const byLane: Record<Lane, number> = { plan: 0, execution: 0, review: 0 };
    const taskInsert = this.db.prepare(`INSERT INTO tasks (
      id,title,description,lane,substatus,priority,project_path,thread_id,executor,auditor,acceptance_criteria,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const threadId = String(row.id);
        const stage = inferConversationStage({
          name: row.name,
          preview: row.preview,
          archived: Number(row.archived) === 1,
        });
        const id = randomUUID();
        const now = new Date().toISOString();
        const inferredTitle = conversationTaskTitle({ name: row.name, preview: row.preview });
        const title = row.source_kind === 'subAgentOther' && /^The following is the Codex agent history/i.test(inferredTitle)
          ? `内部代理审查 · ${String(row.category ?? '未分类')}`
          : inferredTitle;
        const preview = String(row.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
        const category = String(row.category ?? '未分类');
        const description = preview ? `【${category}】${preview}` : `【${category}】由 Codex 对话批量生成。`;
        taskInsert.run(
          id,
          title,
          description,
          stage.lane,
          stage.substatus,
          'medium',
          typeof row.cwd === 'string' ? row.cwd : null,
          threadId,
          stage.executor,
          null,
          stage.acceptanceCriteria,
          now,
          now,
        );
        this.addEvent(id, 'system', 'created', `由对话批量生成，归入${stage.lane}`);
        ids.push(id);
        byLane[stage.lane] += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return {
      tasks: ids.map((id) => this.get(id)),
      created: ids.length,
      skipped: totalConversations - ids.length,
      byLane,
    };
  }

  syncConversations(input: Array<Record<string, unknown>>): Conversation[] {
    const syncedAt = new Date().toISOString();
    const byId = new Map(input.flatMap((thread) => typeof thread.id === 'string' && thread.id ? [[thread.id, thread] as const] : []));
    const existingManual = new Map(
      (this.db.prepare("SELECT id,category FROM conversations WHERE classification_source='manual'").all() as Array<{ id: string; category: string }>)
        .map((row) => [row.id, row.category] as const),
    );
    const categoryCache = new Map<string, string>();
    const resolveCategory = (thread: Record<string, unknown>, visiting = new Set<string>()): string => {
      const id = typeof thread.id === 'string' ? thread.id : '';
      if (id && categoryCache.has(id)) return categoryCache.get(id)!;
      if (id && existingManual.has(id)) return existingManual.get(id)!;
      if (id && visiting.has(id)) return inferConversationCategory(thread);
      if (id) visiting.add(id);
      const parentId = parentConversationId(thread);
      const parent = parentId ? byId.get(parentId) : undefined;
      const category = parent
        ? resolveCategory(parent, visiting)
        : parentId && existingManual.has(parentId)
          ? existingManual.get(parentId)!
          : inferConversationCategory(thread);
      if (id) categoryCache.set(id, category);
      return category;
    };
    const statement = this.db.prepare(`INSERT INTO conversations (
      id,name,preview,cwd,runtime_status,archived,is_pinned,model_provider,source_kind,created_at_epoch,updated_at_epoch,
      category,classification_source,tags_json,note,available,synced_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      preview=excluded.preview,
      cwd=excluded.cwd,
      runtime_status=excluded.runtime_status,
      archived=excluded.archived,
      is_pinned=excluded.is_pinned,
      model_provider=excluded.model_provider,
      source_kind=excluded.source_kind,
      created_at_epoch=excluded.created_at_epoch,
      updated_at_epoch=excluded.updated_at_epoch,
      category=CASE WHEN conversations.classification_source='auto' THEN excluded.category ELSE conversations.category END,
      available=1,
      synced_at=excluded.synced_at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('UPDATE conversations SET available=0');
      for (const thread of input) {
        const id = typeof thread.id === 'string' ? thread.id : '';
        if (!id) continue;
        const status = typeof thread.status === 'string'
          ? thread.status
          : thread.status && typeof thread.status === 'object' && typeof (thread.status as Record<string, unknown>).type === 'string'
            ? String((thread.status as Record<string, unknown>).type)
            : 'notLoaded';
        const category = resolveCategory(thread);
        statement.run(
          id,
          typeof thread.name === 'string' ? thread.name : null,
          typeof thread.preview === 'string' ? thread.preview : '',
          typeof thread.cwd === 'string' ? thread.cwd : null,
          status,
          thread.archived === true ? 1 : 0,
          thread.isPinned === true || thread.pinned === true ? 1 : 0,
          typeof thread.modelProvider === 'string'
            ? thread.modelProvider
            : typeof thread.modelProviderId === 'string' ? thread.modelProviderId : null,
          this.sourceKind(thread),
          typeof thread.createdAt === 'number' ? thread.createdAt : null,
          typeof thread.updatedAt === 'number' ? thread.updatedAt : null,
          category,
          'auto',
          '[]',
          '',
          1,
          syncedAt,
        );
      }
      this.db.prepare('UPDATE sync_state SET last_completed_at=?,last_total=? WHERE singleton=1').run(syncedAt, input.length);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listConversations();
  }

  private sourceKind(thread: Record<string, unknown>): string | null {
    for (const value of [thread.sourceKind, thread.threadSource, thread.source]) {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.kind === 'string') return record.kind;
        if (typeof record.type === 'string') return record.type;
        if (record.subAgent && typeof record.subAgent === 'object') {
          const subAgent = record.subAgent as Record<string, unknown>;
          if ('thread_spawn' in subAgent) return 'subAgentThreadSpawn';
          if ('review' in subAgent) return 'subAgentReview';
          if ('compact' in subAgent) return 'subAgentCompact';
          if ('other' in subAgent) return 'subAgentOther';
          return 'subAgent';
        }
        const known = ['cli', 'vscode', 'exec', 'appServer', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
        const key = known.find((candidate) => candidate in record);
        if (key) return key;
      }
    }
    return null;
  }

  getSyncState(): SyncState {
    const row = this.db.prepare('SELECT last_completed_at,last_total FROM sync_state WHERE singleton=1').get() as Row;
    return {
      lastCompletedAt: typeof row.last_completed_at === 'string' ? row.last_completed_at : null,
      lastTotal: Number(row.last_total ?? 0),
    };
  }

  private fromConversationRow(row: Row): Conversation {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(String(row.tags_json ?? '[]')) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch { /* keep empty tags */ }
    return {
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : null,
      preview: String(row.preview ?? ''),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      runtimeStatus: String(row.runtime_status ?? 'notLoaded'),
      archived: Number(row.archived) === 1,
      isPinned: Number(row.is_pinned) === 1,
      modelProvider: typeof row.model_provider === 'string' ? row.model_provider : null,
      sourceKind: typeof row.source_kind === 'string' ? row.source_kind : null,
      createdAt: typeof row.created_at_epoch === 'number' ? row.created_at_epoch : null,
      updatedAt: typeof row.updated_at_epoch === 'number' ? row.updated_at_epoch : null,
      category: String(row.category),
      classificationSource: row.classification_source === 'manual' ? 'manual' : 'auto',
      tags,
      note: String(row.note ?? ''),
      linkedTaskCount: Number(row.linked_task_count ?? 0),
      syncedAt: String(row.synced_at),
    };
  }

  listConversations(): Conversation[] {
    const rows = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.thread_id = c.id) AS linked_task_count
      FROM conversations c WHERE c.available=1
      ORDER BY COALESCE(c.updated_at_epoch, c.created_at_epoch, 0) DESC`).all() as Row[];
    return rows.map((row) => this.fromConversationRow(row));
  }

  listCategories(): string[] {
    const custom = this.db.prepare('SELECT DISTINCT category FROM conversations ORDER BY category').all() as Array<{ category: string }>;
    return Array.from(new Set([...DEFAULT_CATEGORIES, ...custom.map((row) => row.category).filter(Boolean)]));
  }

  updateConversation(id: string, input: { category?: string; tags?: string[]; note?: string }): Conversation {
    const current = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
    if (!current) throw new Error('对话不存在，请先同步');
    const category = input.category?.trim();
    if (category !== undefined && (!category || category.length > 40)) throw new Error('分类名称应为 1—40 个字符');
    const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
    if (tags?.some((tag) => tag.length > 24)) throw new Error('单个标签不能超过 24 个字符');
    const note = input.note?.trim();
    if (note !== undefined && note.length > 2000) throw new Error('备注不能超过 2000 个字符');
    this.db.prepare(`UPDATE conversations SET
      category=COALESCE(?,category),
      classification_source=CASE WHEN ? IS NULL THEN classification_source ELSE 'manual' END,
      tags_json=COALESCE(?,tags_json),
      note=COALESCE(?,note)
      WHERE id=?`).run(category ?? null, category ?? null, tags ? JSON.stringify(tags) : null, note ?? null, id);
    const row = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.thread_id = c.id) AS linked_task_count
      FROM conversations c WHERE c.id=?`).get(id) as Row;
    return this.fromConversationRow(row);
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
    assertWritableSubstatus(lane, substatus);
    if (input.auditor) assertReviewSeparation(input.executor ?? null, input.auditor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  update(id: string, patch: Partial<TaskInput>): Task {
    const current = this.get(id);
    if (current.substatus === 'accepted' || current.substatus === 'closed') {
      throw new Error('已验收或关闭的任务已锁定，不能通过普通编辑改写');
    }
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
    assertWritableSubstatus(next.lane, next.substatus);
    if (next.auditor) assertReviewSeparation(next.executor, next.auditor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  review(id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note: string }): Task {
    const current = this.get(id);
    if (current.lane !== 'review') throw new Error('任务必须先进入“验收和回顾”');
    if (!current.executor) throw new Error('任务必须先指定执行人，才能进行独立验收');
    assertReviewSeparation(current.executor, input.auditor);
    const note = input.note.trim();
    if (!note) throw new Error('请填写验收或回顾说明');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const targetLane = laneForDecision(input.decision);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tasks SET lane=?,substatus=?,auditor=?,updated_at=? WHERE id=?')
        .run(targetLane, input.decision, input.auditor.trim(), now, id);
      if (targetLane !== current.lane) this.addEvent(id, 'system', 'lane_changed', `${current.lane} → ${targetLane}`);
      this.addEvent(id, 'auditor', input.decision, note);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
