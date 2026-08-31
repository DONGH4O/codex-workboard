import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CodexBridge } from '../dist-electron/codexBridge.js';
import { emptyExecutionSnapshot, eventThreadId, eventTurnId, reduceExecutionSnapshot } from '../dist-electron/executionTracker.js';

const root = path.resolve(import.meta.dirname, '..');
const bridge = new CodexBridge();
let expectedThreadId = '';
const imageQaDir = mkdtempSync(path.join(tmpdir(), 'workboard-image-qa-'));
const imageQaPath = path.join(imageQaDir, 'one-pixel.png');
writeFileSync(imageQaPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

try {
  const models = await bridge.listModels();
  const selected = models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new Error('App Server 未返回可用模型');
  const effort = selected.supportedReasoningEfforts.some((item) => item.reasoningEffort === 'low')
    ? 'low'
    : selected.defaultReasoningEffort;

  expectedThreadId = await bridge.createThread({
    title: `Workboard live QA ${new Date().toISOString()}`,
    cwd: root,
    model: selected.id,
  });
  if (!expectedThreadId) throw new Error('无法创建隔离的实时执行测试对话');

  async function runTurn(reply, permissionPreset, images = []) {
    const methods = [];
    let snapshot = emptyExecutionSnapshot({ taskId: `qa-${permissionPreset}`, threadId: expectedThreadId, model: selected.id, effort, permissionPreset });
    let unsubscribe = () => {};
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${permissionPreset} 实时执行测试等待超时`)), 120_000);
      unsubscribe = bridge.onEvent((event) => {
        if (eventThreadId(event) !== expectedThreadId) return;
        methods.push(event.method);
        snapshot = reduceExecutionSnapshot(snapshot, event);
        if (event.method === 'turn/completed') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const turnStart = await bridge.sendToThread({
      threadId: expectedThreadId,
      text: `Do not use tools. Reply with exactly ${reply} and nothing else.`,
      model: selected.id,
      effort,
      permissionPreset,
      cwd: root,
      images,
    });
    const turnId = turnStart?.turn?.id ?? '';
    if (!turnId) throw new Error(`${permissionPreset} 测试未返回回合 ID`);
    await completed;
    unsubscribe();
    return {
      ok: snapshot.status === 'completed' && snapshot.lastMessage.includes(reply),
      turnId,
      status: snapshot.status,
      message: snapshot.lastMessage,
      permissionPreset: snapshot.permissionPreset,
      methods: [...new Set(methods)],
    };
  }

  async function runSteeredTurn() {
    const turnStartPromise = bridge.sendToThread({
      threadId: expectedThreadId,
      text: 'Use the shell to run exactly `sleep 5`, then reply with ORIGINAL_DIRECTION. Do not reply before the command finishes.',
      model: selected.id,
      effort,
      permissionPreset: 'full-access',
      cwd: root,
    });
    let activeTurn = null;
    for (let attempt = 0; attempt < 80 && !activeTurn; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const thread = await bridge.readThread(expectedThreadId);
      activeTurn = Array.isArray(thread?.turns) ? thread.turns.findLast((turn) => turn?.status === 'inProgress') ?? null : null;
    }
    if (!activeTurn?.id) {
      await turnStartPromise;
      throw new Error('未能从 thread/read 识别正在执行的回合');
    }
    const turnId = activeTurn.id;
    const steer = await bridge.steerTurn({
      threadId: expectedThreadId,
      turnId,
      text: 'Change direction now. After any active command ends, reply with exactly STEER_FLOW_OK and nothing else.',
    });
    await turnStartPromise;
    let completedTurn = null;
    for (let attempt = 0; attempt < 120 && completedTurn?.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const completedThread = await bridge.readThread(expectedThreadId);
      completedTurn = Array.isArray(completedThread?.turns) ? completedThread.turns.find((turn) => turn?.id === turnId) ?? null : null;
    }
    const serialized = JSON.stringify(completedTurn ?? {});
    return {
      ok: steer.turnId === turnId && completedTurn?.status === 'completed' && serialized.includes('STEER_FLOW_OK'),
      turnId,
      steerTurnId: steer.turnId,
      status: completedTurn?.status ?? 'missing',
      receivedGuidance: serialized.includes('STEER_FLOW_OK'),
      methods: ['thread/read', 'turn/steer'],
    };
  }

  const standard = await runTurn('LIVE_FLOW_OK', 'on-request');
  const steered = await runSteeredTurn();
  const imageInput = await runTurn('IMAGE_FLOW_OK', 'on-request', [{ path: imageQaPath, detail: 'original' }]);
  const fullAccess = await runTurn('FULL_ACCESS_FLOW_OK', 'full-access');
  const restored = await runTurn('RESTORED_SANDBOX_OK', 'on-request');

  const result = {
    ok: standard.ok && steered.ok && imageInput.ok && fullAccess.ok && restored.ok,
    model: selected.id,
    effort,
    threadId: expectedThreadId,
    standard,
    steered,
    imageInput,
    fullAccess,
    restored,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || !steered.methods.includes('turn/steer')) process.exitCode = 1;
} finally {
  if (expectedThreadId) await bridge.deleteThread(expectedThreadId).catch(() => undefined);
  bridge.stop();
  rmSync(imageQaDir, { recursive: true, force: true });
}
