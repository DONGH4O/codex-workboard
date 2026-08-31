import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../dist-electron/codexBridge.js';
import { TaskStore } from '../dist-electron/taskStore.js';

const userDataDir = process.env.WORKBOARD_USER_DATA_DIR
  ? path.resolve(process.env.WORKBOARD_USER_DATA_DIR)
  : path.join(os.homedir(), 'Library', 'Application Support', 'Codex Workboard');
const databasePath = path.join(userDataDir, 'taskboard.sqlite');
const store = new TaskStore(databasePath);
const bridge = new CodexBridge();

try {
  const conversations = store.syncConversations(await bridge.listThreads());
  const result = store.runDailyMaintenance();
  process.stdout.write(`${JSON.stringify({ ok: true, databasePath, syncedConversations: conversations.length, ...result }, null, 2)}\nWORKBOARD_DAILY_READY\n`);
} finally {
  bridge.stop();
  store.close();
}
