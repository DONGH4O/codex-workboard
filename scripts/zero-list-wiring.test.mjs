import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const readSource = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('zero directory read production wiring', () => {
  it('guards the production threads:list handler with the isolation switch', () => {
    const main = readSource('electron/main.ts');
    const handler = between(main, "ipcMain.handle('threads:list'", "ipcMain.handle('threads:read'");

    expect(handler).toContain('loadConversationDirectory({');
    expect(handler).toContain('qaUiHarnessEnabled || shouldSkipCodexSync(process.env)');
    expect(handler).toContain('loadStored: () => store.listConversations()');
    expect(handler).toContain('loadRemote: () => bridge.listThreads()');
    expect(handler).toContain('persistRemote: (threads) => store.syncConversations(threads)');
  });

  it('wires bootstrap isolation state into the post-create UI path', () => {
    const app = readSource('src/App.tsx');
    const createTask = between(app, 'async function createTask(input: CreateTaskInput)', 'async function bulkCreateTasks()');

    expect(createTask).toContain('refreshThreadsAfterTaskCreation({');
    expect(createTask).toContain('syncSkipped: sync.skipped');
    expect(createTask).toContain('listThreads: () => window.codexTaskboard.listThreads()');
    expect(createTask).toContain('if (syncedThreads)');
    expect(createTask).toContain('隔离模式未刷新既有会话目录');
  });

  it('renders an explicit isolation state instead of claiming remote synchronization', () => {
    const app = readSource('src/App.tsx');
    expect(app).toContain("sync.skipped ? 'Codex 隔离验收模式'");
    expect(app).toContain('未刷新既有会话目录');
    expect(app).toContain("sync.skipped ? '隔离模式，不刷新既有会话目录'");
  });
});
