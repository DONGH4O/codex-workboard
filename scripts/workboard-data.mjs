import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_NAMES = new Set(['.runtime', '.env', 'credentials', 'credentials.json', 'debug.log', 'logs']);
const CORE_TABLES = ['tasks', 'conversations', 'execution_snapshots', 'audit_events'];
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '..');

function requireAbsolute(label, value) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径`);
  return path.resolve(value);
}

function allowed(sourceRoot, candidate) {
  const relative = path.relative(sourceRoot, candidate);
  if (!relative) return true;
  return !relative.split(path.sep).some((part) => EXCLUDED_NAMES.has(part.toLowerCase()) || part.toLowerCase().endsWith('.log'));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireExternalNewTarget(label, target, forbiddenParent) {
  if (existsSync(target)) throw new Error(`${label}必须尚不存在`);
  if (isWithin(CHECKOUT_ROOT, target)) throw new Error(`${label}不能位于源码目录内部`);
  if (forbiddenParent && isWithin(forbiddenParent, target)) throw new Error(`${label}不能位于源目录内部`);
}

export function buildReadableManifest(root, sourceRoot = root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const absolute = path.join(entry.parentPath, entry.name);
      const relativePath = path.relative(root, absolute).replaceAll('\\', '/');
      return { absolute, path: relativePath, type: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? statSync(absolute).size : 0 };
    })
    .filter((entry) => entry.path !== 'backup-manifest.json' && allowed(sourceRoot, entry.absolute))
    .map(({ path: relativePath, type, size }) => ({ path: relativePath, type, size }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function verifyWorkboardData(dataDir) {
  const databasePath = path.join(dataDir, 'taskboard.sqlite');
  if (!existsSync(databasePath)) throw new Error('备份中缺少 taskboard.sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 外键检查失败');
    const missingTables = CORE_TABLES.filter((table) => !tableExists(db, table));
    if (missingTables.length) throw new Error(`SQLite 缺少核心表：${missingTables.join(', ')}`);
    const counts = Object.fromEntries(CORE_TABLES.map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0)]));
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map((row) => row.name);
    const lanes = taskColumns.includes('lane')
      ? Object.fromEntries(db.prepare('SELECT lane,COUNT(*) AS count FROM tasks GROUP BY lane ORDER BY lane').all().map((row) => [String(row.lane), Number(row.count)]))
      : {};
    const categories = conversationColumns.includes('category')
      ? Object.fromEntries(db.prepare('SELECT category,COUNT(*) AS count FROM conversations GROUP BY category ORDER BY category').all().map((row) => [String(row.category), Number(row.count)]))
      : {};
    const actions = Object.fromEntries(db.prepare('SELECT action,COUNT(*) AS count FROM audit_events GROUP BY action ORDER BY action').all().map((row) => [String(row.action), Number(row.count)]));
    if (tableExists(db, 'execution_snapshots') && tableExists(db, 'tasks')) {
      const orphan = db.prepare('SELECT COUNT(*) AS count FROM execution_snapshots e LEFT JOIN tasks t ON t.id=e.task_id WHERE t.id IS NULL').get();
      if (Number(orphan?.count ?? 0)) throw new Error('执行记录存在孤立任务引用');
    }
    if (tableExists(db, 'audit_events') && tableExists(db, 'tasks')) {
      const orphan = db.prepare('SELECT COUNT(*) AS count FROM audit_events a LEFT JOIN tasks t ON t.id=a.task_id WHERE t.id IS NULL').get();
      if (Number(orphan?.count ?? 0)) throw new Error('审计记录存在孤立任务引用');
      const invalidOrder = db.prepare('SELECT COUNT(*) AS count FROM audit_events a JOIN tasks t ON t.id=a.task_id WHERE a.created_at < t.created_at').get();
      if (Number(invalidOrder?.count ?? 0)) throw new Error('审计动作时间早于任务创建时间');
      const invalidExecutionOrder = db.prepare(`
        SELECT COUNT(*) AS count FROM audit_events terminal
        WHERE terminal.action IN ('execution_completed','execution_blocked','execution_interrupted_on_restart')
          AND NOT EXISTS (
            SELECT 1 FROM audit_events started
            WHERE started.task_id=terminal.task_id
              AND started.action='execution_started'
              AND started.created_at<=terminal.created_at
          )
      `).get();
      if (Number(invalidExecutionOrder?.count ?? 0)) throw new Error('关键执行动作时间顺序无效');
    }
    const attachmentsDir = path.join(dataDir, 'attachments');
    let readableAttachments = 0;
    if (existsSync(attachmentsDir)) {
      for (const entry of readdirSync(attachmentsDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        readFileSync(path.join(entry.parentPath, entry.name));
        readableAttachments += 1;
      }
    }
    return { counts, lanes, categories, actions, keyActionOrderValid: true, readableAttachments };
  } finally {
    db.close();
  }
}

async function gateFor(dataDir, dependencies) {
  const acquire = dependencies.acquireDataAccess ?? (await import('../dist-electron/dataAccessGate.js')).acquireDataAccess;
  return acquire(dataDir, 'backup');
}

export async function backupWorkboardData(sourceValue, backupValue, dependencies = {}) {
  const source = requireAbsolute('源数据目录', sourceValue);
  const backup = requireAbsolute('备份目标目录', backupValue);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error('源数据目录不存在');
  requireExternalNewTarget('备份目标目录', backup, source);
  const lease = await gateFor(source, dependencies);
  try {
    const sourceEntries = buildReadableManifest(source, source);
    cpSync(source, backup, { recursive: true, errorOnExist: true, filter: (candidate) => allowed(source, candidate) });
    const backupEntries = buildReadableManifest(backup, backup);
    if (JSON.stringify(sourceEntries) !== JSON.stringify(backupEntries)) throw new Error('备份目录与允许复制的源清单不一致');
    verifyWorkboardData(backup);
    const manifest = { version: 1, createdAt: new Date().toISOString(), entries: backupEntries };
    writeFileSync(path.join(backup, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } finally {
    lease.release();
  }
}

export function restoreWorkboardData(backupValue, targetValue) {
  const backup = requireAbsolute('备份目录', backupValue);
  const target = requireAbsolute('恢复目标目录', targetValue);
  const manifestPath = path.join(backup, 'backup-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('备份清单不存在');
  requireExternalNewTarget('恢复目标目录', target, backup);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('备份清单格式无效');
  if (JSON.stringify(buildReadableManifest(backup, backup)) !== JSON.stringify(manifest.entries)) throw new Error('备份文件与清单不一致');
  const before = verifyWorkboardData(backup);
  try {
    cpSync(backup, target, { recursive: true, errorOnExist: true, filter: (candidate) => path.resolve(candidate) !== path.resolve(manifestPath) });
    if (JSON.stringify(buildReadableManifest(target, target)) !== JSON.stringify(manifest.entries)) throw new Error('恢复目录与备份文件清单不一致');
    const restored = verifyWorkboardData(target);
    if (JSON.stringify(restored) !== JSON.stringify(before)) throw new Error('恢复目录语义与备份不一致');
    return restored;
  } catch (error) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, source, target] = argv;
  const result = command === 'backup'
    ? await backupWorkboardData(source, target)
    : command === 'restore'
      ? restoreWorkboardData(source, target)
      : (() => { throw new Error('仅支持 backup 或 restore'); })();
  process.stdout.write(`${JSON.stringify({ result: 'PASS', command, ...result }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
