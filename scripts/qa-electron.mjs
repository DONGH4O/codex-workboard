import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
function resolvePackagedExecutable() {
  for (const directoryName of ['mac-arm64', 'mac', 'mac-universal']) {
    const directory = path.join(root, 'dist', directoryName);
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const product = entry.name.slice(0, -4);
      return path.join(directory, entry.name, 'Contents', 'MacOS', product);
    }
  }
  throw new Error('未找到 macOS 打包应用；请先运行 npm run pack');
}
const executable = resolvePackagedExecutable();
const userData = mkdtempSync(path.join(tmpdir(), 'codex-workboard-ui-qa-'));
const port = 9339;
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, WORKBOARD_USER_DATA_DIR: userData, WORKBOARD_SEED_DEMO: '1', WORKBOARD_SKIP_LEGACY_MIGRATION: '1', WORKBOARD_SKIP_CODEX_SYNC: '1' },
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
      if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const waitUntil = async (expression, label, attempts = 40) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  };

  await sleep(3000);
  await waitUntil(`document.body.innerText.includes('在关联对话中继续执行')`, '实时执行演示任务加载', 600);
  const liveExecutionOpened = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('在关联对话中继续执行'));
    card?.click();
    return Boolean(card);
  })()`);
  if (!liveExecutionOpened) {
    const bodyText = await evaluate(`document.body.innerText.slice(0, 1200)`);
    throw new Error(`未找到实时执行演示任务：${bodyText}`);
  }
  await sleep(1800);
  const liveExecutionCheck = await evaluate(`(() => {
    const panel = document.querySelector('.detail-panel');
    const tabs = Array.from(panel?.querySelectorAll('.panel-tabs button') ?? []);
    const modelSelect = document.querySelector('.execution-settings label:nth-child(1) select');
    const speedSelect = document.querySelector('.execution-settings label:nth-child(2) select');
    const effortSelect = document.querySelector('.execution-settings label:nth-child(3) select');
    const permissionSelect = document.querySelector('.execution-settings label:nth-child(4) select');
    const approvalButtons = Array.from(document.querySelectorAll('.approval-actions button')).map((button) => button.textContent.trim());
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('在关联对话中继续执行'));
    return {
      panelVisible: Boolean(panel),
      tabs: tabs.map((button) => button.textContent.trim()),
      activeTab: tabs.find((button) => button.classList.contains('active'))?.textContent.trim() ?? '',
      modelOptions: modelSelect?.options.length ?? 0,
      modelValue: modelSelect?.value ?? '',
      speedOptions: Array.from(speedSelect?.options ?? []).map((option) => option.textContent.trim()),
      speedValue: speedSelect?.value ?? '',
      effortOptions: effortSelect?.options.length ?? 0,
      effortValue: effortSelect?.value ?? '',
      permissionOptions: Array.from(permissionSelect?.options ?? []).map((option) => option.textContent.trim()),
      approvalCard: Boolean(document.querySelector('.approval-card')),
      approvalButtons,
      planItems: document.querySelectorAll('.execution-plan-item').length,
      terminalText: document.querySelector('.execution-console')?.textContent ?? '',
      diffText: document.querySelector('.execution-diff')?.textContent ?? '',
      statusText: document.querySelector('.execution-status')?.textContent?.trim() ?? '',
      cardStatus: card?.querySelector('.execution-state')?.textContent?.trim() ?? '',
      composerDisabled: document.querySelector('.execution-composer textarea')?.disabled ?? false,
    };
  })()`);
  if (process.env.WORKBOARD_QA_CAPTURE_PATH) {
    const screenshot = await new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) => {
        if (message.result?.data) resolve(message.result.data);
        else reject(new Error('无法捕获实时执行界面'));
      });
      socket.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    });
    writeFileSync(process.env.WORKBOARD_QA_CAPTURE_PATH, Buffer.from(screenshot, 'base64'));
  }
  await evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('关联对话'))?.click()`);
  await waitUntil(`Boolean(document.querySelector('.thread-pane'))`, '关联对话面板');
  const directChatBusyCheck = await evaluate(`(() => {
    const composer = document.querySelector('.thread-composer');
    const textarea = composer?.querySelector('textarea');
    const selects = composer?.querySelectorAll('select') ?? [];
    return {
      visible: Boolean(composer),
      textareaDisabled: textarea?.disabled ?? false,
      textareaPlaceholder: textarea?.placeholder ?? '',
      selectCount: selects.length,
      permissionOptions: Array.from(selects[3]?.options ?? []).map((option) => option.textContent.trim()),
      liveReplyVisible: Boolean(document.querySelector('.thread-live-message')),
      liveReplyText: document.querySelector('.thread-live-message')?.textContent ?? '',
      handoffToCodex: document.querySelector('.thread-context')?.textContent.includes('转到 Codex') ?? false,
      unavailableCopy: document.querySelector('.thread-pane')?.textContent.includes('目录尚未同步，但仍可在这里继续发送消息') ?? false,
    };
  })()`);
  await evaluate(`document.querySelector('.panel-header > .icon-button')?.click()`);
  await sleep(120);
  const steerTaskOpened = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('执行中可随时引导'));
    card?.click();
    return Boolean(card);
  })()`);
  await waitUntil(`Boolean(document.querySelector('.execution-composer'))`, '当前回合引导输入框');
  const steerUiCheck = await evaluate(`(() => {
    const composer = document.querySelector('.execution-composer');
    const textarea = composer?.querySelector('textarea');
    const attach = composer?.querySelector('.attachment-button');
    const send = composer?.querySelector('.send-button');
    const steerNote = composer?.querySelector('.steer-mode-note');
    const steerStyle = steerNote ? getComputedStyle(steerNote) : null;
    return {
      taskOpened: ${JSON.stringify(steerTaskOpened)},
      textareaEnabled: textarea ? !textarea.disabled : false,
      placeholder: textarea?.placeholder ?? '',
      steerMode: steerNote?.textContent ?? '',
      steerHeight: steerNote?.getBoundingClientRect().height ?? 0,
      steerFontSize: steerStyle?.fontSize ?? '',
      steerWhiteSpace: steerStyle?.whiteSpace ?? '',
      attachmentVisible: Boolean(attach),
      attachmentEnabled: attach ? !attach.disabled : false,
      sendInitiallyDisabled: send?.disabled ?? false,
      settingsDisabled: Array.from(document.querySelectorAll('.execution-settings select')).every((select) => select.disabled),
      title: send?.getAttribute('title') ?? '',
    };
  })()`);
  await evaluate(`document.querySelector('.panel-header > .icon-button')?.click()`);
  await sleep(120);
  await evaluate(`document.querySelector('.notification-button')?.click()`);
  await waitUntil(`Boolean(document.querySelector('.notification-popover'))`, '通知中心');
  const notificationOpenCheck = await evaluate(`(() => {
    const button = document.querySelector('.notification-button');
    const popover = document.querySelector('.notification-popover');
    return {
      visible: Boolean(popover),
      expanded: button?.getAttribute('aria-expanded') ?? '',
      count: Number(button?.querySelector('.notification-badge')?.textContent ?? 0),
      itemCount: popover?.querySelectorAll('.notification-item').length ?? 0,
      approvalVisible: popover?.innerText.includes('等待审批') ?? false,
      reviewVisible: popover?.innerText.includes('等待验收') ?? false,
      refreshVisible: Boolean(popover?.querySelector('.notification-refresh')),
      menuRole: popover?.getAttribute('role') ?? '',
    };
  })()`);
  if (process.env.WORKBOARD_QA_NOTIFICATION_CAPTURE_PATH) {
    const screenshot = await new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) => {
        if (message.result?.data) resolve(message.result.data);
        else reject(new Error('无法捕获通知中心界面'));
      });
      socket.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    });
    writeFileSync(process.env.WORKBOARD_QA_NOTIFICATION_CAPTURE_PATH, Buffer.from(screenshot, 'base64'));
  }
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(120);
  const notificationEscapeCheck = await evaluate(`({
    closed: !document.querySelector('.notification-popover'),
    expanded: document.querySelector('.notification-button')?.getAttribute('aria-expanded') ?? '',
    focused: document.activeElement === document.querySelector('.notification-button')
  })`);
  await evaluate(`document.querySelector('.notification-button')?.click()`);
  await waitUntil(`Boolean(document.querySelector('.notification-approval'))`, '审批通知');
  await evaluate(`document.querySelector('.notification-approval')?.click()`);
  await waitUntil(`Boolean(document.querySelector('.detail-panel'))`, '通知直达任务详情');
  const notificationActionCheck = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.panel-tabs button'));
    return {
      menuClosed: !document.querySelector('.notification-popover'),
      detailVisible: Boolean(document.querySelector('.detail-panel')),
      activeTab: tabs.find((button) => button.classList.contains('active'))?.textContent?.trim() ?? '',
      approvalVisible: Boolean(document.querySelector('.approval-card')),
      approvalReason: document.querySelector('.approval-card')?.textContent ?? '',
    };
  })()`);
  await evaluate(`document.querySelector('.panel-header > .icon-button')?.click()`);
  await sleep(120);
  const before = await evaluate(`document.querySelectorAll('.task-card').length`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('新增任务'))?.click()`);
  await sleep(150);
  await waitUntil(`(document.querySelector('.conversation-runtime select')?.options.length ?? 0) > 0`, '新任务模型与速度选项');
  const createConversationCheck = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.conversation-mode button'));
    const selects = document.querySelectorAll('.conversation-runtime select');
    const projectField = Array.from(document.querySelectorAll('.modal label.field')).find((label) => label.querySelector(':scope > span')?.textContent?.trim() === '所属项目');
    return {
      labels: buttons.map((button) => button.textContent.trim()),
      defaultNew: buttons.find((button) => button.textContent.includes('新建会话'))?.getAttribute('aria-pressed') ?? '',
      projectOptions: projectField?.querySelector('select')?.options.length ?? 0,
      modelOptions: selects[0]?.options.length ?? 0,
      effortOptions: Array.from(selects[1]?.options ?? []).map((option) => option.textContent.trim()),
      speedOptions: Array.from(selects[2]?.options ?? []).map((option) => option.textContent.trim()),
      permissionOptions: Array.from(selects[3]?.options ?? []).map((option) => option.textContent.trim()),
    };
  })()`);
  if (process.env.WORKBOARD_QA_CREATE_CAPTURE_PATH) {
    const screenshot = await new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) => {
        if (message.result?.data) resolve(message.result.data);
        else reject(new Error('无法捕获新任务会话设置界面'));
      });
      socket.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    });
    writeFileSync(process.env.WORKBOARD_QA_CREATE_CAPTURE_PATH, Buffer.from(screenshot, 'base64'));
  }
  await evaluate(`Array.from(document.querySelectorAll('.conversation-mode button')).find((button) => button.textContent.includes('仅创建任务'))?.click()`);
  const createTaskOnlyCheck = await evaluate(`({
    selected: Array.from(document.querySelectorAll('.conversation-mode button')).find((button) => button.textContent.includes('仅创建任务'))?.getAttribute('aria-pressed') ?? '',
    runtimeHidden: !document.querySelector('.conversation-runtime')
  })`);
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
  const creationCheck = await evaluate(`({
    after: document.querySelectorAll('.task-card').length,
    createdVisible: document.body.innerText.includes('UI 自动化新增任务'),
    detailPanelOpen: Boolean(document.querySelector('.detail-panel'))
  })`);
  await evaluate(`window.codexTaskboard.bulkCreateTasks().then(() => { setTimeout(() => location.reload(), 50); return true; })`);
  await sleep(3500);
  const reviewSeed = await evaluate(`window.codexTaskboard.bootstrap().then(async (state) => {
    const thread = state.threads[0] ?? null;
    const projectPath = thread?.cwd || 'UI QA';
    const task = await window.codexTaskboard.createTask({
      title: 'UI 个人验收模式测试',
      description: '验证用户验收无需额外输入，并可切换 AI 验收。',
      lane: 'review',
      priority: 'medium',
      projectPath,
      threadId: thread?.id ?? null,
      executor: '用户',
      acceptanceCriteria: '界面只提供用户验收和 AI 验收',
    });
    const detailArchiveTask = await window.codexTaskboard.createTask({
      title: 'UI 详情归档按钮测试',
      description: '验证详情面板中的归档按钮可直接归档并提供撤销。',
      lane: 'plan',
      priority: 'medium',
      projectPath,
      threadId: thread?.id ?? null,
    });
    const batchMoveTasks = await Promise.all(['A', 'B'].map((suffix) => window.codexTaskboard.createTask({ title: 'UI 批量迁移测试 ' + suffix, lane: 'plan', projectPath })));
    const batchReviewTasks = await Promise.all(['A', 'B'].map((suffix) => window.codexTaskboard.createTask({ title: 'UI 批量验收测试 ' + suffix, lane: 'review', projectPath, executor: '用户' })));
    return { id: task.id, projectPath, detailArchiveTaskId: detailArchiveTask.id, batchMoveIds: batchMoveTasks.map((item) => item.id), batchReviewIds: batchReviewTasks.map((item) => item.id) };
  })`);
  await evaluate(`location.reload()`);
  await sleep(500);
  await waitUntil(`(document.querySelector('.project-select select')?.options.length ?? 0) >= 2`, '项目筛选器数据加载', 200);
  const projectFilter = await evaluate(`(() => {
    const select = document.querySelector('.project-select select');
    const options = Array.from(select?.options ?? []).map((option) => option.value);
    const target = '全部项目';
    if (select && target) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, target);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { optionCount: options.length, target };
  })()`);
  await sleep(300);
  const batchDefaultHidden = await evaluate(`!document.querySelector('.task-select-checkbox') && !document.querySelector('.board-selection-bar')`);
  await evaluate(`Array.from(document.querySelectorAll('.board-toolbar-actions button')).find((button) => button.textContent.trim() === '多选')?.click()`);
  await waitUntil(`Boolean(document.querySelector('.task-select-checkbox')) && Boolean(document.querySelector('.board-selection-bar'))`, '进入多选模式');
  await evaluate(`(${JSON.stringify(reviewSeed.batchMoveIds)}).forEach((id) => document.querySelector('.task-card[data-task-id="' + id + '"] .task-select-checkbox')?.click())`);
  await sleep(120);
  const batchSelectionCheck = await evaluate(`(() => {
    const bar = document.querySelector('.board-selection-bar');
    return { defaultHidden: ${JSON.stringify(true)}, selected: document.querySelectorAll('.task-select-checkbox:checked').length, text: bar?.innerText ?? '', visible: Boolean(bar), selectedStyle: document.querySelectorAll('.task-card.is-selected').length };
  })()`);
  if (process.env.WORKBOARD_QA_BATCH_CAPTURE_PATH) {
    const screenshot = await new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) => {
        if (message.result?.data) resolve(message.result.data);
        else reject(new Error('无法捕获批量操作界面'));
      });
      socket.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    });
    writeFileSync(process.env.WORKBOARD_QA_BATCH_CAPTURE_PATH, Buffer.from(screenshot, 'base64'));
  }
  await evaluate(`Array.from(document.querySelectorAll('.batch-stage-actions button')).find((button) => button.textContent.trim() === '执行')?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => (${JSON.stringify(reviewSeed.batchMoveIds)}).every((id) => state.tasks.some((task) => task.id === id && task.lane === 'execution')))`, '批量迁移到执行');
  await evaluate(`Array.from(document.querySelectorAll('.board-toolbar-actions button')).find((button) => button.textContent.trim() === '多选')?.click()`);
  await waitUntil(`Boolean(document.querySelector('.task-select-checkbox'))`, '再次进入多选模式');
  await evaluate(`(${JSON.stringify(reviewSeed.batchReviewIds)}).forEach((id) => document.querySelector('.task-card[data-task-id="' + id + '"] .task-select-checkbox')?.click())`);
  await sleep(120);
  const batchAcceptEnabled = await evaluate(`!document.querySelector('.batch-accept-button')?.disabled`);
  await evaluate(`document.querySelector('.batch-accept-button')?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => (${JSON.stringify(reviewSeed.batchReviewIds)}).every((id) => state.tasks.some((task) => task.id === id && task.substatus === 'accepted')))`, '批量验收');
  const batchActionCheck = await evaluate(`Promise.all([
    window.codexTaskboard.bootstrap(),
    ...(${JSON.stringify(reviewSeed.batchReviewIds)}).map((id) => window.codexTaskboard.listAuditEvents(id))
  ]).then(([state, ...events]) => ({
    moved: (${JSON.stringify(reviewSeed.batchMoveIds)}).every((id) => state.tasks.some((task) => task.id === id && task.lane === 'execution')),
    accepted: (${JSON.stringify(reviewSeed.batchReviewIds)}).every((id) => state.tasks.some((task) => task.id === id && task.substatus === 'accepted')),
    audited: events.every((list) => list.some((event) => event.action === 'accepted')),
    acceptEnabled: ${JSON.stringify(batchAcceptEnabled)}
  }))`);
  await evaluate(`Promise.all((${JSON.stringify([...reviewSeed.batchMoveIds, ...reviewSeed.batchReviewIds])}).map((id) => window.codexTaskboard.archiveTask(id)))`);
  await evaluate(`location.reload()`);
  await sleep(500);
  await waitUntil(`document.body.innerText.includes('UI 详情归档按钮测试')`, '详情归档测试任务刷新', 100);
  const detailArchiveOpened = await evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('.timeline-task-row')).find((item) => item.textContent.includes('UI 详情归档按钮测试'))
      ?? Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('UI 详情归档按钮测试'));
    target?.click();
    return Boolean(target);
  })()`);
  await waitUntil(`Boolean(document.querySelector('.stage-archive-button'))`, '详情归档按钮');
  const detailArchiveButtonCheck = await evaluate(`(() => {
    const button = document.querySelector('.stage-archive-button');
    return { opened: ${JSON.stringify(detailArchiveOpened)}, visible: Boolean(button), text: button?.textContent?.trim() ?? '', ariaLabel: button?.getAttribute('aria-label') ?? '' };
  })()`);
  await evaluate(`document.querySelector('.stage-archive-button')?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => !state.tasks.some((task) => task.id === ${JSON.stringify(reviewSeed.detailArchiveTaskId)}))`, '详情按钮归档任务');
  const detailArchiveResult = await evaluate(`Promise.all([
    window.codexTaskboard.bootstrap(),
    window.codexTaskboard.listAuditEvents(${JSON.stringify(reviewSeed.detailArchiveTaskId)})
  ]).then(([state, events]) => ({
    removed: !state.tasks.some((task) => task.id === ${JSON.stringify(reviewSeed.detailArchiveTaskId)}),
    panelClosed: !document.querySelector('.detail-panel'),
    undoVisible: Array.from(document.querySelectorAll('.toast button')).some((button) => button.textContent.includes('撤销')),
    archived: events.some((event) => event.action === 'archived')
  }))`);
  await evaluate(`document.querySelector('.workflow-row[data-lane="execution"]')?.click()`);
  await sleep(180);
  const workflowFilterCheck = await evaluate(`({
    selected: document.querySelector('.workflow-row[data-lane="execution"]')?.getAttribute('aria-pressed'),
    activeClass: document.querySelector('.workflow-row[data-lane="execution"]')?.classList.contains('active') ?? false,
    visibleColumns: document.querySelectorAll('.board-column').length,
    executionColumn: Boolean(document.querySelector('.lane-execution')),
    boardLabel: document.querySelector('.board')?.getAttribute('aria-label') ?? ''
  })`);
  await evaluate(`document.querySelector('.workflow-row[data-lane="execution"]')?.click()`);
  await sleep(180);
  const workflowFilterResetCheck = await evaluate(`({
    selected: document.querySelector('.workflow-row[data-lane="execution"]')?.getAttribute('aria-pressed'),
    visibleColumns: document.querySelectorAll('.board-column').length
  })`);
  const planCardsBeforeMenu = await evaluate(`document.querySelectorAll('.lane-plan .task-card').length`);
  await evaluate(`document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(120);
  const columnMenuOpenCheck = await evaluate(`(() => {
    const trigger = document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]');
    const menu = document.querySelector('.lane-plan .column-menu');
    return {
      visible: Boolean(menu),
      expanded: trigger?.getAttribute('aria-expanded'),
      text: menu?.innerText ?? '',
      radioCount: menu?.querySelectorAll('[role="menuitemradio"]').length ?? 0,
      checkboxCount: menu?.querySelectorAll('[role="menuitemcheckbox"]').length ?? 0,
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.lane-plan .column-menu button')).find((button) => button.textContent.includes('最新对话优先'))?.click()`);
  await sleep(180);
  const columnConversationSortCheck = await evaluate(`window.codexTaskboard.bootstrap().then((state) => {
    const threadTimes = new Map(state.threads.map((thread) => [thread.id, typeof thread.updatedAt === 'number' ? thread.updatedAt : Number.NEGATIVE_INFINITY]));
    const expected = state.tasks.filter((task) => task.lane === 'plan').sort((a, b) => {
      const conversationDifference = (b.threadId ? threadTimes.get(b.threadId) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY)
        - (a.threadId ? threadTimes.get(a.threadId) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY);
      return conversationDifference || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || a.id.localeCompare(b.id);
    })[0]?.id ?? null;
    return {
      expected,
      first: document.querySelector('.lane-plan .task-card')?.dataset.taskId ?? null,
      menuClosed: !document.querySelector('.lane-plan .column-menu')
    };
  })`);
  await evaluate(`document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(120);
  const columnConversationSortSelected = await evaluate(`Array.from(document.querySelectorAll('.lane-plan .column-menu [role="menuitemradio"]')).find((item) => item.textContent.includes('最新对话优先'))?.getAttribute('aria-checked')`);
  await evaluate(`Array.from(document.querySelectorAll('.lane-plan .column-menu button')).find((button) => button.textContent.includes('优先级优先'))?.click()`);
  await sleep(120);
  await evaluate(`document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(120);
  const columnSortCheck = await evaluate(`({
    selected: Array.from(document.querySelectorAll('.lane-plan .column-menu [role="menuitemradio"]')).find((item) => item.textContent.includes('优先级优先'))?.getAttribute('aria-checked'),
    resetVisible: document.querySelector('.lane-plan .column-menu')?.innerText.includes('恢复默认显示') ?? false
  })`);
  await evaluate(`Array.from(document.querySelectorAll('.lane-plan .column-menu button')).find((button) => button.textContent.includes('仅看高优先级'))?.click()`);
  await sleep(120);
  const columnFilterCheck = await evaluate(`({
    cardsBefore: ${JSON.stringify(planCardsBeforeMenu)},
    cardsAfter: document.querySelectorAll('.lane-plan .task-card').length,
    menuClosed: !document.querySelector('.lane-plan .column-menu')
  })`);
  await evaluate(`document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(120);
  await evaluate(`Array.from(document.querySelectorAll('.lane-plan .column-menu button')).find((button) => button.textContent.includes('恢复默认显示'))?.click()`);
  await sleep(120);
  const columnMenuResetCheck = await evaluate(`({
    cardsRestored: document.querySelectorAll('.lane-plan .task-card').length === ${JSON.stringify(planCardsBeforeMenu)},
    menuClosed: !document.querySelector('.lane-plan .column-menu'),
    triggerCollapsed: document.querySelector('.lane-plan .column-actions button[aria-haspopup="menu"]')?.getAttribute('aria-expanded') === 'false'
  })`);
  await evaluate(`document.querySelector('.lane-review .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(120);
  const reviewFilterMenuCheck = await evaluate(`(() => {
    const menu = document.querySelector('.lane-review .column-menu');
    return {
      visible: Boolean(menu),
      text: menu?.innerText ?? '',
      radioCount: menu?.querySelectorAll('[role="menuitemradio"]').length ?? 0,
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.lane-review .column-menu button')).find((button) => button.textContent.trim() === '待验收')?.click()`);
  await sleep(120);
  const reviewPendingFilterCheck = await evaluate(`({
    menuClosed: !document.querySelector('.lane-review .column-menu'),
    onlyPending: Array.from(document.querySelectorAll('.lane-review .task-card .status-chip')).every((chip) => !['已验收', '已回顾'].includes(chip.textContent.trim()))
  })`);
  await evaluate(`document.querySelector('.lane-review .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(80);
  await evaluate(`Array.from(document.querySelectorAll('.lane-review .column-menu button')).find((button) => button.textContent.includes('已验收与已回顾'))?.click()`);
  await sleep(120);
  const reviewCompletedFilterCheck = await evaluate(`({
    menuClosed: !document.querySelector('.lane-review .column-menu'),
    onlyCompleted: Array.from(document.querySelectorAll('.lane-review .task-card .status-chip')).every((chip) => ['已验收', '已回顾'].includes(chip.textContent.trim())),
    emptyExplained: document.querySelector('.lane-review')?.textContent.includes('当前列已启用验收结果筛选') ?? false
  })`);
  await evaluate(`document.querySelector('.lane-review .column-actions button[aria-haspopup="menu"]')?.click()`);
  await sleep(80);
  await evaluate(`Array.from(document.querySelectorAll('.lane-review .column-menu button')).find((button) => button.textContent.includes('恢复默认显示'))?.click()`);
  await sleep(120);
  const contextTargetId = await evaluate(`window.codexTaskboard.bootstrap().then((state) => state.tasks.find((task) => task.title === 'UI 自动化新增任务')?.id || null)`);
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('UI 自动化新增任务'));
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 360 }));
    return Boolean(card);
  })()`);
  await sleep(150);
  const contextMenuOpenCheck = await evaluate(`(() => {
    const menu = document.querySelector('.task-context-menu');
    const openThread = Array.from(menu?.querySelectorAll('button') ?? []).find((button) => button.textContent.includes('在 Codex 中打开'));
    return {
      visible: Boolean(menu),
      text: menu?.innerText ?? '',
      radioCount: menu?.querySelectorAll('[role="menuitemradio"]').length ?? 0,
      openThreadDisabled: openThread?.disabled ?? false,
      position: menu ? getComputedStyle(menu).position : '',
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.task-context-menu button')).find((button) => button.textContent.trim() === '高')?.click()`);
  await sleep(200);
  const contextPriorityCheck = await evaluate(`window.codexTaskboard.bootstrap().then((state) => ({
    priority: state.tasks.find((task) => task.id === ${JSON.stringify(contextTargetId)})?.priority,
    menuClosed: !document.querySelector('.task-context-menu')
  }))`);
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.task-card')).find((item) => item.textContent.includes('UI 自动化新增任务'));
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 360 }));
  })()`);
  await sleep(120);
  await evaluate(`Array.from(document.querySelectorAll('.task-context-menu button')).find((button) => button.textContent.includes('归档任务'))?.click()`);
  await sleep(250);
  const contextArchiveCheck = await evaluate(`window.codexTaskboard.bootstrap().then(async (state) => ({
    removed: !state.tasks.some((task) => task.id === ${JSON.stringify(contextTargetId)}),
    undoVisible: Array.from(document.querySelectorAll('.toast button')).some((button) => button.textContent.includes('撤销')),
    actions: (await window.codexTaskboard.listAuditEvents(${JSON.stringify(contextTargetId)})).map((event) => event.action)
  }))`);
  await evaluate(`Array.from(document.querySelectorAll('.toast button')).find((button) => button.textContent.includes('撤销'))?.click()`);
  await sleep(250);
  const contextRestoreCheck = await evaluate(`window.codexTaskboard.bootstrap().then(async (state) => ({
    restored: state.tasks.some((task) => task.id === ${JSON.stringify(contextTargetId)} && task.priority === 'high'),
    actions: (await window.codexTaskboard.listAuditEvents(${JSON.stringify(contextTargetId)})).map((event) => event.action)
  }))`);
  const openTimelineCheck = await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.timeline-task-row')).find((item) => item.textContent.includes('UI 个人验收模式测试'));
    const bar = row?.querySelector('.timeline-bar-open');
    return { found: Boolean(row), open: Boolean(bar), label: bar?.textContent ?? '' };
  })()`);
  await evaluate(`document.querySelector('.timeline-expand-button')?.click()`);
  await sleep(180);
  const timelineExpandCheck = await evaluate(`(() => {
    const button = document.querySelector('.timeline-expand-button');
    const timeline = document.querySelector('.project-timeline');
    return {
      buttonFound: Boolean(button),
      expanded: timeline?.classList.contains('is-expanded') ?? false,
      ariaExpanded: button?.getAttribute('aria-expanded'),
      buttonText: button?.textContent?.trim() ?? '',
      position: timeline ? getComputedStyle(timeline).position : '',
      rowCount: timeline?.querySelectorAll('.timeline-task-row').length ?? 0,
    };
  })()`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(120);
  const timelineCollapseCheck = await evaluate(`({
    collapsed: !document.querySelector('.project-timeline')?.classList.contains('is-expanded'),
    ariaExpanded: document.querySelector('.timeline-expand-button')?.getAttribute('aria-expanded'),
    buttonText: document.querySelector('.timeline-expand-button')?.textContent?.trim() ?? ''
  })`);
  const reviewOpened = await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.timeline-task-row')).find((item) => item.textContent.includes('UI 个人验收模式测试'));
    row?.click();
    return Boolean(row);
  })()`);
  if (!reviewOpened) throw new Error(`未找到个人验收测试任务；项目筛选=${projectFilter.target}`);
  await waitUntil(`Boolean(document.querySelector('.stage-transfer'))`, '任务详情阶段迁移区');
  await evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('实时执行'))?.click()`);
  await sleep(120);
  const fullAccessUiCheck = await evaluate(`(() => {
    const select = document.querySelector('.execution-settings label:nth-child(4) select');
    if (!select) return { selected: '', warning: false, text: '' };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'full-access');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => resolve({
      selected: select.value,
      warning: Boolean(document.querySelector('.permission-warning')),
      text: document.querySelector('.permission-warning')?.textContent ?? '',
    }), 50));
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.trim() === '任务')?.click()`);
  await sleep(120);
  const stageTransferBefore = await evaluate(`(() => {
    const transfer = document.querySelector('.stage-transfer');
    const stageButtons = Array.from(transfer?.querySelectorAll('.stage-transfer-options button') ?? []);
    const archiveButton = transfer?.querySelector('.stage-archive-button');
    return {
      visible: Boolean(transfer),
      buttonCount: stageButtons.length,
      labels: stageButtons.map((button) => button.textContent.trim()),
      current: stageButtons.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent.trim() ?? '',
      archiveVisible: Boolean(archiveButton),
      archiveLabel: archiveButton?.textContent?.trim() ?? '',
      archiveAriaLabel: archiveButton?.getAttribute('aria-label') ?? '',
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.stage-transfer-options button')).find((button) => button.textContent.includes('执行'))?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => state.tasks.find((task) => task.id === ${JSON.stringify(reviewSeed.id)})?.lane === 'execution')`, '流转到执行');
  const movedToExecution = await evaluate(`window.codexTaskboard.bootstrap().then((state) => state.tasks.find((task) => task.id === ${JSON.stringify(reviewSeed.id)})?.lane === 'execution')`);
  await evaluate(`Array.from(document.querySelectorAll('.stage-transfer-options button')).find((button) => button.textContent.includes('验收和回顾'))?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => state.tasks.find((task) => task.id === ${JSON.stringify(reviewSeed.id)})?.lane === 'review')`, '流转到验收和回顾');
  await waitUntil(`Boolean(document.querySelector('.review-box'))`, '个人验收面板');
  const stageTransferAfter = await evaluate(`window.codexTaskboard.bootstrap().then(async (state) => ({
    movedToReview: state.tasks.find((task) => task.id === ${JSON.stringify(reviewSeed.id)})?.lane === 'review',
    reviewBoxVisible: Boolean(document.querySelector('.review-box')),
    active: Array.from(document.querySelectorAll('.stage-transfer-options button')).find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent.trim() ?? '',
    laneEvents: (await window.codexTaskboard.listAuditEvents(${JSON.stringify(reviewSeed.id)})).filter((event) => event.action === 'lane_changed').length,
    auditVisible: document.querySelector('.timeline')?.innerText.includes('lane_changed') ?? false,
  }))`);
  const stageTransferCheck = { before: stageTransferBefore, movedToExecution, after: stageTransferAfter };
  const userReviewCheck = await evaluate(`(() => {
    const box = document.querySelector('.review-box');
    const select = box?.querySelector('select');
    const options = Array.from(select?.options ?? []).map((option) => option.textContent.trim());
    return {
      visible: Boolean(box),
      options,
      hasIndependentHuman: box?.innerText.includes('独立人工验收') ?? false,
      hasRequiredReviewer: box?.innerText.includes('验收人') ?? false,
      optionalEvidence: box?.innerText.includes('证据与回顾（可选）') ?? false,
      acceptButton: Array.from(box?.querySelectorAll('button') ?? []).some((button) => button.textContent.includes('通过验收')),
    };
  })()`);
  await evaluate(`(() => {
    const select = document.querySelector('.review-box select');
    if (!select) throw new Error('个人验收面板未打开');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'ai');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  const aiReviewCheck = await evaluate(`({
    optionalFocus: document.querySelector('.review-box')?.innerText.includes('AI 关注点（可选）') ?? false,
    launchButton: Array.from(document.querySelectorAll('.review-box button')).some((button) => button.textContent.includes('发起 AI 验收')),
    reworkCopy: document.querySelector('.review-box')?.innerText.includes('不通过会自动退回执行') ?? false
  })`);
  await evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.includes('关联对话'))?.click()`);
  await waitUntil(`Boolean(document.querySelector('.thread-composer textarea'))`, '可输入的关联对话编辑器');
  await evaluate(`(() => {
    const textarea = document.querySelector('.thread-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '继续核对这项任务的最新进展');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(80);
  const directChatReadyCheck = await evaluate(`(() => {
    const composer = document.querySelector('.thread-composer');
    const textarea = composer?.querySelector('textarea');
    const send = composer?.querySelector('.send-button');
    const selects = composer?.querySelectorAll('select') ?? [];
    return {
      visible: Boolean(composer),
      textareaEnabled: textarea ? !textarea.disabled : false,
      value: textarea?.value ?? '',
      sendEnabled: send ? !send.disabled : false,
      sendLabel: send?.getAttribute('aria-label') ?? '',
      modelOptions: selects[0]?.options.length ?? 0,
      speedOptions: Array.from(selects[1]?.options ?? []).map((option) => option.textContent.trim()),
      effortOptions: selects[2]?.options.length ?? 0,
      permissionOptions: Array.from(selects[3]?.options ?? []).map((option) => option.textContent.trim()),
      shortcutHint: composer?.textContent.includes('⌘ Enter 发送') ?? false,
    };
  })()`);
  if (process.env.WORKBOARD_QA_THREAD_CAPTURE_PATH) {
    const screenshot = await new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, (message) => {
        if (message.result?.data) resolve(message.result.data);
        else reject(new Error('无法捕获关联对话直接续聊界面'));
      });
      socket.send(JSON.stringify({ id: requestId, method: 'Page.captureScreenshot', params: { format: 'png', fromSurface: true } }));
    });
    writeFileSync(process.env.WORKBOARD_QA_THREAD_CAPTURE_PATH, Buffer.from(screenshot, 'base64'));
  }
  await evaluate(`Array.from(document.querySelectorAll('.panel-tabs button')).find((button) => button.textContent.trim() === '任务')?.click()`);
  await evaluate(`(() => {
    const select = document.querySelector('.review-box select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'user');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
  await evaluate(`Array.from(document.querySelectorAll('.review-box .accept-button')).find((button) => button.textContent.includes('通过验收'))?.click()`);
  await waitUntil(`window.codexTaskboard.bootstrap().then((state) => state.tasks.some((task) => task.id === ${JSON.stringify(reviewSeed.id)} && task.substatus === 'accepted'))`, '用户验收状态持久化');
  await waitUntil(`Number(document.querySelector('.archive-completed-button')?.textContent?.match(/\\d+/)?.[0] ?? 0) > 0`, '已完成任务归档按钮刷新');
  await evaluate(`(() => {
    const select = document.querySelector('.project-select select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(reviewSeed.projectPath)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(250);
  const archiveBefore = await evaluate(`(() => {
    const button = document.querySelector('.archive-completed-button');
    const closedLoop = Array.from(document.querySelectorAll('.metric-card')).find((item) => item.textContent.includes('累计闭环'));
    return { text: button?.textContent ?? '', disabled: button?.disabled ?? true, closedLoop: Number(closedLoop?.querySelector('strong')?.textContent ?? -1), closedLoopDetail: closedLoop?.querySelector('small')?.textContent ?? '' };
  })()`);
  await evaluate(`document.querySelector('.archive-completed-button')?.click()`);
  await sleep(500);
  const archiveAfter = await evaluate(`({
    taskGone: !document.body.innerText.includes('UI 个人验收模式测试'),
    text: document.querySelector('.archive-completed-button')?.textContent ?? '',
    closedLoop: Number(Array.from(document.querySelectorAll('.metric-card')).find((item) => item.textContent.includes('累计闭环'))?.querySelector('strong')?.textContent ?? -1),
    closedLoopDetail: Array.from(document.querySelectorAll('.metric-card')).find((item) => item.textContent.includes('累计闭环'))?.querySelector('small')?.textContent ?? ''
  })`);
  const sidebarTarget = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.projects .project-row')).find((item) => !item.classList.contains('active'));
    const label = button?.querySelector('span:nth-child(2)')?.textContent?.trim() ?? null;
    button?.click();
    return label;
  })()`);
  await sleep(300);
  const result = await evaluate(`({
    before: ${JSON.stringify(before)},
    liveExecutionCheck: ${JSON.stringify(liveExecutionCheck)},
    directChatBusyCheck: ${JSON.stringify(directChatBusyCheck)},
    steerUiCheck: ${JSON.stringify(steerUiCheck)},
    notificationOpenCheck: ${JSON.stringify(notificationOpenCheck)},
    notificationEscapeCheck: ${JSON.stringify(notificationEscapeCheck)},
    notificationActionCheck: ${JSON.stringify(notificationActionCheck)},
    createConversationCheck: ${JSON.stringify(createConversationCheck)},
    createTaskOnlyCheck: ${JSON.stringify(createTaskOnlyCheck)},
    batchDefaultHidden: ${JSON.stringify(batchDefaultHidden)},
    batchSelectionCheck: ${JSON.stringify(batchSelectionCheck)},
    batchActionCheck: ${JSON.stringify(batchActionCheck)},
    after: ${JSON.stringify(creationCheck)}.after,
    createdVisible: ${JSON.stringify(creationCheck)}.createdVisible,
    detailPanelOpen: ${JSON.stringify(creationCheck)}.detailPanelOpen,
    connected: document.body.innerText.includes('Codex 已连接'),
    projectOptionCount: ${JSON.stringify(projectFilter)}.optionCount,
    selectedProject: ${JSON.stringify(projectFilter)}.target,
    sidebarTarget: ${JSON.stringify(sidebarTarget)},
    sidebarSelectionApplied: document.querySelector('.project-select select')?.value === ${JSON.stringify(sidebarTarget)},
    filteredCards: document.querySelectorAll('.task-card').length,
    timelineRows: document.querySelectorAll('.timeline-task-row').length,
    timelineVisible: Boolean(document.querySelector('.project-timeline')),
    openTimelineCheck: ${JSON.stringify(openTimelineCheck)},
    columnMenuOpenCheck: ${JSON.stringify(columnMenuOpenCheck)},
    columnConversationSortCheck: ${JSON.stringify(columnConversationSortCheck)},
    columnConversationSortSelected: ${JSON.stringify(columnConversationSortSelected)},
    workflowFilterCheck: ${JSON.stringify(workflowFilterCheck)},
    workflowFilterResetCheck: ${JSON.stringify(workflowFilterResetCheck)},
    columnSortCheck: ${JSON.stringify(columnSortCheck)},
    columnFilterCheck: ${JSON.stringify(columnFilterCheck)},
    columnMenuResetCheck: ${JSON.stringify(columnMenuResetCheck)},
    reviewFilterMenuCheck: ${JSON.stringify(reviewFilterMenuCheck)},
    reviewPendingFilterCheck: ${JSON.stringify(reviewPendingFilterCheck)},
    reviewCompletedFilterCheck: ${JSON.stringify(reviewCompletedFilterCheck)},
    contextMenuOpenCheck: ${JSON.stringify(contextMenuOpenCheck)},
    contextPriorityCheck: ${JSON.stringify(contextPriorityCheck)},
    contextArchiveCheck: ${JSON.stringify(contextArchiveCheck)},
    contextRestoreCheck: ${JSON.stringify(contextRestoreCheck)},
    timelineExpandCheck: ${JSON.stringify(timelineExpandCheck)},
    timelineCollapseCheck: ${JSON.stringify(timelineCollapseCheck)},
    stageTransferCheck: ${JSON.stringify(stageTransferCheck)},
    detailArchiveButtonCheck: ${JSON.stringify(detailArchiveButtonCheck)},
    detailArchiveResult: ${JSON.stringify(detailArchiveResult)},
    fullAccessUiCheck: ${JSON.stringify(fullAccessUiCheck)},
    userReviewCheck: ${JSON.stringify(userReviewCheck)},
    aiReviewCheck: ${JSON.stringify(aiReviewCheck)},
    directChatReadyCheck: ${JSON.stringify(directChatReadyCheck)},
    archiveBefore: ${JSON.stringify(archiveBefore)},
    archiveAfter: ${JSON.stringify(archiveAfter)}
  })`);
  socket.close();
  return result;
}

try {
  const result = await run();
  if (process.env.WORKBOARD_QA_EVIDENCE_PATH) writeFileSync(process.env.WORKBOARD_QA_EVIDENCE_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  const checks = [
    ['实时执行面板', result.liveExecutionCheck.panelVisible && result.liveExecutionCheck.tabs.join('|') === '任务|实时执行|关联对话' && result.liveExecutionCheck.activeTab.includes('实时执行')],
    ['当前回合引导与截图入口', result.steerUiCheck.taskOpened && result.steerUiCheck.textareaEnabled && result.steerUiCheck.placeholder.includes('粘贴截图') && result.steerUiCheck.steerMode.includes('引导当前回合') && result.steerUiCheck.steerHeight === 22 && result.steerUiCheck.steerFontSize === '9px' && result.steerUiCheck.steerWhiteSpace === 'nowrap' && result.steerUiCheck.attachmentVisible && result.steerUiCheck.attachmentEnabled && result.steerUiCheck.sendInitiallyDisabled && result.steerUiCheck.settingsDisabled && result.steerUiCheck.title.includes('引导当前回合')],
    ['通知中心', result.notificationOpenCheck.visible && result.notificationOpenCheck.expanded === 'true' && result.notificationOpenCheck.count >= 2 && result.notificationOpenCheck.itemCount >= 2 && result.notificationOpenCheck.approvalVisible && result.notificationOpenCheck.reviewVisible && result.notificationOpenCheck.refreshVisible && result.notificationOpenCheck.menuRole === 'menu' && result.notificationEscapeCheck.closed && result.notificationEscapeCheck.expanded === 'false' && result.notificationEscapeCheck.focused && result.notificationActionCheck.menuClosed && result.notificationActionCheck.detailVisible && result.notificationActionCheck.activeTab.includes('实时执行') && result.notificationActionCheck.approvalVisible && result.notificationActionCheck.approvalReason.includes('运行项目测试以验证改动')],
    ['新任务项目、会话与执行配置', result.createConversationCheck.labels.join('|').includes('新建会话') && result.createConversationCheck.labels.join('|').includes('关联已有') && result.createConversationCheck.labels.join('|').includes('仅创建任务') && result.createConversationCheck.defaultNew === 'true' && result.createConversationCheck.projectOptions >= 2 && result.createConversationCheck.modelOptions >= 2 && result.createConversationCheck.effortOptions.length >= 4 && result.createConversationCheck.speedOptions.includes('标准') && result.createConversationCheck.speedOptions.includes('Fast') && result.createConversationCheck.permissionOptions.join('|') === '未信任操作询问|Codex 按需申请|完全访问权限' && result.createTaskOnlyCheck.selected === 'true' && result.createTaskOnlyCheck.runtimeHidden],
    ['关联对话直接续聊', result.directChatBusyCheck.visible && result.directChatBusyCheck.textareaDisabled && result.directChatBusyCheck.selectCount === 4 && result.directChatBusyCheck.liveReplyVisible && result.directChatBusyCheck.liveReplyText.includes('等待审批') && result.directChatBusyCheck.handoffToCodex && result.directChatReadyCheck.visible && result.directChatReadyCheck.textareaEnabled && result.directChatReadyCheck.value.includes('继续核对') && result.directChatReadyCheck.sendEnabled && result.directChatReadyCheck.sendLabel === '发送消息' && result.directChatReadyCheck.modelOptions >= 2 && result.directChatReadyCheck.speedOptions.includes('标准') && result.directChatReadyCheck.speedOptions.includes('Fast') && result.directChatReadyCheck.effortOptions >= 4 && result.directChatReadyCheck.permissionOptions.join('|') === '未信任操作询问|Codex 按需申请|完全访问权限' && result.directChatReadyCheck.shortcutHint],
    ['模型、速度与权限', result.liveExecutionCheck.modelOptions >= 2 && Boolean(result.liveExecutionCheck.modelValue) && result.liveExecutionCheck.speedOptions.includes('标准') && result.liveExecutionCheck.speedOptions.includes('Fast') && result.liveExecutionCheck.effortOptions >= 4 && Boolean(result.liveExecutionCheck.effortValue) && result.liveExecutionCheck.permissionOptions.join('|') === '未信任操作询问|Codex 按需申请|完全访问权限'],
    ['完全访问警告', result.fullAccessUiCheck.selected === 'full-access' && result.fullAccessUiCheck.warning && result.fullAccessUiCheck.text.includes('关闭审批和沙盒限制')],
    ['审批与执行证据', result.liveExecutionCheck.approvalCard && result.liveExecutionCheck.approvalButtons.join('|') === '拒绝|本次会话允许|批准一次' && result.liveExecutionCheck.planItems === 3 && result.liveExecutionCheck.terminalText.includes('npm test') && result.liveExecutionCheck.diffText.includes('示例变更') && result.liveExecutionCheck.statusText.includes('等待审批') && result.liveExecutionCheck.cardStatus.includes('等待审批') && result.liveExecutionCheck.composerDisabled],
    ['创建与连接', result.createdVisible && result.detailPanelOpen && result.connected],
    ['按需显示的批量迁移与验收', result.batchDefaultHidden && result.batchSelectionCheck.visible && result.batchSelectionCheck.selected === 2 && result.batchSelectionCheck.selectedStyle === 2 && result.batchSelectionCheck.text.includes('已选择 2 项') && result.batchActionCheck.moved && result.batchActionCheck.accepted && result.batchActionCheck.audited && result.batchActionCheck.acceptEnabled],
    ['工作流侧栏筛选', result.workflowFilterCheck.selected === 'true' && result.workflowFilterCheck.activeClass && result.workflowFilterCheck.visibleColumns === 1 && result.workflowFilterCheck.executionColumn && result.workflowFilterCheck.boardLabel.includes('执行') && result.workflowFilterResetCheck.selected === 'false' && result.workflowFilterResetCheck.visibleColumns === 3],
    ['项目与时序', result.timelineVisible && result.projectOptionCount >= 2 && result.selectedProject && result.sidebarTarget && result.sidebarSelectionApplied && result.filteredCards >= 1 && result.timelineRows === result.filteredCards && result.openTimelineCheck.found && result.openTimelineCheck.open && result.openTimelineCheck.label.includes('持续中')],
    ['列菜单', result.columnMenuOpenCheck.visible && result.columnMenuOpenCheck.expanded === 'true' && result.columnMenuOpenCheck.radioCount === 4 && result.columnMenuOpenCheck.checkboxCount === 1 && result.columnMenuOpenCheck.text.includes('最新对话优先') && result.columnMenuOpenCheck.text.includes('仅看高优先级') && result.columnConversationSortSelected === 'true' && result.columnConversationSortCheck.menuClosed && result.columnConversationSortCheck.first === result.columnConversationSortCheck.expected && result.columnSortCheck.selected === 'true' && result.columnSortCheck.resetVisible && result.columnFilterCheck.cardsAfter <= result.columnFilterCheck.cardsBefore && result.columnFilterCheck.menuClosed && result.columnMenuResetCheck.cardsRestored && result.columnMenuResetCheck.menuClosed && result.columnMenuResetCheck.triggerCollapsed],
    ['验收结果筛选', result.reviewFilterMenuCheck.visible && result.reviewFilterMenuCheck.radioCount === 7 && result.reviewFilterMenuCheck.text.includes('全部验收任务') && result.reviewFilterMenuCheck.text.includes('待验收') && result.reviewFilterMenuCheck.text.includes('已验收与已回顾') && result.reviewPendingFilterCheck.menuClosed && result.reviewPendingFilterCheck.onlyPending && result.reviewCompletedFilterCheck.menuClosed && result.reviewCompletedFilterCheck.onlyCompleted],
    ['卡片右键菜单', result.contextMenuOpenCheck.visible && result.contextMenuOpenCheck.radioCount === 6 && result.contextMenuOpenCheck.openThreadDisabled && result.contextMenuOpenCheck.position === 'fixed' && result.contextMenuOpenCheck.text.includes('归档任务') && result.contextPriorityCheck.priority === 'high' && result.contextPriorityCheck.menuClosed && result.contextArchiveCheck.removed && result.contextArchiveCheck.undoVisible && result.contextArchiveCheck.actions.includes('archived') && result.contextRestoreCheck.restored && result.contextRestoreCheck.actions.includes('restored')],
    ['时序展开', result.timelineExpandCheck.buttonFound && result.timelineExpandCheck.expanded && result.timelineExpandCheck.ariaExpanded === 'true' && result.timelineExpandCheck.buttonText.includes('收起') && result.timelineExpandCheck.position === 'fixed' && result.timelineExpandCheck.rowCount >= 1 && result.timelineCollapseCheck.collapsed && result.timelineCollapseCheck.ariaExpanded === 'false' && result.timelineCollapseCheck.buttonText.includes('展开')],
    ['阶段迁移', result.stageTransferCheck.before.visible && result.stageTransferCheck.before.buttonCount === 3 && result.stageTransferCheck.before.labels.join('|').includes('计划中') && result.stageTransferCheck.before.archiveVisible && result.stageTransferCheck.before.archiveLabel.includes('归档任务') && result.stageTransferCheck.before.archiveAriaLabel.includes('可从已归档恢复') && result.stageTransferCheck.movedToExecution && result.stageTransferCheck.after.movedToReview && result.stageTransferCheck.after.reviewBoxVisible && result.stageTransferCheck.after.active.includes('验收和回顾') && result.stageTransferCheck.after.laneEvents >= 2 && result.stageTransferCheck.after.auditVisible],
    ['详情归档按钮', result.detailArchiveButtonCheck.opened && result.detailArchiveButtonCheck.visible && result.detailArchiveButtonCheck.text.includes('可恢复') && result.detailArchiveButtonCheck.ariaLabel.includes('归档任务') && result.detailArchiveResult.removed && result.detailArchiveResult.panelClosed && result.detailArchiveResult.undoVisible && result.detailArchiveResult.archived],
    ['个人与 AI 验收', result.userReviewCheck.visible && result.userReviewCheck.options.join('|') === '用户验收|AI 验收' && !result.userReviewCheck.hasIndependentHuman && !result.userReviewCheck.hasRequiredReviewer && result.userReviewCheck.optionalEvidence && result.userReviewCheck.acceptButton && result.aiReviewCheck.optionalFocus && result.aiReviewCheck.launchButton && result.aiReviewCheck.reworkCopy],
    ['完成归档与闭环累计', result.archiveBefore.text.includes('归档已完成 1') && !result.archiveBefore.disabled && result.archiveAfter.taskGone && result.archiveBefore.closedLoop === result.archiveAfter.closedLoop && result.archiveAfter.closedLoopDetail.includes('已归档')],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([label]) => label);
  if (failed.length) {
    console.error(`UI QA 未通过：${failed.join('、')}`);
    process.exitCode = 1;
  }
} finally {
  child.kill('SIGTERM');
  await sleep(250);
  rmSync(userData, { recursive: true, force: true });
}
