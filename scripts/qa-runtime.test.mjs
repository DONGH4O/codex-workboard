import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertMacBundleRuntimeResources,
  assertWindowsSystemPackage,
  assertWriterLeaseReleased,
  buildFormalAppEnvironment,
  buildIsolatedQaEnvironment,
  buildOfflineLaunchConfiguration,
  buildMinimalFormalEvidence,
  canRemoveQaTemporaryData,
  closeOwnedProcess,
  combinePrimaryAndCleanupError,
  copyPackagedDirectory,
  createQaTemporaryRoot,
  resolveExternalArtifactPath,
  resolvePackagedExecutable,
  runCleanupActions,
  trackChild,
  validateFormalFlowGate,
  waitForDevToolsPort,
  preflightEvidenceTarget,
  writeEvidenceAtomically,
} from './qa-runtime.mjs';

function fakeChild(pid = 42) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('cross-platform QA runtime', () => {
  it('selects the single Windows product executable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'workboard-qa-runtime-'));
    const packageDir = path.join(root, 'dist', 'win-unpacked');
    mkdirSync(packageDir, { recursive: true });
    const executable = path.join(packageDir, 'Codex Workboard.exe');
    writeFileSync(executable, 'fixture');
    expect(resolvePackagedExecutable(root, { platform: 'win32', packageDir }).executable).toBe(path.resolve(executable));
  });

  it('keeps packaged launch independent from source-only switches and entry point', () => {
    const root = path.resolve(process.platform === 'win32' ? 'F:\\repo' : '/repo');
    const executable = path.resolve(process.platform === 'win32' ? 'C:\\package\\Codex Workboard.exe' : '/package/Codex Workboard.app/Contents/MacOS/Codex Workboard');
    const userData = path.resolve(process.platform === 'win32' ? 'C:\\data' : '/data');
    const packaged = buildOfflineLaunchConfiguration({ packaged: true, executable, checkoutRoot: root, userData, platform: 'win32' });
    expect(packaged.cwd).toBe(path.dirname(executable));
    expect(packaged.args).not.toContain('.');
    expect(packaged.args).not.toContain('--no-sandbox');
    expect(packaged.args).toContain('--remote-debugging-port=0');
    const source = buildOfflineLaunchConfiguration({ packaged: false, executable, checkoutRoot: root, userData, platform: 'win32' });
    expect(source.args).toContain('.');
    expect(source.args).toContain('--no-sandbox');
  });

  it('stages packaged applications without rewriting bundle symlinks', () => {
    const copy = vi.fn();
    const source = path.resolve(process.platform === 'win32' ? 'C:\\package' : '/package');
    const destination = path.resolve(process.platform === 'win32' ? 'C:\\staging\\package' : '/staging/package');
    expect(copyPackagedDirectory(source, destination, { copy })).toBe(destination);
    expect(copy).toHaveBeenCalledWith(source, destination, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    expect(() => copyPackagedDirectory('relative', destination, { copy })).toThrow('绝对路径');
  });

  it('distinguishes complete and incomplete macOS bundle runtime resources', () => {
    const executable = '/staging/Codex Workboard.app/Contents/MacOS/Codex Workboard';
    const checked = [];
    const present = (candidate) => {
      checked.push(candidate);
      return { isFile: () => true };
    };
    expect(assertMacBundleRuntimeResources(executable, { platform: 'darwin', stage: 'source', stat: present })).toBe(true);
    expect(checked).toEqual([
      '/staging/Codex Workboard.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat',
      '/staging/Codex Workboard.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
      '/staging/Codex Workboard.app/Contents/Frameworks/Codex Workboard Helper.app/Contents/MacOS/Codex Workboard Helper',
    ]);
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    expect(() => assertMacBundleRuntimeResources(executable, { platform: 'darwin', stage: 'source', stat: missing })).toThrow('macOS source 目录包运行时资源不完整');
    expect(() => assertMacBundleRuntimeResources(executable, { platform: 'darwin', stage: 'staged', stat: missing })).toThrow('macOS staged 目录包运行时资源不完整');
    expect(() => assertMacBundleRuntimeResources(executable, { platform: 'darwin', stat: present })).toThrow('必须标明 source 或 staged 阶段');
    expect(assertMacBundleRuntimeResources('C:\\package\\Codex Workboard.exe', { platform: 'win32', stat: () => { throw new Error('should not run'); } })).toBe(true);
  });

  it('requires Windows staging to be on the system volume', () => {
    const makeDirectory = vi.fn();
    const makeTemporaryDirectory = vi.fn((prefix) => `${prefix}fixture`);
    const created = createQaTemporaryRoot('offline-', {
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local', SystemRoot: 'C:\\Windows' },
      makeDirectory,
      makeTemporaryDirectory,
    });
    expect(created).toContain('C:\\Users\\qa\\AppData\\Local\\CodexWorkboard-QA');
    expect(() => createQaTemporaryRoot('offline-', {
      platform: 'win32',
      environment: { LOCALAPPDATA: 'F:\\Temp', SystemRoot: 'C:\\Windows' },
      makeDirectory,
      makeTemporaryDirectory,
    })).toThrow('系统卷');
  });

  it('always disables Codex sync in isolated non-real QA', () => {
    const environment = buildIsolatedQaEnvironment({ HOME: 'keep' }, 'C:\\isolated', { codexCliPath: 'C:\\missing-codex.exe' });
    expect(environment).toMatchObject({ HOME: 'keep', WORKBOARD_SKIP_CODEX_SYNC: '1', WORKBOARD_SKIP_LEGACY_MIGRATION: '1', CODEX_CLI_PATH: 'C:\\missing-codex.exe' });
  });

  it('rejects zero or multiple macOS application candidates', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'workboard-qa-runtime-'));
    const packageDir = path.join(root, 'mac-arm64');
    mkdirSync(packageDir, { recursive: true });
    expect(() => resolvePackagedExecutable(root, { platform: 'darwin', arch: 'arm64', packageDir })).toThrow('实际找到 0 个');
    for (const product of ['Codex Workboard', 'Stale Workboard']) {
      const executable = path.join(packageDir, `${product}.app`, 'Contents', 'MacOS', product);
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, 'fixture');
    }
    expect(() => resolvePackagedExecutable(root, { platform: 'darwin', arch: 'arm64', packageDir })).toThrow('实际找到 2 个');
  });

  it('keeps generic home variables and requires explicit Codex paths', () => {
    const base = process.platform === 'win32'
      ? { HOME: 'preserved-home', USERPROFILE: 'preserved-profile', CODEX_HOME: 'C:\\Codex Home', CODEX_CLI_PATH: 'C:\\Codex\\codex.exe' }
      : { HOME: '/preserved-home', USERPROFILE: '/preserved-profile', CODEX_HOME: '/codex-home', CODEX_CLI_PATH: '/codex/codex' };
    const userData = process.platform === 'win32' ? 'C:\\Workboard Data' : '/workboard-data';
    const actual = buildFormalAppEnvironment(base, userData);
    expect(actual.HOME).toBe(base.HOME);
    expect(actual.USERPROFILE).toBe(base.USERPROFILE);
    expect(actual.CODEX_HOME).toBe(path.resolve(base.CODEX_HOME));
    expect(actual.CODEX_CLI_PATH).toBe(path.resolve(base.CODEX_CLI_PATH));
    expect(() => buildFormalAppEnvironment({ ...base, CODEX_HOME: '' }, userData)).toThrow('CODEX_HOME');
    expect(() => buildFormalAppEnvironment({ ...base, CODEX_CLI_PATH: '' }, userData)).toThrow('CODEX_CLI_PATH');
  });

  it('only permits evidence paths outside the checkout', () => {
    const root = path.resolve(process.platform === 'win32' ? 'C:\\repo' : '/repo');
    const external = path.resolve(process.platform === 'win32' ? 'C:\\evidence\\result.json' : '/evidence/result.json');
    expect(resolveExternalArtifactPath(external, root)).toBe(external);
    expect(() => resolveExternalArtifactPath(path.join(root, 'scripts', 'evidence.json'), root)).toThrow('源码目录之外');
    expect(() => resolveExternalArtifactPath('relative.json', root)).toThrow('绝对路径');
  });

  it('discovers a dynamic DevTools port from stderr', async () => {
    const child = fakeChild();
    const pending = waitForDevToolsPort(child, path.join(tmpdir(), 'missing-user-data'), { timeoutMs: 1000 });
    child.stderr.write('DevTools listening on ws://127.0.0.1:43123/devtools/browser/test\n');
    await expect(pending).resolves.toBe(43123);
  });

  it('discovers the DevTools port file and rejects timeout or early exit', async () => {
    const fileChild = fakeChild();
    await expect(waitForDevToolsPort(fileChild, path.join(tmpdir(), 'virtual-user-data'), { timeoutMs: 1000, read: () => '45555\n/devtools/browser/id' })).resolves.toBe(45555);

    const exitedChild = fakeChild();
    const exited = waitForDevToolsPort(exitedChild, path.join(tmpdir(), 'missing-user-data'), { timeoutMs: 1000 });
    exitedChild.emit('exit', 3, null);
    await expect(exited).rejects.toThrow('就绪前退出');

    const timeoutChild = fakeChild();
    await expect(waitForDevToolsPort(timeoutChild, path.join(tmpdir(), 'missing-user-data'), { timeoutMs: 5 })).rejects.toThrow('调试端点未就绪');

    const errorChild = fakeChild();
    const trackedErrorChild = trackChild(errorChild);
    const spawnFailure = waitForDevToolsPort(errorChild, path.join(tmpdir(), 'missing-user-data'), { timeoutMs: 1000 });
    errorChild.emit('error', new Error('ENOENT'));
    await expect(spawnFailure).rejects.toThrow('启动失败：ENOENT');
    await expect(trackedErrorChild.exit).resolves.toMatchObject({ error: expect.any(Error) });
  });

  it('waits for graceful exit and only falls back to the exact Windows process tree', async () => {
    const gracefulChild = fakeChild(51);
    const gracefulTracked = trackChild(gracefulChild);
    const graceful = closeOwnedProcess(gracefulTracked, { graceful: async () => {
      gracefulChild.exitCode = 0;
      gracefulChild.emit('exit', 0, null);
    }, gracefulTimeoutMs: 50 });
    await expect(graceful).resolves.toMatchObject({ forced: false, exit: { code: 0 } });

    const forcedChild = fakeChild(52);
    const forcedTracked = trackChild(forcedChild);
    const execFile = vi.fn((_file, _args, _options, callback) => {
      forcedChild.exitCode = 1;
      forcedChild.emit('exit', 1, null);
      callback(null);
    });
    await expect(closeOwnedProcess(forcedTracked, { platform: 'win32', graceful: vi.fn(), gracefulTimeoutMs: 1, execFile })).resolves.toMatchObject({ forced: true });
    expect(execFile).toHaveBeenCalledWith('taskkill.exe', ['/PID', '52', '/T', '/F'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
  });

  it('continues exact cleanup after a graceful-close error', async () => {
    const child = fakeChild(53);
    const tracked = trackChild(child);
    const execFile = vi.fn((_file, _args, _options, callback) => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      callback(null);
    });
    const result = await closeOwnedProcess(tracked, {
      platform: 'win32',
      graceful: async () => { throw new Error('page close failed'); },
      gracefulTimeoutMs: 1,
      execFile,
    });
    expect(result).toMatchObject({ forced: true, gracefulError: expect.any(Error) });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('forces only an owned POSIX process group', async () => {
    const child = fakeChild(54);
    const tracked = trackChild(child, { ownsProcessGroup: true });
    const killProcess = vi.fn(() => {
      child.signalCode = 'SIGKILL';
      child.emit('exit', null, 'SIGKILL');
    });
    await expect(closeOwnedProcess(tracked, { platform: 'darwin', graceful: vi.fn(), gracefulTimeoutMs: 1, killProcess })).resolves.toMatchObject({ forced: true });
    expect(killProcess).toHaveBeenCalledWith(-54, 'SIGKILL');

    const unowned = fakeChild(55);
    await expect(closeOwnedProcess(trackChild(unowned), { platform: 'darwin', graceful: vi.fn(), gracefulTimeoutMs: 1, killProcess })).rejects.toThrow('未声明独占进程组');
  });

  it('runs every cleanup action and preserves the primary failure', async () => {
    const calls = [];
    const cleanup = await runCleanupActions([
      ['first', async () => { calls.push('first'); throw new Error('cleanup one'); }],
      ['second', async () => { calls.push('second'); }],
      ['third', async () => { calls.push('third'); throw new Error('cleanup three'); }],
    ]);
    expect(calls).toEqual(['first', 'second', 'third']);
    const primary = new Error('primary');
    expect(combinePrimaryAndCleanupError(primary, cleanup)).toBe(primary);
    expect(primary.cleanupFailures).toEqual(['first: cleanup one', 'third: cleanup three']);
    expect(canRemoveQaTemporaryData(primary, [])).toBe(false);
    expect(canRemoveQaTemporaryData(undefined, cleanup)).toBe(false);
    expect(canRemoveQaTemporaryData(undefined, [])).toBe(true);
  });

  it('rejects formal flow unless both real-execution gates are present', () => {
    expect(() => validateFormalFlowGate([], {})).toThrow('默认拒绝');
    expect(() => validateFormalFlowGate(['--execute-real'], {})).toThrow('默认拒绝');
    expect(() => validateFormalFlowGate([], { WORKBOARD_W5_REAL_FLOW: '1' })).toThrow('默认拒绝');
    expect(validateFormalFlowGate(['--execute-real'], { WORKBOARD_W5_REAL_FLOW: '1' })).toBe(true);
    expect(() => validateFormalFlowGate(['--execute-real'], { WORKBOARD_W5_REAL_FLOW: '1' }, { platform: 'win32' })).toThrow('WORKBOARD_PACKAGE_DIR');
  });

  it('requires a Windows package on the system volume and a released writer lease', () => {
    expect(assertWindowsSystemPackage('C:\\package', { SystemRoot: 'C:\\Windows' }, 'win32')).toBe(true);
    expect(() => assertWindowsSystemPackage('F:\\package', { SystemRoot: 'C:\\Windows' }, 'win32')).toThrow('系统卷');
    expect(assertWriterLeaseReleased('/data', { readDirectory: () => [] })).toBe(true);
    expect(() => assertWriterLeaseReleased('/data', { readDirectory: () => ['data-access.lock'] })).toThrow('writer lease');
  });

  it('emits only whitelisted formal evidence', () => {
    const evidence = buildMinimalFormalEvidence({
      ok: true,
      package: 'C:\\private\\package.exe',
      isolation: { codexHome: 'C:\\Users\\private\\.codex' },
      appServerBaseline: { active: 2, archived: 1, pages: 2 },
      checks: { sync: true },
      evidence: { task: { id: 'secret-id', title: 'secret title', auditEventCount: 3, auditActions: ['created'] } },
      error: null,
    });
    expect(evidence).toMatchObject({ ok: true, cleanupFailed: false, summary: { activeConversations: 2, auditEventCount: 3 } });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret-id');
    expect(serialized).not.toContain('secret title');
    expect(buildMinimalFormalEvidence({ ok: true, cleanupFailed: true }).cleanupFailed).toBe(true);
    expect(buildMinimalFormalEvidence({ ok: true, cleanupFailed: true }).ok).toBe(false);
  });

  it('preflights and atomically replaces an external evidence target', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'workboard-evidence-'));
    const target = path.join(directory, 'result.json');
    expect(preflightEvidenceTarget(target)).toBe(target);
    expect(existsSync(target)).toBe(false);
    writeEvidenceAtomically(target, '{"ok":true}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    writeEvidenceAtomically(target, '{"ok":false}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":false}\n');
  });
});
