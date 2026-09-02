import { spawn } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertWriterLeaseReleased, buildIsolatedQaEnvironment, buildOfflineLaunchConfiguration, canRemoveQaTemporaryData, closeOwnedProcess, combinePrimaryAndCleanupError, createQaTemporaryRoot, resolvePackagedExecutable, runCleanupActions, trackChild, waitForDevToolsPort, waitForTrackedExit } from './qa-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
let temporaryRoot;
let userData;
const packagedMode = process.argv.includes('--packaged');
let child;
let trackedChild;
let socket;
let output = '';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const debug = (message) => { if (process.env.WORKBOARD_QA_DEBUG === '1') console.error(`[offline-qa] ${message}`); };

async function waitForPage(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((candidate) => candidate.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Electron is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Electron 调试页面未就绪：${output.slice(-1200)}`);
}

async function connect(page) {
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const rejectPending = (reason) => {
    for (const { reject } of pending.values()) reject(reason);
    pending.clear();
  };
  socket.addEventListener('close', (event) => rejectPending(new Error(`Electron 调试连接已关闭（${event.code}）：${output.slice(-1200)}`)));
  socket.addEventListener('error', () => rejectPending(new Error(`Electron 调试连接发生错误：${output.slice(-1200)}`)));
  socket.addEventListener('message', async (event) => {
    try {
      let payload;
      if (typeof event.data === 'string') payload = event.data;
      else if (event.data instanceof Blob) payload = await event.data.text();
      else payload = Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(payload);
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    } catch (error) {
      rejectPending(error);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function run() {
  temporaryRoot = createQaTemporaryRoot('offline-');
  userData = path.join(temporaryRoot, 'user-data');
  let launchExecutable;
  if (packagedMode) {
    const sourcePackage = resolvePackagedExecutable(root, { packageDir: process.env.WORKBOARD_PACKAGE_DIR });
    let stagedPackageDir;
    if (sourcePackage.platform === 'win32') {
      stagedPackageDir = path.join(temporaryRoot, 'package');
      cpSync(sourcePackage.packageDir, stagedPackageDir, { recursive: true, errorOnExist: true });
    } else {
      stagedPackageDir = path.join(temporaryRoot, path.basename(sourcePackage.packageDir));
      cpSync(sourcePackage.packageDir, stagedPackageDir, { recursive: true, errorOnExist: true });
    }
    const staged = resolvePackagedExecutable(root, { platform: sourcePackage.platform, arch: sourcePackage.arch, packageDir: stagedPackageDir });
    launchExecutable = staged.executable;
  } else {
    launchExecutable = (await import('electron')).default;
  }
  const launch = buildOfflineLaunchConfiguration({ packaged: packagedMode, executable: launchExecutable, checkoutRoot: root, userData });
  // The launch builder limits this device's source-only GPU/sandbox workaround to source mode.
  child = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: buildIsolatedQaEnvironment({ ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, userData, { codexCliPath: path.join(temporaryRoot, 'must-not-run-codex.exe') }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  trackedChild = trackChild(child, { ownsProcessGroup: process.platform !== 'win32' });
  const portPromise = waitForDevToolsPort(child, launch.devToolsDataDir, { timeoutMs: 30_000 });
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  const port = await portPromise;
  debug(`port-${port}`);

  debug('waiting-page');
  const page = await waitForPage(port);
  debug('connecting-websocket');
  const request = await connect(page);
  debug('waiting-ui');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await request('Runtime.evaluate', {
      expression: `document.body.innerText.includes('任务管理') && document.body.innerText.includes('在关联对话中继续执行')`,
      returnByValue: true,
    });
    if (ready.result?.value) break;
    if (attempt === 99) throw new Error('离线界面没有完成加载');
    await sleep(100);
  }

  const evaluated = await request('Runtime.evaluate', {
    expression: `(() => {
      const shell = document.querySelector('.app-shell');
      const drag = document.querySelector('.drag-region');
      const sidebar = document.querySelector('.sidebar');
      return {
        platformClass: shell?.className || '',
        dragDisplay: drag ? getComputedStyle(drag).display : '',
        sidebarPaddingTop: sidebar ? getComputedStyle(sidebar).paddingTop : '',
        connected: Boolean(document.querySelector('.connection-dot.online')),
        diagnosticVisible: ['尚未启动', '驱动版本不兼容', '需要登录', '协议不兼容', '连接错误'].some((label) => document.body.innerText.includes(label)),
        stale: document.body.innerText.includes('Codex 缓存模式'),
        demoLoaded: document.body.innerText.includes('在关联对话中继续执行'),
      };
    })()`,
    returnByValue: true,
  });
  debug('ui-evaluated');
  const result = evaluated.result?.value;
  if (!result?.platformClass.includes(`platform-${process.platform}`)) throw new Error(`平台类名不正确：${JSON.stringify(result)}`);
  if (process.platform === 'win32' && (result.dragDisplay !== 'none' || result.sidebarPaddingTop !== '12px')) {
    throw new Error(`Windows 标题栏布局不正确：${JSON.stringify(result)}`);
  }
  if (result.connected || !result.diagnosticVisible || result.stale || !result.demoLoaded) throw new Error(`离线状态不正确：${JSON.stringify(result)}`);

  void request('Page.close').catch(() => undefined);
  debug('last-window-close-sent');
  const exited = await waitForTrackedExit(trackedChild, 10_000);
  if (!exited) throw new Error('关闭最后一个窗口后 Electron 未退出');
  if (exited.code !== 0) throw new Error(`Electron 非正常退出：${exited.code ?? exited.signal ?? 'unknown'}`);
  const dataFiles = readdirSync(userData, { recursive: true }).map(String);
  if (!dataFiles.some((file) => file.endsWith('taskboard.sqlite'))) throw new Error('隔离数据目录中未生成任务数据库');

  return {
    ok: true,
    mode: packagedMode ? 'packaged' : 'source',
    platform: process.platform,
    platformClass: result.platformClass,
    dragDisplay: result.dragDisplay,
    sidebarPaddingTop: result.sidebarPaddingTop,
    connected: result.connected,
    diagnosticVisible: result.diagnosticVisible,
    stale: result.stale,
    demoLoaded: result.demoLoaded,
    isolatedData: true,
    electronExitCode: exited.code,
  };
}

let result;
let primaryError;
try {
  result = await run();
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
} finally {
  const cleanupErrors = await runCleanupActions([
    ['Electron 进程退出', async () => {
      if (!trackedChild || child.exitCode !== null || child.signalCode !== null) return;
      const closed = await closeOwnedProcess(trackedChild, { graceful: () => child.kill('SIGTERM') });
      if (closed.forced || closed.gracefulError) throw new Error('Electron 未通过无错误的正常关闭路径退出');
    }],
    ['CDP 连接关闭', async () => socket?.close()],
    ['writer lease 释放', async () => { if (userData) assertWriterLeaseReleased(userData); }],
  ]);
  if (canRemoveQaTemporaryData(primaryError, cleanupErrors)) {
    cleanupErrors.push(...await runCleanupActions([
      ['临时目录清理', async () => rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })],
    ]));
  }
  const finalError = combinePrimaryAndCleanupError(primaryError, cleanupErrors);
  if (finalError) throw finalError;
}
console.log(JSON.stringify(result, null, 2));
