import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type RpcId = number;
type RpcResponse = { id: RpcId; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

const ALL_SOURCE_KINDS = [
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

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

export class CodexBridge {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private starting: Promise<void> | null = null;
  private lastError = '';
  readonly version: string;

  constructor() {
    try {
      this.version = execFileSync(this.codexPath(), ['--version'], { encoding: 'utf8' }).trim();
    } catch {
      this.version = 'unknown';
    }
  }

  private codexPath(): string {
    const resolved = execFileSync('/bin/zsh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim();
    if (!resolved) throw new Error('未找到 codex CLI');
    return resolved;
  }

  async start(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const child = spawn(this.codexPath(), ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.process = child;

      child.once('exit', (code, signal) => {
        const message = `Codex App Server 已退出 (${code ?? signal ?? 'unknown'})`;
        this.lastError = message;
        this.process = null;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(message));
        }
        this.pending.clear();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) this.lastError = text.slice(-600);
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => this.onLine(line));

      await this.request('initialize', {
        clientInfo: {
          name: 'codex-workboard',
          title: 'Codex Workboard',
          version: '1.0.0',
        },
      });
      this.notify('initialized', {});
      this.lastError = '';
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private onLine(line: string): void {
    let message: RpcResponse | undefined;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'Codex App Server 请求失败'));
    } else {
      pending.resolve(message.result);
    }
  }

  private write(payload: object): void {
    if (!this.process?.stdin.writable) throw new Error('Codex App Server 未连接');
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: object): void {
    this.write({ method, params });
  }

  private request(method: string, params: object, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  private async listThreadPageSet(archived: boolean): Promise<Array<Record<string, unknown>>> {
    await this.start();
    const threads: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let pages = 0;
    do {
      const response = (await this.request('thread/list', {
        cursor,
        limit: 200,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived,
        sourceKinds: ALL_SOURCE_KINDS,
      })) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      threads.push(...(response.data ?? []).map((thread) => ({ ...thread, archived })));
      const nextCursor = response.nextCursor ?? null;
      if (nextCursor && seenCursors.has(nextCursor)) throw new Error('thread/list 返回了重复游标');
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
      pages += 1;
    } while (cursor && pages < 500);
    if (cursor) throw new Error('thread/list 超出安全分页上限');
    return threads;
  }

  async listThreads(): Promise<Array<Record<string, unknown>>> {
    const active = await this.listThreadPageSet(false);
    const archived = await this.listThreadPageSet(true);
    return [...active, ...archived];
  }

  async readThread(threadId: string): Promise<Record<string, unknown>> {
    await this.start();
    const response = (await this.request('thread/read', { threadId, includeTurns: true })) as {
      thread?: Record<string, unknown>;
    };
    return response.thread ?? response;
  }

  async sendToThread(threadId: string, text: string): Promise<unknown> {
    await this.start();
    return this.request(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      },
      30_000,
    );
  }

  status(): { connected: boolean; version: string; error?: string } {
    return {
      connected: Boolean(this.process),
      version: this.version,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  stop(): void {
    this.process?.kill('SIGTERM');
    this.process = null;
  }
}
