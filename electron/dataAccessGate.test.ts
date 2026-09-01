import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDataAccess } from './dataAccessGate.js';

describe('shared Workboard data access gate', () => {
  it.each(['writer', 'backup'] as const)('creates and idempotently releases a %s lease', (role) => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const lease = acquireDataAccess(dataDir, role);
    expect(JSON.parse(readFileSync(lease.lockPath, 'utf8'))).toMatchObject({ version: 1, role, pid: process.pid });
    lease.release();
    lease.release();
    expect(existsSync(lease.lockPath)).toBe(false);
  });

  it('prevents backup and writer access from overlapping', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const writer = acquireDataAccess(dataDir, 'writer');
    expect(() => acquireDataAccess(dataDir, 'backup')).toThrow('正在被应用、维护或备份任务使用');
    writer.release();
    const backup = acquireDataAccess(dataDir, 'backup');
    expect(() => acquireDataAccess(dataDir, 'writer')).toThrow('正在被应用、维护或备份任务使用');
    backup.release();
  });

  it('rejects a relative data directory before resolving it against the process cwd', () => {
    expect(() => acquireDataAccess('.\\relative-data', 'writer')).toThrow('必须是绝对路径');
  });
});
