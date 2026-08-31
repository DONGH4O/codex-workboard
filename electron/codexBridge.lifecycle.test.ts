import { describe, expect, it } from 'vitest';
import { CodexBridge } from './codexBridge.js';

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

    expect(bridge.status()).toEqual({ connected: false, version: 'unknown' });
    expect(resolveCalls).toBe(0);
    expect(versionCalls).toBe(0);
  });
});
