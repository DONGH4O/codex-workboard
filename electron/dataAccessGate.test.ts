import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDataAccess } from './dataAccessGate.js';

describe('shared Workboard data access gate', () => {
  it.each(['writer', 'backup'] as const)('creates and idempotently releases a %s lease', (role) => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const lease = acquireDataAccess(dataDir, role);
    expect(JSON.parse(readFileSync(lease.lockPath, 'utf8'))).toMatchObject({ version: 2, role, pid: process.pid });
    expect(JSON.parse(readFileSync(lease.lockPath, 'utf8')).leaseId).toMatch(/^[a-zA-Z0-9-]{8,80}$/);
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

  it('atomically recovers a well-formed legacy v1 lock owned by a dead process as a v2 lease', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, JSON.stringify({ version: 1, role: 'writer', pid: 987654, createdAt: new Date().toISOString() }));
    const lease = acquireDataAccess(dataDir, 'writer', { isProcessAlive: () => false });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ version: 2, role: 'writer', pid: process.pid });
    expect(readdirSync(runtimeDir).filter((name) => name.startsWith('data-access.stale-'))).toEqual([]);
    lease.release();
  });

  it('refuses a well-formed legacy v1 lock owned by a live process', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, JSON.stringify({ version: 1, role: 'backup', pid: process.pid, createdAt: new Date().toISOString() }));
    expect(() => acquireDataAccess(dataDir, 'writer', { isProcessAlive: () => true })).toThrow('正在被应用、维护或备份任务使用');
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).version).toBe(1);
  });

  it('rejects an invalid legacy v1 lock without deleting it', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    mkdirSync(runtimeDir);
    const invalid = JSON.stringify({ version: 1, role: 'writer', createdAt: new Date().toISOString() });
    writeFileSync(lockPath, invalid);
    expect(() => acquireDataAccess(dataDir, 'writer', { isProcessAlive: () => false })).toThrow('格式无效');
    expect(readFileSync(lockPath, 'utf8')).toBe(invalid);
  });

  it('rejects a malformed existing lock without deleting it', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, '{malformed');
    expect(() => acquireDataAccess(dataDir, 'writer', { isProcessAlive: () => false })).toThrow('格式无效');
    expect(readFileSync(lockPath, 'utf8')).toBe('{malformed');
  });

  it('refuses takeover when the lock owner changes before the atomic rename', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    const replacement = { version: 2, leaseId: 'replacement-owner-1234', role: 'backup', pid: process.pid, createdAt: new Date().toISOString() };
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, JSON.stringify({ version: 2, leaseId: 'dead-owner-1234', role: 'writer', pid: 987654, createdAt: new Date().toISOString() }));
    expect(() => acquireDataAccess(dataDir, 'writer', {
      isProcessAlive: () => false,
      beforeStaleRename: () => writeFileSync(lockPath, JSON.stringify(replacement)),
    })).toThrow('接管期间已换主');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('preserves a new owner that wins the race after stale lock quarantine', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    const replacement = { version: 2, leaseId: 'concurrent-owner-1234', role: 'backup', pid: process.pid, createdAt: new Date().toISOString() };
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, JSON.stringify({ version: 2, leaseId: 'dead-owner-1234', role: 'writer', pid: 987654, createdAt: new Date().toISOString() }));
    expect(() => acquireDataAccess(dataDir, 'writer', {
      isProcessAlive: () => false,
      afterStaleRename: () => writeFileSync(lockPath, JSON.stringify(replacement)),
    })).toThrow('并发访问');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('retries acquisition when the previous owner releases before stale rename', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const runtimeDir = path.join(dataDir, '.runtime');
    const lockPath = path.join(runtimeDir, 'data-access.lock');
    mkdirSync(runtimeDir);
    writeFileSync(lockPath, JSON.stringify({ version: 2, leaseId: 'dead-owner-1234', role: 'writer', pid: 987654, createdAt: new Date().toISOString() }));
    let released = false;
    const lease = acquireDataAccess(dataDir, 'backup', {
      isProcessAlive: () => false,
      beforeStaleRename: () => { if (!released) { released = true; unlinkSync(lockPath); } },
    });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ version: 2, role: 'backup', pid: process.pid });
    lease.release();
  });

  it('release never deletes a lock that was replaced by another owner', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const lockPath = path.join(dataDir, '.runtime', 'data-access.lock');
    const replacement = { version: 2, leaseId: 'replacement-owner-1234', role: 'backup', pid: process.pid, createdAt: new Date().toISOString() };
    const lease = acquireDataAccess(dataDir, 'writer', {
      beforeReleaseRename: () => writeFileSync(lockPath, JSON.stringify(replacement)),
    });
    lease.release();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('release restores malformed foreign contents to the canonical lock path', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'workboard-gate-'));
    const lockPath = path.join(dataDir, '.runtime', 'data-access.lock');
    const lease = acquireDataAccess(dataDir, 'writer', {
      beforeReleaseRename: () => writeFileSync(lockPath, '{foreign-malformed'),
    });
    expect(() => lease.release()).toThrow('格式无效');
    expect(readFileSync(lockPath, 'utf8')).toBe('{foreign-malformed');
  });
});
