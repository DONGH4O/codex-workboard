import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildLaunchBinding, probeControl, resolveRunControlOptions, startWorkboard, statusWorkboard, stopWorkboard, validateRunBinding } from './workboard-run-control.mjs';
import { startRunControlServer } from '../electron/runControl.ts';

describe('isolated Windows run control', () => {
  it('accepts task-specific environment paths with spaces and gives explicit arguments priority', () => {
    const env = {
      WORKBOARD_EXECUTABLE_PATH: 'C:\\Portable Apps\\Codex Workboard.exe',
      WORKBOARD_USER_DATA_DIR: 'C:\\Workboard Data\\accepted',
      WORKBOARD_STATE_DIR: 'C:\\Workboard State\\accepted',
    };
    expect(resolveRunControlOptions([], env)).toEqual({
      executablePath: env.WORKBOARD_EXECUTABLE_PATH,
      dataDir: env.WORKBOARD_USER_DATA_DIR,
      stateDir: env.WORKBOARD_STATE_DIR,
    });
    expect(resolveRunControlOptions([
      '--exe=D:\\Override\\Workboard.exe',
      '--data-dir=D:\\Override\\data',
      '--state-dir=D:\\Override\\state',
    ], env)).toEqual({
      executablePath: 'D:\\Override\\Workboard.exe',
      dataDir: 'D:\\Override\\data',
      stateDir: 'D:\\Override\\state',
    });
  });

  it.runIf(process.platform === 'win32')('uses the production framed pipe for ping, rejection, and acknowledged stop', async () => {
    const runId = `pipe-${Date.now()}`;
    const pipePath = `\\\\.\\pipe\\codex-workboard-${runId}`;
    let quitRequested = false;
    const server = await startRunControlServer(pipePath, runId, () => { quitRequested = true; });
    try {
      await probeControl({ runId, pipePath }, 'ping', 2_000);
      expect(quitRequested).toBe(false);
      await expect(probeControl({ runId: `${runId}-wrong`, pipePath }, 'ping', 2_000)).rejects.toThrow('拒绝');
      await expect(probeControl({ runId, pipePath }, 'unsupported', 2_000)).rejects.toThrow('拒绝');
      expect(quitRequested).toBe(false);
      const fragmentedResponse = await new Promise((resolve, reject) => {
        const socket = net.createConnection(pipePath);
        let response = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('fragmented pipe timeout')); }, 2_000);
        socket.setEncoding('utf8');
        socket.on('connect', () => {
          const frame = JSON.stringify({ action: 'ping', runId });
          socket.write(frame.slice(0, 7));
          setImmediate(() => socket.write(`${frame.slice(7)}\n`));
        });
        socket.on('data', (chunk) => { response += chunk; });
        socket.on('end', () => { clearTimeout(timer); resolve(response); });
        socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      });
      expect(JSON.parse(fragmentedResponse.trim())).toEqual({ accepted: true });
      await probeControl({ runId, pipePath }, 'stop', 2_000);
      await vi.waitFor(() => expect(quitRequested).toBe(true));
    } finally {
      await server.close();
    }
  });

  it.runIf(process.platform === 'win32')('atomically binds start, status, graceful stop and state cleanup', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-'));
    const exe = path.join(root, 'Codex Workboard.exe');
    const data = path.join(root, 'data'); const stateDir = path.join(root, 'state');
    const { writeFileSync } = await import('node:fs'); writeFileSync(exe, 'fake');
    const binding = buildLaunchBinding(exe, data, stateDir, '12345678-abcd');
    let live = true;
    const info = { executablePath: binding.executable, processCreatedAt: '20260901010101.000000+480', commandLine: binding.runId };
    info.commandLine = `--workboard-run-id=${binding.runId} --workboard-data-dir=${binding.data} --workboard-control-pipe=${binding.pipePath}`;
    const runtime = { spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })), queryProcess: vi.fn(async () => live ? info : null), probeReady: vi.fn(), requestStop: vi.fn(async () => { live = false; }) };
    const started = await startWorkboard(binding, runtime);
    expect(runtime.spawn).toHaveBeenCalledWith(binding.executable, [
      `--workboard-run-id=${binding.runId}`,
      `--workboard-data-dir=${binding.data}`,
      `--workboard-control-pipe=${binding.pipePath}`,
    ], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: expect.objectContaining({ WORKBOARD_USER_DATA_DIR: binding.data, WORKBOARD_SKIP_LEGACY_MIGRATION: '1' }),
    }));
    expect(JSON.parse(readFileSync(path.join(stateDir, 'workboard-run.json'), 'utf8'))).toMatchObject({ pid: 4242, runId: binding.runId, version: 1 });
    expect(await statusWorkboard(stateDir, runtime)).toMatchObject({ running: true });
    expect(await stopWorkboard(stateDir, runtime)).toMatchObject({ stopped: true, alreadyStopped: false });
  });

  it('refuses mismatched process identity before stop and only uses a targeted fallback after revalidation', async () => {
    const state = { version: 1, runId: '12345678', pid: 42, processCreatedAt: 'time', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\data', pipePath: '\\\\.\\pipe\\codex-workboard-12345678' };
    expect(() => validateRunBinding(state, { executablePath: 'C:\\Other.exe', processCreatedAt: 'time', commandLine: '' }))
      .toThrow('绑定不一致：executablePath, runId, dataDir, pipePath');
  });

  it.runIf(process.platform === 'win32')('removes stale state but preserves a mismatched live-process state', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-'));
    const stateDir = path.join(root, 'state'); const { mkdirSync, writeFileSync, existsSync } = await import('node:fs'); mkdirSync(stateDir);
    const state = { version: 1, runId: '12345678', pid: 42, processCreatedAt: 'time', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\data', pipePath: '\\\\.\\pipe\\codex-workboard-12345678' };
    writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(state));
    expect(await statusWorkboard(stateDir, { queryProcess: vi.fn(async () => null) })).toMatchObject({ running: false, staleRemoved: true });
    expect(existsSync(path.join(stateDir, 'workboard-run.json'))).toBe(false);
    writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(state));
    await expect(statusWorkboard(stateDir, { queryProcess: vi.fn(async () => ({ executablePath: 'C:\\Other.exe', processCreatedAt: 'time', commandLine: '' })) })).rejects.toThrow('绑定不一致');
    expect(existsSync(path.join(stateDir, 'workboard-run.json'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('uses graceful stop then revalidates before targeted tree fallback', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const stateDir = path.join(root, 'state');
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs'); mkdirSync(stateDir);
    const state = { version: 1, runId: '12345678', pid: 42, processCreatedAt: 'time', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\data', pipePath: '\\\\.\\pipe\\codex-workboard-12345678' };
    const info = { executablePath: state.executablePath, processCreatedAt: state.processCreatedAt, commandLine: `--workboard-run-id=${state.runId} --workboard-data-dir=${state.dataDir} --workboard-control-pipe=${state.pipePath}` };
    writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(state));
    let calls = 0; let live = true;
    const queryProcess = vi.fn(async () => { calls += 1; return live ? info : null; });
    const killTree = vi.fn(async (pid) => { expect(pid).toBe(42); live = false; });
    await stopWorkboard(stateDir, { queryProcess, requestStop: vi.fn(async () => { throw new Error('timeout'); }), killTree, delay: vi.fn() });
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(queryProcess.mock.calls.length).toBeGreaterThan(2);
    expect(existsSync(path.join(stateDir, 'workboard-run.json'))).toBe(false);
  }, 10_000);

  it.runIf(process.platform === 'win32')('kills the exact spawned child handle when startup cannot establish an OS binding', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-'));
    const exe = path.join(root, 'Codex Workboard.exe'); const data = path.join(root, 'data'); const stateDir = path.join(root, 'state');
    const { writeFileSync, existsSync } = await import('node:fs'); writeFileSync(exe, 'fake');
    const child = { pid: 77, unref: vi.fn(), kill: vi.fn() };
    await expect(startWorkboard(buildLaunchBinding(exe, data, stateDir, '12345678-fail'), {
      spawn: () => child, queryProcess: vi.fn(async () => null), delay: vi.fn(),
    })).rejects.toThrow('无法读取');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(stateDir, 'workboard-run.json'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('retries readiness and supports repeated status and stop after state cleanup', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const exe = path.join(root, 'Codex Workboard.exe');
    const data = path.join(root, 'data'); const stateDir = path.join(root, 'state'); const { writeFileSync } = await import('node:fs'); writeFileSync(exe, 'fake');
    const binding = buildLaunchBinding(exe, data, stateDir, '12345678-ready'); let probes = 0; let live = true;
    const info = { executablePath: binding.executable, processCreatedAt: 'time', commandLine: `--workboard-run-id=${binding.runId} --workboard-data-dir=${binding.data} --workboard-control-pipe=${binding.pipePath}` };
    const runtime = { spawn: () => ({ pid: 88, unref: vi.fn(), kill: vi.fn() }), queryProcess: vi.fn(async () => live ? info : null), probeReady: vi.fn(async () => { probes += 1; if (probes < 3) throw new Error('not ready'); }), delay: vi.fn(), requestStop: vi.fn(async () => { live = false; }) };
    await startWorkboard(binding, runtime); expect(probes).toBe(3);
    await stopWorkboard(stateDir, runtime);
    expect(await statusWorkboard(stateDir, runtime)).toMatchObject({ running: false, reason: 'no-state' });
    expect(await stopWorkboard(stateDir, runtime)).toMatchObject({ stopped: true, alreadyStopped: true });
  });

  it.runIf(process.platform === 'win32')('recovers a stale controller lock but refuses a live lock owner', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const exe = path.join(root, 'Codex Workboard.exe');
    const data = path.join(root, 'data'); const stateDir = path.join(root, 'state'); const { mkdirSync, writeFileSync } = await import('node:fs'); writeFileSync(exe, 'fake'); mkdirSync(stateDir);
    mkdirSync(path.join(stateDir, 'workboard-start.lock')); writeFileSync(path.join(stateDir, 'workboard-start.lock', 'owner.json'), JSON.stringify({ pid: 999, runId: 'old', createdAt: 'time' }));
    const binding = buildLaunchBinding(exe, data, stateDir, '12345678-lock'); const child = { pid: 89, unref: vi.fn(), kill: vi.fn() };
    const info = { executablePath: binding.executable, processCreatedAt: 'time', commandLine: `--workboard-run-id=${binding.runId} --workboard-data-dir=${binding.data} --workboard-control-pipe=${binding.pipePath}` };
    await startWorkboard(binding, { spawn: () => child, queryProcess: vi.fn(async (pid) => pid === 999 ? null : info), probeReady: vi.fn() });
    mkdirSync(path.join(stateDir, 'workboard-start.lock')); writeFileSync(path.join(stateDir, 'workboard-start.lock', 'owner.json'), JSON.stringify({ pid: 999, runId: 'live', createdAt: 'time' }));
    await expect(startWorkboard({ ...binding, runId: '12345678-next' }, { queryProcess: vi.fn(async () => info) })).rejects.toThrow('启动控制器正在运行');
  });

  it.runIf(process.platform === 'win32')('preserves the startup error and clears owned files when identity changes or cleanup fails', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const exe = path.join(root, 'Codex Workboard.exe');
    const data = path.join(root, 'data'); const stateDir = path.join(root, 'state'); const { writeFileSync, existsSync } = await import('node:fs'); writeFileSync(exe, 'fake');
    const binding = buildLaunchBinding(exe, data, stateDir, '12345678-clean'); const primary = new Error('ready failed'); const child = { pid: 90, unref: vi.fn(), kill: vi.fn(() => { throw new Error('kill failed'); }) };
    const good = { executablePath: binding.executable, processCreatedAt: 'time', commandLine: `--workboard-run-id=${binding.runId} --workboard-data-dir=${binding.data} --workboard-control-pipe=${binding.pipePath}` };
    let queries = 0;
    await expect(startWorkboard(binding, { spawn: () => child, queryProcess: vi.fn(async () => { queries += 1; return queries === 1 ? good : { ...good, processCreatedAt: 'reused' }; }), probeReady: vi.fn(async () => { throw primary; }), delay: vi.fn(), killTree: vi.fn(async () => { throw new Error('tree failed'); }) })).rejects.toBe(primary);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(stateDir, 'workboard-run.json'))).toBe(false);
  });

  it('does not kill when the process disappears at the final post-wait identity check', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const stateDir = path.join(root, 'state');
    const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(stateDir);
    const state = { version: 1, runId: '12345678', pid: 42, processCreatedAt: 'time', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\data', pipePath: '\\\\.\\pipe\\codex-workboard-12345678' };
    const info = { executablePath: state.executablePath, processCreatedAt: state.processCreatedAt, commandLine: `--workboard-run-id=${state.runId} --workboard-data-dir=${state.dataDir} --workboard-control-pipe=${state.pipePath}` };
    writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(state));
    let calls = 0; const queryProcess = vi.fn(async () => { calls += 1; return calls <= 51 ? info : null; }); const killTree = vi.fn();
    await stopWorkboard(stateDir, { queryProcess, requestStop: vi.fn(async () => {}), killTree, delay: vi.fn() });
    expect(killTree).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('preserves a newer run state installed while an old status detects a missing process', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-control-')); const stateDir = path.join(root, 'state');
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs'); mkdirSync(stateDir);
    const oldState = { version: 1, runId: '12345678-old', pid: 42, processCreatedAt: 'old', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\old', pipePath: '\\\\.\\pipe\\codex-workboard-12345678-old' };
    const newState = { ...oldState, runId: '12345678-new', pid: 43, processCreatedAt: 'new', dataDir: 'F:\\new', pipePath: '\\\\.\\pipe\\codex-workboard-12345678-new' };
    writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(oldState));
    await statusWorkboard(stateDir, { queryProcess: vi.fn(async () => { writeFileSync(path.join(stateDir, 'workboard-run.json'), JSON.stringify(newState)); return null; }) });
    expect(JSON.parse(readFileSync(path.join(stateDir, 'workboard-run.json'), 'utf8'))).toMatchObject({ runId: newState.runId });
  });

  it.each(['processCreatedAt', 'executablePath', 'dataDir', 'pipePath'])('rejects an incomplete or altered %s binding', (field) => {
    const state = { version: 1, runId: '12345678', pid: 42, processCreatedAt: 'time', executablePath: 'C:\\Workboard.exe', dataDir: 'F:\\data', pipePath: '\\\\.\\pipe\\codex-workboard-12345678' };
    const changed = { ...state, [field]: '' };
    expect(() => validateRunBinding(changed, { executablePath: state.executablePath, processCreatedAt: state.processCreatedAt, commandLine: '' })).toThrow();
  });
});
