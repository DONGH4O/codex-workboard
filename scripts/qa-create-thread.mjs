import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindW3TurnStart,
  buildW3Evidence,
  isW3BoundTurnEvent,
  summarizeW3TurnParams,
  validateW3ExecutionGate,
  w3ExecutionSummary,
} from './w3-qa-safety.mjs';

const SCRIPT_NAME = 'qa-create-thread';

function defaultOutput(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function completionPromise(events, bindingRef, timeoutMs) {
  let resolveCompletion;
  let rejectCompletion;
  const promise = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const timer = setTimeout(() => rejectCompletion(new Error('W3 basic-create 回合等待超时')), timeoutMs);
  const accept = (event) => {
    const binding = bindingRef.current;
    if (!binding || event.method !== 'turn/completed' || !isW3BoundTurnEvent(event, binding)) return false;
    clearTimeout(timer);
    const status = event.params?.turn?.status;
    if (status === 'completed') resolveCompletion(event);
    else rejectCompletion(new Error(`W3 basic-create 目标回合状态不是 completed`));
    return true;
  };
  for (const event of events) {
    if (accept(event)) break;
  }
  return { promise, accept, cancel: () => clearTimeout(timer) };
}

export async function main(dependencies = {}) {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const env = dependencies.env ?? process.env;
  const output = dependencies.output ?? defaultOutput;
  let config;
  try {
    config = validateW3ExecutionGate({ argv, env, prerequisites: {} }, dependencies.safetyRuntime);
    if (config.scenario !== 'basic-create') throw new Error('qa-create-thread 只实现 basic-create 场景');
  } catch (error) {
    output({ ...w3ExecutionSummary({ argv, env }), result: 'REFUSED', script: SCRIPT_NAME, errorKind: error instanceof Error ? error.name : 'Error' });
    throw error;
  }

  const runtimeModule = !dependencies.createBridge || !dependencies.buildTurnStartParams
    ? await import('../dist-electron/codexBridge.js')
    : null;
  const permissionPreset = 'untrusted';
  const previewParams = (dependencies.buildTurnStartParams ?? runtimeModule.buildTurnStartParams)({
    threadId: 'pending-w3-qa-thread',
    text: 'W3 basic-create permission preview',
    cwd: config.workspace,
    permissionPreset,
  });
  const permission = summarizeW3TurnParams(previewParams, config.workspace);
  output({ result: 'READY_FOR_REAL_EXECUTION', script: SCRIPT_NAME, scenario: config.scenario, permission, realInteractionStarted: false });

  const createBridge = dependencies.createBridge ?? (() => new runtimeModule.CodexBridge());
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  const now = dependencies.now ?? (() => new Date());
  const eventMethods = [];
  const queuedEvents = [];
  const bindingRef = { current: null };
  let bridge;
  let unsubscribe = () => {};
  let completion;
  let createdQaThread = false;
  let resumedAfterRestart = false;
  let modelConfigured = false;
  let effortConfigured = false;
  let serviceTierConfigured = false;
  let stage = 'connected';
  let threadId = '';
  let title = '';
  let primaryError;
  let cleanupError;
  const stopAttempts = new Set();
  const stopBridgeOnce = async (target) => {
    if (!target || stopAttempts.has(target)) return !cleanupError;
    stopAttempts.add(target);
    try {
      await target.stop();
      return true;
    } catch (error) {
      cleanupError ??= error;
      return false;
    }
  };

  try {
    bridge = createBridge();
    const models = await bridge.listModels();
    const model = models.find((item) => item.isDefault) ?? models[0];
    if (!model) throw new Error('App Server 未返回可用模型');
    const serviceTier = model.serviceTiers?.find((tier) => tier.id === 'priority') ?? model.serviceTiers?.[0] ?? null;
    modelConfigured = true;
    effortConfigured = Boolean(model.defaultReasoningEffort);
    serviceTierConfigured = Boolean(serviceTier?.id);

    title = `Windows Workboard 验收 ${now().toISOString()}`;
    threadId = await bridge.createThread({
      title,
      cwd: config.workspace,
      model: model.id,
      serviceTier: serviceTier?.id ?? null,
    });
    createdQaThread = true;
    stage = 'thread-created';

    unsubscribe = bridge.onEvent((event) => {
      queuedEvents.push(event);
      if (bindingRef.current && isW3BoundTurnEvent(event, bindingRef.current)) eventMethods.push(event.method);
      completion?.accept(event);
    });
    const response = await bridge.sendToThread({
      threadId,
      text: '这是 Windows Workboard 验收会话。不要使用工具，只回复“已发起”。',
      model: model.id,
      effort: model.defaultReasoningEffort,
      serviceTier: serviceTier?.id ?? null,
      permissionPreset,
      cwd: config.workspace,
    });
    bindingRef.current = bindW3TurnStart(threadId, response);
    stage = 'turn-started';
    for (const event of queuedEvents) {
      if (isW3BoundTurnEvent(event, bindingRef.current)) eventMethods.push(event.method);
    }
    completion = completionPromise(queuedEvents, bindingRef, timeoutMs);
    await completion.promise;
    stage = 'completed';

    const firstBridge = bridge;
    bridge = undefined;
    if (await stopBridgeOnce(firstBridge)) {
      bridge = createBridge();
      const restored = await bridge.readThread(threadId);
      resumedAfterRestart = Array.isArray(restored?.turns)
        && restored.turns.some((turn) => turn?.id === bindingRef.current.turnId);
      if (!resumedAfterRestart) throw new Error('重启桥接后未读回目标回合');
    }
  } catch (error) {
    primaryError = error;
    stage = 'failed';
  } finally {
    completion?.cancel();
    unsubscribe();
    const finalBridge = bridge;
    bridge = undefined;
    await stopBridgeOnce(finalBridge);
  }

  const failed = Boolean(primaryError || cleanupError);
  if (failed) stage = 'failed';
  const evidence = buildW3Evidence({
    ok: !failed,
    script: SCRIPT_NAME,
    scenario: config.scenario,
    stage,
    eventMethods,
    permission,
    modelConfigured,
    effortConfigured,
    serviceTierConfigured,
    createdQaThread,
    resumedAfterRestart,
    cleanupFailed: Boolean(cleanupError),
    error: primaryError ?? cleanupError,
  });
  output(evidence);
  if (createdQaThread) {
    const outcome = failed ? '执行未通过，但 QA 会话已保留' : 'QA 会话已保留';
    (dependencies.terminal ?? console.error)(`W3 ${outcome}，请按名称“${title}”检查；精确会话标识：${threadId}`);
  }
  if (failed) throw primaryError ?? cleanupError;
  return evidence;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => { process.exitCode = 1; });
}
