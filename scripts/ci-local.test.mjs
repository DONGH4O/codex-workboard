import { describe, expect, it } from 'vitest';
import { localCiCommands } from './ci-local.mjs';

describe('local CI simulation command selection', () => {
  it('uses Windows packaging and verification only on Windows', () => {
    const commands = localCiCommands('win32').map((args) => args.join(' '));
    expect(commands).toContain('run pack:win');
    expect(commands).toContain('run verify:win-package');
    expect(commands).not.toContain('run pack:mac');
  });

  it('uses macOS packaging on macOS and rejects unsupported platforms', () => {
    const commands = localCiCommands('darwin').map((args) => args.join(' '));
    expect(commands).toContain('run pack:mac');
    expect(commands).toContain('run test:ui:packaged');
    expect(commands).not.toContain('run verify:win-package');
    expect(() => localCiCommands('linux')).toThrow('暂不支持平台');
  });
});
