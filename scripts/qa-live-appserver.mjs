import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindW3ServerRequest,
  bindW3TurnStart,
  buildW3Evidence,
  dispatchW3Scenario,
  isW3BoundTurnEvent,
  summarizeW3TurnParams,
  validateW3ExecutionGate,
  w3ExecutionSummary,
} from './w3-qa-safety.mjs';

const SCRIPT_NAME = 'qa-live-appserver';
const READ_ONLY_SCENARIOS = new Set(['list-sync', 'read-existing']);
const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
];

function defaultOutput(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function prerequisitesForScenario(scenario, env) {
  if (scenario === 'read-existing') return { existingThreadId: env.WORKBOARD_W3_EXISTING_THREAD_ID };
  if (scenario === 'basic-create' || scenario === 'list-sync') return {};
  return { threadId: env.WORKBOARD_W3_QA_THREAD_ID };
}

export function createW3EventQueue(bridge, timeoutMs = 120_000) {
  const events = [];
  const waiters = new Set();
  let closed = false;
  const settle = (waiter, event) => {
    let matched = false;
    try {
      matched = waiter.predicate(event);
    } catch (error) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(error);
      return;
    }
    if (!matched) return;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(event);
  };
  const unsubscribe = bridge.onEvent((event) => {
    events.push(event);
    for (const waiter of [...waiters]) settle(waiter, event);
  });
  return {
    events,
    waitFor(predicate, label, waitMs = timeoutMs) {
      if (closed) return Promise.reject(new Error('W3 事件队列已关闭'));
      for (const event of events) {
        if (predicate(event)) return Promise.resolve(event);
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`W3 等待超时：${label}`));
        }, waitMs);
        waiters.add(waiter);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('W3 事件队列已关闭'));
      }
      waiters.clear();
    },
  };
}

function turnStatus(event) {
  return event?.params?.turn?.status;
}

async function waitForTurnEnd(queue, binding, allowedStatuses) {
  const event = await queue.waitFor(
    (candidate) => candidate.method === 'turn/completed' && isW3BoundTurnEvent(candidate, binding),
    '目标回合结束',
  );
  const status = turnStatus(event);
  if (!allowedStatuses.includes(status)) throw new Error(`W3 目标回合状态不符合场景要求`);
  return status;
}

export function createLiveScenarioHandlers(context) {
  const { bridge, queue, threadId, model, permissionPreset, workspace } = context;
  const start = async (text) => {
    const response = await bridge.sendToThread({
      threadId,
      text,
      model: model.id,
      effort: model.defaultReasoningEffort,
      serviceTier: context.serviceTier,
      permissionPreset,
      cwd: workspace,
    });
    return bindW3TurnStart(threadId, response);
  };
  const waitForRequest = async (binding, methods) => {
    const event = await queue.waitFor(
      (candidate) => methods.includes(candidate.method) && isW3BoundTurnEvent(candidate, binding),
      '目标服务端请求',
    );
    return bindW3ServerRequest(event, binding, methods);
  };

  const approval = (decision) => async () => {
    const binding = await start('请使用当前平台的命令工具运行 Node.js 单行命令，只输出固定文本 W3_APPROVAL_CHECK；不要修改文件。');
    const request = await waitForRequest(binding, APPROVAL_METHODS);
    bridge.respondToApproval(request.requestId, decision);
    await waitForTurnEnd(queue, binding, ['completed']);
    return { binding };
  };

  const userInput = (action) => async () => {
    const binding = await start('请调用 request_user_input，只询问一个无敏感信息的单选问题，然后等待答复。');
    const request = await waitForRequest(binding, ['item/tool/requestUserInput']);
    if (action === 'answer') {
      const event = queue.events.find((candidate) => candidate.requestId === request.requestId);
      const question = Array.isArray(event?.params?.questions) ? event.params.questions[0] : null;
      const questionId = question && typeof question.id === 'string' ? question.id : '';
      if (!questionId) throw new Error('W3 用户输入请求缺少问题标识');
      bridge.respondToUserInput(request.requestId, { [questionId]: { answers: ['W3 QA'] } });
    } else if (action === 'cancel') {
      bridge.cancelUserInput(request.requestId);
    } else {
      const requestEvent = queue.events.find((candidate) => candidate.requestId === request.requestId);
      const advertisedTimeout = requestEvent?.params?.autoResolutionMs;
      const effectiveTimeout = typeof advertisedTimeout === 'number' && advertisedTimeout > 0
        ? advertisedTimeout
        : context.fallbackUserInputTimeoutMs;
      await queue.waitFor(
        (candidate) => candidate.method === 'workboard/serverRequestClosed'
          && candidate.requestId === request.requestId
          && candidate.params?.reason === 'timeout',
        '用户输入自动超时收敛',
        effectiveTimeout + context.timeoutMarginMs,
      );
    }
    await waitForTurnEnd(queue, binding, ['completed', 'interrupted']);
    return { binding };
  };

  return {
    'list-sync': async () => {
      const threads = await bridge.listThreads();
      if (!Array.isArray(threads)) throw new Error('会话同步未返回列表');
      if (threads.some((thread) => typeof thread?.archived !== 'boolean')) {
        throw new Error('会话同步结果缺少当前或归档来源标记');
      }
      return { listSyncCompleted: true };
    },
    'read-existing': async () => {
      const thread = await bridge.readThread(threadId);
      if (thread?.id !== threadId) throw new Error('只读会话返回了不同标识');
      return {};
    },
    steer: async () => {
      const binding = await start('不要使用工具。请先准备一份较长的编号说明，在完成前等待后续引导。');
      const steered = await bridge.steerTurn({ threadId, turnId: binding.turnId, text: '改变方向，只回复 STEER_FLOW_OK。' });
      if (steered?.turnId !== binding.turnId) throw new Error('引导没有绑定目标回合');
      await waitForTurnEnd(queue, binding, ['completed']);
      return { binding };
    },
    interrupt: async () => {
      const binding = await start('不要使用工具。请生成一份足够长的编号说明，以便验证中断。');
      await bridge.interruptTurn(threadId, binding.turnId);
      await waitForTurnEnd(queue, binding, ['interrupted']);
      return { binding };
    },
    'approval-decline': approval('decline'),
    'approval-once': approval('accept'),
    'approval-session': approval('acceptForSession'),
    'user-input-answer': userInput('answer'),
    'user-input-cancel': userInput('cancel'),
    'user-input-timeout': userInput('timeout'),
  };
}

export async function main(dependencies = {}) {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const env = dependencies.env ?? process.env;
  const output = dependencies.output ?? defaultOutput;
  const requestedScenario = (() => {
    const argument = argv.find((item) => item.startsWith('--scenario='));
    if (argument) return argument.slice('--scenario='.length);
    const index = argv.indexOf('--scenario');
    return index >= 0 ? argv[index + 1] : '';
  })();
  let config;
  try {
    config = validateW3ExecutionGate({
      argv,
      env,
      prerequisites: prerequisitesForScenario(requestedScenario, env),
    }, dependencies.safetyRuntime);
    if (config.scenario === 'basic-create') throw new Error('basic-create 只能使用 qa-create-thread');
  } catch (error) {
    output({ ...w3ExecutionSummary({ argv, env }), result: 'REFUSED', script: SCRIPT_NAME, errorKind: error instanceof Error ? error.name : 'Error' });
    throw error;
  }

  const threadId = config.scenario === 'list-sync'
    ? null
    : config.scenario === 'read-existing'
      ? env.WORKBOARD_W3_EXISTING_THREAD_ID
      : env.WORKBOARD_W3_QA_THREAD_ID;
  const needsRuntimeModule = config.scenario !== 'unknown-request'
    && (!dependencies.createBridge || !dependencies.buildTurnStartParams);
  const runtimeModule = needsRuntimeModule ? await import('../dist-electron/codexBridge.js') : null;
  const permissionPreset = 'untrusted';
  let permission = null;
  if (!READ_ONLY_SCENARIOS.has(config.scenario) && config.scenario !== 'unknown-request') {
    const preview = (dependencies.buildTurnStartParams ?? runtimeModule.buildTurnStartParams)({
      threadId,
      text: 'W3 live scenario permission preview',
      cwd: config.workspace,
      permissionPreset,
    });
    permission = summarizeW3TurnParams(preview, config.workspace);
  }
  output({ result: 'READY_FOR_REAL_EXECUTION', script: SCRIPT_NAME, scenario: config.scenario, permission, realInteractionStarted: false });

  if (config.scenario === 'unknown-request') {
    const error = new Error('unknown-request 由固定 CodexBridge 隔离契约测试执行，不是可独立运行的真实场景');
    output(buildW3Evidence({ ok: false, script: SCRIPT_NAME, scenario: config.scenario, stage: 'failed', error }));
    throw error;
  }

  const fallbackUserInputTimeoutMs = dependencies.fallbackUserInputTimeoutMs ?? 5_000;
  const timeoutMarginMs = dependencies.timeoutMarginMs ?? 5_000;
  const createBridge = dependencies.createBridge ?? (() => new runtimeModule.CodexBridge({
    ...(config.scenario === 'user-input-timeout' ? { serverRequestTimeoutMs: fallbackUserInputTimeoutMs } : {}),
  }));
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  let bridge;
  let queue;
  let primaryError;
  let cleanupError;
  let completed = false;
  let modelConfigured = false;
  let effortConfigured = false;
  let serviceTierConfigured = false;
  let listSyncCompleted = false;
  const stopAttempts = new Set();
  const stopBridgeOnce = async (target) => {
    if (!target || stopAttempts.has(target)) return;
    stopAttempts.add(target);
    try { await target.stop(); } catch (error) { cleanupError ??= error; }
  };

  try {
    bridge = createBridge();
    queue = createW3EventQueue(bridge, timeoutMs);
    let model = { id: '', defaultReasoningEffort: '', serviceTiers: [] };
    let serviceTier = null;
    if (!READ_ONLY_SCENARIOS.has(config.scenario)) {
      const models = await bridge.listModels();
      model = models.find((item) => item.isDefault) ?? models[0];
      if (!model) throw new Error('App Server 未返回可用模型');
      serviceTier = model.serviceTiers?.find((tier) => tier.id === 'priority')?.id ?? model.serviceTiers?.[0]?.id ?? null;
      modelConfigured = true;
      effortConfigured = Boolean(model.defaultReasoningEffort);
      serviceTierConfigured = Boolean(serviceTier);
    }
    const handlers = dependencies.scenarioHandlers ?? createLiveScenarioHandlers({
      bridge, queue, threadId, model, serviceTier, permissionPreset, workspace: config.workspace,
      fallbackUserInputTimeoutMs, timeoutMarginMs,
    });
    const scenarioResult = await dispatchW3Scenario(config.scenario, handlers);
    listSyncCompleted = scenarioResult?.listSyncCompleted === true;
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    queue?.close();
    const target = bridge;
    bridge = undefined;
    await stopBridgeOnce(target);
  }

  const failed = !completed || Boolean(primaryError || cleanupError);
  const evidence = buildW3Evidence({
    ok: !failed,
    script: SCRIPT_NAME,
    scenario: config.scenario,
    stage: failed ? 'failed' : 'completed',
    eventMethods: queue?.events.map((event) => event.method),
    permission,
    modelConfigured,
    effortConfigured,
    serviceTierConfigured,
    listSyncCompleted,
    cleanupFailed: Boolean(cleanupError),
    error: primaryError ?? cleanupError,
  });
  output(evidence);
  const terminalMessage = config.scenario === 'list-sync'
    ? 'W3 场景 list-sync 已结束；只读取当前与归档会话目录，没有修改任何会话。'
    : `W3 场景 ${config.scenario} 已结束；会话保持不变，精确会话标识：${threadId}`;
  (dependencies.terminal ?? console.error)(terminalMessage);
  if (failed) throw primaryError ?? cleanupError ?? new Error('W3 场景未完成');
  return evidence;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => { process.exitCode = 1; });
}
