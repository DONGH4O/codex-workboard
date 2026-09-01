import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from '../dist-electron/codexBridge.js';
import { TaskStore } from '../dist-electron/taskStore.js';
import { resolveWorkboardUserData } from './workboard-paths.mjs';

export async function runDailyMaintenance(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const userDataDir = resolveWorkboardUserData(env, dependencies.platform, dependencies.homeDirectory);
  const databasePath = path.join(userDataDir, 'taskboard.sqlite');
  const store = dependencies.createStore?.(databasePath) ?? new TaskStore(databasePath);
  const bridge = dependencies.createBridge?.() ?? new CodexBridge();
  try {
    const conversations = store.syncConversations(await bridge.listThreads());
    const result = store.runDailyMaintenance();
    (dependencies.output ?? process.stdout.write.bind(process.stdout))(
      `${JSON.stringify({ ok: true, databasePath, syncedConversations: conversations.length, ...result }, null, 2)}\nWORKBOARD_DAILY_READY\n`,
    );
    return result;
  } finally {
    try {
      await bridge.stop();
    } finally {
      store.close();
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDailyMaintenance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
