import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronExecutable from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'codex-workboard-offline-'));
const userData = path.join(temporaryRoot, 'user-data');
let child;
let childExit;
let socket;
let output = '';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const debug = (message) => { if (process.env.WORKBOARD_QA_DEBUG === '1') console.error(`[offline-qa] ${message}`); };

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('无法分配 Electron 调试端口'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

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
  debug('reserving-port');
  const port = await availablePort();
  debug(`port-${port}`);
  // Electron's GPU sandbox cannot start from this device's non-system project volume.
  // This switch is limited to the disposable offline QA process; packaged-app QA runs separately.
  child = spawn(electronExecutable, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '.'], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_CLI_PATH: path.join(temporaryRoot, 'must-not-run-codex.exe'),
      WORKBOARD_USER_DATA_DIR: userData,
      WORKBOARD_SEED_DEMO: '1',
      WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
      WORKBOARD_SKIP_CODEX_SYNC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

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
        offline: document.body.innerText.includes('Codex 未连接'),
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
  if (!result.offline || result.stale || !result.demoLoaded) throw new Error(`离线状态不正确：${JSON.stringify(result)}`);

  void request('Page.close').catch(() => undefined);
  debug('last-window-close-sent');
  const exited = await Promise.race([childExit, sleep(10000).then(() => null)]);
  if (!exited) throw new Error('关闭最后一个窗口后 Electron 未退出');
  const dataFiles = readdirSync(userData, { recursive: true }).map(String);
  if (!dataFiles.some((file) => file.endsWith('taskboard.sqlite'))) throw new Error('隔离数据目录中未生成任务数据库');

  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    platformClass: result.platformClass,
    dragDisplay: result.dragDisplay,
    sidebarPaddingTop: result.sidebarPaddingTop,
    offline: result.offline,
    stale: result.stale,
    demoLoaded: result.demoLoaded,
    isolatedData: true,
    electronExitCode: exited.code,
  }, null, 2));
}

let failure;
try {
  await run();
} catch (error) {
  failure = error;
} finally {
  socket?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  if (childExit) await Promise.race([childExit.catch(() => null), sleep(5000)]);
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
    else console.error(`临时目录清理失败：${cleanupError.message}`);
  }
}
if (failure) throw failure;
