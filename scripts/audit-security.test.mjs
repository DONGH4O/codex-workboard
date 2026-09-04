import { describe, expect, it, vi } from 'vitest';
import { isRetryableAuditEndpointFailure, runSecurityAudit } from './audit-security.mjs';

const endpointTimeout = {
  status: 1,
  stdout: '',
  stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\nnpm error audit endpoint returned an error\n',
};

describe('bounded dependency security audit', () => {
  it('retries the observed endpoint timeout once and preserves a successful result', () => {
    const execute = vi.fn()
      .mockReturnValueOnce(endpointTimeout)
      .mockReturnValueOnce({ status: 0, stdout: 'found 0 vulnerabilities\n', stderr: '' });
    const errors = [];
    expect(runSecurityAudit({ execute, writeOut: vi.fn(), writeErr: (value) => errors.push(value) })).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(errors.join('')).toContain('唯一一次重试');
  });

  it('fails after the single retry when the endpoint remains unavailable', () => {
    const execute = vi.fn().mockReturnValue(endpointTimeout);
    expect(runSecurityAudit({ execute, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not retry a vulnerability report or an unrelated failure', () => {
    const vulnerability = vi.fn().mockReturnValue({ status: 1, stdout: '# npm audit report\n1 high severity vulnerability\n', stderr: '' });
    expect(runSecurityAudit({ execute: vulnerability, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(1);
    expect(vulnerability).toHaveBeenCalledOnce();

    const unrelated = vi.fn().mockReturnValue({ status: 2, stdout: '', stderr: 'invalid config\n' });
    expect(runSecurityAudit({ execute: unrelated, writeOut: vi.fn(), writeErr: vi.fn() })).toBe(2);
    expect(unrelated).toHaveBeenCalledOnce();
  });

  it('requires endpoint markers and rejects mixed vulnerability output', () => {
    expect(isRetryableAuditEndpointFailure(endpointTimeout)).toBe(true);
    expect(isRetryableAuditEndpointFailure({ status: 1, stdout: '', stderr: 'npm error audit endpoint returned an error\n' })).toBe(false);
    expect(isRetryableAuditEndpointFailure({ ...endpointTimeout, stdout: '# npm audit report\n1 vulnerability\n' })).toBe(false);
    expect(isRetryableAuditEndpointFailure({ ...endpointTimeout, stdout: '1 high severity vulnerability\n' })).toBe(false);
  });
});
