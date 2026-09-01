import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CodexBridge } from './codexBridge.js';
import { SUPPORTED_CODEX_VERSION } from './codexDriver.js';

type RpcMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

class FakeAppServer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: RpcMessage[] = [];
  killed = false;

  constructor(private readonly respond: (message: RpcMessage) => unknown | undefined, private readonly exitDelayMs: number | null = 0) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line) as RpcMessage;
        this.messages.push(message);
        if (message.id === undefined) continue;
        const result = this.respond(message);
        if (result !== undefined) this.send({ id: message.id, result });
      }
    });
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(): boolean {
    this.killed = true;
    if (this.exitDelayMs === 0) queueMicrotask(() => this.emit('exit', 0, null));
    else if (this.exitDelayMs !== null) setTimeout(() => this.emit('exit', 0, null), this.exitDelayMs);
    return true;
  }
}

function standardResponse(message: RpcMessage): unknown {
  if (message.method === 'initialize') return { userAgent: 'test', codexHome: 'C:\\Users\\tester\\.codex', platformFamily: 'windows', platformOs: 'windows' };
  if (message.method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
  if (message.method === 'model/list') return { data: [], nextCursor: null };
  if (message.method === 'windowsSandbox/readiness') return { status: 'notConfigured' };
  return {};
}

function runtime(serverFactory: (env: NodeJS.ProcessEnv) => FakeAppServer, overrides: Record<string, unknown> = {}) {
  return {
    resolveDriver: () => ({ executablePath: 'C:\\Codex\\codex.exe', source: 'desktopApp' as const, codexHome: 'C:\\Users\\tester\\.codex' }),
    readVersion: () => SUPPORTED_CODEX_VERSION,
    spawnAppServer: (_path: string, env: NodeJS.ProcessEnv) => serverFactory(env) as unknown as ChildProcessWithoutNullStreams,
    requestTimeoutMs: 100,
    serverRequestTimeoutMs: 20,
    processExitTimeoutMs: 100,
    ...overrides,
  };
}

describe('Codex bridge lifecycle', () => {
  it('does not resolve or execute Codex while the bridge is only constructed', () => {
    let resolveCalls = 0;
    let versionCalls = 0;
    const bridge = new CodexBridge({
      resolveExecutable: () => {
        resolveCalls += 1;
        return 'must-not-run-codex';
      },
      readVersion: () => {
        versionCalls += 1;
        return 'must-not-run-version';
      },
    });
    expect(bridge.status()).toMatchObject({ connected: false, state: 'idle', version: 'unknown', accountChecked: false, modelListChecked: false });
    expect(resolveCalls).toBe(0);
    expect(versionCalls).toBe(0);
  });

  it('rejects an incompatible version before spawning', async () => {
    const spawnAppServer = vi.fn();
    const bridge = new CodexBridge(runtime(() => { throw new Error('must not spawn'); }, {
      readVersion: () => 'codex-cli 0.130.0',
      spawnAppServer,
    }));
    await expect(bridge.start()).rejects.toThrow('版本不兼容');
    expect(spawnAppServer).not.toHaveBeenCalled();
    expect(bridge.status()).toMatchObject({ connected: false, state: 'version_incompatible' });
  });

  it('stops at AUTH_REQUIRED without listing models or creating data', async () => {
    let server!: FakeAppServer;
    const bridge = new CodexBridge(runtime(() => {
      server = new FakeAppServer((message) => {
        if (message.method === 'initialize') return standardResponse(message);
        if (message.method === 'account/read') return { account: null, requiresOpenaiAuth: true };
        throw new Error(`unexpected method ${message.method}`);
      });
      return server;
    }));
    await expect(bridge.start()).rejects.toThrow('需要登录');
    expect(server.messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(server.killed).toBe(true);
    expect(bridge.status()).toMatchObject({ connected: false, state: 'auth_required', accountChecked: true, modelListChecked: false });
  });

  it('uses one CODEX_HOME and becomes ready only after model and Windows readiness checks', async () => {
    let receivedEnv: NodeJS.ProcessEnv = {};
    let versionEnv: NodeJS.ProcessEnv = {};
    let server!: FakeAppServer;
    const bridge = new CodexBridge(runtime((env) => {
      receivedEnv = env;
      server = new FakeAppServer(standardResponse);
      return server;
    }, { readVersion: (_path: string, env: NodeJS.ProcessEnv) => { versionEnv = env; return SUPPORTED_CODEX_VERSION; } }));
    await bridge.start();
    expect(receivedEnv.CODEX_HOME).toBe('C:\\Users\\tester\\.codex');
    expect(versionEnv).toBe(receivedEnv);
    expect(server.messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'account/read', 'model/list', 'windowsSandbox/readiness']);
    expect(server.messages[0].params).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false } });
    expect(bridge.status()).toMatchObject({ connected: true, state: 'ready', accountChecked: true, modelListChecked: true, windowsSandbox: { state: 'needs_setup' } });
    await bridge.stop();
    expect(server.killed).toBe(true);
  });

  it('cleans a protocol failure and can retry with a new child', async () => {
    const servers: FakeAppServer[] = [];
    const bridge = new CodexBridge(runtime(() => {
      const attempt = servers.length;
      const server = new FakeAppServer((message) => attempt === 0 && message.method === 'initialize'
        ? { userAgent: 'bad' }
        : standardResponse(message));
      servers.push(server);
      return server;
    }));
    await expect(bridge.start()).rejects.toThrow('initialize 响应缺少');
    expect(servers[0].killed).toBe(true);
    expect(bridge.status()).toMatchObject({ connected: false, state: 'protocol_incompatible' });
    await bridge.start();
    expect(servers).toHaveLength(2);
    expect(bridge.status()).toMatchObject({ connected: true, state: 'ready' });
    await bridge.stop();
  });

  it('waits for delayed exit before failed start completes and rejects retry while a child remains', async () => {
    let delayedExited = false;
    const delayed = new FakeAppServer((message) => message.method === 'initialize' ? { userAgent: 'bad' } : standardResponse(message), 25);
    delayed.once('exit', () => { delayedExited = true; });
    let spawns = 0;
    const bridge = new CodexBridge(runtime(() => {
      spawns += 1;
      return delayed;
    }));
    await expect(bridge.start()).rejects.toThrow('initialize 响应缺少');
    expect(delayedExited).toBe(true);
    expect(spawns).toBe(1);

    const stuck = new FakeAppServer((message) => message.method === 'initialize' ? { userAgent: 'bad' } : standardResponse(message), null);
    const stuckBridge = new CodexBridge(runtime(() => stuck, { processExitTimeoutMs: 20 }));
    await expect(stuckBridge.start()).rejects.toThrow('终止超时');
    expect(stuckBridge.status()).toMatchObject({ connected: false, state: 'error' });
    await expect(stuckBridge.start()).rejects.toThrow('未确认退出');
  });

  it('rejects an initialize response that reports a different CODEX_HOME', async () => {
    let server!: FakeAppServer;
    const bridge = new CodexBridge(runtime(() => {
      server = new FakeAppServer((message) => message.method === 'initialize'
        ? { userAgent: 'test', codexHome: 'C:\\Other\\.codex', platformFamily: 'windows', platformOs: 'windows' }
        : standardResponse(message));
      return server;
    }));
    await expect(bridge.start()).rejects.toThrow('不同的 CODEX_HOME');
    expect(server.killed).toBe(true);
    expect(bridge.status()).toMatchObject({ connected: false, state: 'protocol_incompatible' });
  });

  it('cleans a spawn error and permits a later retry', async () => {
    let attempt = 0;
    const bridge = new CodexBridge(runtime(() => {
      attempt += 1;
      const server = new FakeAppServer(attempt === 1 ? () => undefined : standardResponse);
      if (attempt === 1) queueMicrotask(() => server.emit('error', new Error('spawn denied')));
      return server;
    }));
    await expect(bridge.start()).rejects.toThrow('启动失败');
    expect(bridge.status()).toMatchObject({ connected: false, state: 'error' });
    await bridge.start();
    expect(attempt).toBe(2);
    await bridge.stop();
  });

  it('preserves a handshake-time exit error without waiting for the same exit twice', async () => {
    let attempt = 0;
    const bridge = new CodexBridge(runtime(() => {
      attempt += 1;
      let server!: FakeAppServer;
      server = new FakeAppServer(attempt === 1 ? (message) => {
        if (message.method === 'initialize') queueMicrotask(() => server.emit('exit', 1, null));
        return undefined;
      } : standardResponse);
      return server;
    }));
    await expect(bridge.start()).rejects.toThrow('Codex App Server 已退出 (1)');
    expect(bridge.status().error).not.toContain('终止超时');
    await bridge.start();
    expect(attempt).toBe(2);
    await bridge.stop();
  });

  it('paginates models plus active and archived threads with fixed source kinds', async () => {
    let server!: FakeAppServer;
    let modelListCalls = 0;
    const threadRequests: RpcMessage[] = [];
    const bridge = new CodexBridge(runtime(() => {
      server = new FakeAppServer((message) => {
        if (message.method === 'model/list') {
          modelListCalls += 1;
          if (modelListCalls === 1) return { data: [], nextCursor: null };
          return message.params?.cursor ? { data: [{ id: 'm2', model: 'm2', serviceTiers: [] }], nextCursor: null } : { data: [{ id: 'm1', model: 'm1', serviceTiers: [] }], nextCursor: 'next-model' };
        }
        if (message.method === 'thread/list') {
          threadRequests.push(message);
          const archived = message.params?.archived === true;
          const cursor = message.params?.cursor;
          if (!cursor) return { data: [{ id: archived ? 'archived-1' : 'active-1' }], nextCursor: archived ? null : 'next-thread' };
          return { data: [{ id: 'active-2' }], nextCursor: null };
        }
        return standardResponse(message);
      });
      return server;
    }));
    await bridge.start();
    expect((await bridge.listModels()).map((model) => model.id)).toEqual(['m1', 'm2']);
    expect((await bridge.listThreads()).map((thread) => thread.id)).toEqual(['active-1', 'active-2', 'archived-1']);
    expect(threadRequests).toHaveLength(3);
    expect(threadRequests.every((request) => Array.isArray(request.params?.sourceKinds) && request.params?.sourceKinds.includes('unknown'))).toBe(true);
    await bridge.stop();
  });

  it('answers string-id user input, times out, and rejects unknown or permissions requests immediately', async () => {
    let server!: FakeAppServer;
    const events: string[] = [];
    const bridge = new CodexBridge(runtime(() => {
      server = new FakeAppServer(standardResponse);
      return server;
    }));
    bridge.onEvent((event) => events.push(event.method));
    await bridge.start();

    server.send({ id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [], isBlocking: true, autoResolutionMs: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.respondToUserInput('input-1', { q: { answers: ['A'] } });
    expect(server.messages.at(-1)).toEqual({ id: 'input-1', result: { answers: { q: { answers: ['A'] } } } });

    server.send({ id: 'input-cancel', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [], isBlocking: true, autoResolutionMs: null } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.cancelUserInput('input-cancel');
    expect(server.messages.at(-1)).toEqual({ id: 'input-cancel', result: { answers: {} } });

    server.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    bridge.respondToApproval('approval-1', 'accept');
    expect(server.messages.at(-1)).toEqual({ id: 'approval-1', result: { decision: 'accept' } });
    expect(() => bridge.respondToApproval('approval-1', 'decline')).toThrow('已提交');
    server.send({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'approval-1' } });

    server.send({ id: 'input-turn-end', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [], isBlocking: true, autoResolutionMs: null } });
    server.send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => bridge.respondToUserInput('input-turn-end', {})).toThrow('已失效');

    server.send({ id: 'permissions-1', method: 'item/permissions/requestApproval', params: { threadId: 't', turnId: 'u' } });
    server.send({ id: 99, method: 'unknown/method', params: { threadId: 't', turnId: 'u' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.messages).toContainEqual({ id: 'permissions-1', error: { code: -32601, message: 'Codex Workboard 不支持服务端请求：item/permissions/requestApproval' } });
    expect(server.messages).toContainEqual({ id: 99, error: { code: -32601, message: 'Codex Workboard 不支持服务端请求：unknown/method' } });

    server.send({ id: 'input-timeout', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [], isBlocking: true, autoResolutionMs: null } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.messages).toContainEqual({ id: 'input-timeout', result: { answers: {} } });
    expect(events).toContain('workboard/serverRequestUnsupported');
    expect(events).toContain('workboard/serverRequestClosed');
    await bridge.stop();
  });
});
