import net from 'node:net';
import path from 'node:path';

export interface WorkboardRunBinding {
  version: 1;
  runId: string;
  pid: number;
  processCreatedAt: string;
  executablePath: string;
  dataDir: string;
  pipePath: string;
}

export function parseWorkboardRunArgs(argv: string[]): Partial<Pick<WorkboardRunBinding, 'runId' | 'dataDir' | 'pipePath'>> {
  const value = (name: string) => argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runId = value('workboard-run-id');
  const dataDir = value('workboard-data-dir');
  const pipePath = value('workboard-control-pipe');
  if (![runId, dataDir, pipePath].some(Boolean)) return {};
  if (!runId || !/^[a-zA-Z0-9-]{8,80}$/.test(runId)) throw new Error('Workboard 运行编号无效');
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Workboard 运行数据目录必须是绝对路径');
  if (pipePath !== `\\\\.\\pipe\\codex-workboard-${runId}`) throw new Error('Workboard 控制管道无效');
  return { runId, dataDir: path.resolve(dataDir), pipePath };
}

export function startRunControlServer(pipePath: string, runId: string, requestQuit: () => void) {
  const server = net.createServer((socket) => {
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => { /* client disconnects are contained per connection */ });
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 4_096) {
        handled = true;
        socket.end('{"accepted":false}\n');
        return;
      }
      const frameEnd = input.indexOf('\n');
      if (frameEnd < 0) return;
      handled = true;
      try {
        const request = JSON.parse(input.slice(0, frameEnd));
        if (request?.runId !== runId || !['ping', 'stop'].includes(request?.action)) throw new Error('binding mismatch');
        socket.end('{"accepted":true}\n', () => { if (request.action === 'stop') requestQuit(); });
      } catch {
        socket.end('{"accepted":false}\n');
      }
    });
    socket.on('end', () => { if (!handled) socket.destroy(); });
  });
  return new Promise<{ close(): Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.removeListener('error', reject);
      resolve({ close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())) });
    });
  });
}
