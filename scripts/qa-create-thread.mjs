import { CodexBridge } from '../dist-electron/codexBridge.js';

let bridge = new CodexBridge();
let threadId = '';
let evidence = null;
let targetTurnId = '';
let completeTurn;
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('首条任务消息未在时限内完成')), 120_000);
  completeTurn = (turn) => {
    clearTimeout(timer);
    resolve(turn);
  };
});
bridge.onEvent((event) => {
  const turn = event.params?.turn;
  if (event.method === 'turn/completed' && turn && typeof turn === 'object' && turn.id === targetTurnId) completeTurn(turn);
});

try {
  const models = await bridge.listModels();
  const model = models.find((item) => item.isDefault) ?? models[0];
  if (!model) throw new Error('App Server 未返回可用模型');
  const fastTier = model.serviceTiers.find((tier) => tier.id === 'priority') ?? model.serviceTiers[0] ?? null;
  const title = `Workboard 自动会话验证 ${new Date().toISOString()}`;
  threadId = await bridge.createThread({
    title,
    model: model.id,
    serviceTier: fastTier?.id ?? null,
  });
  const thread = await bridge.readThread(threadId);
  const actualTitle = typeof thread.name === 'string' ? thread.name : '';
  if (actualTitle !== title.slice(0, 80)) throw new Error(`新会话命名不一致：${actualTitle || '空'}`);
  bridge.stop();
  await new Promise((resolve) => setTimeout(resolve, 250));
  bridge = new CodexBridge();
  bridge.onEvent((event) => {
    const turn = event.params?.turn;
    if (event.method === 'turn/completed' && turn && typeof turn === 'object' && turn.id === targetTurnId) completeTurn(turn);
  });
  const response = await bridge.sendToThread({
    threadId,
    text: '这是 Workboard 新任务会话发起验证。请只回复“已发起”，不要执行其他操作。',
    model: model.id,
    effort: model.defaultReasoningEffort,
    serviceTier: fastTier?.id ?? null,
    permissionPreset: 'untrusted',
  });
  targetTurnId = response && typeof response === 'object' && response.turn && typeof response.turn.id === 'string' ? response.turn.id : '';
  if (!targetTurnId) throw new Error('首条任务消息未返回 turn ID');
  await completed;
  const startedThread = await bridge.readThread(threadId);
  if (!Array.isArray(startedThread.turns) || startedThread.turns.length < 1) throw new Error('新会话中没有首条任务回合');
  evidence = { threadId, turnId: targetTurnId, model: model.id, effort: model.defaultReasoningEffort, serviceTier: fastTier?.id ?? null, named: true, resumedAfterRestart: true, firstTurnStarted: true };
} finally {
  if (threadId) await bridge.deleteThread(threadId);
  bridge.stop();
}

console.log(JSON.stringify({ ok: true, ...evidence, deleted: true }));
