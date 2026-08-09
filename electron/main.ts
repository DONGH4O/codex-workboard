import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from './codexBridge.js';
import { TaskStore, type TaskInput } from './taskStore.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const bridge = new CodexBridge();
let store: TaskStore;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1050,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    backgroundColor: '#f5f5f7',
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
  const capturePath = process.env.TASKBOARD_CAPTURE_PATH;
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG());
          if (process.env.TASKBOARD_CAPTURE_AND_EXIT === '1') app.quit();
        });
      }, 2500);
    });
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', async () => {
    let threads: Array<Record<string, unknown>> = [];
    let error = '';
    try {
      threads = await bridge.listThreads();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      tasks: store.list(),
      threads,
      codex: { ...bridge.status(), ...(error ? { error } : {}) },
    };
  });
  ipcMain.handle('threads:list', () => bridge.listThreads());
  ipcMain.handle('threads:read', (_event, threadId: string) => bridge.readThread(threadId));
  ipcMain.handle('threads:send', (_event, threadId: string, text: string) => bridge.sendToThread(threadId, text));
  ipcMain.handle('threads:open', async (_event, threadId: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error('无效的对话 ID');
    await shell.openExternal(`codex://threads/${encodeURIComponent(threadId)}`);
  });
  ipcMain.handle('tasks:create', (_event, input: TaskInput) => store.create(input));
  ipcMain.handle('tasks:update', (_event, id: string, patch: Partial<TaskInput>) => store.update(id, patch));
  ipcMain.handle('tasks:audit:list', (_event, taskId: string) => store.listEvents(taskId));
  ipcMain.handle(
    'tasks:review',
    (_event, id: string, input: { auditor: string; decision: 'accepted' | 'rework' | 'closed'; note: string }) =>
      store.review(id, input),
  );
}

app.whenReady().then(() => {
  store = new TaskStore(path.join(app.getPath('userData'), 'taskboard.sqlite'));
  if (process.env.TASKBOARD_SEED_DEMO === '1' && store.list().length === 0) {
    store.create({
      title: '整理长期项目的下一步',
      description: '把分散在对话里的目标收拢为可执行任务。',
      lane: 'plan',
      substatus: 'idea',
      priority: 'medium',
      acceptanceCriteria: '任务目标、边界和关联对话均清晰可追溯。',
    });
    store.create({
      title: '在关联对话中继续执行',
      description: '任务与 Codex 对话保持双向可追溯。',
      lane: 'execution',
      substatus: 'running',
      priority: 'high',
      executor: '执行角色',
      acceptanceCriteria: '对话记录可以在右侧面板读取。',
    });
    store.create({
      title: '由独立角色完成验收',
      description: '验收结论和证据写入审计轨迹。',
      lane: 'review',
      substatus: 'pending_review',
      priority: 'medium',
      executor: '执行角色',
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  bridge.stop();
  store?.close();
});
