import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Command,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  Link2,
  ListFilter,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRound,
  X,
} from 'lucide-react';
import type {
  AuditEvent,
  BootstrapData,
  CodexThreadDetail,
  CodexThreadSummary,
  CreateTaskInput,
  Lane,
  Priority,
  Substatus,
  Task,
} from './types';

const laneMeta: Record<Lane, { title: string; subtitle: string; icon: typeof Inbox }> = {
  plan: { title: '计划中', subtitle: '想法与已就绪任务', icon: Inbox },
  execution: { title: '执行', subtitle: '领取、运行与阻塞', icon: CircleDot },
  review: { title: '验收和回顾', subtitle: '独立审计与闭环', icon: ShieldCheck },
};

const statusText: Record<Substatus, string> = {
  idea: '想法',
  ready: '待执行',
  claimed: '已领取',
  running: '执行中',
  blocked: '阻塞',
  pending_review: '待验收',
  rework: '需返工',
  accepted: '已验收',
  closed: '已回顾',
};

const priorityText: Record<Priority, string> = { low: '低', medium: '中', high: '高' };

function threadTitle(thread: CodexThreadSummary): string {
  return thread.name?.trim() || thread.preview?.trim() || '未命名对话';
}

function shortPath(path?: string | null): string {
  if (!path) return '未设置项目';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function formatTime(input?: number | string): string {
  if (!input) return '—';
  const date = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function extractMessages(detail: CodexThreadDetail | null): Array<{ role: 'user' | 'assistant'; text: string }> {
  if (!detail?.turns) return [];
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const turn of detail.turns) {
    const items = Array.isArray(turn.items) ? (turn.items as Array<Record<string, unknown>>) : [];
    for (const item of items) {
      const type = String(item.type ?? '');
      const role = type.toLowerCase().includes('user') ? 'user' : type.toLowerCase().includes('agent') ? 'assistant' : null;
      if (!role) continue;
      let text = typeof item.text === 'string' ? item.text : '';
      if (!text && Array.isArray(item.content)) {
        text = (item.content as Array<Record<string, unknown>>)
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n');
      }
      if (text.trim()) messages.push({ role, text: text.trim() });
    }
  }
  return messages.slice(-20);
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [codex, setCodex] = useState<BootstrapData['codex']>({ connected: false, version: '—' });
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null;
  const linkedThread = selectedTask?.threadId ? threads.find((thread) => thread.id === selectedTask.threadId) ?? null : null;

  async function bootstrap() {
    setLoading(true);
    try {
      const data = await window.codexTaskboard.bootstrap();
      setTasks(data.tasks);
      setThreads(data.threads);
      setCodex(data.codex);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  const filteredTasks = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => `${task.title} ${task.description} ${task.projectPath ?? ''}`.toLocaleLowerCase().includes(query));
  }, [filter, tasks]);

  const metrics = useMemo(() => ({
    planned: tasks.filter((task) => task.lane === 'plan').length,
    running: tasks.filter((task) => task.lane === 'execution').length,
    completed: tasks.filter((task) => task.substatus === 'accepted' || task.substatus === 'closed').length,
    atRisk: tasks.filter((task) => task.substatus === 'blocked' || task.substatus === 'rework').length,
  }), [tasks]);

  async function createTask(input: CreateTaskInput) {
    try {
      const task = await window.codexTaskboard.createTask(input);
      setTasks((current) => [task, ...current]);
      setCreateOpen(false);
      setSelectedId(task.id);
      setNotice({ tone: 'success', text: '任务已创建' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function moveTask(task: Task, lane: Lane) {
    if (task.lane === lane) return;
    try {
      const updated = await window.codexTaskboard.updateTask(task.id, { lane });
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  function replaceTask(updated: Task) {
    setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand-row">
          <div className="brand-mark"><Command size={16} strokeWidth={2.2} /></div>
          <span>Codex</span>
          <ChevronDown size={14} className="muted-icon" />
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <button type="button" onClick={() => setCreateOpen(true)}><Plus size={17} />新任务</button>
          <button type="button"><MessageSquareText size={17} />全部对话<span className="nav-count">{threads.length}</span></button>
          <button type="button" className="active"><LayoutDashboard size={17} />任务看板</button>
          <button type="button"><Clock3 size={17} />已安排</button>
          <button type="button"><Archive size={17} />已归档</button>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">工作流</div>
          <button type="button" className="workflow-row"><Inbox size={14} />计划中<span>{tasks.filter((t) => t.lane === 'plan').length}</span></button>
          <button type="button" className="workflow-row"><CircleDot size={14} />执行<span>{tasks.filter((t) => t.lane === 'execution').length}</span></button>
          <button type="button" className="workflow-row"><ShieldCheck size={14} />验收和回顾<span>{tasks.filter((t) => t.lane === 'review').length}</span></button>
        </div>

        <div className="sidebar-section projects">
          <div className="section-label">最近项目</div>
          {Array.from(new Set(threads.map((thread) => thread.cwd).filter(Boolean))).slice(0, 5).map((cwd) => (
            <div className="project-row" key={cwd}><span className="folder-dot" />{shortPath(cwd)}</div>
          ))}
          {!threads.length && <div className="empty-sidebar">等待 Codex 连接</div>}
        </div>

        <div className="connection-card">
          <span className={`connection-dot ${codex.connected ? 'online' : ''}`} />
          <div><strong>{codex.connected ? 'Codex 已连接' : 'Codex 未连接'}</strong><small>{codex.version}</small></div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>任务管理</h1>
            <div className="eyebrow">高效规划 · 智能协同 · 结果驱动</div>
          </div>
          <div className="top-actions">
            <label className="search-box">
              <Search size={15} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索任务、项目或对话…" aria-label="搜索任务" />
              <kbd>⌘ K</kbd>
            </label>
            <button type="button" className="icon-button" onClick={() => void bootstrap()} title="刷新"><RefreshCw size={16} /></button>
            <button type="button" className="icon-button notification-button" title="通知"><Bell size={16} /><span /></button>
            <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={16} />新增任务</button>
          </div>
        </header>

        <section className="metric-grid" aria-label="任务概览">
          <MetricCard tone="plan" icon={ClipboardCheck} label="计划中" value={metrics.planned} detail="等待梳理与领取" />
          <MetricCard tone="execution" icon={TrendingUp} label="执行中" value={metrics.running} detail="已进入工作流" />
          <MetricCard tone="complete" icon={CheckCircle2} label="已闭环" value={metrics.completed} detail="已验收或回顾" />
          <MetricCard tone="risk" icon={AlertTriangle} label="风险任务" value={metrics.atRisk} detail="阻塞或待返工" />
        </section>

        <div className="board-toolbar">
          <div><strong>任务看板</strong><span className="board-summary"><b>{tasks.length}</b> 个任务 · <b>{tasks.filter((t) => t.substatus === 'pending_review').length}</b> 个待验收</span></div>
          <button type="button" className="quiet-button"><ListFilter size={15} />筛选</button>
        </div>

        <section className="board" aria-label="任务看板">
          {(Object.keys(laneMeta) as Lane[]).map((lane) => (
            <BoardColumn
              key={lane}
              lane={lane}
              tasks={filteredTasks.filter((task) => task.lane === lane)}
              threads={threads}
              loading={loading}
              onSelect={setSelectedId}
              onMove={async (taskId, targetLane) => {
                const task = tasks.find((item) => item.id === taskId);
                if (task) await moveTask(task, targetLane);
              }}
              onCreate={() => setCreateOpen(true)}
            />
          ))}
        </section>
      </main>

      {selectedTask && (
        <TaskPanel
          task={selectedTask}
          thread={linkedThread}
          onClose={() => setSelectedId(null)}
          onTaskChange={replaceTask}
          onNotice={setNotice}
        />
      )}

      {createOpen && <CreateTaskModal threads={threads} onClose={() => setCreateOpen(false)} onCreate={createTask} />}
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.tone === 'success' ? <Check size={16} /> : <CircleDot size={16} />}{notice.text}<button type="button" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </div>
  );
}

function MetricCard({ tone, icon: Icon, label, value, detail }: {
  tone: 'plan' | 'execution' | 'complete' | 'risk';
  icon: typeof Inbox;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
      <span className="metric-icon"><Icon size={21} strokeWidth={1.8} /></span>
    </article>
  );
}

function BoardColumn({ lane, tasks, threads, loading, onSelect, onMove, onCreate }: {
  lane: Lane;
  tasks: Task[];
  threads: CodexThreadSummary[];
  loading: boolean;
  onSelect(id: string): void;
  onMove(taskId: string, lane: Lane): Promise<void>;
  onCreate(): void;
}) {
  const meta = laneMeta[lane];
  const Icon = meta.icon;
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      className={`board-column lane-${lane} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const id = event.dataTransfer.getData('text/task-id');
        if (id) void onMove(id, lane);
      }}
    >
      <div className="column-header">
        <div className="column-title"><span className="lane-icon"><Icon size={14} /></span><strong>{meta.title}</strong><span className="column-count">{tasks.length}</span></div>
        <div className="column-actions"><button type="button" onClick={onCreate} aria-label={`在${meta.title}新增任务`}><Plus size={15} /></button><button type="button" aria-label="更多"><MoreHorizontal size={15} /></button></div>
        <p>{meta.subtitle}</p>
      </div>
      <div className="card-list">
        {loading && <div className="column-empty"><LoaderCircle className="spin" size={18} />正在读取本机任务</div>}
        {!loading && tasks.map((task) => {
          const linked = task.threadId ? threads.find((thread) => thread.id === task.threadId) : null;
          return (
            <article
              className="task-card"
              key={task.id}
              draggable
              onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)}
              onClick={() => onSelect(task.id)}
            >
              <div className="card-topline"><span className={`status-chip status-${task.substatus}`}>{statusText[task.substatus]}</span><span className={`priority priority-${task.priority}`}>{priorityText[task.priority]}</span></div>
              <h3>{task.title}</h3>
              {task.description && <p>{task.description}</p>}
              <div className="card-project"><span className="folder-dot" />{shortPath(task.projectPath || linked?.cwd)}</div>
              <div className="card-footer">
                <span>{linked ? <><Link2 size={13} />{threadTitle(linked).slice(0, 22)}</> : <><MessageSquareText size={13} />未关联对话</>}</span>
                {task.lane === 'review' && <ShieldCheck size={14} className="review-mark" />}
                {task.executor && <span className="avatar" title={`执行人：${task.executor}`}>{task.executor.slice(0, 1).toUpperCase()}</span>}
              </div>
            </article>
          );
        })}
        {!loading && !tasks.length && <div className="column-empty"><Sparkles size={18} /><strong>这里还没有任务</strong><span>拖入任务，或直接新增</span><button type="button" onClick={onCreate}><Plus size={14} />新增任务</button></div>}
      </div>
    </div>
  );
}

function CreateTaskModal({ threads, onClose, onCreate }: { threads: CodexThreadSummary[]; onClose(): void; onCreate(input: CreateTaskInput): Promise<void> }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lane, setLane] = useState<Lane>('plan');
  const [priority, setPriority] = useState<Priority>('medium');
  const [threadId, setThreadId] = useState('');
  const [executor, setExecutor] = useState('');
  const [criteria, setCriteria] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onCreate({
      title,
      description,
      lane,
      substatus: lane === 'plan' ? 'idea' : undefined,
      priority,
      threadId: threadId || null,
      projectPath: threads.find((thread) => thread.id === threadId)?.cwd ?? null,
      executor: executor || null,
      acceptanceCriteria: criteria,
    });
    setSaving(false);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-header"><div><span>新建</span><h2>新增任务</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div>
        <div className="form-stack">
          <label className="field"><span>任务标题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="要完成什么？" /></label>
          <label className="field"><span>描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="补充上下文、边界或预期结果" rows={3} /></label>
          <div className="field-grid three">
            <label className="field"><span>所在阶段</span><select value={lane} onChange={(event) => setLane(event.target.value as Lane)}><option value="plan">计划中</option><option value="execution">执行</option><option value="review">验收和回顾</option></select></label>
            <label className="field"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            <label className="field"><span>执行人</span><input value={executor} onChange={(event) => setExecutor(event.target.value)} placeholder="可稍后填写" /></label>
          </div>
          <label className="field"><span>关联 Codex 对话</span><select value={threadId} onChange={(event) => setThreadId(event.target.value)}><option value="">暂不关联</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)} · {shortPath(thread.cwd)}</option>)}</select><small>读取本机真实对话；任务只保存关联 ID。</small></label>
          <label className="field"><span>验收标准</span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="哪些证据满足后才算完成？" rows={2} /></label>
        </div>
        <div className="modal-footer"><span>⌘ ↵ 创建任务</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!title.trim() || saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建任务</button></div></div>
      </form>
    </div>
  );
}

function TaskPanel({ task, thread, onClose, onTaskChange, onNotice }: {
  task: Task;
  thread: CodexThreadSummary | null;
  onClose(): void;
  onTaskChange(task: Task): void;
  onNotice(value: { tone: 'error' | 'success'; text: string }): void;
}) {
  const [tab, setTab] = useState<'task' | 'thread'>('task');
  const [detail, setDetail] = useState<CodexThreadDetail | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [message, setMessage] = useState('');
  const [auditor, setAuditor] = useState(task.auditor ?? '');
  const [reviewNote, setReviewNote] = useState('');
  const messages = extractMessages(detail);

  useEffect(() => {
    setDetail(null);
    setTab('task');
    setAuditor(task.auditor ?? '');
    void window.codexTaskboard.listAuditEvents(task.id).then(setEvents);
  }, [task.id]);

  useEffect(() => {
    if (tab !== 'thread' || !task.threadId || detail) return;
    setLoadingThread(true);
    void window.codexTaskboard.readThread(task.threadId)
      .then(setDetail)
      .catch((error) => onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
      .finally(() => setLoadingThread(false));
  }, [detail, onNotice, tab, task.threadId]);

  async function patchTask(patch: Partial<Task>) {
    try {
      const updated = await window.codexTaskboard.updateTask(task.id, patch);
      onTaskChange(updated);
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function review(decision: 'accepted' | 'rework' | 'closed') {
    try {
      const updated = await window.codexTaskboard.reviewTask(task.id, { auditor, decision, note: reviewNote });
      onTaskChange(updated);
      setEvents(await window.codexTaskboard.listAuditEvents(task.id));
      setReviewNote('');
      onNotice({ tone: 'success', text: decision === 'rework' ? '任务已退回执行' : '验收记录已保存' });
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function sendMessage() {
    if (!task.threadId || !message.trim()) return;
    try {
      await window.codexTaskboard.sendToThread(task.threadId, message.trim());
      setMessage('');
      onNotice({ tone: 'success', text: '已提交到关联 Codex 对话' });
      setTimeout(() => {
        void window.codexTaskboard.readThread(task.threadId!).then(setDetail);
      }, 1200);
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <aside className="detail-panel">
      <div className="panel-header">
        <div className="panel-tabs"><button type="button" className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>任务</button><button type="button" className={tab === 'thread' ? 'active' : ''} onClick={() => setTab('thread')}>关联对话</button></div>
        <button type="button" className="icon-button" onClick={onClose}><X size={17} /></button>
      </div>

      {tab === 'task' ? (
        <div className="panel-scroll">
          <div className="task-heading"><span className={`status-chip status-${task.substatus}`}>{statusText[task.substatus]}</span><h2>{task.title}</h2><p>{task.description || '暂无任务描述。'}</p></div>
          <div className="detail-section">
            <h3>任务属性</h3>
            <div className="property-row"><span><CircleDot size={14} />阶段</span><select value={task.lane} onChange={(event) => void patchTask({ lane: event.target.value as Lane })}><option value="plan">计划中</option><option value="execution">执行</option><option value="review">验收和回顾</option></select></div>
            <div className="property-row"><span><UserRound size={14} />执行人</span><input defaultValue={task.executor ?? ''} placeholder="未分配" onBlur={(event) => void patchTask({ executor: event.target.value })} /></div>
            <div className="property-row"><span><ClipboardCheck size={14} />验收人</span><strong>{task.auditor || '待独立分配'}</strong></div>
            <div className="property-row"><span><Link2 size={14} />对话</span><button type="button" className="inline-link" disabled={!thread} onClick={() => setTab('thread')}>{thread ? threadTitle(thread).slice(0, 25) : '未关联'}</button></div>
          </div>
          <div className="detail-section"><h3>验收标准</h3><textarea className="criteria-box" defaultValue={task.acceptanceCriteria} placeholder="尚未填写验收标准" onBlur={(event) => void patchTask({ acceptanceCriteria: event.target.value })} /></div>
          <div className="insight-box">
            <div className="insight-title"><Sparkles size={16} /><strong>智能验收提示</strong></div>
            <ul>
              <li className={task.acceptanceCriteria ? 'done' : ''}>{task.acceptanceCriteria ? '验收标准已记录' : '补充可验证的验收标准'}</li>
              <li className={task.threadId ? 'done' : ''}>{task.threadId ? '执行对话可追溯' : '关联执行该任务的 Codex 对话'}</li>
              <li className={task.auditor && task.auditor !== task.executor ? 'done' : ''}>{task.auditor && task.auditor !== task.executor ? '独立验收角色已分离' : '指定与执行人不同的审计角色'}</li>
            </ul>
          </div>
          {task.lane === 'review' && (
            <div className="review-box">
              <div className="review-title"><ShieldCheck size={17} /><div><strong>独立验收</strong><span>验收人与执行人不能相同</span></div></div>
              <label className="field"><span>验收人</span><input value={auditor} onChange={(event) => setAuditor(event.target.value)} placeholder="输入审计角色名称" /></label>
              <label className="field"><span>证据与回顾</span><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} placeholder="记录验证结果、缺口或后续动作" /></label>
              <div className="review-actions"><button type="button" className="secondary-button danger-text" onClick={() => void review('rework')}>退回执行</button><button type="button" className="secondary-button" onClick={() => void review('closed')}>仅回顾关闭</button><button type="button" className="accept-button" onClick={() => void review('accepted')}><ShieldCheck size={14} />通过验收</button></div>
            </div>
          )}
          <div className="detail-section"><h3>审计轨迹</h3><div className="timeline">{events.map((event) => <div className="timeline-event" key={event.id}><span className="timeline-dot" /><div><strong>{event.action}</strong><p>{event.note}</p><small>{event.actorRole} · {formatTime(event.createdAt)}</small></div></div>)}{!events.length && <p className="empty-copy">尚无记录</p>}</div></div>
        </div>
      ) : (
        <div className="thread-pane">
          <div className="thread-context">
            <div><Bot size={17} /><span><strong>{thread ? threadTitle(thread) : '未关联对话'}</strong><small>{thread ? shortPath(thread.cwd) : '请先在任务中关联一个 Codex 对话'}</small></span></div>
            {task.threadId && <button type="button" className="quiet-button" onClick={() => void window.codexTaskboard.openThreadInCodex(task.threadId!)}><ExternalLink size={14} />在 Codex 打开</button>}
          </div>
          <div className="messages">
            {loadingThread && <div className="column-empty"><LoaderCircle className="spin" size={18} />读取对话记录</div>}
            {!loadingThread && messages.map((item, index) => <div className={`message ${item.role}`} key={`${item.role}-${index}`}><div className="message-role">{item.role === 'user' ? <UserRound size={13} /> : <Bot size={13} />}{item.role === 'user' ? '你' : 'Codex'}</div><p>{item.text}</p></div>)}
            {!loadingThread && task.threadId && !messages.length && <div className="column-empty"><MessageSquareText size={18} /><strong>对话已关联</strong><span>当前版本未解析出可显示的文本消息</span></div>}
            {!task.threadId && <div className="column-empty"><Link2 size={18} /><strong>未关联 Codex 对话</strong><span>编辑任务时选择一个本机对话</span></div>}
          </div>
          {task.threadId && <div className="composer"><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="继续这个 Codex 对话…" rows={2} /><div><span>通过本机 App Server 提交</span><button type="button" className="send-button" disabled={!message.trim()} onClick={() => void sendMessage()}><Send size={15} /></button></div></div>}
        </div>
      )}
    </aside>
  );
}

export default App;
