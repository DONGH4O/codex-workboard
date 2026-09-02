import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveExternalArtifactPath(value, checkoutRoot, label = 'QA 证据路径') {
  if (!value) return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
  const resolved = path.resolve(value);
  if (within(path.resolve(checkoutRoot), resolved)) throw new Error(`${label}必须位于源码目录之外`);
  return resolved;
}

export function preflightEvidenceTarget(target) {
  if (!target || !path.isAbsolute(target)) throw new Error('证据目标必须是绝对路径');
  const probe = `${target}.write-probe-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(probe, 'wx');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(probe, { force: true });
  }
  return target;
}

export function writeEvidenceAtomically(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function requireAbsoluteEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`正式流程必须显式提供绝对路径 ${name}`);
  }
  return path.resolve(value);
}

export function buildFormalAppEnvironment(baseEnvironment, userData) {
  if (!path.isAbsolute(userData)) throw new Error('正式流程 Workboard 数据目录必须是绝对路径');
  const codexHome = requireAbsoluteEnvironment(baseEnvironment, 'CODEX_HOME');
  const codexCliPath = requireAbsoluteEnvironment(baseEnvironment, 'CODEX_CLI_PATH');
  return {
    ...baseEnvironment,
    CODEX_HOME: codexHome,
    CODEX_CLI_PATH: codexCliPath,
    WORKBOARD_USER_DATA_DIR: path.resolve(userData),
    WORKBOARD_SEED_DEMO: '1',
    WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
    TASKBOARD_SEED_DEMO: '1',
  };
}

function requireFile(candidate, stat = statSync) {
  try {
    return stat(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolvePackagedExecutable(checkoutRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const stat = options.stat ?? statSync;
  const readDirectory = options.readDirectory ?? readdirSync;
  const explicitPackageDir = options.packageDir;
  if (explicitPackageDir && !path.isAbsolute(explicitPackageDir)) throw new Error('WORKBOARD_PACKAGE_DIR 必须是绝对路径');

  let packageDir;
  let candidates = [];
  if (platform === 'win32') {
    packageDir = path.resolve(explicitPackageDir ?? path.join(checkoutRoot, 'dist', 'win-unpacked'));
    candidates = [path.join(packageDir, 'Codex Workboard.exe')];
  } else if (platform === 'darwin') {
    packageDir = path.resolve(explicitPackageDir ?? path.join(checkoutRoot, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac'));
    if (packageDir.toLowerCase().endsWith('.app')) {
      const product = path.basename(packageDir, '.app');
      candidates = [path.join(packageDir, 'Contents', 'MacOS', product)];
    } else {
      let entries = [];
      try { entries = readDirectory(packageDir, { withFileTypes: true }); } catch { entries = []; }
      candidates = entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
        .map((entry) => path.join(packageDir, entry.name, 'Contents', 'MacOS', entry.name.slice(0, -4)));
    }
  } else {
    throw new Error(`暂不支持 ${platform} 的目录包 QA`);
  }

  const existing = candidates.filter((candidate) => exists(candidate) && requireFile(candidate, stat));
  if (existing.length !== 1) throw new Error(`目录包可执行文件必须唯一，实际找到 ${existing.length} 个`);
  const executable = path.resolve(existing[0]);
  const containmentRoot = packageDir.toLowerCase().endsWith('.app') ? packageDir : path.resolve(packageDir);
  if (!within(containmentRoot, executable)) throw new Error('目录包可执行文件越出预期目录');
  return { executable, packageDir: containmentRoot, platform, arch };
}

export function createQaTemporaryRoot(prefix, options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  let parent = tmpdir();
  if (platform === 'win32') {
    parent = environment.LOCALAPPDATA;
    if (!parent || !path.isAbsolute(parent)) throw new Error('Windows QA 需要绝对路径 LOCALAPPDATA');
    assertWindowsSystemPackage(parent, environment, platform);
    parent = path.join(parent, 'CodexWorkboard-QA');
  }
  (options.makeDirectory ?? mkdirSync)(parent, { recursive: true });
  return (options.makeTemporaryDirectory ?? mkdtempSync)(path.join(parent, prefix));
}

export function buildOfflineLaunchConfiguration({ packaged, executable, checkoutRoot, userData, platform = process.platform }) {
  if (![executable, checkoutRoot, userData].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('Electron QA 启动路径必须是绝对路径');
  }
  const devToolsDataDir = path.join(userData, 'chromium');
  const args = ['--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${devToolsDataDir}`, '--enable-logging=stderr'];
  if (packaged) {
    return { executable, cwd: path.dirname(executable), args, devToolsDataDir };
  }
  if (platform === 'win32') args.push('--disable-gpu', '--disable-software-rasterizer', '--no-sandbox');
  args.push('.');
  return { executable, cwd: checkoutRoot, args, devToolsDataDir };
}

export function buildIsolatedQaEnvironment(baseEnvironment, userData, options = {}) {
  const environment = {
    ...baseEnvironment,
    WORKBOARD_USER_DATA_DIR: userData,
    WORKBOARD_SEED_DEMO: '1',
    WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
    WORKBOARD_SKIP_CODEX_SYNC: '1',
  };
  if (options.codexCliPath) environment.CODEX_CLI_PATH = options.codexCliPath;
  return environment;
}

export function trackChild(child, options = {}) {
  const exit = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  return { child, exit, ownsProcessGroup: Boolean(options.ownsProcessGroup) };
}

export async function waitForTrackedExit(tracked, timeoutMs) {
  return Promise.race([tracked.exit, delay(timeoutMs).then(() => null)]);
}

function execFilePromise(file, args, implementation = execFile) {
  return new Promise((resolve, reject) => implementation(file, args, { windowsHide: true }, (error) => error ? reject(error) : resolve()));
}

export async function closeOwnedProcess(tracked, options = {}) {
  const { child } = tracked;
  const graceful = options.graceful ?? (() => child.kill('SIGTERM'));
  if (child.exitCode !== null || child.signalCode !== null) return { forced: false, exit: await tracked.exit };
  let gracefulError;
  try { await graceful(); } catch (error) { gracefulError = error; }
  const gracefulExit = await waitForTrackedExit(tracked, options.gracefulTimeoutMs ?? 10_000);
  if (gracefulExit?.error) throw gracefulExit.error;
  if (gracefulExit) return { forced: false, exit: gracefulExit, gracefulError };
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('无法精确收敛缺少有效 PID 的 QA 子进程');
  if ((options.platform ?? process.platform) === 'win32') {
    try {
      await execFilePromise('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], options.execFile);
    } catch (error) {
      const racedExit = await waitForTrackedExit(tracked, 250);
      if (!racedExit) throw error;
      return { forced: true, exit: racedExit, gracefulError };
    }
  } else {
    if (!tracked.ownsProcessGroup) throw new Error('非 Windows QA 子进程未声明独占进程组，拒绝不精确的强制退出');
    (options.killProcess ?? process.kill)(-child.pid, 'SIGKILL');
  }
  const forcedExit = await waitForTrackedExit(tracked, options.forceTimeoutMs ?? 5_000);
  if (!forcedExit) throw new Error(`QA 子进程 ${child.pid} 未能退出`);
  return { forced: true, exit: forcedExit, gracefulError };
}

export function canRemoveQaTemporaryData(primaryError, cleanupErrors) {
  return !primaryError && cleanupErrors.length === 0;
}

export async function runCleanupActions(actions) {
  const errors = [];
  for (const [label, action] of actions) {
    try { await action(); } catch (error) {
      errors.push({ label, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return errors;
}

export function combinePrimaryAndCleanupError(primaryError, cleanupErrors) {
  if (primaryError) {
    if (cleanupErrors.length) primaryError.cleanupFailures = cleanupErrors.map(({ label, error }) => `${label}: ${error.message}`);
    return primaryError;
  }
  if (!cleanupErrors.length) return undefined;
  return new AggregateError(cleanupErrors.map(({ error }) => error), `QA 清理失败：${cleanupErrors.map(({ label }) => label).join('、')}`);
}

export function assertWriterLeaseReleased(dataDir, options = {}) {
  const runtimeDir = path.join(dataDir, '.runtime');
  let entries = [];
  try { entries = (options.readDirectory ?? readdirSync)(runtimeDir); } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return true;
    throw error;
  }
  const locks = entries.map(String).filter((name) => /^data-access(?:\.|$).*\.lock$/i.test(name) || name === 'data-access.lock');
  if (locks.length) throw new Error(`Workboard writer lease 未释放：${locks.join(', ')}`);
  return true;
}

export function validateFormalFlowGate(argv, env, options = {}) {
  if (!argv.includes('--execute-real') || env.WORKBOARD_W5_REAL_FLOW !== '1') {
    throw new Error('正式流程默认拒绝：必须同时提供 --execute-real 与 WORKBOARD_W5_REAL_FLOW=1');
  }
  if (options.platform === 'win32' && !env.WORKBOARD_PACKAGE_DIR) {
    throw new Error('Windows 正式流程必须显式提供系统卷 WORKBOARD_PACKAGE_DIR');
  }
  return true;
}

export function assertWindowsSystemPackage(packageDir, env, platform = process.platform) {
  if (platform !== 'win32') return true;
  const systemRoot = path.parse(env.SystemRoot || env.SYSTEMROOT || '').root;
  if (!systemRoot || path.parse(packageDir).root.toLowerCase() !== systemRoot.toLowerCase()) {
    throw new Error('Windows 正式流程目录包必须位于系统卷');
  }
  return true;
}

export function buildMinimalFormalEvidence(result, cleanupFailures = []) {
  const baseline = result.appServerBaseline;
  const task = result.evidence?.task;
  return {
    ok: Boolean(result.ok) && !result.cleanupFailed && cleanupFailures.length === 0 && !result.error,
    scenario: 'formal-flow',
    checks: Object.fromEntries(Object.entries(result.checks ?? {}).map(([name, value]) => [name, Boolean(value)])),
    summary: {
      activeConversations: Number(baseline?.active ?? 0),
      archivedConversations: Number(baseline?.archived ?? 0),
      pages: Number(baseline?.pages ?? 0),
      auditEventCount: Number(task?.auditEventCount ?? 0),
      auditActions: Array.isArray(task?.auditActions) ? task.auditActions.map(String) : [],
    },
    cleanupFailed: Boolean(result.cleanupFailed) || cleanupFailures.length > 0,
    failed: Boolean(result.error) || Boolean(result.cleanupFailed) || cleanupFailures.length > 0,
  };
}

export function waitForDevToolsPort(child, userData, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const read = options.read ?? readFileSync;
  const activePortPath = path.join(userData, 'DevToolsActivePort');
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(port);
    };
    const parse = (text) => {
      const match = text.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\//i);
      const port = Number(match?.[1]);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
    };
    const onData = (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      const port = parse(stderr);
      if (port) finish(undefined, port);
    };
    const onExit = (code, signal) => finish(new Error(`Electron 在调试端点就绪前退出 (${code ?? signal ?? 'unknown'})`));
    const onError = (error) => finish(new Error(`Electron 启动失败：${error.message}`));
    const poll = () => {
      if (settled) return;
      try {
        const port = Number(String(read(activePortPath, 'utf8')).split(/\r?\n/, 1)[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return finish(undefined, port);
      } catch { /* DevToolsActivePort is not ready yet. */ }
      pollTimer = setTimeout(poll, 50);
    };
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    const timer = setTimeout(() => finish(new Error(`Electron 调试端点未就绪：${stderr.slice(-1200)}`)), timeoutMs);
    let pollTimer = setTimeout(poll, 0);
  });
}
