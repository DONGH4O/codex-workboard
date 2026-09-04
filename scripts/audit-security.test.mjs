import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildNpmAuditInvocation, isRetryableAuditEndpointFailure, runSecurityAudit } from './audit-security.mjs';

const endpointTimeout = {
  status: 1,
  stdout: '',
  stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\nnpm error audit endpoint returned an error\n',
};
const npmCliPath = path.resolve('fixtures', 'npm-cli.js');
const runAudit = (options) => runSecurityAudit({ npmCliPath, ...options });

describe('bounded dependency security audit', () => {
  it('retries the observed endpoint timeout once and preserves a successful result', () => {
    const execute = vi.fn()
      .mockReturnValueOnce(endpointTimeout)
      .mockReturnValueOnce({ status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' });
    const errors = [];
    expect(runAudit({ execute, writeOut: vi.fn(), writeErr: (value) => errors.push(value) })).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(errors.join('')).toContain('唯一一次重试');
  });

  it('fails after the single retry when the endpoint remains unavailable', () => {
    const execute = vi.fn().mockReturnValue(endpointTimeout);
    expect(runAudit({ execute, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not retry a vulnerability report or an unrelated failure', () => {
    const vulnerability = vi.fn().mockReturnValue({ status: 1, stdout: '# npm audit report\n1 high severity vulnerability\n', stderr: '' });
    expect(runAudit({ execute: vulnerability, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(1);
    expect(vulnerability).toHaveBeenCalledOnce();

    const unrelated = vi.fn().mockReturnValue({ status: 2, stdout: '', stderr: 'invalid config\n' });
    expect(runAudit({ execute: unrelated, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(2);
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it('requires endpoint markers and rejects mixed vulnerability output', () => {
    expect(isRetryableAuditEndpointFailure(endpointTimeout)).toBe(true);
    expect(isRetryableAuditEndpointFailure({ status: 1, stdout: '', stderr: 'npm error audit endpoint returned an error\n' })).toBe(false);
    expect(isRetryableAuditEndpointFailure({ ...endpointTimeout, stdout: '# npm audit report\n1 vulnerability\n' })).toBe(false);
    expect(isRetryableAuditEndpointFailure({ ...endpointTimeout, stdout: '1 high severity vulnerability\n' })).toBe(false);
  });

  it('runs npm CLI through the current Node executable without a shell command', () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    expect(runAudit({ execute, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(0);
    expect(execute).toHaveBeenCalledWith({
      executable: process.execPath,
      args: [npmCliPath, 'audit', '--registry=https://registry.npmjs.org', '--audit-level=high'],
      attempt: 1,
    });
  });

  it('launches the npm CLI supplied by the current npm script through Node', () => {
    const invocation = buildNpmAuditInvocation(process.env.npm_execpath);
    const probe = spawnSync(invocation.executable, [invocation.args[0], '--version'], { encoding: 'utf8', windowsHide: true });
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps absolute npm CLI paths with spaces as one argv item on Windows and macOS', () => {
    const windowsCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    expect(buildNpmAuditInvocation(windowsCli, { platform: 'win32', executable: 'C:\\Program Files\\nodejs\\node.exe' })).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: [windowsCli, 'audit', '--registry=https://registry.npmjs.org', '--audit-level=high'],
    });
    const macCli = '/Applications/Node Runtime/lib/node modules/npm/bin/npm-cli.js';
    expect(buildNpmAuditInvocation(macCli, { platform: 'darwin', executable: '/usr/local/bin/node' })).toEqual({
      executable: '/usr/local/bin/node',
      args: [macCli, 'audit', '--registry=https://registry.npmjs.org', '--audit-level=high'],
    });
  });

  it('fails before spawning when npm provides no CLI path or a relative path', () => {
    for (const invalidPath of ['', 'npm-cli.js']) {
      const execute = vi.fn();
      const errors = [];
      expect(runSecurityAudit({ npmCliPath: invalidPath, execute, writeOut: vi.fn(), writeErr: (value) => errors.push(value) })).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      expect(errors.join('')).toContain('绝对路径 npm_execpath');
    }
  });
});
