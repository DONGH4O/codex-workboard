import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  assertMacBundleRuntimeResources,
  assertWriterLeaseReleased,
  buildIsolatedQaEnvironment,
  buildOfflineLaunchConfiguration,
  canRemoveQaTemporaryData,
  closeOwnedProcess,
  combinePrimaryAndCleanupError,
  copyPackagedDirectory,
  createQaTemporaryRoot,
  qaApplicationCloseMethod,
  resolveExternalArtifactPath,
  resolvePackagedExecutable,
  runCleanupActions,
  trackChild,
  waitForDevToolsPort,
  waitForTrackedExit,
  writeEvidenceAtomically,
} from './qa-runtime.mjs';
import { cleanupGovernedSessions, establishGovernedSession } from './qa-governed-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sourcePackage = resolvePackagedExecutable(root, { packageDir: process.env.WORKBOARD_PACKAGE_DIR });
const evidencePath = resolveExternalArtifactPath(process.env.WORKBOARD_QA_GOVERNED_EVIDENCE_PATH, root, 'WORKBOARD_QA_GOVERNED_EVIDENCE_PATH');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const profiles = [
  { width: 1050, height: 680, zoomFactor: 0.8 },
  { width: 1280, height: 800, zoomFactor: 1 },
  { width: 1540, height: 940, zoomFactor: 1.25 },
];

let temporaryRoot;
let userData;
let stagedPackageDir;
let primaryError;
const sessions = [];

async function waitForPage(port, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((candidate) => candidate.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The packaged renderer is still starting.
    }
    await sleep(100);
  }
  throw new Error(`目录包调试页面未就绪：${output()}`);
}

async function connect(page, output, registerSocket = () => undefined) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  registerSocket(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const rejectPending = (reason) => {
    for (const item of pending.values()) item.reject(reason);
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending(new Error(`目录包调试连接已关闭：${output()}`)));
  socket.addEventListener('error', () => rejectPending(new Error(`目录包调试连接发生错误：${output()}`)));
  socket.addEventListener('message', async (event) => {
    try {
      const raw = typeof event.data === 'string' ? event.data : event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(raw);
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    } catch (error) {
      rejectPending(error);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  const waitUntil = async (expression, label, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  };
  return { socket, request, evaluate, waitUntil };
}

async function launch() {
  const staged = resolvePackagedExecutable(root, { platform: sourcePackage.platform, arch: sourcePackage.arch, packageDir: stagedPackageDir });
  const launchConfig = buildOfflineLaunchConfiguration({ packaged: true, executable: staged.executable, checkoutRoot: root, userData });
  const environment = buildIsolatedQaEnvironment({ ...process.env, ELECTRON_ENABLE_LOGGING: '1', WORKBOARD_QA_UI_HARNESS: '1' }, userData, {
    codexCliPath: path.join(temporaryRoot, 'must-not-run-codex.exe'),
  });
  const child = spawn(launchConfig.executable, launchConfig.args, {
    cwd: launchConfig.cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const tracked = trackChild(child, { ownsProcessGroup: process.platform !== 'win32' });
  let output = '';
  const append = (chunk) => { output = `${output}${chunk}`.slice(-5000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const session = { child, tracked, socket: null, output: () => output, closed: false };
  await establishGovernedSession({
    session,
    sessions,
    waitForPort: () => waitForDevToolsPort(child, launchConfig.devToolsDataDir, { timeoutMs: 30_000 }),
    waitForPage: (port) => waitForPage(port, () => output),
    connectPage: (page, registerSocket) => connect(page, () => output, registerSocket),
    closeProcess: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = await closeOwnedProcess(tracked, { graceful: () => child.kill('SIGTERM') });
      if (closed.forced || closed.gracefulError) throw new Error('早期目录包进程未正常退出');
    },
    assertLeaseReleased: async () => assertWriterLeaseReleased(userData),
  });
  await session.waitUntil(`Boolean(document.body?.innerText.includes('任务管理') && window.codexTaskboard?.qa)`, '受控 QA 界面加载', 300);
  return session;
}

async function closeSession(session) {
  if (session.closed) return;
  void session.request(qaApplicationCloseMethod()).catch(() => undefined);
  const exited = await waitForTrackedExit(session.tracked, 12_000);
  if (!exited) throw new Error('请求正常关闭后目录包未退出');
  if (exited.code !== 0) throw new Error(`目录包非正常退出：${exited.code ?? exited.signal ?? 'unknown'} ${session.output()}`);
  session.socket.close();
  session.closed = true;
  const writerLeaseReleased = assertWriterLeaseReleased(userData);
  return { normalExit: exited.code === 0, exitCode: exited.code, writerLeaseReleased };
}

async function openTask(session, title) {
  const cardExpression = `Array.from(document.querySelectorAll('.task-card')).some((item) => item.textContent.includes(${JSON.stringify(title)}))`;
  try {
    await session.waitUntil(cardExpression, `${title} 任务卡加载`, 300);
  } catch (error) {
    const diagnostic = await session.evaluate(`({ readyState: document.readyState, cardCount: document.querySelectorAll('.task-card').length, boardPresent: Boolean(document.querySelector('.board')) })`);
    throw new Error(`${error.message}：${JSON.stringify(diagnostic)}`);
  }
  const opened = await session.evaluate(`(() => {
    document.querySelector('.modal .icon-button')?.click();
    document.querySelector('.detail-panel .panel-header > .icon-button')?.click();
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes(${JSON.stringify(title)}));
    card?.click();
    return Boolean(card);
  })()`);
  if (!opened) throw new Error(`未找到演示任务：${title}`);
  await session.waitUntil(`Boolean(document.querySelector('.detail-panel'))`, `${title} 详情面板`);
}

async function inject(session, event) {
  return session.evaluate(`window.codexTaskboard.qa.injectExecutionEvent(${JSON.stringify(event)})`);
}

async function run() {
  temporaryRoot = createQaTemporaryRoot('governed-ui-');
  userData = path.join(temporaryRoot, 'user-data');
  assertMacBundleRuntimeResources(sourcePackage.executable, { platform: sourcePackage.platform, stage: 'source' });
  stagedPackageDir = sourcePackage.platform === 'win32'
    ? path.join(temporaryRoot, 'package')
    : path.join(temporaryRoot, path.basename(sourcePackage.packageDir));
  copyPackagedDirectory(sourcePackage.packageDir, stagedPackageDir);
  const staged = resolvePackagedExecutable(root, { platform: sourcePackage.platform, arch: sourcePackage.arch, packageDir: stagedPackageDir });
  assertMacBundleRuntimeResources(staged.executable, { platform: staged.platform, stage: 'staged' });

  const first = await launch();
  const layoutMatrix = [];
  for (const profile of profiles) {
    await first.evaluate(`window.codexTaskboard.qa.applyWindowProfile(${JSON.stringify(profile)})`);
    await sleep(350);
    await openTask(first, '在关联对话中继续执行');
    const detail = await first.evaluate(`(() => {
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const board = document.querySelector('.board');
      const columns = Array.from(document.querySelectorAll('.board-column')).map((item) => item.getBoundingClientRect());
      const panel = document.querySelector('.detail-panel')?.getBoundingClientRect();
      const ordered = columns.every((rect, index) => index === 0 || columns[index - 1].right <= rect.left + 1);
      return {
        viewport,
        columnCount: columns.length,
        columnsOrderedWithoutOverlap: ordered,
        boardScrollContained: Boolean(board) && board.scrollWidth >= board.clientWidth && board.scrollHeight >= board.clientHeight,
        detailContained: Boolean(panel) && panel.left >= 0 && panel.top >= 0 && panel.right <= viewport.width + 1 && panel.bottom <= viewport.height + 1,
      };
    })()`);
    await first.evaluate(`document.querySelector('.detail-panel .panel-header > .icon-button')?.click()`);
    await first.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('新增任务'))?.click()`);
    await first.waitUntil(`Boolean(document.querySelector('.modal'))`, '新增任务模态框');
    const modal = await first.evaluate(`(() => {
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const rect = document.querySelector('.modal')?.getBoundingClientRect();
      return {
        modalContained: Boolean(rect) && rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
        modalScrollable: Boolean(document.querySelector('.form-stack')) && document.querySelector('.form-stack').scrollHeight >= document.querySelector('.form-stack').clientHeight,
      };
    })()`);
    await first.evaluate(`document.querySelector('.modal .icon-button')?.click()`);
    layoutMatrix.push({ ...profile, ...detail, ...modal });
  }

  await openTask(first, '在关联对话中继续执行');
  await first.evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('实时执行'))?.click()`);
  const threadId = 'demo-live-thread';
  const turnId = 'demo-turn';
  await inject(first, { method: 'turn/plan/updated', params: { threadId, turnId, plan: [{ step: '受控计划已完成', status: 'completed' }, { step: '受控计划执行中', status: 'inProgress' }] } });
  await inject(first, { method: 'item/agentMessage/delta', params: { threadId, turnId, delta: '隔离流式消息可见' } });
  await inject(first, { method: 'item/commandExecution/outputDelta', params: { threadId, turnId, delta: '\nISOLATED_COMMAND_OUTPUT' } });
  await inject(first, { method: 'turn/diff/updated', params: { threadId, turnId, diff: 'ISOLATED_DIFF_VISIBLE' } });
  await first.waitUntil(`document.body.innerText.includes('隔离流式消息可见') && document.body.innerText.includes('ISOLATED_COMMAND_OUTPUT') && document.body.innerText.includes('ISOLATED_DIFF_VISIBLE')`, '流式执行证据展示');
  const executionEvidence = await first.evaluate(`({
    streamingVisible: document.body.innerText.includes('隔离流式消息可见'),
    planVisible: document.body.innerText.includes('受控计划已完成') && document.body.innerText.includes('受控计划执行中'),
    commandOutputVisible: document.body.innerText.includes('ISOLATED_COMMAND_OUTPUT'),
    diffVisible: document.body.innerText.includes('ISOLATED_DIFF_VISIBLE')
  })`);

  const approvalLabels = [
    ['拒绝', 'decline'],
    ['批准一次', 'accept'],
    ['本次会话允许', 'acceptForSession'],
  ];
  let approvalRequest = 910000;
  for (const [label] of approvalLabels) {
    approvalRequest += 1;
    await inject(first, {
      method: 'item/commandExecution/requestApproval',
      requestId: approvalRequest,
      params: { threadId, turnId, itemId: `qa-approval-${approvalRequest}`, reason: `受控审批 ${label}`, command: ['node', '--version'], cwd: temporaryRoot, availableDecisions: ['decline', 'accept', 'acceptForSession'] },
    });
    await first.waitUntil(`document.querySelector('.approval-card')?.textContent.includes(${JSON.stringify(`受控审批 ${label}`)})`, `${label}审批卡`);
    await first.evaluate(`Array.from(document.querySelectorAll('.approval-actions button')).find((button) => button.textContent.trim() === ${JSON.stringify(label)})?.click()`);
    await first.waitUntil(`!document.querySelector('.approval-card')`, `${label}审批收敛`);
  }

  const questionEvent = (requestId, question) => ({
    method: 'item/tool/requestUserInput',
    requestId,
    params: { threadId, turnId, itemId: `qa-input-${requestId}`, isBlocking: true, questions: [{ id: 'choice', header: '选择', question, isOther: false, isSecret: false, options: [{ label: '继续', description: '推进测试' }] }] },
  });
  await inject(first, questionEvent(920001, '请提交受控回答'));
  await first.waitUntil(`Boolean(document.querySelector('.user-input-card'))`, '用户输入卡');
  await first.evaluate(`(() => { const select = document.querySelector('.user-input-card select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, '继续'); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await first.evaluate(`Array.from(document.querySelectorAll('.user-input-card button')).find((button) => button.textContent.includes('提交回答'))?.click()`);
  await first.waitUntil(`!document.querySelector('.user-input-card')`, '用户回答收敛');

  await inject(first, questionEvent(920002, '请取消受控回答'));
  await first.waitUntil(`Boolean(document.querySelector('.user-input-card'))`, '用户取消卡');
  await first.evaluate(`Array.from(document.querySelectorAll('.user-input-card button')).find((button) => button.textContent.trim() === '取消')?.click()`);
  await first.waitUntil(`!document.querySelector('.user-input-card')`, '用户取消收敛');

  await inject(first, questionEvent(920003, '请模拟超时收敛'));
  await first.waitUntil(`Boolean(document.querySelector('.user-input-card'))`, '用户超时卡');
  await inject(first, { method: 'workboard/serverRequestClosed', requestId: 920003, params: { requestId: 920003, reason: 'timeout', threadId, turnId } });
  await first.waitUntil(`!document.querySelector('.user-input-card')`, '用户超时收敛');
  const userInputConvergence = { answer: true, cancel: true, timeout: true };

  await inject(first, { method: 'workboard/serverRequestUnsupported', requestId: 930001, params: { requestId: 930001, method: 'qa/unknownRequest', threadId, turnId } });
  await first.waitUntil(`document.querySelector('.execution-error')?.textContent.includes('qa/unknownRequest')`, '未知请求界面错误');
  const unknownRequestVisible = await first.evaluate(`document.querySelector('.execution-error')?.textContent.includes('qa/unknownRequest') ?? false`);

  await openTask(first, '执行中可随时引导');
  await first.evaluate(`(() => { const textarea = document.querySelector('.execution-composer textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, '隔离引导同一回合'); textarea.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await first.evaluate(`document.querySelector('.execution-composer .send-button')?.click()`);
  await first.waitUntil(`document.querySelector('.toast')?.textContent.includes('已引导当前执行回合')`, '同回合引导提示');
  await first.evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.trim() === '任务')?.click()`);
  await first.waitUntil(`Boolean(document.querySelector('.open-codex-link'))`, '任务详情转到 Codex 入口');
  const handoffClick = await first.evaluate(`(() => { window.confirm = () => true; const button = document.querySelector('.open-codex-link'); const result = { found: Boolean(button), disabled: button?.disabled ?? null, text: button?.textContent ?? '', panel: document.querySelector('.detail-panel')?.textContent?.slice(0, 500) ?? '' }; if (button && !button.disabled) button.click(); return result; })()`);
  if (!handoffClick.found || handoffClick.disabled) throw new Error(`未能点击受控转到 Codex 入口：${JSON.stringify(handoffClick)}`);
  try {
    await first.waitUntil(`document.querySelector('.toast')?.textContent.includes('深链接未能打开') && document.querySelector('.toast')?.textContent.includes('手动打开')`, '深链接失败回退提示');
  } catch (error) {
    const diagnostic = await first.evaluate(`(async () => ({ toast: document.querySelector('.toast')?.textContent ?? '', panel: document.querySelector('.detail-panel')?.textContent?.slice(0, 1200) ?? '', stats: await window.codexTaskboard.qa.stats() }))()`);
    throw new Error(`${error.message}：${JSON.stringify(diagnostic)}`);
  }
  const handoffState = await first.evaluate(`window.codexTaskboard.bootstrap().then((state) => ({ task: state.tasks.find((item) => item.title === '执行中可随时引导'), execution: state.executions.find((item) => item.threadId === 'demo-steer-thread') }))`);

  await openTask(first, '在关联对话中继续执行');
  await first.evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('实时执行'))?.click()`);
  await first.waitUntil(`Boolean(document.querySelector('.execution-status'))`, '实时执行状态');
  await inject(first, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  await first.waitUntil(`document.querySelector('.execution-status')?.textContent.includes('执行已完成')`, '正常完成状态');
  const normalCompletionVisible = true;
  await inject(first, { method: 'turn/started', params: { threadId, turn: { id: 'qa-restart-turn', status: 'inProgress' } } });
  await first.waitUntil(`document.querySelector('.execution-status')?.textContent.includes('执行中')`, '重启前活动状态');

  const firstStats = await first.evaluate(`window.codexTaskboard.qa.stats()`);
  const firstClose = await closeSession(first);

  const second = await launch();
  await openTask(second, '在关联对话中继续执行');
  await second.evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('实时执行'))?.click()`);
  await second.waitUntil(`Boolean(document.querySelector('.execution-status'))`, '重启后实时执行面板');
  const restart = await second.evaluate(`window.codexTaskboard.bootstrap().then((state) => ({
    task: state.tasks.find((item) => item.title === '在关联对话中继续执行'),
    execution: state.executions.find((item) => item.threadId === 'demo-live-thread'),
    uiInterrupted: document.querySelector('.execution-status')?.textContent.includes('执行已中断') ?? false,
    uiEvidencePreserved: document.body.innerText.includes('ISOLATED_COMMAND_OUTPUT') && document.body.innerText.includes('ISOLATED_DIFF_VISIBLE'),
    uiRestartReason: document.querySelector('.execution-error')?.textContent ?? ''
  }))`);
  const secondStats = await second.evaluate(`window.codexTaskboard.qa.stats()`);
  const secondClose = await closeSession(second);

  const layoutPassed = layoutMatrix.every((item) => item.columnCount === 3 && item.columnsOrderedWithoutOverlap && item.boardScrollContained && item.detailContained && item.modalContained && item.modalScrollable);
  const protocolPassed = firstStats.injectedEvents >= 13
    && firstStats.approvalDecisions.decline === 1
    && firstStats.approvalDecisions.accept === 1
    && firstStats.approvalDecisions.acceptForSession === 1
    && firstStats.userInputAnswers === 1
    && firstStats.userInputCancels === 1
    && firstStats.steerActions === 1
    && firstStats.handoffInterrupts === 1
    && firstStats.deepLinkFailures === 1
    && firstStats.codexConnected === false
    && Object.values(executionEvidence).every(Boolean)
    && Object.values(userInputConvergence).every(Boolean)
    && unknownRequestVisible
    && normalCompletionVisible;
  const handoffPassed = handoffState.task?.substatus === 'blocked' && handoffState.execution?.status === 'interrupted';
  const restartPassed = restart.task?.substatus === 'blocked'
    && restart.execution?.status === 'interrupted'
    && restart.execution?.turnId === 'qa-restart-turn'
    && restart.uiInterrupted
    && restart.uiEvidencePreserved
    && restart.uiRestartReason.includes('Workboard 已重启')
    && secondStats.codexConnected === false
    && firstClose.normalExit && firstClose.writerLeaseReleased
    && secondClose.normalExit && secondClose.writerLeaseReleased;
  if (!layoutPassed || !protocolPassed || !handoffPassed || !restartPassed) {
    throw new Error(`受控目录包 UI 验收失败：${JSON.stringify({ layoutPassed, protocolPassed, handoffPassed, restartPassed, layoutMatrix, firstStats, handoffState, restart, secondStats })}`);
  }
  return {
    result: 'PASS',
    packaged: true,
    platform: process.platform,
    isolated: true,
    realCodexConnected: false,
    layoutMatrix,
    executionEvidence,
    approvals: { decline: true, acceptOnce: true, acceptForSession: true, converged: true },
    userInputConvergence,
    unknownRequest: { uiFailureVisible: unknownRequestVisible, protocolResponseCoveredByBridgeContractTest: true },
    protocolCounters: firstStats,
    normalCompletionVisible,
    handoff: { interrupted: true, deepLinkFallbackVisible: true },
    restart: { status: restart.execution.status, taskSubstatus: restart.task.substatus, evidencePreserved: restart.uiEvidencePreserved, reasonVisible: true },
    lifecycle: { first: firstClose, second: secondClose },
  };
}

let result;
try {
  result = await run();
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
} finally {
  const cleanupErrors = await cleanupGovernedSessions({
    sessions,
    closeTrackedProcess: async (session, graceful) => {
      const closed = await closeOwnedProcess(session.tracked, { graceful });
      if (closed.forced || closed.gracefulError) throw new Error('目录包未通过无错误的正常关闭路径退出');
    },
    assertLeaseReleased: async () => { if (userData) assertWriterLeaseReleased(userData); },
  });
  if (canRemoveQaTemporaryData(primaryError, cleanupErrors)) {
    cleanupErrors.push(...await runCleanupActions([
      ['隔离目录清理', async () => rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })],
    ]));
  }
  const finalError = combinePrimaryAndCleanupError(primaryError, cleanupErrors);
  if (finalError) throw finalError;
}

if (evidencePath) writeEvidenceAtomically(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
