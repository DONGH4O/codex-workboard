import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkboardUserData } from './workboard-paths.mjs';

export async function runDailyMaintenance(dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const userDataDir = resolveWorkboardUserData(env, dependencies.platform, dependencies.homeDirectory);
  const databasePath = path.join(userDataDir, 'taskboard.sqlite');
  const gateFactory = dependencies.acquireDataAccess
    ?? (await import('../dist-electron/dataAccessGate.js')).acquireDataAccess;
  const lease = gateFactory(userDataDir, 'writer');
  let store;
  let bridge;
  let result;
  let primaryError;
  try {
    const Store = dependencies.createStore ? null : (await import('../dist-electron/taskStore.js')).TaskStore;
    store = dependencies.createStore?.(databasePath) ?? new Store(databasePath);
    const Bridge = dependencies.createBridge ? null : (await import('../dist-electron/codexBridge.js')).CodexBridge;
    bridge = dependencies.createBridge?.() ?? new Bridge();
    const conversations = store.syncConversations(await bridge.listThreads());
    result = store.runDailyMaintenance();
    (dependencies.output ?? process.stdout.write.bind(process.stdout))(
      `${JSON.stringify({ ok: true, databasePath, syncedConversations: conversations.length, ...result }, null, 2)}\nWORKBOARD_DAILY_READY\n`,
    );
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try { await bridge?.stop(); } catch (error) { cleanupError ??= error; }
  try { store?.close(); } catch (error) { cleanupError ??= error; }
  try { lease.release(); } catch (error) { cleanupError ??= error; }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDailyMaintenance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
