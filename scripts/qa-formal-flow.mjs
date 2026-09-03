import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertWindowsSystemPackage,
  assertWriterLeaseReleased,
  buildFormalAppEnvironment,
  buildOfflineLaunchConfiguration,
  buildMinimalFormalEvidence,
  canRemoveQaTemporaryData,
  closeOwnedProcess,
  combinePrimaryAndCleanupError,
  resolveExternalArtifactPath,
  resolvePackagedExecutable,
  runCleanupActions,
  trackChild,
  validateFormalFlowGate,
  waitForDevToolsPort,
  preflightEvidenceTarget,
  writeEvidenceAtomically,
} from './qa-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const keepUserData = process.argv.includes('--keep-user-data');
validateFormalFlowGate(process.argv.slice(2), process.env, { platform: process.platform });
const { resolveCodexExecutable } = await import('../dist-electron/codexBridge.js');
const evidencePath = resolveExternalArtifactPath(process.env.WORKBOARD_QA_EVIDENCE_PATH, root, 'WORKBOARD_QA_EVIDENCE_PATH');
if (!evidencePath) throw new Error('正式流程必须显式提供源码目录外的 WORKBOARD_QA_EVIDENCE_PATH');
preflightEvidenceTarget(evidencePath);
const packagedApplication = resolvePackagedExecutable(root, { packageDir: process.env.WORKBOARD_PACKAGE_DIR });
assertWindowsSystemPackage(packagedApplication.packageDir, process.env);
const validatedEnvironment = buildFormalAppEnvironment(process.env, path.join(tmpdir(), 'codex-workboard-formal-validation-only'));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'codex-workboard-formal-flow-'));
const isolatedUserData = path.join(temporaryRoot, 'user-data');
const formalEnvironment = { ...validatedEnvironment, WORKBOARD_USER_DATA_DIR: isolatedUserData };
const codexHome = formalEnvironment.CODEX_HOME;
const runId = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
const taskTitle = `正式流程测试 ${runId}`;
const manualCategory = `流程验证-${runId.slice(-6)}`;
const executor = 'Subagent-执行';
const allSourceKinds = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

const result = {
  ok: false,
  runId,
  package: null,
  isolation: {
    temporaryRoot,
    userData: isolatedUserData,
    codexHome,
    demoSeed: true,
    kept: keepUserData,
  },
  appServerBaseline: null,
  checks: {},
  evidence: {},
  evidencePath,
  error: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function resolveExecutable() {
  return packagedApplication.executable;
}

function resolveCodex() {
  return resolveCodexExecutable();
}

class AppServerClient {
  constructor(executable) {
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env: formalEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.tracked = trackChild(this.child, { ownsProcessGroup: process.platform !== 'win32' });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'App Server 请求失败'));
      else pending.resolve(message.result);
    });
    this.child.once('exit', (code, signal) => {
      const error = new Error(`App Server 已退出 (${code ?? signal ?? 'unknown'}) ${this.stderr}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex-workboard-formal-flow-qa', title: 'Codex Workboard Formal Flow QA', version: '1.0.0' },
    });
    this.notify('initialized', {});
  }

  async list(archived) {
    const threads = [];
    let cursor = null;
    const seen = new Set();
    let pages = 0;
    do {
      const response = await this.request('thread/list', {
        cursor,
        limit: 200,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived,
        sourceKinds: allSourceKinds,
      });
      threads.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
      assert(!cursor || !seen.has(cursor), 'App Server 返回重复游标', { archived, cursor });
      if (cursor) seen.add(cursor);
      pages += 1;
      assert(pages < 500, 'App Server 分页超过安全上限', { archived, pages });
    } while (cursor);
    return { threads, pages };
  }

  async stop() {
    return closeOwnedProcess(this.tracked, {
      graceful: () => {
        if (!this.child.stdin.destroyed) this.child.stdin.end();
        else this.child.kill('SIGTERM');
      },
    });
  }
}

async function waitForPage(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await sleep(200);
  }
  throw new Error('正式打包应用的 CDP 页面未就绪');
}

async function connectCdp(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || 'CDP 请求失败'));
    else resolve(message.result);
  });

  function command(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`页面执行失败：${description}`);
    }
    return response.result?.value;
  }

  return { socket, command, evaluate };
}

async function waitUntil(evaluate, expression, label, timeoutMs = 30_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(expression);
    if (lastValue) return lastValue;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}; last=${JSON.stringify(lastValue)}`);
}

function byText(tag, text, rootSelector = 'document') {
  return `Array.from((${rootSelector})?.querySelectorAll(${JSON.stringify(tag)}) ?? []).find((node) => node.textContent?.trim().includes(${JSON.stringify(text)}))`;
}

function setValue(selector, value, eventName = 'input') {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('找不到元素: ${selector}');
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
    return element.value;
  })()`;
}

async function run() {
  const executable = resolveExecutable();
  result.package = executable;

  const baselineClient = new AppServerClient(resolveCodex());
  let child;
  let trackedChild;
  let cdp;
  let primaryError;
  try {
    await baselineClient.initialize();
    const [active, archived] = await Promise.all([baselineClient.list(false), baselineClient.list(true)]);
    const baselineIds = new Set([...active.threads, ...archived.threads].map((thread) => thread.id).filter(Boolean));
    result.appServerBaseline = {
      total: baselineIds.size,
      active: active.threads.length,
      archived: archived.threads.length,
      pages: active.pages + archived.pages,
      sourceKinds: allSourceKinds,
    };
    assert(baselineIds.size > 0, '官方 App Server 未返回任何对话');
    await baselineClient.stop();

    const launch = buildOfflineLaunchConfiguration({ packaged: true, executable, checkoutRoot: root, userData: isolatedUserData });
    child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: formalEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    trackedChild = trackChild(child, { ownsProcessGroup: process.platform !== 'win32' });
    const portPromise = waitForDevToolsPort(child, launch.devToolsDataDir, { timeoutMs: 30_000 });
    let appStderr = '';
    child.stderr.on('data', (chunk) => {
      appStderr = `${appStderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    const port = await portPromise;

    const page = await waitForPage(port);
    cdp = await connectCdp(page);
    await cdp.command('Runtime.enable');
    await waitUntil(cdp.evaluate, `document.body?.innerText?.includes('Codex 已连接')`, 'Codex 连接', 60_000);
    const bootstrap = await cdp.evaluate(`window.codexTaskboard.bootstrap()`);
    const isolatedDatabase = path.join(isolatedUserData, 'taskboard.sqlite');
    assert(existsSync(isolatedDatabase), '隔离 userData 未生效，已在任何流程写操作前停止', { expectedDatabase: isolatedDatabase });
    result.evidence.isolation = { database: isolatedDatabase, exists: true };
    assert(bootstrap.codex?.connected === true, '应用内 App Server 未连接', bootstrap.codex);
    const appIds = new Set(bootstrap.threads.map((thread) => thread.id));
    const missingIds = [...baselineIds].filter((id) => !appIds.has(id));
    assert(appIds.size === baselineIds.size && missingIds.length === 0, '应用未全量同步官方 App Server 对话', {
      expected: baselineIds.size,
      actual: appIds.size,
      missingIds: missingIds.slice(0, 10),
    });
    result.checks.fullSync = true;
    result.evidence.sync = {
      expectedTotal: baselineIds.size,
      actualTotal: appIds.size,
      active: bootstrap.sync.active,
      archived: bootstrap.sync.archived,
      categories: bootstrap.categories.length,
      connected: bootstrap.codex.connected,
      version: bootstrap.codex.version,
    };

    await cdp.evaluate(`${byText('button', '全部对话')}?.click()`);
    await waitUntil(cdp.evaluate, `document.querySelectorAll('.conversation-row').length > 0`, '全部对话列表');
    const visibleConversationCount = await cdp.evaluate(`document.querySelectorAll('.conversation-row').length`);
    assert(visibleConversationCount === result.appServerBaseline.active, '全部对话视图未展示全部未归档对话', {
      expectedActive: result.appServerBaseline.active,
      visibleConversationCount,
    });
    const selectedConversation = await cdp.evaluate(`(() => {
      const row = document.querySelector('.conversation-row');
      const title = row?.querySelector('.conversation-title')?.textContent?.trim();
      const threadId = row?.dataset.threadId;
      row?.click();
      return { title, threadId };
    })()`);
    assert(selectedConversation?.threadId, '无法打开首个对话', selectedConversation);
    const selectedThreadId = selectedConversation.threadId;
    await waitUntil(cdp.evaluate, `Boolean(document.querySelector('.conversation-detail'))`, '对话详情');
    const categorySelector = '.conversation-detail .panel-field input[list="conversation-categories"]';
    await cdp.evaluate(setValue(categorySelector, manualCategory));
    await cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(categorySelector)});
      element?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      element?.dispatchEvent(new FocusEvent('blur'));
    })()`);
    await waitUntil(cdp.evaluate, `window.codexTaskboard.bootstrap().then((data) => data.threads.some((thread) => thread.id === ${JSON.stringify(selectedThreadId)} && thread.category === ${JSON.stringify(manualCategory)} && thread.classificationSource === 'manual'))`, '人工分类持久化');
    result.checks.openAndCategorizeConversation = true;
    result.evidence.conversation = {
      visibleConversationCount,
      threadId: selectedThreadId,
      title: selectedConversation.title,
      manualCategory,
    };

    await cdp.evaluate(`${byText('button', '转为任务', "document.querySelector('.conversation-detail')")}?.click()`);
    await waitUntil(cdp.evaluate, `Boolean(document.querySelector('.modal'))`, '从对话转任务弹窗');
    await cdp.evaluate(setValue('.modal input[placeholder="要完成什么？"]', taskTitle));
    await cdp.evaluate(setValue('.modal textarea[placeholder="补充上下文、边界或预期结果"]', '由端到端流程测试创建并验证个人验收闭环。'));
    await cdp.evaluate(setValue('.modal input[placeholder="可稍后填写"]', executor));
    await cdp.evaluate(setValue('.modal textarea[placeholder="哪些证据满足后才算完成？"]', '全量同步、人工分类、任务流转与用户验收全部通过。'));
    const modalThreadId = await cdp.evaluate(`(() => {
      const existingMode = Array.from(document.querySelectorAll('.modal .conversation-mode button')).find((button) => button.textContent?.includes('关联已有'));
      if (existingMode?.getAttribute('aria-pressed') !== 'true') return '';
      return document.querySelector('.modal .conversation-setup label.field select')?.value || '';
    })()`);
    assert(modalThreadId === selectedThreadId, '从对话创建任务时未保留关联 ID', { selectedThreadId, modalThreadId });
    await cdp.evaluate(`document.querySelector('.modal button[type="submit"]')?.click()`);
    await waitUntil(cdp.evaluate, `document.body.innerText.includes(${JSON.stringify(taskTitle)}) && Boolean(document.querySelector('.detail-panel'))`, '关联任务创建');
    let created = await cdp.evaluate(`window.codexTaskboard.bootstrap().then((data) => data.tasks.find((task) => task.title === ${JSON.stringify(taskTitle)}))`);
    assert(created?.threadId === selectedThreadId, '新任务未关联原对话', created);
    assert(created?.lane === 'plan', '新任务初始阶段不是计划中', created);
    result.checks.createLinkedTask = true;

    await cdp.evaluate(`${byText('button', '执行', "document.querySelector('.stage-transfer')")}?.click()`);
    await waitUntil(cdp.evaluate, `window.codexTaskboard.bootstrap().then((data) => data.tasks.some((task) => task.id === ${JSON.stringify(created.id)} && task.lane === 'execution' && ['claimed', 'running'].includes(task.substatus)))`, '流转到执行');
    await cdp.evaluate(`${byText('button', '验收和回顾', "document.querySelector('.stage-transfer')")}?.click()`);
    await waitUntil(cdp.evaluate, `window.codexTaskboard.bootstrap().then((data) => data.tasks.some((task) => task.id === ${JSON.stringify(created.id)} && task.lane === 'review' && task.substatus === 'pending_review'))`, '流转到验收');
    await waitUntil(cdp.evaluate, `Boolean(document.querySelector('.review-box'))`, '个人验收表单');
    result.checks.lifecycleToReview = true;

    const reviewModes = await cdp.evaluate(`Array.from(document.querySelector('.review-box select')?.options ?? []).map((option) => option.textContent?.trim())`);
    assert(reviewModes.join('|') === '用户验收|AI 验收', '个人验收界面出现了额外角色或缺少 AI 验收', reviewModes);
    const reviewCopy = await cdp.evaluate(`document.querySelector('.review-box')?.innerText || ''`);
    assert(!reviewCopy.includes('独立人工验收') && !reviewCopy.includes('验收人'), '个人模式仍要求独立人工验收人', reviewCopy);
    assert(reviewCopy.includes('证据与回顾（可选）'), '用户验收仍要求人工说明', reviewCopy);
    await cdp.evaluate(`${byText('button', '通过验收', "document.querySelector('.review-box')")}?.click()`);
    await waitUntil(cdp.evaluate, `window.codexTaskboard.bootstrap().then((data) => data.tasks.some((task) => task.id === ${JSON.stringify(created.id)} && task.substatus === 'accepted' && task.auditor === '用户'))`, '用户无输入验收通过');
    const events = await cdp.evaluate(`window.codexTaskboard.listAuditEvents(${JSON.stringify(created.id)})`);
    const actions = events.map((event) => event.action);
    assert(actions.includes('created') && actions.filter((action) => action === 'lane_changed').length >= 2 && actions.includes('accepted'), '审计轨迹不完整', events);
    await waitUntil(cdp.evaluate, `document.querySelector('.timeline')?.innerText?.includes('accepted')`, '界面显示审计轨迹');
    result.checks.personalAcceptanceModes = true;
    result.checks.userAcceptanceWithoutInput = true;
    result.checks.auditTrailVisible = true;
    result.evidence.task = {
      id: created.id,
      title: taskTitle,
      threadId: created.threadId,
      executor,
      auditor: '用户',
      finalLane: 'review',
      finalSubstatus: 'accepted',
      auditActions: actions,
      auditEventCount: events.length,
    };

    result.ok = Object.values(result.checks).every(Boolean);
    assert(result.ok, '存在未通过的业务流程检查', result.checks);
  } catch (error) {
    result.error = { present: true };
    primaryError = error instanceof Error ? error : new Error(String(error));
  }
  const cleanupErrors = await runCleanupActions([
    ['App Server 退出', async () => {
      const closed = await baselineClient.stop();
      if (closed.forced || closed.gracefulError) throw new Error('App Server 未通过无错误的正常关闭路径退出');
    }],
    ['Electron 进程退出', async () => {
      if (!trackedChild) return;
      const closed = await closeOwnedProcess(trackedChild, {
        graceful: async () => {
          if (cdp?.socket.readyState === WebSocket.OPEN) await cdp.command('Page.close');
          else child.kill('SIGTERM');
        },
      });
      if (closed.forced || closed.gracefulError) throw new Error('Electron 未通过无错误的正常关闭路径退出');
    }],
    ['CDP 连接关闭', async () => cdp?.socket.close()],
    ['writer lease 释放', async () => assertWriterLeaseReleased(isolatedUserData)],
  ]);
  result.cleanupFailed = cleanupErrors.length > 0;
  const finalError = combinePrimaryAndCleanupError(primaryError, cleanupErrors);
  if (finalError) throw finalError;
  return result;
}

let primaryError;
let cleanupFailed = false;
try {
  await run();
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
  result.ok = false;
  result.error = { present: true };
  cleanupFailed = Boolean(result.cleanupFailed);
} finally {
  const cleanupErrors = await runCleanupActions([
    ['writer lease 最终复核', async () => assertWriterLeaseReleased(isolatedUserData)],
  ]);
  if (!keepUserData && !cleanupFailed && canRemoveQaTemporaryData(primaryError, cleanupErrors)) {
    cleanupErrors.push(...await runCleanupActions([
      ['正式流程临时目录清理', async () => rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })],
    ]));
  }
  const finalError = combinePrimaryAndCleanupError(primaryError, cleanupErrors);
  const serialized = JSON.stringify(buildMinimalFormalEvidence(result, cleanupErrors), null, 2);
  writeEvidenceAtomically(evidencePath, `${serialized}\n`);
  console.log(serialized);
  if (finalError) throw finalError;
}
