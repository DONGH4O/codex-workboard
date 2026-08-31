import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('codexTaskboard', {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listThreads: () => ipcRenderer.invoke('threads:list'),
  readThread: (threadId: string) => ipcRenderer.invoke('threads:read', threadId),
  listModels: () => ipcRenderer.invoke('models:list'),
  pickImages: () => ipcRenderer.invoke('attachments:pick-images'),
  savePastedImage: (input: unknown) => ipcRenderer.invoke('attachments:save-pasted-image', input),
  sendToThread: (input: unknown) => ipcRenderer.invoke('threads:send', input),
  steerTurn: (input: unknown) => ipcRenderer.invoke('execution:steer', input),
  getExecution: (taskId: string) => ipcRenderer.invoke('execution:get', taskId),
  respondToApproval: (input: unknown) => ipcRenderer.invoke('execution:approval:respond', input),
  onExecutionEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('execution:event', listener);
    return () => ipcRenderer.removeListener('execution:event', listener);
  },
  openThreadInCodex: (threadId: string) => ipcRenderer.invoke('threads:open', threadId),
  handoffToCodex: (input: unknown) => ipcRenderer.invoke('threads:handoff-to-codex', input),
  updateConversation: (threadId: string, input: unknown) => ipcRenderer.invoke('threads:update-meta', threadId, input),
  createTask: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
  bulkCreateTasks: () => ipcRenderer.invoke('tasks:bulk-create-from-conversations'),
  updateTask: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
  archiveTask: (id: string) => ipcRenderer.invoke('tasks:archive', id),
  restoreTask: (id: string) => ipcRenderer.invoke('tasks:restore', id),
  listAuditEvents: (taskId: string) => ipcRenderer.invoke('tasks:audit:list', taskId),
  reviewTask: (id: string, input: unknown) => ipcRenderer.invoke('tasks:review', id, input),
  aiReviewTask: (id: string, input: unknown) => ipcRenderer.invoke('tasks:ai-review', id, input),
  runDailyMaintenance: () => ipcRenderer.invoke('tasks:daily-maintenance'),
  archiveCompletedTasks: () => ipcRenderer.invoke('tasks:archive-completed'),
});
