import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'dist/mac-arm64/Codex Taskboard Demo.app/Contents/MacOS/Codex Taskboard Demo');
const userData = mkdtempSync(path.join(tmpdir(), 'codex-taskboard-ui-qa-'));
const port = 9339;
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  env: { ...process.env, TASKBOARD_SEED_DEMO: '1' },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await sleep(200);
  }
  throw new Error('Electron 调试页面未就绪');
}

async function run() {
  const page = await waitForPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => {
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });

  await sleep(3000);
  const before = await evaluate(`document.querySelectorAll('.task-card').length`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('新增任务'))?.click()`);
  await sleep(150);
  await evaluate(`(() => {
    const input = document.querySelector('.modal input[placeholder="要完成什么？"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'UI 自动化新增任务');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return Boolean(input);
  })()`);
  await sleep(100);
  await evaluate(`document.querySelector('.modal button[type="submit"]')?.click()`);
  await sleep(700);
  const result = await evaluate(`({
    before: ${JSON.stringify(before)},
    after: document.querySelectorAll('.task-card').length,
    createdVisible: document.body.innerText.includes('UI 自动化新增任务'),
    detailPanelOpen: Boolean(document.querySelector('.detail-panel')),
    connected: document.body.innerText.includes('Codex 已连接')
  })`);
  socket.close();
  return result;
}

try {
  const result = await run();
  console.log(JSON.stringify(result));
  if (!result.createdVisible || !result.detailPanelOpen || result.after !== result.before + 1 || !result.connected) process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await sleep(250);
  rmSync(userData, { recursive: true, force: true });
}

