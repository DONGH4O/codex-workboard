import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('codexTaskboard', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listThreads: () => ipcRenderer.invoke('threads:list'),
  readThread: (threadId: string) => ipcRenderer.invoke('threads:read', threadId),
  sendToThread: (threadId: string, text: string) => ipcRenderer.invoke('threads:send', threadId, text),
  openThreadInCodex: (threadId: string) => ipcRenderer.invoke('threads:open', threadId),
  updateConversation: (threadId: string, input: unknown) => ipcRenderer.invoke('threads:update-meta', threadId, input),
  createTask: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
  updateTask: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
  listAuditEvents: (taskId: string) => ipcRenderer.invoke('tasks:audit:list', taskId),
  reviewTask: (id: string, input: unknown) => ipcRenderer.invoke('tasks:review', id, input),
});
