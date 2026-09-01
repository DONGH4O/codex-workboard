import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultWorkboardUserData, resolveWorkboardUserData } from './workboard-paths.mjs';

describe('Workboard data directory resolution', () => {
  it('always prefers the explicit task-specific data directory', () => {
    expect(resolveWorkboardUserData({ WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\workboard' }, 'win32', 'C:\\Users\\tester'))
      .toBe(path.resolve('F:\\isolated\\workboard'));
  });

  it('uses the roaming application data root on Windows', () => {
    expect(defaultWorkboardUserData('win32', { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, 'C:\\Users\\tester'))
      .toBe(path.resolve('C:\\Users\\tester\\AppData\\Roaming', 'Codex Workboard'));
  });

  it('uses platform-specific defaults without rewriting the home environment', () => {
    expect(defaultWorkboardUserData('darwin', {}, 'Z:\\mock-home')).toBe(path.resolve('Z:\\mock-home/Library/Application Support/Codex Workboard'));
    expect(defaultWorkboardUserData('linux', { XDG_CONFIG_HOME: '/var/test-config' }, '/home/tester')).toBe(path.resolve('/var/test-config/Codex Workboard'));
  });
});
