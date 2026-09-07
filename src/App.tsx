import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Archive,
  AlertTriangle,
  Bell,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Command,
  ExternalLink,
  FileDiff,
  Inbox,
  ImagePlus,
  LayoutDashboard,
  Link2,
  ListFilter,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MoreHorizontal,
  Plus,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TimerReset,
  TrendingUp,
  UserRound,
  X,
} from 'lucide-react';
import type {
  AuditEvent,
  ApprovalDecision,
  BootstrapData,
  CodexModelOption,
  CodexThreadDetail,
  CodexThreadSummary,
  ComposerImage,
  CreateTaskInput,
  ExecutionSnapshot,
  ExecutionPermissionPreset,
  Lane,
  Priority,
  Substatus,
  Task,
} from './types';
import { refreshThreadsAfterTaskCreation } from './conversationSync';
import { ConversationPanel, ConversationView } from './ConversationView';
import { codexHandoffNotice, openCodexThreadWithNotice } from './codexOpen';

type AppView = 'board' | 'conversations' | 'archive';
type AppNotice = { tone: 'error' | 'success'; text: string; actionLabel?: string; onAction?: () => void | Promise<void> };
type TaskProjectOption = { path: string; label: string; category: string; activity: number; updatedAt: number };
type WorkboardNotification = {
  id: string;
  kind: 'approval' | 'risk' | 'review' | 'sync';
  taskId?: string;
  title: string;
  detail: string;
  updatedAt: string;
};

const laneMeta: Record<Lane, { title: string; subtitle: string; icon: typeof Inbox }> = {
  plan: { title: '计划中', subtitle: '想法与已就绪任务', icon: Inbox },
  execution: { title: '执行', subtitle: '领取、运行与阻塞', icon: CircleDot },
  review: { title: '验收和回顾', subtitle: '用户确认或 AI 验收', icon: ShieldCheck },
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
const executionStatusText: Record<ExecutionSnapshot['status'], string> = {
  idle: '尚未执行',
  running: '实时执行中',
  waiting_approval: '等待审批',
  waiting_input: '等待回答',
  completed: '执行已完成',
  failed: '执行失败',
  interrupted: '执行已中断',
};
const effortText: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '自动调度' };
const codexStateText: Record<BootstrapData['codex']['state'], string> = {
  idle: '尚未启动',
  starting: '正在预检',
  ready: '协议已就绪',
  version_incompatible: '驱动版本不兼容',
  auth_required: '需要登录',
  protocol_incompatible: '协议不兼容',
  error: '连接错误',
};

function threadTitle(thread: CodexThreadSummary): string {
  return thread.name?.trim() || thread.preview?.trim() || '未命名对话';
}

function shortPath(path?: string | null): string {
  if (!path) return '未设置项目';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || '操作失败，请稍后重试';
}

function formatTime(input?: number | string): string {
  if (!input) return '-';
  const date = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDate(input?: string | null): string {
  const date = input ? new Date(input) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

function dateInputValue(input?: string | null): string {
  const date = input ? new Date(input) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function projectForTask(task: Task, threads: CodexThreadSummary[]): string {
  const thread = task.threadId ? threads.find((item) => item.id === task.threadId) : null;
  return task.projectName || thread?.category || shortPath(task.projectPath) || '未分类项目';
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
  const [executions, setExecutions] = useState<Record<string, ExecutionSnapshot>>({});
  const executionRef = useRef<Record<string, ExecutionSnapshot>>({});
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [sync, setSync] = useState<BootstrapData['sync']>({
    total: 0,
    active: 0,
    unarchived: 0,
    archived: 0,
    lastSyncedAt: null,
    stale: false,
    skipped: false,
    migratedTaskCount: 0,
    archivedTaskCount: 0,
  });
  const [codex, setCodex] = useState<BootstrapData['codex']>({ connected: false, state: 'idle', version: 'unknown', expectedVersion: 'unknown', accountChecked: false, modelListChecked: false });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<AppView>('board');
  const [createOpen, setCreateOpen] = useState(false);
  const [createThreadId, setCreateThreadId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectedProject, setSelectedProject] = useState('全部项目');
  const [selectedLane, setSelectedLane] = useState<Lane | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);
  const notificationButtonRef = useRef<HTMLButtonElement>(null);
  const archiveEligibleCount = tasks.filter((task) => task.substatus === 'accepted' || task.substatus === 'closed').length;

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const batchSelectedTasks = tasks.filter((task) => selectedTaskIds.has(task.id));
  const batchReviewableCount = batchSelectedTasks.filter((task) => task.lane === 'review' && task.substatus !== 'accepted' && task.substatus !== 'closed').length;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedConversationId = selectedTask?.threadId || (selectedTask ? executions[selectedTask.id]?.threadId : null) || null;
  const linkedThread = selectedConversationId ? threads.find((thread) => thread.id === selectedConversationId) ?? null : null;

  async function bootstrap() {
    setLoading(true);
    try {
      const data = await window.codexTaskboard.bootstrap();
      setTasks(data.tasks);
      const executionMap = Object.fromEntries(data.executions.map((snapshot) => [snapshot.taskId, snapshot]));
      executionRef.current = executionMap;
      setExecutions(executionMap);
      setThreads(data.threads);
      setCategories(data.categories);
      setSync(data.sync);
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

  useEffect(() => window.codexTaskboard.onExecutionEvent(({ snapshot, task }) => {
    const previous = executionRef.current[snapshot.taskId];
    executionRef.current = { ...executionRef.current, [snapshot.taskId]: snapshot };
    setExecutions(executionRef.current);
    replaceTask(task);
    if (previous?.status !== snapshot.status) {
      if (snapshot.status === 'waiting_approval') setNotice({ tone: 'error', text: `“${task.title}”等待审批` });
      if (snapshot.status === 'waiting_input') setNotice({ tone: 'error', text: `“${task.title}”等待回答` });
      if (snapshot.status === 'completed') setNotice({ tone: 'success', text: `“${task.title}”执行完成，已进入验收` });
      if (snapshot.status === 'failed' || snapshot.status === 'interrupted') setNotice({ tone: 'error', text: `“${task.title}”执行受阻，请查看实时执行` });
    }
  }), []);

  const projectOptions = useMemo(() => Array.from(new Set(tasks.map((task) => projectForTask(task, threads)))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [tasks, threads]);
  const taskProjectOptions = useMemo<TaskProjectOption[]>(() => {
    const byCategory = new Map<string, Map<string, TaskProjectOption>>();
    const collect = (category: string, projectPath: string, updatedAt: number) => {
      if (!category || !projectPath) return;
      const paths = byCategory.get(category) ?? new Map<string, TaskProjectOption>();
      const existing = paths.get(projectPath);
      if (existing) {
        existing.activity += 1;
        existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
      } else {
        paths.set(projectPath, { path: projectPath, category, label: category, activity: 1, updatedAt });
      }
      byCategory.set(category, paths);
    };
    for (const thread of threads) {
      if (!thread.archived && thread.cwd) collect(thread.category, thread.cwd, thread.updatedAt ?? 0);
    }
    for (const task of tasks) {
      if (!task.projectPath) continue;
      collect(task.projectName || projectForTask(task, threads), task.projectPath, new Date(task.updatedAt).getTime() / 1000);
    }
    return Array.from(byCategory.entries()).flatMap(([category, paths]) => {
      const candidates = Array.from(paths.values());
      return [candidates.sort((a, b) => b.activity - a.activity || b.updatedAt - a.updatedAt)[0]];
    }).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [tasks, threads]);
  const defaultCreateProjectPath = useMemo(() => {
    if (selectedProject === '全部项目') return '';
    return taskProjectOptions.find((project) => project.category === selectedProject)?.path ?? '';
  }, [selectedProject, taskProjectOptions]);

  const filteredTasks = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      const project = projectForTask(task, threads);
      const projectMatch = selectedProject === '全部项目' || project === selectedProject;
      const laneMatch = selectedLane === null || task.lane === selectedLane;
      const queryMatch = !query || `${task.title} ${task.description} ${task.projectPath ?? ''} ${project}`.toLocaleLowerCase().includes(query);
      return projectMatch && laneMatch && queryMatch;
    });
  }, [filter, selectedLane, selectedProject, tasks, threads]);

  const notifications = useMemo<WorkboardNotification[]>(() => {
    const items = new Map<string, WorkboardNotification>();
    for (const task of tasks) {
      const execution = executions[task.id];
      if (execution?.status === 'waiting_approval' || execution?.status === 'waiting_input') {
        items.set(task.id, {
          id: `approval-${task.id}`,
          kind: 'approval',
          taskId: task.id,
          title: `等待审批：${task.title}`,
          detail: execution.pendingApproval?.reason || execution.pendingUserInput?.questions[0]?.question || 'Codex 正在等待你确认下一步操作',
          updatedAt: execution.updatedAt,
        });
        continue;
      }
      if (task.substatus === 'blocked' || task.substatus === 'rework' || execution?.status === 'failed' || execution?.status === 'interrupted') {
        items.set(task.id, {
          id: `risk-${task.id}`,
          kind: 'risk',
          taskId: task.id,
          title: `${task.substatus === 'rework' ? '需要返工' : '执行受阻'}：${task.title}`,
          detail: execution?.error || execution?.lastMessage || '请查看实时执行和阻塞原因',
          updatedAt: execution?.updatedAt || task.updatedAt,
        });
        continue;
      }
      if (task.substatus === 'pending_review') {
        items.set(task.id, {
          id: `review-${task.id}`,
          kind: 'review',
          taskId: task.id,
          title: `等待验收：${task.title}`,
          detail: '可由你直接确认，或发起 AI 验收',
          updatedAt: task.updatedAt,
        });
      }
    }
    if (sync.stale) {
      items.set('sync-stale', {
        id: 'sync-stale',
        kind: 'sync',
        title: 'Codex 同步已中断',
        detail: sync.lastSyncedAt ? `上次同步 ${formatTime(sync.lastSyncedAt)}，点击重新连接` : '当前使用本地缓存，点击重新连接',
        updatedAt: sync.lastSyncedAt || new Date(0).toISOString(),
      });
    }
    const priority = { approval: 0, sync: 1, risk: 2, review: 3 } as const;
    return Array.from(items.values()).sort((a, b) => priority[a.kind] - priority[b.kind] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [executions, sync.lastSyncedAt, sync.stale, tasks]);

  const metrics = useMemo(() => ({
    planned: filteredTasks.filter((task) => task.lane === 'plan').length,
    running: filteredTasks.filter((task) => task.lane === 'execution').length,
    completed: tasks.filter((task) => task.substatus === 'accepted' || task.substatus === 'closed').length + sync.archivedTaskCount,
    completedActive: tasks.filter((task) => task.substatus === 'accepted' || task.substatus === 'closed').length,
    atRisk: filteredTasks.filter((task) => task.substatus === 'blocked' || task.substatus === 'rework').length,
  }), [filteredTasks, sync.archivedTaskCount, tasks]);

  useEffect(() => {
    if (!notificationOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!notificationRef.current?.contains(event.target as Node)) setNotificationOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setNotificationOpen(false);
      notificationButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [notificationOpen]);

  async function archiveCompleted() {
    setMaintenanceBusy(true);
    try {
      const result = await window.codexTaskboard.archiveCompletedTasks();
      if (result.archivedTaskIds.length) {
        const archived = new Set(result.archivedTaskIds);
        setTasks((current) => current.filter((task) => !archived.has(task.id)));
        setSelectedTaskId((current) => current && archived.has(current) ? null : current);
        setSync((current) => ({ ...current, archivedTaskCount: current.archivedTaskCount + result.archived }));
      }
      setNotice({ tone: 'success', text: result.archived ? `已归档 ${result.archived} 个已完成任务` : '没有已验收或已回顾的任务可归档' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function createTask(input: CreateTaskInput) {
    try {
      const task = await window.codexTaskboard.createTask(input);
      setTasks((current) => [task, ...current]);
      let nextThreads = threads;
      if (input.createConversation && task.threadId) {
        try {
          const syncedThreads = await refreshThreadsAfterTaskCreation({
            createConversation: input.createConversation,
            threadId: task.threadId,
            syncSkipped: sync.skipped,
            listThreads: () => window.codexTaskboard.listThreads(),
          });
          if (syncedThreads) {
            nextThreads = syncedThreads;
            setThreads(syncedThreads);
            setCategories(Array.from(new Set(syncedThreads.map((thread) => thread.category))).sort((a, b) => a.localeCompare(b, 'zh-CN')));
          }
        } catch {
          setNotice({ tone: 'error', text: '任务和新会话已创建；对话目录将在下次刷新时显示' });
        }
      } else if (task.threadId) {
        setThreads((current) => current.map((thread) => thread.id === task.threadId ? { ...thread, linkedTaskCount: thread.linkedTaskCount + 1 } : thread));
      }
      setCreateOpen(false);
      setCreateThreadId(null);
      setView('board');
      setFilter('');
      setSelectedLane(null);
      setSelectedProject(projectForTask(task, nextThreads));
      setSelectedThreadId(null);
      setSelectedTaskId(task.id);
      setNotice(task.conversationLaunchError
        ? { tone: 'error', text: `任务已保留，但 Codex 会话未能启动：${task.conversationLaunchError}` }
        : { tone: 'success', text: input.createConversation
          ? sync.skipped ? '任务已创建，Codex 已开始处理；隔离模式未刷新既有会话目录' : '任务已创建，Codex 已开始处理'
          : '任务已创建并已定位' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function bulkCreateTasks() {
    setBulkBusy(true);
    try {
      const result = await window.codexTaskboard.bulkCreateTasks();
      if (result.tasks.length) {
        setTasks((current) => [...result.tasks, ...current]);
        const linked = new Set(result.tasks.map((task) => task.threadId).filter(Boolean));
        setThreads((current) => current.map((thread) => linked.has(thread.id) ? { ...thread, linkedTaskCount: thread.linkedTaskCount + 1 } : thread));
      }
      setNotice({
        tone: 'success',
        text: result.created
          ? `已生成 ${result.created} 个任务：计划 ${result.byLane.plan}、执行 ${result.byLane.execution}、验收 ${result.byLane.review}`
          : '所有对话都已关联任务，没有重复创建',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBulkBusy(false);
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

  function toggleTaskSelection(taskId: string) {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  async function batchMoveTasks(lane: Lane) {
    const targets = batchSelectedTasks.filter((task) => task.lane !== lane && task.substatus !== 'accepted' && task.substatus !== 'closed');
    if (!targets.length) {
      setNotice({ tone: 'error', text: '选中任务没有可迁移项；终态任务不会被修改' });
      return;
    }
    const results = await Promise.allSettled(targets.map((task) => window.codexTaskboard.updateTask(task.id, { lane })));
    const updated = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const updatedById = new Map(updated.map((task) => [task.id, task]));
    setTasks((current) => current.map((task) => updatedById.get(task.id) ?? task));
    setSelectedTaskIds(new Set());
    setSelectionMode(false);
    const failed = results.length - updated.length;
    setNotice({ tone: failed ? 'error' : 'success', text: `已将 ${updated.length} 个任务迁移到${laneMeta[lane].title}${failed ? `，${failed} 个未能迁移` : ''}` });
  }

  async function batchAcceptTasks() {
    const targets = batchSelectedTasks.filter((task) => task.lane === 'review' && task.substatus !== 'accepted' && task.substatus !== 'closed');
    if (!targets.length) {
      setNotice({ tone: 'error', text: '请选择“验收和回顾”中的待验收任务' });
      return;
    }
    const results = await Promise.allSettled(targets.map((task) => window.codexTaskboard.reviewTask(task.id, {
      auditor: '用户',
      reviewerType: 'user',
      decision: 'accepted',
      note: '用户批量验收通过',
    })));
    const updated = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const updatedById = new Map(updated.map((task) => [task.id, task]));
    setTasks((current) => current.map((task) => updatedById.get(task.id) ?? task));
    setSelectedTaskIds(new Set());
    setSelectionMode(false);
    const failed = results.length - updated.length;
    setNotice({ tone: failed ? 'error' : 'success', text: `已验收 ${updated.length} 个任务${failed ? `，${failed} 个未通过状态校验` : ''}` });
  }

  async function setTaskPriority(taskId: string, priority: Priority) {
    try {
      const updated = await window.codexTaskboard.updateTask(taskId, { priority });
      replaceTask(updated);
      setNotice({ tone: 'success', text: `优先级已设为${priorityText[priority]}` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function restoreArchivedTask(taskId: string) {
    try {
      const restored = await window.codexTaskboard.restoreTask(taskId);
      setTasks((current) => current.some((task) => task.id === restored.id) ? current : [restored, ...current]);
      setSync((current) => ({ ...current, archivedTaskCount: Math.max(0, current.archivedTaskCount - 1) }));
      setNotice({ tone: 'success', text: `已恢复“${restored.title}”` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function archiveTaskFromCard(task: Task) {
    try {
      await window.codexTaskboard.archiveTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setSelectedTaskIds((current) => { const next = new Set(current); next.delete(task.id); return next; });
      setSelectedTaskId((current) => current === task.id ? null : current);
      setSync((current) => ({ ...current, archivedTaskCount: current.archivedTaskCount + 1 }));
      setNotice({
        tone: 'success',
        text: `已归档“${task.title}”`,
        actionLabel: '撤销',
        onAction: () => restoreArchivedTask(task.id),
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  function replaceTask(updated: Task) {
    setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function openThreadInCodex(threadId: string) {
    const notice = await openCodexThreadWithNotice(threadId, window.codexTaskboard.openThreadInCodex, userFacingError);
    if (notice) setNotice(notice);
  }

  async function openTaskInCodex(task: Task) {
    if (!task.threadId) return;
    const execution = executionRef.current[task.id];
    const live = execution?.status === 'running' || execution?.status === 'waiting_approval' || execution?.status === 'waiting_input';
    if (!live) {
      await openThreadInCodex(task.threadId);
      return;
    }
    if (!window.confirm('这段对话当前由 Workboard 执行。转到 Codex 会中断当前回合并释放会话，确认继续？')) return;
    try {
      const result = await window.codexTaskboard.handoffToCodex({ taskId: task.id, threadId: task.threadId });
      replaceTask(result.task);
      setNotice(codexHandoffNotice(result.openResult));
    } catch (error) {
      setNotice({ tone: 'error', text: userFacingError(error) });
    }
  }

  function switchView(next: AppView) {
    setView(next);
    setSelectionMode(false);
    setSelectedTaskIds(new Set());
    if (next === 'board') setSelectedLane(null);
    setSelectedTaskId(null);
    setSelectedThreadId(null);
    setFilter('');
  }

  function selectWorkflow(lane: Lane) {
    setView('board');
    setSelectedLane((current) => current === lane ? null : lane);
    setSelectedTaskId(null);
    setSelectedThreadId(null);
    setFilter('');
  }

  function openCreate(threadId: string | null = null) {
    setCreateThreadId(threadId);
    setCreateOpen(true);
  }

  function openNotification(notification: WorkboardNotification) {
    setNotificationOpen(false);
    if (notification.kind === 'sync') {
      void bootstrap();
      return;
    }
    if (!notification.taskId) return;
    setView('board');
    setSelectedLane(null);
    setSelectedProject('全部项目');
    setFilter('');
    setSelectedThreadId(null);
    setSelectedTaskId(notification.taskId);
  }

  const viewTitle = view === 'board' ? '任务管理' : view === 'conversations' ? '全部对话' : '已归档';
  const viewSubtitle = view === 'board' ? '高效规划 · 智能协同 · 结果驱动' : view === 'conversations' ? '统一检索、分类和关联当前 Codex 对话' : '保留历史上下文，按分类快速回查';
  const uncategorized = threads.filter((thread) => !thread.archived && thread.category === '未分类').length;
  const linkedConversations = threads.filter((thread) => !thread.archived && thread.linkedTaskCount > 0).length;

  return (
    <div className={`app-shell platform-${window.codexTaskboard.platform}`}>
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand-row">
          <div className="brand-mark"><Command size={16} strokeWidth={2.2} /></div>
          <span>Workboard</span>
          <ChevronDown size={14} className="muted-icon" />
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <button type="button" onClick={() => openCreate()}><Plus size={17} />新任务</button>
          <button type="button" className={view === 'conversations' ? 'active' : ''} onClick={() => switchView('conversations')}><MessageSquareText size={17} />全部对话<span className="nav-count">{sync.active}</span></button>
          <button type="button" className={view === 'board' ? 'active' : ''} onClick={() => switchView('board')}><LayoutDashboard size={17} />任务看板</button>
          <button type="button" className={view === 'archive' ? 'active' : ''} onClick={() => switchView('archive')}><Archive size={17} />已归档<span className="nav-count">{sync.archived}</span></button>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">工作流</div>
          {(Object.keys(laneMeta) as Lane[]).map((lane) => {
            const meta = laneMeta[lane];
            const Icon = meta.icon;
            const active = view === 'board' && selectedLane === lane;
            return <button type="button" className={`workflow-row ${active ? 'active' : ''}`} data-lane={lane} aria-pressed={active} key={lane} onClick={() => selectWorkflow(lane)} title={active ? `取消${meta.title}筛选` : `只看${meta.title}任务`}><Icon size={14} />{meta.title}<span>{tasks.filter((task) => task.lane === lane).length}</span></button>;
          })}
        </div>

        <div className="sidebar-section projects">
          <div className="section-label">最近项目</div>
          {projectOptions.slice(0, 6).map((project) => (
            <button type="button" className={`project-row ${selectedProject === project ? 'active' : ''}`} key={project} onClick={() => { setSelectedProject(project); switchView('board'); }} title={`查看 ${project}`}><span className="folder-dot" /><span>{project}</span><b>{tasks.filter((task) => projectForTask(task, threads) === project).length}</b></button>
          ))}
          {!projectOptions.length && <div className="empty-sidebar">等待 Codex 连接</div>}
        </div>

        <div className="connection-card" title={[codex.error, codex.executablePath, codex.codexHome ? `CODEX_HOME: ${codex.codexHome}` : ''].filter(Boolean).join('\n')}>
          <span className={`connection-dot ${codex.connected && !sync.stale ? 'online' : ''}`} />
          <div>
            <strong>{sync.skipped ? 'Codex 隔离验收模式' : sync.stale ? `Codex 缓存模式 · ${codexStateText[codex.state]}` : codex.connected ? 'Codex 已连接' : codexStateText[codex.state]}</strong>
            <small>{sync.skipped ? `未刷新既有会话目录 · ${codex.version}` : sync.stale ? `上次同步 ${sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleString('zh-CN') : '未知'} · ${codex.version}` : `${codex.version}${codex.source ? ` · ${codex.source}` : ''}`}</small>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{viewTitle}</h1>
            <div className="eyebrow">{viewSubtitle}</div>
          </div>
          <div className="top-actions">
            <label className="search-box">
              <Search size={15} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索任务、项目或对话…" aria-label="搜索" />
              <kbd>⌘ K</kbd>
            </label>
            <button type="button" className="icon-button" onClick={() => void bootstrap()} title="刷新"><RefreshCw size={16} /></button>
            <div className="notification-center" ref={notificationRef}>
              <button
                type="button"
                className="icon-button notification-button"
                ref={notificationButtonRef}
                title="待处理通知"
                aria-label={`通知，${notifications.length} 项待处理`}
                aria-haspopup="menu"
                aria-controls="notification-menu"
                aria-expanded={notificationOpen}
                onClick={() => setNotificationOpen((current) => !current)}
              >
                <Bell size={16} />
                {notifications.length > 0 && <span className="notification-badge">{notifications.length > 99 ? '99+' : notifications.length}</span>}
              </button>
              {notificationOpen && <div className="notification-popover" id="notification-menu" role="menu" aria-label="待处理通知">
                <div className="notification-popover-header">
                  <div><strong>待处理</strong><span>{notifications.length ? `${notifications.length} 项需要关注` : '当前没有待处理事项'}</span></div>
                  <button type="button" className="notification-refresh" title="刷新通知" aria-label="刷新通知" onClick={() => void bootstrap()}><RefreshCw size={14} /></button>
                </div>
                <div className="notification-list">
                  {notifications.map((notification) => <button
                    type="button"
                    role="menuitem"
                    className={`notification-item notification-${notification.kind}`}
                    key={notification.id}
                    onClick={() => openNotification(notification)}
                  >
                    <span className="notification-kind-icon" aria-hidden="true">
                      {notification.kind === 'approval' ? <ClipboardCheck size={15} /> : notification.kind === 'risk' ? <AlertTriangle size={15} /> : notification.kind === 'review' ? <ShieldCheck size={15} /> : <RefreshCw size={15} />}
                    </span>
                    <span className="notification-copy">
                      <strong>{notification.title}</strong>
                      <small>{notification.detail}</small>
                      <time>{formatTime(notification.updatedAt)}</time>
                    </span>
                  </button>)}
                  {!notifications.length && <div className="notification-empty">
                    <CheckCircle2 size={24} />
                    <strong>已全部处理</strong>
                    <span>新的审批、阻塞或验收事项会出现在这里。</span>
                  </div>}
                </div>
              </div>}
            </div>
            <button type="button" className="primary-button" onClick={() => openCreate()}><Plus size={16} />新增任务</button>
          </div>
        </header>

        {view === 'board' ? (
          <section className="metric-grid" aria-label="任务概览">
            <MetricCard tone="plan" icon={ClipboardCheck} label="计划中" value={metrics.planned} detail="等待梳理与领取" />
            <MetricCard tone="execution" icon={TrendingUp} label="执行中" value={metrics.running} detail="已进入工作流" />
            <MetricCard tone="complete" icon={CheckCircle2} label="累计闭环" value={metrics.completed} detail={`看板 ${metrics.completedActive} · 已归档 ${sync.archivedTaskCount}`} />
            <MetricCard tone="risk" icon={AlertTriangle} label="风险任务" value={metrics.atRisk} detail="阻塞或待返工" />
          </section>
        ) : (
          <section className="metric-grid" aria-label="对话概览">
            <MetricCard tone="plan" icon={MessageSquareText} label="当前对话" value={sync.active} detail={sync.skipped ? '隔离模式，不刷新既有会话目录' : sync.stale ? '本地缓存，等待重新同步' : 'App Server 全来源同步'} />
            <MetricCard tone="execution" icon={LayoutDashboard} label="已关联任务" value={linkedConversations} detail="进入任务工作流" />
            <MetricCard tone="complete" icon={Archive} label="已归档" value={sync.archived} detail="历史对话可回查" />
            <MetricCard tone="risk" icon={AlertTriangle} label="待分类" value={uncategorized} detail="需要人工确认" />
          </section>
        )}

        {view === 'board' && <div className="board-toolbar">
          <div className="board-toolbar-title"><strong>项目工作台</strong><span className="board-summary"><b>{filteredTasks.length}</b> 个任务 · <b>{filteredTasks.filter((t) => t.substatus === 'pending_review').length}</b> 个待验收</span></div>
          <div className="board-toolbar-actions">
            <button type="button" className={`quiet-button selection-mode-button ${selectionMode ? 'active' : ''}`} aria-pressed={selectionMode} onClick={() => { setSelectionMode((current) => !current); setSelectedTaskIds(new Set()); }}><CheckCircle2 size={14} />{selectionMode ? '退出多选' : '多选'}</button>
            <label className="project-select"><ListFilter size={14} /><span>项目</span><select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)} aria-label="选择项目"><option>全部项目</option>{projectOptions.map((project) => <option key={project}>{project}</option>)}</select></label>
            <span className="automation-state"><TimerReset size={14} />每日 08:30 自动整理 · 已归档 {sync.archivedTaskCount}</span>
            <button type="button" className="quiet-button archive-completed-button" disabled={maintenanceBusy || archiveEligibleCount === 0} title={archiveEligibleCount ? `归档 ${archiveEligibleCount} 个已验收或已回顾任务` : '只有已验收或已回顾的任务才能归档'} onClick={() => void archiveCompleted()}>{maintenanceBusy ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}归档已完成 {archiveEligibleCount}</button>
          </div>
        </div>}

        {view === 'board' ? <>{selectionMode && <div className={`board-selection-bar ${selectedTaskIds.size ? 'is-visible' : ''}`} aria-live="polite">
          <div><input type="checkbox" checked={selectedTaskIds.size > 0 && filteredTasks.length > 0 && filteredTasks.every((task) => selectedTaskIds.has(task.id))} aria-label="选择当前筛选下的全部任务" onChange={(event) => setSelectedTaskIds(event.target.checked ? new Set(filteredTasks.map((task) => task.id)) : new Set())} /><strong>已选择 {selectedTaskIds.size} 项</strong><button type="button" onClick={() => setSelectedTaskIds(new Set())} disabled={!selectedTaskIds.size}>清除</button></div>
          <div className="batch-stage-actions"><span>迁移到</span>{(Object.keys(laneMeta) as Lane[]).map((lane) => <button type="button" key={lane} disabled={!selectedTaskIds.size} onClick={() => void batchMoveTasks(lane)}>{laneMeta[lane].title}</button>)}<button type="button" className="batch-accept-button" disabled={!batchReviewableCount} title={batchReviewableCount ? `验收 ${batchReviewableCount} 个待验收任务` : '选中项中没有待验收任务'} onClick={() => void batchAcceptTasks()}><ShieldCheck size={13} />批量验收 {batchReviewableCount || ''}</button></div>
        </div>}<div className="board-workspace">
          <section className={`board ${selectedLane ? 'lane-filtered' : ''}`} aria-label={`${selectedProject}${selectedLane ? laneMeta[selectedLane].title : '三阶段'}任务看板`}>
            {((selectedLane ? [selectedLane] : Object.keys(laneMeta)) as Lane[]).map((lane) => (
              <BoardColumn
                key={lane}
                lane={lane}
                tasks={filteredTasks.filter((task) => task.lane === lane)}
                threads={threads}
                executions={executions}
                selectedIds={selectedTaskIds}
                selectionMode={selectionMode}
                loading={loading}
                onSelect={setSelectedTaskId}
                onToggleSelect={toggleTaskSelection}
                onMove={async (taskId, targetLane) => {
                  const task = tasks.find((item) => item.id === taskId);
                  if (task) await moveTask(task, targetLane);
                }}
                onPriority={setTaskPriority}
                onOpenThread={(task) => void openTaskInCodex(task)}
                onArchive={archiveTaskFromCard}
                onCreate={() => openCreate()}
              />
            ))}
          </section>
          <TaskTimeline tasks={filteredTasks} project={selectedProject} onSelect={setSelectedTaskId} />
        </div></> : <ConversationView threads={threads} categories={categories} archivedOnly={view === 'archive'} filter={filter} selectedId={selectedThreadId} onSelect={setSelectedThreadId} onBulkCreate={() => void bulkCreateTasks()} bulkBusy={bulkBusy} />}
      </main>

      {selectedTask && (
        <TaskPanel
          task={selectedTask}
          thread={linkedThread}
          execution={executions[selectedTask.id] ?? null}
          onClose={() => setSelectedTaskId(null)}
          onTaskChange={replaceTask}
          onArchive={archiveTaskFromCard}
          onNotice={setNotice}
        />
      )}

      {selectedThread && view !== 'board' && (
        <ConversationPanel
          thread={selectedThread}
          categories={categories}
          onClose={() => setSelectedThreadId(null)}
          onUpdate={(updated) => {
            setThreads((current) => current.map((thread) => thread.id === updated.id ? updated : thread));
            if (!categories.includes(updated.category)) setCategories((current) => [...current, updated.category]);
          }}
          onCreateTask={(threadId) => openCreate(threadId)}
          onOpen={(threadId) => void openThreadInCodex(threadId)}
        />
      )}

      {createOpen && <CreateTaskModal threads={threads.filter((thread) => !thread.archived)} projects={taskProjectOptions} defaultProjectName={selectedProject === '全部项目' ? '' : selectedProject} defaultProjectPath={defaultCreateProjectPath} defaultThreadId={createThreadId} onClose={() => { setCreateOpen(false); setCreateThreadId(null); }} onCreate={createTask} />}
      {notice && <div className={`toast ${notice.tone}`} role="status">{notice.tone === 'success' ? <Check size={16} /> : <CircleDot size={16} />}<span>{notice.text}</span>{notice.actionLabel && notice.onAction && <button type="button" className="toast-action" onClick={() => void notice.onAction?.()}>{notice.actionLabel}</button>}<button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </div>
  );
}

function TaskTimeline({ tasks, project, onSelect }: { tasks: Task[]; project: string; onSelect(id: string): void }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => tasks
    .map((task) => {
      const start = new Date(task.startAt).getTime();
      const rawEnd = task.endAt ? new Date(task.endAt).getTime() : Date.now();
      return { task, start, end: Math.max(Number.isFinite(rawEnd) ? rawEnd : Date.now(), start + 86_400_000), open: !task.endAt };
    })
    .filter((row) => Number.isFinite(row.start))
    .sort((a, b) => a.start - b.start), [tasks]);

  const min = rows.length ? Math.min(...rows.map((row) => row.start)) : Date.now();
  const max = rows.length ? Math.max(...rows.map((row) => row.end), min + 86_400_000) : min + 86_400_000;
  const span = Math.max(max - min, 86_400_000);
  const ticks = Array.from({ length: 7 }, (_, index) => min + (span * index) / 6);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  return (
    <>
      {expanded && <div className="timeline-expanded-backdrop" aria-hidden="true" onClick={() => setExpanded(false)} />}
      <section id="project-task-timeline" className={`project-timeline ${expanded ? 'is-expanded' : ''}`} aria-label="项目任务时序图">
        <div className="project-timeline-header">
          <div><CalendarDays size={15} /><strong>项目时序</strong><span>{project} · {rows.length} 个任务</span></div>
          <div className="timeline-header-actions">
            <span>开始 - 结束</span>
            <button type="button" className="timeline-expand-button" aria-controls="project-task-timeline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} title={expanded ? '收起项目时序图' : '展开项目时序图'}>
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}{expanded ? '收起' : '展开'}
            </button>
          </div>
        </div>
        <div className="timeline-scale"><span className="timeline-name-spacer" />{ticks.map((tick) => <time key={tick}>{formatDate(new Date(tick).toISOString())}</time>)}</div>
        <div className="timeline-rows">
          {rows.map(({ task, start, end, open }) => {
            const left = ((start - min) / span) * 100;
            const width = Math.max(((end - start) / span) * 100, 1.5);
            return <button type="button" className="timeline-task-row" key={task.id} onClick={() => { setExpanded(false); onSelect(task.id); }} title={`${task.title}：${formatDate(task.startAt)} 至 ${open ? '持续中' : formatDate(task.endAt)}`}>
              <span className="timeline-task-name"><i className={`timeline-lane-dot timeline-lane-${task.lane}`} />{task.title}</span>
              <span className="timeline-track"><span className={`timeline-bar timeline-bar-${task.lane} ${open ? 'timeline-bar-open' : ''}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}><b>{formatDate(task.startAt)}-{open ? '持续中' : formatDate(task.endAt)}</b>{open && <i aria-hidden="true" />}</span></span>
            </button>;
          })}
          {!rows.length && <div className="timeline-empty">当前项目还没有可展示的任务时间。</div>}
        </div>
      </section>
    </>
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

function BoardColumn({ lane, tasks, threads, executions, selectedIds, selectionMode, loading, onSelect, onToggleSelect, onMove, onPriority, onOpenThread, onArchive, onCreate }: {
  lane: Lane;
  tasks: Task[];
  threads: CodexThreadSummary[];
  executions: Record<string, ExecutionSnapshot>;
  selectedIds: Set<string>;
  selectionMode: boolean;
  loading: boolean;
  onSelect(id: string): void;
  onToggleSelect(id: string): void;
  onMove(taskId: string, lane: Lane): Promise<void>;
  onPriority(taskId: string, priority: Priority): Promise<void>;
  onOpenThread(task: Task): void;
  onArchive(task: Task): Promise<void>;
  onCreate(): void;
}) {
  const meta = laneMeta[lane];
  const Icon = meta.icon;
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortMode, setSortMode] = useState<'default' | 'updated' | 'thread-updated' | 'priority'>('default');
  const [highPriorityOnly, setHighPriorityOnly] = useState(false);
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextTask = contextMenu ? tasks.find((task) => task.id === contextMenu.taskId) ?? null : null;
  const threadUpdatedAt = useMemo(() => new Map(threads.map((thread) => [thread.id, typeof thread.updatedAt === 'number' ? thread.updatedAt : Number.NEGATIVE_INFINITY])), [threads]);
  const visibleTasks = useMemo(() => {
    let scoped = [...tasks];
    if (lane === 'review' && reviewStatusFilter === 'pending') scoped = scoped.filter((task) => task.substatus !== 'accepted' && task.substatus !== 'closed');
    if (lane === 'review' && reviewStatusFilter === 'completed') scoped = scoped.filter((task) => task.substatus === 'accepted' || task.substatus === 'closed');
    if (highPriorityOnly) scoped = scoped.filter((task) => task.priority === 'high');
    if (sortMode === 'updated') scoped.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (sortMode === 'thread-updated') scoped.sort((a, b) => {
      const conversationDifference = (b.threadId ? threadUpdatedAt.get(b.threadId) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY)
        - (a.threadId ? threadUpdatedAt.get(a.threadId) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY);
      return conversationDifference || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.id.localeCompare(b.id);
    });
    if (sortMode === 'priority') {
      const rank: Record<Priority, number> = { high: 3, medium: 2, low: 1 };
      scoped.sort((a, b) => rank[b.priority] - rank[a.priority] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return scoped;
  }, [highPriorityOnly, lane, reviewStatusFilter, sortMode, tasks, threadUpdatedAt]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  function chooseSort(value: 'default' | 'updated' | 'thread-updated' | 'priority') {
    setSortMode(value);
    setMenuOpen(false);
  }

  function resetView() {
    setSortMode('default');
    setHighPriorityOnly(false);
    setReviewStatusFilter('all');
    setMenuOpen(false);
  }

  function runContextAction(action: () => void) {
    setContextMenu(null);
    window.setTimeout(action, 0);
  }

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
        <div className="column-actions" ref={menuRef}>
          <button type="button" onClick={onCreate} aria-label={`在${meta.title}新增任务`} title={`在${meta.title}新增任务`}><Plus size={15} /></button>
          <button type="button" className={menuOpen ? 'more-active' : ''} aria-label={`${meta.title}列选项`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`column-menu-${lane}`} title={`${meta.title}列选项`} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={15} /></button>
          {menuOpen && <div className="column-menu" id={`column-menu-${lane}`} role="menu" aria-label={`${meta.title}列选项`}>
            <div className="column-menu-summary"><strong>列显示</strong><span>{visibleTasks.length}/{tasks.length}</span></div>
            <span className="column-menu-label">排序</span>
            <button type="button" role="menuitemradio" aria-checked={sortMode === 'default'} onClick={() => chooseSort('default')}><span>默认顺序</span>{sortMode === 'default' && <Check size={13} />}</button>
            <button type="button" role="menuitemradio" aria-checked={sortMode === 'updated'} onClick={() => chooseSort('updated')}><span>最近更新优先</span>{sortMode === 'updated' && <Check size={13} />}</button>
            <button type="button" role="menuitemradio" aria-checked={sortMode === 'thread-updated'} title="按关联 Codex 对话的最近更新时间排序，未关联任务置后" onClick={() => chooseSort('thread-updated')}><span>最新对话优先</span>{sortMode === 'thread-updated' && <Check size={13} />}</button>
            <button type="button" role="menuitemradio" aria-checked={sortMode === 'priority'} onClick={() => chooseSort('priority')}><span>优先级优先</span>{sortMode === 'priority' && <Check size={13} />}</button>
            {lane === 'review' && <><div className="column-menu-divider" /><span className="column-menu-label">验收结果</span><button type="button" role="menuitemradio" aria-checked={reviewStatusFilter === 'all'} onClick={() => { setReviewStatusFilter('all'); setMenuOpen(false); }}><span>全部验收任务</span>{reviewStatusFilter === 'all' && <Check size={13} />}</button><button type="button" role="menuitemradio" aria-checked={reviewStatusFilter === 'pending'} onClick={() => { setReviewStatusFilter('pending'); setMenuOpen(false); }}><span>待验收</span>{reviewStatusFilter === 'pending' && <Check size={13} />}</button><button type="button" role="menuitemradio" aria-checked={reviewStatusFilter === 'completed'} onClick={() => { setReviewStatusFilter('completed'); setMenuOpen(false); }}><span>已验收与已回顾</span>{reviewStatusFilter === 'completed' && <Check size={13} />}</button></>}
            <div className="column-menu-divider" />
            <button type="button" role="menuitemcheckbox" aria-checked={highPriorityOnly} onClick={() => { setHighPriorityOnly((value) => !value); setMenuOpen(false); }}><span>仅看高优先级</span>{highPriorityOnly && <Check size={13} />}</button>
            {(sortMode !== 'default' || highPriorityOnly || reviewStatusFilter !== 'all') && <button type="button" className="column-menu-reset" role="menuitem" onClick={resetView}><span>恢复默认显示</span></button>}
          </div>}
        </div>
        <p>{meta.subtitle}</p>
      </div>
      <div className="card-list">
        {loading && <div className="column-empty"><LoaderCircle className="spin" size={18} />正在读取本机任务</div>}
        {!loading && visibleTasks.map((task) => {
          const execution = executions[task.id];
          const conversationThreadId = task.threadId || execution?.threadId || null;
          const linked = conversationThreadId ? threads.find((thread) => thread.id === conversationThreadId) : null;
          const live = execution?.status === 'running' || execution?.status === 'waiting_approval' || execution?.status === 'waiting_input';
          return (
            <article
              className={`task-card ${selectedIds.has(task.id) ? 'is-selected' : ''}`}
              data-task-id={task.id}
              key={task.id}
              draggable
              onDragStart={(event) => event.dataTransfer.setData('text/task-id', task.id)}
              onClick={() => onSelect(task.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.min(event.clientX || rect.left + 24, window.innerWidth - 224);
                const y = Math.min(event.clientY || rect.top + 24, window.innerHeight - 386);
                setMenuOpen(false);
                setContextMenu({ taskId: task.id, x: Math.max(8, x), y: Math.max(8, y) });
              }}
            >
              <div className="card-topline">{selectionMode && <input className="task-select-checkbox" type="checkbox" checked={selectedIds.has(task.id)} aria-label={`选择任务：${task.title}`} onClick={(event) => event.stopPropagation()} onChange={() => onToggleSelect(task.id)} />}<span className={`status-chip status-${task.substatus}`}>{statusText[task.substatus]}</span><span className={`priority priority-${task.priority}`}>{priorityText[task.priority]}</span>{execution && <span className={`execution-state execution-${execution.status} ${live ? 'is-live' : ''}`}><i />{executionStatusText[execution.status]}</span>}</div>
              <h3>{task.title}</h3>
              {task.description && <p>{task.description}</p>}
              <div className="card-project"><span className="folder-dot" />{shortPath(task.projectPath || linked?.cwd)}</div>
              <div className="card-footer">
                <span>{linked ? <><Link2 size={13} />{threadTitle(linked).slice(0, 22)}</> : conversationThreadId ? <><RefreshCw size={13} />对话待同步</> : <><MessageSquareText size={13} />未关联对话</>}</span>
                {task.lane === 'review' && <ShieldCheck size={14} className="review-mark" />}
                {task.executor && <span className="avatar" title={`执行人：${task.executor}`}>{task.executor.slice(0, 1).toUpperCase()}</span>}
              </div>
            </article>
          );
        })}
        {!loading && !tasks.length && <div className="column-empty"><Sparkles size={18} /><strong>这里还没有任务</strong><span>拖入任务，或直接新增</span><button type="button" onClick={onCreate}><Plus size={14} />新增任务</button></div>}
        {!loading && tasks.length > 0 && !visibleTasks.length && <div className="column-empty"><ListFilter size={18} /><strong>没有符合条件的任务</strong><span>{lane === 'review' && reviewStatusFilter !== 'all' ? '当前列已启用验收结果筛选' : '当前列已启用优先级筛选'}</span><button type="button" onClick={resetView}>显示全部任务</button></div>}
      </div>
      {contextTask && contextMenu && createPortal(<div className="task-context-menu" ref={contextMenuRef} role="menu" aria-label={`${contextTask.title}任务操作`} style={{ left: contextMenu.x, top: contextMenu.y }}>
        <div className="task-context-heading"><strong>{contextTask.title}</strong><span>{statusText[contextTask.substatus]}</span></div>
        <span className="task-context-label">优先级</span>
        {(['high', 'medium', 'low'] as Priority[]).map((priority) => <button type="button" role="menuitemradio" aria-checked={contextTask.priority === priority} disabled={contextTask.substatus === 'accepted' || contextTask.substatus === 'closed'} key={priority} onClick={() => runContextAction(() => void onPriority(contextTask.id, priority))}><span>{priorityText[priority]}</span>{contextTask.priority === priority && <Check size={13} />}</button>)}
        <div className="task-context-divider" />
        <span className="task-context-label">移动到</span>
        {(Object.keys(laneMeta) as Lane[]).map((targetLane) => <button type="button" role="menuitemradio" aria-checked={contextTask.lane === targetLane} disabled={contextTask.lane === targetLane || contextTask.substatus === 'accepted' || contextTask.substatus === 'closed'} key={targetLane} onClick={() => runContextAction(() => void onMove(contextTask.id, targetLane))}><span>{laneMeta[targetLane].title}</span>{contextTask.lane === targetLane && <Check size={13} />}</button>)}
        <div className="task-context-divider" />
        <button type="button" role="menuitem" disabled={!contextTask.threadId} onClick={() => { if (contextTask.threadId) onOpenThread(contextTask); setContextMenu(null); }}><span><ExternalLink size={13} />{executions[contextTask.id]?.status === 'running' || executions[contextTask.id]?.status === 'waiting_approval' || executions[contextTask.id]?.status === 'waiting_input' ? '转到 Codex（中断当前回合）' : '在 Codex 中打开'}</span></button>
        <button type="button" className="task-context-archive" role="menuitem" onClick={() => runContextAction(() => void onArchive(contextTask))}><span><Archive size={13} />归档任务</span><small>可撤销</small></button>
      </div>, document.body)}
    </div>
  );
}

function CreateTaskModal({ threads, projects, defaultProjectName, defaultProjectPath, defaultThreadId, onClose, onCreate }: { threads: CodexThreadSummary[]; projects: TaskProjectOption[]; defaultProjectName: string; defaultProjectPath: string; defaultThreadId: string | null; onClose(): void; onCreate(input: CreateTaskInput): Promise<void> }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [lane, setLane] = useState<Lane>('plan');
  const [priority, setPriority] = useState<Priority>('medium');
  const [threadId, setThreadId] = useState(defaultThreadId ?? '');
  const [conversationMode, setConversationMode] = useState<'new' | 'existing' | 'none'>(defaultThreadId ? 'existing' : 'new');
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [model, setModel] = useState('');
  const [serviceTier, setServiceTier] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionPreset, setPermissionPreset] = useState<ExecutionPermissionPreset>('untrusted');
  const [projectName, setProjectName] = useState(defaultThreadId ? threads.find((thread) => thread.id === defaultThreadId)?.category ?? '' : defaultProjectName);
  const [projectPath, setProjectPath] = useState(defaultThreadId ? threads.find((thread) => thread.id === defaultThreadId)?.cwd ?? '' : defaultProjectPath);
  const [executor, setExecutor] = useState('');
  const [criteria, setCriteria] = useState('');
  const [startAt, setStartAt] = useState(dateInputValue(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const selectedModel = models.find((item) => item.id === model) ?? null;

  useEffect(() => {
    let active = true;
    void window.codexTaskboard.listModels().then((items) => {
      if (!active) return;
      setModels(items);
      const initial = items.find((item) => item.isDefault) ?? items[0];
      if (initial) {
        setModel(initial.id);
        setEffort(initial.defaultReasoningEffort);
        setServiceTier(initial.defaultServiceTier ?? '');
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (conversationMode !== 'none' && permissionPreset === 'full-access' && !window.confirm('完全访问权限会关闭审批和沙盒限制，Codex 可修改工作区外文件并执行系统操作。确认仅对这个任务的首轮执行使用完全访问权限？')) return;
    setSaving(true);
    await onCreate({
      title,
      description,
      lane,
      substatus: lane === 'plan' ? 'idea' : undefined,
      priority,
      threadId: conversationMode === 'existing' ? threadId || null : null,
      createConversation: conversationMode === 'new',
      conversationModel: conversationMode !== 'none' ? model || undefined : undefined,
      conversationEffort: conversationMode !== 'none' ? effort || undefined : undefined,
      conversationServiceTier: conversationMode !== 'none' ? serviceTier || null : undefined,
      conversationPermissionPreset: conversationMode !== 'none' ? permissionPreset : undefined,
      projectName: projectName || null,
      projectPath: projectPath || null,
      executor: executor || null,
      acceptanceCriteria: criteria,
      startAt: new Date(`${startAt}T00:00:00`).toISOString(),
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
          <label className="field"><span>所属项目</span><select value={projectName} disabled={conversationMode === 'existing' && Boolean(threadId)} onChange={(event) => { const selected = projects.find((project) => project.category === event.target.value); setProjectName(event.target.value); setProjectPath(selected?.path ?? ''); }}><option value="">未设置项目</option>{projects.map((project) => <option key={project.category} value={project.category}>{project.label}</option>)}</select><small>{conversationMode === 'existing' && threadId ? '项目由关联会话决定。' : projectPath ? `工作目录：${projectPath}` : '请选择业务项目，系统会使用该项目的主工作目录。'}</small></label>
          <div className="field-grid three">
            <label className="field"><span>所在阶段</span><select value={lane} onChange={(event) => setLane(event.target.value as Lane)}><option value="plan">计划中</option><option value="execution">执行</option><option value="review">验收和回顾</option></select></label>
            <label className="field"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            <label className="field"><span>执行人</span><input value={executor} onChange={(event) => setExecutor(event.target.value)} placeholder="可稍后填写" /></label>
          </div>
          <label className="field"><span>开始日期</span><input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} /><small>任务验收通过或回顾关闭时自动记录结束时间。</small></label>
          <div className="field conversation-setup"><span>Codex 会话</span><div className="conversation-mode" role="group" aria-label="选择会话方式">
            <button type="button" className={conversationMode === 'new' ? 'active' : ''} aria-pressed={conversationMode === 'new'} onClick={() => setConversationMode('new')}><MessageSquareText size={14} /><span>新建会话<small>默认</small></span></button>
            <button type="button" className={conversationMode === 'existing' ? 'active' : ''} aria-pressed={conversationMode === 'existing'} onClick={() => { setConversationMode('existing'); const selected = threads.find((thread) => thread.id === threadId); if (selected) { setProjectName(selected.category); setProjectPath(selected.cwd ?? ''); } }}><Link2 size={14} /><span>关联已有</span></button>
            <button type="button" className={conversationMode === 'none' ? 'active' : ''} aria-pressed={conversationMode === 'none'} onClick={() => setConversationMode('none')}><Inbox size={14} /><span>仅创建任务</span></button>
          </div>
            {conversationMode === 'existing' && <label className="field"><span>选择已有会话</span><select value={threadId} onChange={(event) => { setThreadId(event.target.value); const selected = threads.find((thread) => thread.id === event.target.value); setProjectName(selected?.category ?? ''); setProjectPath(selected?.cwd ?? ''); }}><option value="">请选择</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)} · {shortPath(thread.cwd)}</option>)}</select><small>沿用已有上下文和项目目录。</small></label>}
            {conversationMode !== 'none' && <><div className="field-grid four conversation-runtime">
              <label className="field"><span>模型</span><select value={model} onChange={(event) => { const next = models.find((item) => item.id === event.target.value); setModel(event.target.value); setEffort(next?.defaultReasoningEffort ?? ''); setServiceTier(next?.defaultServiceTier ?? ''); }} disabled={!models.length}>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
              <label className="field"><span>思考深度</span><select value={effort} onChange={(event) => setEffort(event.target.value)}>{selectedModel?.supportedReasoningEfforts.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortText[item.reasoningEffort] ?? item.reasoningEffort}</option>)}</select></label>
              <label className="field"><span>速度</span><select value={serviceTier} onChange={(event) => setServiceTier(event.target.value)}><option value="">标准</option>{selectedModel?.serviceTiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
              <label className="field"><span>审批策略</span><select value={permissionPreset} onChange={(event) => setPermissionPreset(event.target.value as ExecutionPermissionPreset)}><option value="untrusted">未信任操作询问</option><option value="on-request">Codex 按需申请</option><option value="full-access">完全访问权限</option></select></label>
            </div>{permissionPreset === 'full-access' && <div className="permission-warning"><AlertTriangle size={13} /><span><strong>完全访问</strong> 将关闭审批和沙盒限制；创建前仍需你再次确认。</span></div>}<small>{conversationMode === 'new' ? '创建后会立即发送任务内容，Codex 将按所选审批策略开始执行。' : '这些设置用于下一次从 Workboard 发送消息。'}</small></>}
            {conversationMode === 'none' && <small>只保存任务卡，适合尚未准备执行的想法。</small>}
          </div>
          <label className="field"><span>验收标准</span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="哪些证据满足后才算完成？" rows={2} /></label>
        </div>
        <div className="modal-footer"><span>⌘ ↵ 创建任务</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!title.trim() || saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}创建任务</button></div></div>
      </form>
    </div>
  );
}

function TaskPanel({ task, thread, execution, onClose, onTaskChange, onArchive, onNotice }: {
  task: Task;
  thread: CodexThreadSummary | null;
  execution: ExecutionSnapshot | null;
  onClose(): void;
  onTaskChange(task: Task): void;
  onArchive(task: Task): void | Promise<void>;
  onNotice(value: { tone: 'error' | 'success'; text: string }): void;
}) {
  const [tab, setTab] = useState<'task' | 'execution' | 'thread'>('task');
  const [detail, setDetail] = useState<CodexThreadDetail | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<ComposerImage[]>([]);
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionPreset, setPermissionPreset] = useState<ExecutionPermissionPreset>('untrusted');
  const [serviceTier, setServiceTier] = useState('');
  const [sending, setSending] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [userInputBusy, setUserInputBusy] = useState(false);
  const [userInputAnswers, setUserInputAnswers] = useState<Record<string, string>>({});
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [reviewNote, setReviewNote] = useState('');
  const [reviewMode, setReviewMode] = useState<'user' | 'ai'>('user');
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  const [pendingThreadMessages, setPendingThreadMessages] = useState<Array<{ id: string; text: string; turnId: string | null; kind: 'message' | 'steer' }>>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const conversationThreadId = task.threadId || execution?.threadId || null;
  const effectiveThread = detail ?? thread;
  const messages = extractMessages(detail);
  const taskLocked = task.substatus === 'accepted' || task.substatus === 'closed';
  const linkedConversationAvailable = Boolean(conversationThreadId);
  const executionBusy = execution?.status === 'running' || execution?.status === 'waiting_approval' || execution?.status === 'waiting_input';
  const steerReady = execution?.status === 'running' && Boolean(execution.turnId);
  const hasComposerInput = Boolean(message.trim() || attachments.length);
  const composerDisabled = !linkedConversationAvailable || sending || taskLocked || execution?.status === 'waiting_approval' || execution?.status === 'waiting_input' || (execution?.status === 'running' && !execution.turnId);
  const reworkReady = task.lane === 'execution' && task.substatus === 'rework' && execution?.status === 'completed';
  const selectedModel = models.find((item) => item.id === model) ?? null;
  const effortOptions = selectedModel?.supportedReasoningEfforts ?? [];
  const serviceTierOptions = selectedModel?.serviceTiers ?? [];
  const selectedServiceTier = serviceTierOptions.find((item) => item.id === serviceTier) ?? null;
  const elapsedSeconds = execution?.startedAt
    ? Math.max(0, Math.floor(((execution.completedAt ? new Date(execution.completedAt).getTime() : clock) - new Date(execution.startedAt).getTime()) / 1000))
    : 0;

  useEffect(() => {
    setDetail(null);
    setTab(execution?.status === 'running' || execution?.status === 'waiting_approval' || execution?.status === 'waiting_input' ? 'execution' : 'task');
    setPermissionPreset(execution?.permissionPreset ?? 'untrusted');
    setReviewMode('user');
    setMessage('');
    setAttachments([]);
    setPendingThreadMessages([]);
    void window.codexTaskboard.listAuditEvents(task.id).then(setEvents);
  }, [task.id]);

  useEffect(() => {
    let active = true;
    void window.codexTaskboard.listModels().then((items) => {
      if (!active) return;
      setModels(items);
      const initial = items.find((item) => item.id === execution?.model) ?? items.find((item) => item.isDefault) ?? items[0];
      if (initial) {
        setModel(initial.id);
        const supported = initial.supportedReasoningEfforts.map((item) => item.reasoningEffort);
        setEffort(execution?.effort && supported.includes(execution.effort) ? execution.effort : initial.defaultReasoningEffort);
        setServiceTier(execution?.serviceTier && initial.serviceTiers.some((tier) => tier.id === execution.serviceTier) ? execution.serviceTier : initial.defaultServiceTier ?? '');
      }
    }).catch((error) => onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }));
    return () => { active = false; };
  }, [task.id]);

  useEffect(() => {
    if (execution?.status !== 'running' && execution?.status !== 'waiting_approval' && execution?.status !== 'waiting_input') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [execution?.status]);

  useEffect(() => {
    setUserInputAnswers({});
  }, [execution?.pendingUserInput?.requestId]);

  useEffect(() => {
    if (tab !== 'thread' || !conversationThreadId || detail) return;
    setLoadingThread(true);
    void window.codexTaskboard.readThread(conversationThreadId)
      .then(setDetail)
      .catch((error) => onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
      .finally(() => setLoadingThread(false));
  }, [conversationThreadId, detail, onNotice, tab]);

  useEffect(() => {
    if (!pendingThreadMessages.length || !conversationThreadId || !execution?.turnId || !pendingThreadMessages.some((item) => item.turnId === execution.turnId) || !['completed', 'failed', 'interrupted'].includes(execution.status)) return;
    let active = true;
    setLoadingThread(true);
    void window.codexTaskboard.readThread(conversationThreadId)
      .then((nextDetail) => { if (active) setDetail(nextDetail); })
      .catch((error) => onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (!active) return;
        setPendingThreadMessages((current) => current.filter((item) => item.turnId !== execution.turnId));
        setLoadingThread(false);
      });
    return () => { active = false; };
  }, [conversationThreadId, execution?.status, execution?.turnId, onNotice, pendingThreadMessages.length]);

  useEffect(() => {
    if (tab !== 'thread') return;
    const frame = window.requestAnimationFrame(() => {
      const container = messagesRef.current;
      if (!container) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      container.scrollTo({ top: container.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [execution?.lastMessage, execution?.status, messages.length, pendingThreadMessages.length, tab]);

  async function patchTask(patch: Partial<Task>) {
    try {
      const updated = await window.codexTaskboard.updateTask(task.id, patch);
      onTaskChange(updated);
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function transferTask(targetLane: Lane) {
    if (taskLocked || targetLane === task.lane) return;
    try {
      const updated = await window.codexTaskboard.updateTask(task.id, { lane: targetLane });
      onTaskChange(updated);
      setEvents(await window.codexTaskboard.listAuditEvents(task.id));
      onNotice({ tone: 'success', text: `已移至${laneMeta[targetLane].title}` });
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function review(decision: 'accepted' | 'rework' | 'closed') {
    try {
      const updated = await window.codexTaskboard.reviewTask(task.id, {
        auditor: '用户',
        reviewerType: 'user',
        decision,
        note: reviewNote,
      });
      onTaskChange(updated);
      setEvents(await window.codexTaskboard.listAuditEvents(task.id));
      setReviewNote('');
      onNotice({ tone: 'success', text: decision === 'rework' ? '任务已退回执行' : '验收记录已保存' });
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function runAiReview() {
    setAiReviewBusy(true);
    try {
      const result = await window.codexTaskboard.aiReviewTask(task.id, { focus: reviewNote });
      onTaskChange(result.task);
      setEvents(await window.codexTaskboard.listAuditEvents(task.id));
      setReviewNote('');
      onNotice({ tone: 'success', text: result.decision === 'accepted' ? 'AI 验收通过，已记录验收结论' : 'AI 验收未通过，任务已退回执行' });
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAiReviewBusy(false);
    }
  }

  async function sendMessage(origin: 'execution' | 'thread' = 'execution') {
    if (!conversationThreadId || !hasComposerInput) return;
    const text = message.trim();
    const images = attachments.map((item) => ({ path: item.path }));
    setSending(true);
    try {
      if (steerReady && execution?.turnId) {
        const result = await window.codexTaskboard.steerTurn({ taskId: task.id, threadId: conversationThreadId, turnId: execution.turnId, text, images });
        onTaskChange(result.task);
        setMessage('');
        setAttachments([]);
        setPendingThreadMessages((current) => [...current, { id: `${execution.turnId}-${Date.now()}`, text: text || `[截图 ${images.length} 张]`, turnId: execution.turnId, kind: 'steer' }]);
        if (origin === 'execution') setTab('execution');
        onNotice({ tone: 'success', text: '已引导当前执行回合，Codex 会按新方向继续' });
        return;
      }
      if (permissionPreset === 'full-access' && !window.confirm('完全访问权限会关闭审批和沙盒限制，Codex 可修改工作区外文件并执行系统操作。确认仅对本次启动使用完全访问权限？')) return;
      const result = await window.codexTaskboard.sendToThread({
        taskId: task.id,
        threadId: conversationThreadId,
        text,
        images,
        model: model || undefined,
        effort: effort || undefined,
        serviceTier: serviceTier || null,
        permissionPreset,
      });
      onTaskChange(result.task);
      setMessage('');
      setAttachments([]);
      if (origin === 'thread') setPendingThreadMessages((current) => [...current, { id: `${result.snapshot.turnId}-${Date.now()}`, text: text || `[截图 ${images.length} 张]`, turnId: result.snapshot.turnId, kind: 'message' }]);
      else setTab('execution');
      onNotice({
        tone: 'success',
        text: result.conversationRecovered
          ? '原对话已不可用，已创建续作对话并成功提交任务'
          : origin === 'thread' ? '消息已发送，Codex 正在回复' : 'Codex 已开始执行，可在此实时跟踪',
      });
    } catch (error) {
      onNotice({ tone: 'error', text: userFacingError(error) });
    } finally {
      setSending(false);
    }
  }

  async function openConversationInCodex() {
    if (!conversationThreadId) return;
    if (!executionBusy) {
      const notice = await openCodexThreadWithNotice(conversationThreadId, window.codexTaskboard.openThreadInCodex, userFacingError);
      if (notice) onNotice(notice);
      return;
    }
    if (!window.confirm('这段对话当前由 Workboard 执行。转到 Codex 会中断当前回合并释放会话，确认继续？')) return;
    setHandoffBusy(true);
    try {
      const result = await window.codexTaskboard.handoffToCodex({ taskId: task.id, threadId: conversationThreadId });
      onTaskChange(result.task);
      setEvents(await window.codexTaskboard.listAuditEvents(task.id));
      onNotice(codexHandoffNotice(result.openResult));
    } catch (error) {
      onNotice({ tone: 'error', text: userFacingError(error) });
    } finally {
      setHandoffBusy(false);
    }
  }

  async function pickComposerImages() {
    try {
      const picked = await window.codexTaskboard.pickImages();
      setAttachments((current) => [...current, ...picked].slice(0, 4));
      if (picked.length) onNotice({ tone: 'success', text: `已添加 ${Math.min(picked.length, 4)} 张截图` });
    } catch (error) {
      onNotice({ tone: 'error', text: userFacingError(error) });
    }
  }

  async function pasteComposerImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')).slice(0, Math.max(0, 4 - attachments.length));
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText) setMessage((current) => `${current}${pastedText}`);
    try {
      const saved = await Promise.all(files.map(async (file) => window.codexTaskboard.savePastedImage({ bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type })));
      setAttachments((current) => [...current, ...saved].slice(0, 4));
      onNotice({ tone: 'success', text: `已粘贴 ${saved.length} 张截图` });
    } catch (error) {
      onNotice({ tone: 'error', text: userFacingError(error) });
    }
  }

  function attachmentTray() {
    if (!attachments.length) return null;
    return <div className="composer-attachments" aria-label="待发送截图">{attachments.map((item) => <div className="composer-attachment" key={item.path}><img src={item.preview} alt={item.name} /><span>{item.name}</span><button type="button" aria-label={`移除 ${item.name}`} onClick={() => setAttachments((current) => current.filter((image) => image.path !== item.path))}><X size={11} /></button></div>)}</div>;
  }

  async function respondApproval(decision: ApprovalDecision) {
    if (!execution?.pendingApproval) return;
    setApprovalBusy(true);
    try {
      await window.codexTaskboard.respondToApproval({ taskId: task.id, requestId: execution.pendingApproval.requestId, decision });
      onNotice({ tone: decision === 'decline' || decision === 'cancel' ? 'error' : 'success', text: decision === 'acceptForSession' ? '本次会话已允许该操作' : decision === 'accept' ? '已批准本次操作' : '已拒绝本次操作' });
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setApprovalBusy(false);
    }
  }

  async function closeUserInput(cancelled = false) {
    if (!execution?.pendingUserInput) return;
    setUserInputBusy(true);
    try {
      if (cancelled) {
        await window.codexTaskboard.cancelUserInput({ taskId: task.id, requestId: execution.pendingUserInput.requestId });
      } else {
        const answers = Object.fromEntries(execution.pendingUserInput.questions.map((question) => [
          question.id,
          { answers: userInputAnswers[question.id]?.trim() ? [userInputAnswers[question.id].trim()] : [] },
        ]));
        await window.codexTaskboard.respondToUserInput({ taskId: task.id, requestId: execution.pendingUserInput.requestId, answers });
      }
      onNotice({ tone: cancelled ? 'error' : 'success', text: cancelled ? '已取消本次回答' : '已提交回答' });
      setUserInputAnswers({});
    } catch (error) {
      onNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setUserInputBusy(false);
    }
  }

  return (
    <aside className="detail-panel">
      <div className="panel-header">
        <div className="panel-tabs"><button type="button" className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>任务</button><button type="button" className={tab === 'execution' ? 'active' : ''} onClick={() => setTab('execution')}>实时执行{execution && <i className={`panel-live-dot execution-${execution.status}`} />}</button><button type="button" className={tab === 'thread' ? 'active' : ''} onClick={() => setTab('thread')}>关联对话</button></div>
        <button type="button" className="icon-button" onClick={onClose}><X size={17} /></button>
      </div>

      {tab === 'task' ? (
        <div className="panel-scroll">
          <div className="task-heading"><span className={`status-chip status-${task.substatus}`}>{statusText[task.substatus]}</span><h2>{task.title}</h2><p>{task.description || '暂无任务描述。'}</p></div>
          <div className="detail-section">
            <h3>任务属性</h3>
            <div className="property-row"><span><CircleDot size={14} />当前阶段</span><strong>{laneMeta[task.lane].title}</strong></div>
            <div className="property-row"><span><UserRound size={14} />执行人</span><input defaultValue={task.executor ?? ''} placeholder="未分配" onBlur={(event) => void patchTask({ executor: event.target.value })} /></div>
            <div className="property-row"><span><ClipboardCheck size={14} />验收结果</span><strong>{task.auditor || '等待用户或 AI 验收'}</strong></div>
            <div className="property-row"><span><CalendarDays size={14} />开始</span><input type="date" defaultValue={dateInputValue(task.startAt)} onBlur={(event) => event.target.value && void patchTask({ startAt: new Date(`${event.target.value}T00:00:00`).toISOString() })} /></div>
            <div className="property-row"><span><CalendarDays size={14} />结束</span><strong>{task.endAt ? formatDate(task.endAt) : '持续中'}</strong></div>
            <div className="property-row"><span><Link2 size={14} />对话</span><div className="property-actions"><button type="button" className="inline-link" disabled={!conversationThreadId} onClick={() => setTab('thread')}>{effectiveThread ? threadTitle(effectiveThread).slice(0, 18) : conversationThreadId ? '继续关联对话' : '未关联'}</button>{conversationThreadId && <button type="button" className="inline-link open-codex-link" disabled={handoffBusy} title={executionBusy ? '中断 Workboard 当前回合并释放会话后，在 Codex 中继续' : '在 Codex 中打开'} onClick={() => void openConversationInCodex()}>{handoffBusy ? <LoaderCircle className="spin" size={12} /> : <ExternalLink size={12} />}{executionBusy ? '转到 Codex' : '在 Codex 中打开'}</button>}</div></div>
            <div className={`stage-transfer ${taskLocked ? 'is-locked' : ''}`}>
              <div className="stage-transfer-heading"><strong>迁移工作阶段</strong><span>{taskLocked ? '终态阶段已锁定，仍可归档' : '点击后立即更新并记录审计'}</span></div>
              <div className="stage-transfer-options">
                {(Object.keys(laneMeta) as Lane[]).map((targetLane) => {
                  const StageIcon = laneMeta[targetLane].icon;
                  const active = task.lane === targetLane;
                  return <button type="button" key={targetLane} className={active ? 'active' : ''} aria-pressed={active} disabled={taskLocked || active} onClick={() => void transferTask(targetLane)}><StageIcon size={13} /><span>{laneMeta[targetLane].title}</span>{active && <Check size={12} />}</button>;
                })}
              </div>
              <button type="button" className="stage-archive-button" aria-label="归档任务，可从已归档恢复" onClick={() => void onArchive(task)}><Archive size={13} /><span>归档任务</span><small>可恢复</small></button>
            </div>
          </div>
          <div className="detail-section"><h3>验收标准</h3><textarea className="criteria-box" defaultValue={task.acceptanceCriteria} placeholder="尚未填写验收标准" onBlur={(event) => void patchTask({ acceptanceCriteria: event.target.value })} /></div>
          <div className="insight-box">
            <div className="insight-title"><Sparkles size={16} /><strong>智能验收提示</strong></div>
            <ul>
              <li className={task.acceptanceCriteria ? 'done' : ''}>{task.acceptanceCriteria ? '验收标准已记录' : '补充可验证的验收标准'}</li>
              <li className={conversationThreadId ? 'done' : ''}>{conversationThreadId ? '执行对话可追溯' : '关联执行该任务的 Codex 对话'}</li>
              <li className={task.auditor ? 'done' : ''}>{task.auditor ? `验收结论已由${task.auditor}记录` : '可由用户直接确认，或发起 AI 验收'}</li>
            </ul>
          </div>
          {task.lane === 'review' && (
            <div className="review-box">
              <div className="review-title"><ShieldCheck size={17} /><div><strong>验收与回顾</strong><span>由你直接确认，或交给 AI 检查</span></div></div>
              <label className="field"><span>验收方式</span><select value={reviewMode} onChange={(event) => setReviewMode(event.target.value as 'user' | 'ai')}><option value="user">用户验收</option><option value="ai">AI 验收</option></select></label>
              <label className="field"><span>{reviewMode === 'ai' ? 'AI 关注点（可选）' : '证据与回顾（可选）'}</span><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} placeholder={reviewMode === 'ai' ? '不填写也可以直接发起，AI会按验收标准判断' : '可留空，系统会自动记录验收动作'} /></label>
              {reviewMode === 'ai' ? <>
                <div className="ai-review-hint"><Bot size={14} /><span>{!task.threadId ? '请先关联执行对话' : !task.acceptanceCriteria ? '请先填写验收标准' : 'AI将读取关联对话作为证据；不通过会自动退回执行。'}</span></div>
                <div className="review-actions"><button type="button" className="accept-button ai-review-button" disabled={aiReviewBusy || !task.threadId || !task.acceptanceCriteria} onClick={() => void runAiReview()}>{aiReviewBusy ? <LoaderCircle className="spin" size={14} /> : <Bot size={14} />}{aiReviewBusy ? 'AI 验收中…' : '发起 AI 验收'}</button></div>
              </> : <div className="review-actions"><button type="button" className="secondary-button danger-text" onClick={() => void review('rework')}>退回执行</button><button type="button" className="secondary-button" onClick={() => void review('closed')}>仅回顾关闭</button><button type="button" className="accept-button" onClick={() => void review('accepted')}><ShieldCheck size={14} />通过验收</button></div>}
            </div>
          )}
          <div className="detail-section"><h3>审计轨迹</h3><div className="timeline">{events.map((event) => <div className="timeline-event" key={event.id}><span className="timeline-dot" /><div><strong>{event.action}</strong><p>{event.note}</p><small>{event.actorRole} · {formatTime(event.createdAt)}</small></div></div>)}{!events.length && <p className="empty-copy">尚无记录</p>}</div></div>
        </div>
      ) : tab === 'execution' ? (
        <div className="execution-pane">
          <div className="execution-controls">
            <div className="execution-status-line">
              <span className={`execution-status execution-${execution?.status ?? 'idle'}`}><i />{reworkReady ? '等待继续执行' : execution ? executionStatusText[execution.status] : '尚未执行'}</span>
              <time>{execution?.startedAt ? `${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒` : '等待启动'}</time>
            </div>
            <div className="execution-settings">
              <label><span>模型</span><select value={model} onChange={(event) => { const nextModel = models.find((item) => item.id === event.target.value); setModel(event.target.value); if (nextModel) { setEffort(nextModel.defaultReasoningEffort); setServiceTier(nextModel.defaultServiceTier ?? ''); } }} disabled={sending || executionBusy}>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
              <label><span>速度</span><select value={serviceTier} onChange={(event) => setServiceTier(event.target.value)} disabled={sending || executionBusy}><option value="">标准</option>{serviceTierOptions.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
              <label><span>思考深度</span><select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={sending || executionBusy}>{effortOptions.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortText[item.reasoningEffort] ?? item.reasoningEffort}</option>)}</select></label>
              <label><span>审批策略</span><select value={permissionPreset} onChange={(event) => setPermissionPreset(event.target.value as ExecutionPermissionPreset)} disabled={sending || executionBusy}><option value="untrusted">未信任操作询问</option><option value="on-request">Codex 按需申请</option><option value="full-access">完全访问权限</option></select></label>
            </div>
            {permissionPreset === 'full-access' && <div className="permission-warning"><AlertTriangle size={13} /><span><strong>完全访问</strong> 将关闭审批和沙盒限制；启动前仍需你再次确认。</span></div>}
          </div>

          <div className="execution-scroll">
            {execution?.pendingApproval && <section className="approval-card" aria-label="等待审批">
              <div className="approval-card-title"><ShieldCheck size={16} /><div><strong>需要你的审批</strong><span>{execution.pendingApproval.reason || 'Codex 请求执行受保护操作'}</span></div></div>
              {execution.pendingApproval.command && <code>{execution.pendingApproval.command}</code>}
              <dl><div><dt>目录</dt><dd>{execution.pendingApproval.cwd || task.projectPath || '未提供'}</dd></div>{execution.pendingApproval.networkHost && <div><dt>网络目标</dt><dd>{execution.pendingApproval.networkProtocol ? `${execution.pendingApproval.networkProtocol}://` : ''}{execution.pendingApproval.networkHost}</dd></div>}</dl>
              {execution.pendingApproval.unsupportedDecisionCount > 0 && <p className="execution-empty">另有 {execution.pendingApproval.unsupportedDecisionCount} 个结构化决策暂不由工作台展示，可转到 Codex 处理。</p>}
              {execution.pendingApproval.responseSubmitted && <p className="execution-empty">审批决定已提交，正在等待 Codex 确认。</p>}
              <div className="approval-actions">{execution.pendingApproval.availableDecisions.includes('cancel') && <button type="button" className="secondary-button danger-text" disabled={approvalBusy || execution.pendingApproval.responseSubmitted} onClick={() => void respondApproval('cancel')}>取消请求</button>}{execution.pendingApproval.availableDecisions.includes('decline') && <button type="button" className="secondary-button danger-text" disabled={approvalBusy || execution.pendingApproval.responseSubmitted} onClick={() => void respondApproval('decline')}>拒绝</button>}{execution.pendingApproval.availableDecisions.includes('acceptForSession') && <button type="button" className="secondary-button" disabled={approvalBusy || execution.pendingApproval.responseSubmitted} onClick={() => void respondApproval('acceptForSession')}>本次会话允许</button>}{execution.pendingApproval.availableDecisions.includes('accept') && <button type="button" className="primary-button" disabled={approvalBusy || execution.pendingApproval.responseSubmitted} onClick={() => void respondApproval('accept')}>{approvalBusy || execution.pendingApproval.responseSubmitted ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{execution.pendingApproval.responseSubmitted ? '等待确认' : '批准一次'}</button>}</div>
            </section>}

            {execution?.pendingUserInput && <section className="approval-card user-input-card" aria-label="等待回答">
              <div className="approval-card-title"><MessageSquareText size={16} /><div><strong>Codex 需要补充信息</strong><span>{execution.pendingUserInput.isBlocking ? '回答前执行将暂停' : '可补充信息以继续执行'}</span></div></div>
              {execution.pendingUserInput.questions.map((question) => <label className="field" key={question.id}><span>{question.header || question.question}</span>{question.options.length && !question.isOther ? <select value={userInputAnswers[question.id] ?? ''} onChange={(event) => setUserInputAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">请选择</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <><input type={question.isSecret ? 'password' : 'text'} list={question.options.length ? `request-options-${question.id}` : undefined} value={userInputAnswers[question.id] ?? ''} onChange={(event) => setUserInputAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.question} />{question.options.length > 0 && <datalist id={`request-options-${question.id}`}>{question.options.map((option) => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist>}</>}</label>)}
              <div className="approval-actions"><button type="button" className="secondary-button danger-text" disabled={userInputBusy} onClick={() => void closeUserInput(true)}>取消</button><button type="button" className="primary-button" disabled={userInputBusy} onClick={() => void closeUserInput(false)}>{userInputBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}提交回答</button></div>
            </section>}

            <section className="execution-section execution-plan">
              <div className="execution-section-title"><Activity size={14} /><strong>执行计划</strong><span>{execution?.plan.filter((item) => item.status === 'completed').length ?? 0}/{execution?.plan.length ?? 0}</span></div>
              {execution?.plan.length ? <div className="execution-plan-list">{execution.plan.map((item, index) => <div className={`execution-plan-item plan-${item.status}`} key={`${item.step}-${index}`}><span>{item.status === 'completed' ? <Check size={12} /> : item.status === 'inProgress' ? <LoaderCircle className="spin" size={12} /> : <CircleDot size={12} />}</span><p>{item.step}</p></div>)}</div> : <p className="execution-empty">Codex 分享计划后会显示在这里。</p>}
            </section>

            <section className="execution-section">
              <div className="execution-section-title"><Bot size={14} /><strong>最新进展</strong></div>
              <p className="execution-message">{execution?.lastMessage || '尚未收到执行消息。'}</p>
            </section>

            <section className="execution-section">
              <div className="execution-section-title"><SquareTerminal size={14} /><strong>终端输出</strong>{execution?.currentItem?.type === 'commandExecution' && <span>运行中</span>}</div>
              <pre className="execution-console">{execution?.output || '尚无命令输出。'}</pre>
            </section>

            <section className="execution-section">
              <div className="execution-section-title"><FileDiff size={14} /><strong>文件变化</strong></div>
              <pre className="execution-diff">{execution?.diff || '尚无文件变化。'}</pre>
            </section>

            {execution?.error && <div className="execution-error"><AlertTriangle size={14} /><span>{execution.error}</span></div>}
          </div>

          <div className="execution-composer">
            {steerReady && <p className="steer-mode-note"><Activity size={11} />引导当前回合<span>补充内容会立即生效</span></p>}
            {attachmentTray()}
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => void pasteComposerImages(event)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !composerDisabled && hasComposerInput) { event.preventDefault(); void sendMessage('execution'); } }} placeholder={execution?.status === 'waiting_approval' ? '请先处理审批，再继续引导' : execution?.status === 'waiting_input' ? '请先回答 Codex 的问题' : steerReady ? '补充要求、粘贴截图或修正方向，发送后直接引导当前回合…' : reworkReady ? '补充返工要求或粘贴截图，发送后创建新的执行回合…' : execution?.status === 'completed' ? '继续追问、补充下一步要求或粘贴截图…' : '告诉 Codex 下一步要执行什么，支持直接粘贴截图…'} rows={2} disabled={composerDisabled} />
            <div><span>{!conversationThreadId ? '请先创建或关联 Codex 会话' : taskLocked ? '终态任务已锁定' : execution?.status === 'waiting_approval' ? '请先处理审批' : execution?.status === 'waiting_input' ? '请先回答 Codex 的问题' : steerReady ? '正在执行 · 本次发送会引导当前回合' : `${selectedModel?.displayName ?? 'Codex'} · ${selectedServiceTier?.name ?? '标准'} · ${(effortText[effort] ?? effort) || '默认'}`}</span><div className="composer-actions"><button type="button" className="attachment-button" aria-label="添加截图" title="添加截图（也可直接粘贴）" disabled={composerDisabled || attachments.length >= 4} onClick={() => void pickComposerImages()}><ImagePlus size={14} /></button><button type="button" className={`send-button ${steerReady ? 'steer-button' : ''}`} title={steerReady ? '引导当前回合（⌘ Enter）' : '开始执行（⌘ Enter）'} disabled={composerDisabled || !hasComposerInput} onClick={() => void sendMessage('execution')}>{sending ? <LoaderCircle className="spin" size={14} /> : steerReady ? <Send size={14} /> : <Play size={14} />}</button></div></div>
          </div>
        </div>
      ) : (
        <div className="thread-pane">
          <div className="thread-context">
            <div><Bot size={17} /><span><strong>{effectiveThread ? threadTitle(effectiveThread) : conversationThreadId ? '关联对话待同步' : '未关联对话'}</strong><small>{effectiveThread ? shortPath(effectiveThread.cwd) : conversationThreadId ? '目录尚未同步，但仍可在这里继续发送消息' : '请先在任务中关联一个 Codex 对话'}</small></span></div>
            {conversationThreadId && <button type="button" className="quiet-button" disabled={handoffBusy} title={executionBusy ? '中断 Workboard 当前回合并释放会话后，在 Codex 中继续' : '在 Codex 中打开'} onClick={() => void openConversationInCodex()}>{handoffBusy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}{executionBusy ? '转到 Codex' : '在 Codex 中打开'}</button>}
          </div>
          <div className="messages" ref={messagesRef} aria-live="polite">
            {loadingThread && <div className="column-empty"><LoaderCircle className="spin" size={18} />读取对话记录</div>}
            {!loadingThread && messages.map((item, index) => <div className={`message ${item.role}`} key={`${item.role}-${index}`}><div className="message-role">{item.role === 'user' ? <UserRound size={13} /> : <Bot size={13} />}{item.role === 'user' ? '你' : 'Codex'}</div><p>{item.text}</p></div>)}
            {pendingThreadMessages.map((item) => <div className={`message user pending-message ${item.kind === 'steer' ? 'steer-message' : ''}`} key={item.id}><div className="message-role"><UserRound size={13} />你 · {item.kind === 'steer' ? '已引导当前回合' : '已发送'}</div><p>{item.text}</p></div>)}
            {executionBusy && <div className="message assistant thread-live-message"><div className="message-role"><LoaderCircle className="spin" size={13} />Codex · {execution?.status === 'waiting_approval' ? '等待审批' : execution?.status === 'waiting_input' ? '等待回答' : '正在回复'}</div><div className="thread-live-bubble"><p>{execution?.status === 'waiting_approval' ? execution.pendingApproval?.reason || '需要你确认一项受保护操作。' : execution?.status === 'waiting_input' ? execution.pendingUserInput?.questions[0]?.question || '需要你补充信息。' : execution?.lastMessage || '正在处理你的消息…'}</p><button type="button" className="quiet-button" onClick={() => setTab('execution')}><Activity size={13} />{execution?.status === 'waiting_approval' ? '处理审批' : execution?.status === 'waiting_input' ? '回答问题' : '查看执行'}</button></div></div>}
            {!loadingThread && conversationThreadId && effectiveThread && !messages.length && <div className="column-empty"><MessageSquareText size={18} /><strong>对话已关联</strong><span>可以在下方直接继续发送消息</span></div>}
            {!loadingThread && conversationThreadId && !effectiveThread && <div className="column-empty"><RefreshCw size={18} /><strong>对话目录待同步</strong><span>历史记录暂不可见，但不影响继续发送</span></div>}
            {!conversationThreadId && <div className="column-empty"><Link2 size={18} /><strong>未关联 Codex 对话</strong><span>编辑任务时选择一个本机对话</span></div>}
          </div>
          {conversationThreadId && <div className="thread-composer">
            <div className="execution-settings thread-composer-settings">
              <label><span>模型</span><select value={model} onChange={(event) => { const nextModel = models.find((item) => item.id === event.target.value); setModel(event.target.value); if (nextModel) { setEffort(nextModel.defaultReasoningEffort); setServiceTier(nextModel.defaultServiceTier ?? ''); } }} disabled={sending || executionBusy}>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
              <label><span>速度</span><select value={serviceTier} onChange={(event) => setServiceTier(event.target.value)} disabled={sending || executionBusy}><option value="">标准</option>{serviceTierOptions.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
              <label><span>思考深度</span><select value={effort} onChange={(event) => setEffort(event.target.value)} disabled={sending || executionBusy}>{effortOptions.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortText[item.reasoningEffort] ?? item.reasoningEffort}</option>)}</select></label>
              <label><span>审批策略</span><select value={permissionPreset} onChange={(event) => setPermissionPreset(event.target.value as ExecutionPermissionPreset)} disabled={sending || executionBusy}><option value="untrusted">未信任操作询问</option><option value="on-request">Codex 按需申请</option><option value="full-access">完全访问权限</option></select></label>
            </div>
            {permissionPreset === 'full-access' && <div className="permission-warning"><AlertTriangle size={13} /><span><strong>完全访问</strong> 将关闭审批和沙盒限制；发送前仍需你再次确认。</span></div>}
            {steerReady && <p className="steer-mode-note"><Activity size={11} />引导当前回合<span>补充内容会立即生效</span></p>}
            {attachmentTray()}
            <textarea aria-label="直接回复关联对话" value={message} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => void pasteComposerImages(event)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !composerDisabled && hasComposerInput) { event.preventDefault(); void sendMessage('thread'); } }} placeholder={execution?.status === 'waiting_approval' ? '请先处理审批，再继续引导' : execution?.status === 'waiting_input' ? '请先回答 Codex 的问题' : steerReady ? '补充要求、粘贴截图或修正方向，发送后直接引导当前回合…' : taskLocked ? '终态任务已锁定' : '直接回复这段对话，支持粘贴截图…'} rows={3} disabled={composerDisabled} />
            <div className="thread-composer-footer"><span>{execution?.status === 'waiting_approval' ? '请先处理审批' : execution?.status === 'waiting_input' ? '请先回答 Codex 的问题' : steerReady ? '正在执行 · ⌘ Enter 引导当前回合' : `${selectedModel?.displayName ?? 'Codex'} · ⌘ Enter 发送`}</span><div className="composer-actions"><button type="button" className="attachment-button" aria-label="添加截图" title="添加截图（也可直接粘贴）" disabled={composerDisabled || attachments.length >= 4} onClick={() => void pickComposerImages()}><ImagePlus size={14} /></button><button type="button" className={`send-button ${steerReady ? 'steer-button' : ''}`} aria-label={steerReady ? '引导当前回合' : '发送消息'} title={steerReady ? '引导当前回合（⌘ Enter）' : '发送消息（⌘ Enter）'} disabled={composerDisabled || !hasComposerInput} onClick={() => void sendMessage('thread')}>{sending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}</button></div></div>
          </div>}
        </div>
      )}
    </aside>
  );
}

export default App;
