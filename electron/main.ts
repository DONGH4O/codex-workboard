import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge, isThreadNotFoundError, type CodexBridgeEvent } from './codexBridge.js';
import { loadBootstrapConversations } from './bootstrap.js';
import { emptyExecutionSnapshot, eventThreadId, eventTurnId, reduceExecutionSnapshot, type ApprovalDecision, type ExecutionPermissionPreset, type ExecutionSnapshot } from './executionTracker.js';
import { browserWindowPlatformOptions, shouldQuitWhenAllWindowsClose, shouldSkipCodexSync, WINDOWS_APP_USER_MODEL_ID } from './platform.js';
import { TaskStore, type TaskInput } from './taskStore.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
app.setName('Codex Workboard');
if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
const appDataPath = app.getPath('appData');
const requestedUserData = process.env.WORKBOARD_USER_DATA_DIR;
app.setPath('userData', requestedUserData ? path.resolve(requestedUserData) : path.join(appDataPath, 'Codex Workboard'));
const bridge = new CodexBridge();
let store: TaskStore;
let mainWindow: BrowserWindow | null = null;
let migratedTaskCount = 0;
const turnTasks = new Map<string, string>();
const pendingThreadTasks = new Map<string, string>();
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const imageMimeByExtension: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
type ComposerImage = { path: string; name: string; preview: string };

function validateImagePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');
  const stats = statSync(resolved);
  if (!stats.isFile() || stats.size > 12 * 1024 * 1024) throw new Error('截图必须是小于 12MB 的图片文件');
  return resolved;
}

function imageAttachment(filePath: string): ComposerImage {
  const resolved = validateImagePath(filePath);
  const extension = path.extname(resolved).toLowerCase();
  return {
    path: resolved,
    name: path.basename(resolved),
    preview: `data:${imageMimeByExtension[extension]};base64,${readFileSync(resolved).toString('base64')}`,
  };
}

function normalizeTurnImages(value: unknown): Array<{ path: string; detail: 'original' }> {
  if (!Array.isArray(value)) return [];
  if (value.length > 4) throw new Error('每次最多添加 4 张截图');
  return value.map((item) => {
    const imagePath = item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' ? (item as { path: string }).path : '';
    if (!imagePath) throw new Error('截图路径无效');
    return { path: validateImagePath(imagePath), detail: 'original' as const };
  });
}

function steeringError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not steerable|active turn|expectedTurnId|turn mismatch|no active turn/i.test(message)) {
    return new Error('当前回合暂时无法引导，可能已经结束，或正处于评审/压缩阶段。请等待状态更新后再发送。');
  }
  return error instanceof Error ? error : new Error(message);
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

function publishExecution(snapshot: ExecutionSnapshot, task = store.get(snapshot.taskId)): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('execution:event', { snapshot, task });
}

function taskForBridgeEvent(event: CodexBridgeEvent) {
  const turnId = eventTurnId(event);
  const mappedTaskId = turnId ? turnTasks.get(turnId) : null;
  if (mappedTaskId) return store.get(mappedTaskId);
  const threadId = eventThreadId(event);
  const pendingTaskId = threadId ? pendingThreadTasks.get(threadId) : null;
  if (pendingTaskId) return store.get(pendingTaskId);
  return threadId ? store.findRunnableTaskByThreadId(threadId) : null;
}

function handleBridgeEvent(event: CodexBridgeEvent): void {
  const task = taskForBridgeEvent(event);
  if (!task?.threadId) return;
  const turnId = eventTurnId(event);
  if (turnId) turnTasks.set(turnId, task.id);
  const previous = store.getExecutionSnapshot(task.id);
  const base = previous ?? emptyExecutionSnapshot({ taskId: task.id, threadId: task.threadId, turnId: turnId || null });
  const next = store.saveExecutionSnapshot(reduceExecutionSnapshot(base, event));
  let updatedTask = task;
  if (event.method === 'turn/started' && turnId && previous?.turnId !== turnId) {
    updatedTask = store.markExecutionStarted(task.id, turnId);
  }
  if (event.method === 'turn/completed' && turnId && previous?.status !== next.status) {
    updatedTask = store.markExecutionFinished(task.id, next.status === 'completed' ? 'completed' : next.status === 'interrupted' ? 'interrupted' : 'failed', turnId);
    showNotification(next.status === 'completed' ? '任务进入验收' : '任务执行受阻', updatedTask.title);
  } else if (next.status === 'waiting_approval' && previous?.pendingApproval?.requestId !== next.pendingApproval?.requestId) {
    showNotification('任务等待审批', updatedTask.title);
  }
  publishExecution(next, updatedTask);
  if (event.method === 'turn/completed' && turnId) turnTasks.delete(turnId);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    ...browserWindowPlatformOptions(process.platform),
    backgroundColor: '#eef8ff',
    show: false,
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(currentDir, '../dist-renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:') && !url.startsWith('http://127.0.0.1:5173')) event.preventDefault();
  });
  const capturePath = process.env.WORKBOARD_CAPTURE_PATH || process.env.TASKBOARD_CAPTURE_PATH;
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG());
          if (process.env.WORKBOARD_CAPTURE_AND_EXIT === '1' || process.env.TASKBOARD_CAPTURE_AND_EXIT === '1') app.quit();
        });
      }, 2500);
    });
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', async () => {
    const { threads, error, stale } = await loadBootstrapConversations({
      skipCodexSync: shouldSkipCodexSync(process.env),
      loadStored: () => store.listConversations(),
      loadRemote: () => bridge.listThreads(),
      persistRemote: (remoteThreads) => store.syncConversations(remoteThreads),
    });
    const unarchived = threads.filter((thread) => !thread.archived).length;
    const archived = threads.length - unarchived;
    const syncState = store.getSyncState();
    return {
      tasks: store.listActive(),
      executions: store.listExecutionSnapshots(),
      threads,
      categories: store.listCategories(),
      sync: {
        total: threads.length,
        active: unarchived,
        unarchived,
        archived,
        lastSyncedAt: syncState.lastCompletedAt,
        stale,
        migratedTaskCount,
        archivedTaskCount: store.archivedCount(),
      },
      codex: { ...bridge.status(), ...(error ? { error } : {}) },
    };
  });
  ipcMain.handle('threads:list', async () => store.syncConversations(await bridge.listThreads()));
  ipcMain.handle('threads:read', (_event, threadId: string) => bridge.readThread(threadId));
  ipcMain.handle('models:list', () => bridge.listModels());
  ipcMain.handle('attachments:pick-images', async () => {
    const options = {
      title: '选择要发送给 Codex 的截图',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths.slice(0, 4).map(imageAttachment);
  });
  ipcMain.handle('attachments:save-pasted-image', (_event, input: { bytes?: Uint8Array; mimeType?: string }) => {
    const mimeType = input?.mimeType ?? '';
    const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : mimeType === 'image/gif' ? '.gif' : '';
    if (!extension) throw new Error('剪贴板图片格式不受支持');
    const buffer = Buffer.from(input.bytes ?? []);
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('截图必须小于 12MB');
    const directory = path.join(app.getPath('userData'), 'attachments');
    mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${randomUUID()}${extension}`);
    writeFileSync(filePath, buffer, { flag: 'wx' });
    return imageAttachment(filePath);
  });
  ipcMain.handle('threads:send', async (_event, input: { taskId: string; threadId: string; text: string; images?: unknown; model?: string; effort?: string; serviceTier?: string | null; permissionPreset?: ExecutionPermissionPreset }) => {
    let task = store.get(input.taskId);
    if (!task.threadId || task.threadId !== input.threadId) throw new Error('任务与关联对话不匹配');
    const images = normalizeTurnImages(input.images);
    if (!input.text?.trim() && !images.length) throw new Error('请输入要交给 Codex 的任务或添加截图');
    if (pendingThreadTasks.has(input.threadId)) throw new Error('该对话已有任务正在启动');
    let activeThreadId = input.threadId;
    let conversationRecovered = false;
    pendingThreadTasks.set(activeThreadId, task.id);
    let response: unknown;
    try {
      response = await bridge.sendToThread({ ...input, images, threadId: activeThreadId, text: input.text?.trim() ?? '', cwd: task.projectPath && path.isAbsolute(task.projectPath) ? task.projectPath : undefined });
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        pendingThreadTasks.delete(activeThreadId);
        throw error;
      }
      const previousThreadId = activeThreadId;
      pendingThreadTasks.delete(previousThreadId);
      try {
        activeThreadId = await bridge.createThread({
          title: `${task.title} · 续作`,
          cwd: task.projectPath && path.isAbsolute(task.projectPath) ? task.projectPath : undefined,
          model: input.model,
          serviceTier: input.serviceTier,
        });
        task = store.relinkThread(task.id, activeThreadId, `原对话 ${previousThreadId} 无法恢复，已创建续作对话 ${activeThreadId}`);
        conversationRecovered = true;
        pendingThreadTasks.set(activeThreadId, task.id);
        response = await bridge.sendToThread({ ...input, images, threadId: activeThreadId, text: input.text?.trim() ?? '', cwd: task.projectPath && path.isAbsolute(task.projectPath) ? task.projectPath : undefined });
      } catch (recoveryError) {
        pendingThreadTasks.delete(activeThreadId);
        const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new Error(`原对话无法恢复，创建续作对话也失败：${reason}`);
      }
    }
    const turn = response && typeof response === 'object' ? (response as { turn?: Record<string, unknown> }).turn : null;
    const turnId = turn && typeof turn.id === 'string' ? turn.id : '';
    if (!turnId) {
      pendingThreadTasks.delete(activeThreadId);
      throw new Error('Codex 未返回执行回合 ID');
    }
    turnTasks.set(turnId, task.id);
    pendingThreadTasks.delete(activeThreadId);
    const existing = store.getExecutionSnapshot(task.id);
    const snapshot = store.saveExecutionSnapshot({
      ...(existing?.turnId === turnId ? existing : emptyExecutionSnapshot({ taskId: task.id, threadId: activeThreadId, turnId })),
      model: input.model || existing?.model || null,
      effort: input.effort || existing?.effort || null,
      serviceTier: input.serviceTier !== undefined ? input.serviceTier : existing?.serviceTier ?? null,
      permissionPreset: input.permissionPreset ?? 'untrusted',
      status: 'running',
      updatedAt: new Date().toISOString(),
    });
    const updatedTask = existing?.turnId === turnId ? store.get(task.id) : store.markExecutionStarted(task.id, turnId);
    publishExecution(snapshot, updatedTask);
    return { turn, snapshot, task: updatedTask, conversationRecovered };
  });
  ipcMain.handle('execution:steer', async (_event, input: { taskId: string; threadId: string; turnId: string; text: string; images?: unknown }) => {
    const task = store.get(input.taskId);
    const snapshot = store.getExecutionSnapshot(input.taskId);
    if (!task.threadId || task.threadId !== input.threadId) throw new Error('任务与关联对话不匹配');
    if (!snapshot || snapshot.threadId !== input.threadId || snapshot.turnId !== input.turnId) throw new Error('当前执行回合已变化，请刷新后重试');
    if (snapshot.status === 'waiting_approval' || snapshot.pendingApproval) throw new Error('请先处理当前审批，再继续引导对话');
    if (snapshot.status !== 'running') throw new Error('当前没有可引导的执行回合');
    const images = normalizeTurnImages(input.images);
    if (!input.text?.trim() && !images.length) throw new Error('请输入引导内容或添加截图');
    try {
      const result = await bridge.steerTurn({ threadId: input.threadId, turnId: input.turnId, text: input.text ?? '', images });
      if (result.turnId !== input.turnId) throw new Error('Codex 返回了不匹配的执行回合');
      store.recordExecutionGuidance(task.id, input.turnId, input.text?.trim() || `已补充 ${images.length} 张截图`);
      return { result, snapshot: store.getExecutionSnapshot(task.id), task: store.get(task.id) };
    } catch (error) {
      throw steeringError(error);
    }
  });
  ipcMain.handle('execution:get', (_event, taskId: string) => store.getExecutionSnapshot(taskId));
  ipcMain.handle('execution:approval:respond', (_event, input: { taskId: string; requestId: number; decision: ApprovalDecision }) => {
    const snapshot = store.getExecutionSnapshot(input.taskId);
    if (!snapshot?.pendingApproval || snapshot.pendingApproval.requestId !== input.requestId) throw new Error('审批请求已失效');
    bridge.respondToApproval(input.requestId, input.decision);
    const updated = store.saveExecutionSnapshot(reduceExecutionSnapshot(snapshot, { method: 'serverRequest/resolved', params: { requestId: input.requestId } }));
    publishExecution(updated);
    return updated;
  });
  ipcMain.handle('threads:open', async (_event, threadId: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error('无效的对话 ID');
    await shell.openExternal(`codex://threads/${encodeURIComponent(threadId)}`);
  });
  ipcMain.handle('threads:handoff-to-codex', async (_event, input: { taskId: string; threadId: string }) => {
    const task = store.get(input.taskId);
    if (!task.threadId || task.threadId !== input.threadId) throw new Error('任务与关联对话不匹配');
    const snapshot = store.getExecutionSnapshot(task.id);
    const live = snapshot && snapshot.threadId === input.threadId && snapshot.turnId && (snapshot.status === 'running' || snapshot.status === 'waiting_approval');
    if (live && snapshot.turnId) {
      await bridge.interruptTurn(input.threadId, snapshot.turnId);
      const now = new Date().toISOString();
      const interrupted = store.saveExecutionSnapshot({ ...snapshot, status: 'interrupted', pendingApproval: null, completedAt: now, updatedAt: now, error: '已由用户转到 Codex 继续' });
      const updatedTask = store.markExecutionFinished(task.id, 'interrupted', snapshot.turnId);
      store.recordConversationHandoff(task.id, input.threadId);
      publishExecution(interrupted, updatedTask);
    }
    await bridge.unsubscribeThread(input.threadId);
    await shell.openExternal(`codex://threads/${encodeURIComponent(input.threadId)}`);
    return { task: store.get(task.id), interrupted: Boolean(live) };
  });
  ipcMain.handle('threads:update-meta', (_event, threadId: string, input: { category?: string; tags?: string[]; note?: string }) =>
    store.updateConversation(threadId, input));
  ipcMain.handle('tasks:create', async (_event, input: TaskInput & { createConversation?: boolean; conversationModel?: string; conversationEffort?: string; conversationServiceTier?: string | null; conversationPermissionPreset?: ExecutionPermissionPreset }) => {
    const {
      createConversation,
      conversationModel,
      conversationEffort,
      conversationServiceTier,
      conversationPermissionPreset,
      ...taskInput
    } = input;
    if (!taskInput.title?.trim()) throw new Error('任务标题不能为空');
    let threadId = taskInput.threadId ?? null;
    if (createConversation && !threadId) {
      threadId = await bridge.createThread({
        title: taskInput.title,
        cwd: taskInput.projectPath && path.isAbsolute(taskInput.projectPath) ? taskInput.projectPath : undefined,
        model: conversationModel,
        serviceTier: conversationServiceTier,
      });
    }
    let task = store.create({ ...taskInput, threadId });
    if (threadId && (conversationModel || conversationEffort || conversationServiceTier !== undefined)) {
      store.saveExecutionSnapshot({
        ...emptyExecutionSnapshot({
          taskId: task.id,
          threadId,
          model: conversationModel ?? null,
          effort: conversationEffort ?? null,
          serviceTier: conversationServiceTier ?? null,
          permissionPreset: conversationPermissionPreset ?? 'untrusted',
        }),
        status: 'idle',
        startedAt: null,
      });
    }
    if (!createConversation || !threadId) return task;

    const firstMessage = [
      `请处理以下任务：${task.title}`,
      task.description ? `任务说明：${task.description}` : '',
      task.acceptanceCriteria ? `验收标准：${task.acceptanceCriteria}` : '',
      '请先给出执行计划，然后开始处理；遇到需要用户确认的操作时请发起审批。',
    ].filter(Boolean).join('\n\n');
    pendingThreadTasks.set(threadId, task.id);
    try {
      const response = await bridge.sendToThread({
        threadId,
        text: firstMessage,
        model: conversationModel,
        effort: conversationEffort,
        serviceTier: conversationServiceTier,
        permissionPreset: conversationPermissionPreset ?? 'untrusted',
        cwd: task.projectPath && path.isAbsolute(task.projectPath) ? task.projectPath : undefined,
      });
      const turn = response && typeof response === 'object' ? (response as { turn?: Record<string, unknown> }).turn : null;
      const turnId = turn && typeof turn.id === 'string' ? turn.id : '';
      if (!turnId) throw new Error('Codex 未返回执行回合 ID');
      turnTasks.set(turnId, task.id);
      const existing = store.getExecutionSnapshot(task.id);
      store.saveExecutionSnapshot({
        ...(existing?.turnId === turnId ? existing : emptyExecutionSnapshot({ taskId: task.id, threadId, turnId })),
        model: conversationModel || existing?.model || null,
        effort: conversationEffort || existing?.effort || null,
        serviceTier: conversationServiceTier !== undefined ? conversationServiceTier : existing?.serviceTier ?? null,
        permissionPreset: conversationPermissionPreset ?? 'untrusted',
        status: 'running',
        updatedAt: new Date().toISOString(),
      });
      task = existing?.turnId === turnId ? store.get(task.id) : store.markExecutionStarted(task.id, turnId);
      return task;
    } catch (error) {
      return {
        ...store.get(task.id),
        conversationLaunchError: error instanceof Error ? error.message : String(error),
      };
    } finally {
      pendingThreadTasks.delete(threadId);
    }
  });
  ipcMain.handle('tasks:bulk-create-from-conversations', () => store.bulkCreateFromConversations());
  ipcMain.handle('tasks:update', (_event, id: string, patch: Partial<TaskInput>) => store.update(id, patch));
  ipcMain.handle('tasks:archive', (_event, id: string) => store.archiveTask(id));
  ipcMain.handle('tasks:restore', (_event, id: string) => store.restoreTask(id));
  ipcMain.handle('tasks:audit:list', (_event, taskId: string) => store.listEvents(taskId));
  ipcMain.handle(
    'tasks:review',
    (_event, id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note?: string; reviewerType?: 'independent' | 'user' | 'ai' }) =>
      store.review(id, input),
  );
  ipcMain.handle('tasks:ai-review', async (_event, id: string, input: { focus?: string }) => {
    const task = store.get(id);
    if (task.lane !== 'review') throw new Error('任务必须先进入“验收和回顾”');
    if (!task.threadId) throw new Error('AI 验收需要先关联执行对话');
    if (!task.acceptanceCriteria.trim()) throw new Error('AI 验收需要明确的验收标准');
    const evidence = await bridge.readThread(task.threadId);
    const result = await bridge.runAcceptanceReview({
      title: task.title,
      criteria: task.acceptanceCriteria,
      evidence: JSON.stringify(evidence),
      focus: input.focus?.trim(),
      cwd: task.projectPath,
    });
    const updated = store.review(id, {
      auditor: 'AI审计 · Codex',
      reviewerType: 'ai',
      decision: result.decision,
      note: `${result.note}\nAI验收会话：${result.reviewThreadId}`,
    });
    return { task: updated, ...result };
  });
  ipcMain.handle('tasks:daily-maintenance', () => store.runDailyMaintenance());
  ipcMain.handle('tasks:archive-completed', () => store.archiveCompletedTasks());
}

app.whenReady().then(() => {
  store = new TaskStore(path.join(app.getPath('userData'), 'taskboard.sqlite'));
  store.expireLiveExecutions();
  bridge.onEvent(handleBridgeEvent);
  migratedTaskCount = process.env.WORKBOARD_SKIP_LEGACY_MIGRATION === '1'
    ? 0
    : store.importLegacy(path.join(appDataPath, 'codex-taskboard-demo', 'taskboard.sqlite'));
  const seedDemo = process.env.WORKBOARD_SEED_DEMO === '1' || process.env.TASKBOARD_SEED_DEMO === '1';
  if (seedDemo && store.list().length === 0) {
    store.syncConversations([
      { id: 'demo-live-thread', name: '示例交付对话', preview: '演示任务执行与审批流程。', cwd: '/demo/project', sourceKind: 'appServer', archived: false, createdAt: 1, updatedAt: 3 },
      { id: 'demo-review-thread', name: '示例验收对话', preview: '演示用户验收与 AI 验收。', cwd: '/demo/review', sourceKind: 'appServer', archived: false, createdAt: 1, updatedAt: 2 },
      { id: 'demo-plan-thread', name: '示例规划对话', preview: '演示任务规划与项目筛选。', cwd: '/demo/planning', sourceKind: 'appServer', archived: false, createdAt: 1, updatedAt: 1 },
    ]);
    store.create({
      title: '整理长期项目的下一步',
      description: '把分散在对话里的目标收拢为可执行任务。',
      lane: 'plan',
      substatus: 'idea',
      priority: 'medium',
      projectName: '规划示例',
      projectPath: '/demo/planning',
      threadId: 'demo-plan-thread',
      acceptanceCriteria: '任务目标、边界和关联对话均清晰可追溯。',
    });
    const executionDemo = store.create({
      title: '在关联对话中继续执行',
      description: '任务与 Codex 对话保持双向可追溯。',
      lane: 'execution',
      substatus: 'running',
      priority: 'high',
      projectName: '交付示例',
      projectPath: '/demo/project',
      executor: '执行角色',
      threadId: 'demo-live-thread',
      acceptanceCriteria: '对话记录可以在右侧面板读取。',
    });
    store.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: executionDemo.id, threadId: 'demo-live-thread', turnId: 'demo-turn', model: 'gpt-5.6-terra', effort: 'medium' }),
      status: 'waiting_approval',
      plan: [
        { step: '读取项目状态', status: 'completed' },
        { step: '运行验证命令', status: 'inProgress' },
        { step: '整理执行结果', status: 'pending' },
      ],
      lastMessage: '正在核对项目状态，下一步需要运行验证命令。',
      output: '$ npm test\n准备执行测试套件',
      diff: 'src/example.ts | 示例变更等待确认',
      currentItem: { type: 'commandExecution', command: 'npm test', cwd: '/demo/project', status: 'inProgress' },
      pendingApproval: {
        requestId: 900001,
        method: 'item/commandExecution/requestApproval',
        threadId: 'demo-live-thread',
        turnId: 'demo-turn',
        itemId: 'demo-command',
        reason: '运行项目测试以验证改动',
        command: 'npm test',
        cwd: '/demo/project',
        networkHost: '',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    });
    const steerDemo = store.create({
      title: '执行中可随时引导',
      description: '在当前回合补充截图或修正方向，不创建新回合。',
      lane: 'execution',
      substatus: 'running',
      priority: 'medium',
      projectName: '交付示例',
      projectPath: '/demo/project',
      executor: 'Codex',
      threadId: 'demo-steer-thread',
      acceptanceCriteria: '引导内容进入同一个执行回合，并写入审计轨迹。',
    });
    store.saveExecutionSnapshot({
      ...emptyExecutionSnapshot({ taskId: steerDemo.id, threadId: 'demo-steer-thread', turnId: 'demo-steer-turn', model: 'gpt-5.6-terra', effort: 'medium' }),
      status: 'running',
      plan: [{ step: '等待用户补充方向', status: 'inProgress' }],
      lastMessage: '正在执行；你可以继续输入文字或粘贴截图来调整方向。',
    });
    store.create({
      title: '由独立角色完成验收',
      description: '验收结论和证据写入审计轨迹。',
      lane: 'review',
      substatus: 'pending_review',
      priority: 'medium',
      projectName: '验收示例',
      projectPath: '/demo/review',
      executor: '执行角色',
      threadId: 'demo-review-thread',
      acceptanceCriteria: '验收人与执行人不同，且有明确回顾记录。',
    });
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (shouldQuitWhenAllWindowsClose(process.platform)) app.quit();
});

app.on('before-quit', () => {
  bridge.stop();
  store?.close();
});
