import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RUN_STATE_VERSION = 1;

function canonical(value) { return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase(); }
function requiredAbsolute(label, value) {
  if (!value || !path.win32.isAbsolute(value)) throw new Error(`${label} 必须是 Windows 绝对路径`);
  return path.win32.normalize(value);
}
export function buildLaunchBinding(executablePath, dataDir, stateDir, runId = randomUUID()) {
  const executable = requiredAbsolute('Workboard 可执行文件', executablePath);
  const data = requiredAbsolute('Workboard 数据目录', dataDir);
  const state = requiredAbsolute('Workboard 状态目录', stateDir);
  return { executable, data, state, runId, pipePath: `\\\\.\\pipe\\codex-workboard-${runId}` };
}

export function validateRunBinding(state, processInfo) {
  if (state?.version !== RUN_STATE_VERSION || !/^[a-zA-Z0-9-]{8,80}$/.test(state.runId ?? '')
    || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !String(state.processCreatedAt ?? '').trim()
    || !path.win32.isAbsolute(state.executablePath ?? '') || !path.win32.isAbsolute(state.dataDir ?? '')
    || state.executablePath !== path.win32.normalize(state.executablePath) || state.dataDir !== path.win32.normalize(state.dataDir)
    || state.pipePath !== `\\\\.\\pipe\\codex-workboard-${state.runId}`) throw new Error('Workboard 运行状态格式无效');
  if (!processInfo) return { running: false, reason: 'process-missing' };
  const commandLine = String(processInfo.commandLine ?? '');
  const checks = {
    executablePath: canonical(processInfo.executablePath ?? '') === canonical(state.executablePath),
    processCreatedAt: String(processInfo.processCreatedAt) === String(state.processCreatedAt),
    runId: commandLine.includes(`--workboard-run-id=${state.runId}`),
    dataDir: commandLine.includes(`--workboard-data-dir=${state.dataDir}`),
    pipePath: commandLine.includes(`--workboard-control-pipe=${state.pipePath}`),
  };
  const mismatches = Object.entries(checks).filter(([, matched]) => !matched).map(([field]) => field);
  if (mismatches.length) throw new Error(`操作系统进程与 Workboard 运行状态绑定不一致：${mismatches.join(', ')}`);
  return { running: true, reason: 'verified' };
}

export function writeRunStateAtomically(stateDir, state, runtime = {}) {
  const mkdir = runtime.mkdir ?? mkdirSync;
  const write = runtime.write ?? writeFileSync;
  const rename = runtime.rename ?? renameSync;
  mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, 'workboard-run.json');
  const temporary = path.join(stateDir, `workboard-run-${state.runId}.tmp`);
  write(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  rename(temporary, target);
  return target;
}

function execFilePromise(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
async function queryProcess(pid) {
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue; if($p){$p | Select-Object ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress}`;
  const stdout = await execFilePromise('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!String(stdout).trim()) return null;
  const value = JSON.parse(String(stdout));
  return { executablePath: value.ExecutablePath, processCreatedAt: value.CreationDate, commandLine: value.CommandLine };
}
function readState(stateDir) { return JSON.parse(readFileSync(path.join(stateDir, 'workboard-run.json'), 'utf8')); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireStartLock(binding, runtime) {
  const lockPath = path.join(binding.state, 'workboard-start.lock');
  const ownerPath = (root) => path.join(root, 'owner.json');
  const open = () => {
    mkdirSync(lockPath);
    writeFileSync(ownerPath(lockPath), JSON.stringify({ version: 1, pid: process.pid, runId: binding.runId, createdAt: new Date().toISOString() }), { flag: 'wx' });
  };
  try { open(); return { lockPath }; } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'EEXIST')) throw error;
    let owner;
    for (let attempt = 0; attempt < 4 && !owner; attempt += 1) {
      try { owner = JSON.parse(readFileSync(ownerPath(lockPath), 'utf8')); } catch { await (runtime.delay ?? delay)(25); }
    }
    if (!Number.isSafeInteger(owner?.pid) || !owner?.runId || !owner?.createdAt) throw new Error('Workboard 启动锁不可读，拒绝自动接管');
    if (Number.isSafeInteger(owner?.pid) && await (runtime.queryProcess ?? queryProcess)(owner.pid)) throw new Error('另一个 Workboard 启动控制器正在运行');
    const quarantine = path.join(binding.state, `workboard-start.stale-${binding.runId}`);
    renameSync(lockPath, quarantine);
    try { open(); } catch (error) {
      throw new Error(`Workboard 启动锁接管期间出现并发启动：${error instanceof Error ? error.message : String(error)}`);
    }
    const quarantinedOwner = JSON.parse(readFileSync(ownerPath(quarantine), 'utf8'));
    if (JSON.stringify(quarantinedOwner) !== JSON.stringify(owner)) {
      rmSync(lockPath, { recursive: true, force: true });
      if (!existsSync(lockPath)) renameSync(quarantine, lockPath);
      throw new Error('Workboard 启动锁在接管期间已换主');
    }
    rmSync(quarantine, { recursive: true, force: true });
    return { lockPath };
  }
}

function removeOwnedState(stateDir, runId) {
  const statePath = path.join(stateDir, 'workboard-run.json');
  if (!existsSync(statePath)) return;
  const quarantine = path.join(stateDir, `workboard-run.stale-${runId}.json`);
  try {
    renameSync(statePath, quarantine);
    const quarantined = JSON.parse(readFileSync(quarantine, 'utf8'));
    if (quarantined?.runId === runId) rmSync(quarantine, { force: true });
    else if (!existsSync(statePath)) renameSync(quarantine, statePath);
  } catch {
    if (existsSync(quarantine) && !existsSync(statePath)) {
      try { renameSync(quarantine, statePath); } catch { /* preserve quarantined evidence */ }
    }
  }
}

export async function startWorkboard(binding, runtime = {}) {
  if (!existsSync(binding.executable)) throw new Error('Workboard 可执行文件不存在');
  mkdirSync(binding.data, { recursive: true }); mkdirSync(binding.state, { recursive: true });
  const { lockPath } = await acquireStartLock(binding, runtime);
  try {
    if (existsSync(path.join(binding.state, 'workboard-run.json'))) {
      const current = await statusWorkboard(binding.state, runtime);
      if (current.running) throw new Error('状态目录已有正在运行的 Workboard 实例');
    }
    const child = (runtime.spawn ?? spawn)(binding.executable, [
      `--workboard-run-id=${binding.runId}`, `--workboard-data-dir=${binding.data}`, `--workboard-control-pipe=${binding.pipePath}`,
    ], { detached: true, stdio: 'ignore', windowsHide: false, env: { ...process.env, WORKBOARD_USER_DATA_DIR: binding.data, WORKBOARD_SKIP_LEGACY_MIGRATION: '1' } });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('Workboard 进程未返回有效 PID');
    child.unref?.();
    let candidateState;
    try {
      let info = null;
      for (let attempt = 0; attempt < 20 && !info; attempt += 1) { info = await (runtime.queryProcess ?? queryProcess)(child.pid); if (!info) await (runtime.delay ?? delay)(100); }
      if (!info?.processCreatedAt) throw new Error('无法读取新 Workboard 进程状态');
      candidateState = { version: 1, runId: binding.runId, pid: child.pid, processCreatedAt: info.processCreatedAt, executablePath: binding.executable, dataDir: binding.data, pipePath: binding.pipePath };
      validateRunBinding(candidateState, info);
      let ready = false;
      let readyError;
      const readyDeadline = Date.now() + 30_000;
      for (let attempt = 0; !ready && attempt < 120 && Date.now() < readyDeadline; attempt += 1) {
        try { await (runtime.probeReady ?? probeControl)(candidateState, 'ping', 1_000); ready = true; }
        catch (error) { readyError = error; await (runtime.delay ?? delay)(200); }
      }
      if (!ready) throw readyError ?? new Error('Workboard 控制管道未就绪');
      writeRunStateAtomically(binding.state, candidateState, runtime);
      return candidateState;
    } catch (primaryError) {
      let safelyTreeBound = false;
      const info = await (runtime.queryProcess ?? queryProcess)(child.pid).catch(() => null);
      if (candidateState && info) {
        try { validateRunBinding(candidateState, info); safelyTreeBound = true; } catch { /* PID was reused or identity changed */ }
      }
      try {
        if (safelyTreeBound) await (runtime.killTree ?? killTree)(child.pid);
        else child.kill?.();
      } catch { /* preserve startup failure */ }
      try { rmSync(path.join(binding.state, `workboard-run-${binding.runId}.tmp`), { force: true }); } catch { /* preserve startup failure */ }
      try { removeOwnedState(binding.state, binding.runId); } catch { /* preserve startup failure */ }
      throw primaryError;
    }
  } finally { rmSync(lockPath, { recursive: true, force: true }); }
}

export async function statusWorkboard(stateDir, runtime = {}) {
  const directory = requiredAbsolute('Workboard 状态目录', stateDir);
  const statePath = path.join(directory, 'workboard-run.json');
  if (!existsSync(statePath)) return { state: null, running: false, reason: 'no-state', staleRemoved: false };
  const state = readState(directory);
  const result = validateRunBinding(state, await (runtime.queryProcess ?? queryProcess)(state.pid));
  if (!result.running) {
    removeOwnedState(directory, state.runId);
    return { state, ...result, staleRemoved: true };
  }
  return { state, ...result, staleRemoved: false };
}

export async function probeControl(state, action, timeoutMs = 1_500) {
  await new Promise((resolve, reject) => {
    let input = '';
    let settled = false;
    const socket = net.createConnection(state.pipePath);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => { socket.destroy(); finish(new Error('Workboard 控制管道超时')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ action, runId: state.runId })}\n`));
    socket.on('data', (data) => {
      input += data;
      const frameEnd = input.indexOf('\n');
      if (frameEnd < 0) return;
      let accepted = false;
      try { accepted = JSON.parse(input.slice(0, frameEnd))?.accepted === true; } catch { /* reject below */ }
      socket.end();
      finish(accepted ? undefined : new Error('Workboard 控制管道拒绝请求'));
    });
    socket.on('close', () => finish(new Error('Workboard 控制管道未接受请求')));
    socket.on('error', (error) => finish(error));
  });
}
const killTree = (pid) => execFilePromise('taskkill.exe', ['/PID', String(pid), '/T', '/F']);

export async function stopWorkboard(stateDir, runtime = {}) {
  const directory = requiredAbsolute('Workboard 状态目录', stateDir);
  const { state, running, staleRemoved } = await statusWorkboard(directory, runtime);
  if (!running) return { stopped: true, alreadyStopped: true, staleRemoved };
  try { await (runtime.requestStop ?? ((value) => probeControl(value, 'stop')))(state); } catch { /* verified fallback below */ }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await (runtime.queryProcess ?? queryProcess)(state.pid)) { removeOwnedState(directory, state.runId); return { stopped: true, alreadyStopped: false }; }
    await (runtime.delay ?? delay)(100);
  }
  const finalProcess = await (runtime.queryProcess ?? queryProcess)(state.pid);
  const finalBinding = validateRunBinding(state, finalProcess);
  if (!finalBinding.running) {
    removeOwnedState(directory, state.runId);
    return { stopped: true, alreadyStopped: false };
  }
  await (runtime.killTree ?? killTree)(state.pid);
  if (await (runtime.queryProcess ?? queryProcess)(state.pid)) throw new Error('已验证 Workboard 进程树未能停止');
  removeOwnedState(directory, state.runId);
  return { stopped: true, alreadyStopped: false };
}

export function resolveRunControlOptions(args, env = process.env) {
  const get = (name) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  return {
    executablePath: get('exe') ?? env.WORKBOARD_EXECUTABLE_PATH,
    dataDir: get('data-dir') ?? env.WORKBOARD_USER_DATA_DIR,
    stateDir: get('state-dir') ?? env.WORKBOARD_STATE_DIR,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  const options = resolveRunControlOptions(args, env);
  const result = command === 'start' ? await startWorkboard(buildLaunchBinding(options.executablePath, options.dataDir, options.stateDir))
    : command === 'status' ? await statusWorkboard(options.stateDir)
      : command === 'stop' ? await stopWorkboard(options.stateDir) : (() => { throw new Error('仅支持 start、status 或 stop'); })();
  process.stdout.write(`${JSON.stringify({ result: 'PASS', command, ...result }, null, 2)}\n`);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
