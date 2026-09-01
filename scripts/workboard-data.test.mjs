import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireDataAccess } from '../electron/dataAccessGate.js';
import { backupWorkboardData, restoreWorkboardData, verifyWorkboardData } from './workboard-data.mjs';

function sourceFixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'workboard-data-'));
  const source = path.join(parent, 'source');
  mkdirSync(path.join(source, 'attachments'), { recursive: true });
  mkdirSync(path.join(source, '.runtime'), { recursive: true });
  writeFileSync(path.join(source, 'attachments', 'proof.txt'), 'readable');
  writeFileSync(path.join(source, '.runtime', 'status.json'), 'runtime');
  writeFileSync(path.join(source, 'debug.log'), 'debug');
  const db = new DatabaseSync(path.join(source, 'taskboard.sqlite'));
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, created_at TEXT, lane TEXT); CREATE TABLE execution_snapshots(task_id TEXT REFERENCES tasks(id)); CREATE TABLE audit_events(task_id TEXT REFERENCES tasks(id), created_at TEXT, action TEXT); CREATE TABLE conversations(id TEXT, category TEXT); PRAGMA foreign_keys=ON;`);
  db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('task-1', '2026-01-01T00:00:00.000Z', 'execution');
  db.prepare('INSERT INTO execution_snapshots VALUES (?)').run('task-1');
  db.prepare('INSERT INTO audit_events VALUES (?,?,?)').run('task-1', '2026-01-01T00:00:01.000Z', 'created');
  db.prepare('INSERT INTO conversations VALUES (?,?)').run('conversation-1', '测试分类');
  db.close();
  return { parent, source };
}

describe('Workboard backup and restore', () => {
  it('copies a closed data directory, excludes runtime material, and restores to a new target', async () => {
    const { parent, source } = sourceFixture();
    const backup = path.join(parent, 'backup');
    const restored = path.join(parent, 'restored');
    const release = vi.fn();
    const manifest = await backupWorkboardData(source, backup, { acquireDataAccess: () => ({ release }) });
    expect(release).toHaveBeenCalledTimes(1);
    expect(verifyWorkboardData(backup)).toMatchObject({ counts: { tasks: 1, execution_snapshots: 1, audit_events: 1 }, readableAttachments: 1 });
    expect(verifyWorkboardData(backup)).toMatchObject({ lanes: { execution: 1 }, categories: { 测试分类: 1 }, actions: { created: 1 }, keyActionOrderValid: true });
    expect(existsSync(path.join(backup, '.runtime'))).toBe(false);
    expect(existsSync(path.join(backup, 'debug.log'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(backup, 'backup-manifest.json'), 'utf8')).entries)
      .toEqual(expect.arrayContaining([{ path: 'attachments/proof.txt', type: 'file', size: 8 }]));
    expect(JSON.parse(readFileSync(path.join(backup, 'backup-manifest.json'), 'utf8')).verification).toBeUndefined();
    expect(restoreWorkboardData(backup, restored)).toMatchObject({ counts: { tasks: 1 }, readableAttachments: 1 });
  });

  it('refuses existing targets, relative paths, and an active data lease', async () => {
    const { parent, source } = sourceFixture();
    await expect(backupWorkboardData(source, path.join(parent, 'backup'), {
      acquireDataAccess: () => { throw new Error('正在被应用、维护或备份任务使用'); },
    })).rejects.toThrow('正在被应用');
    await expect(backupWorkboardData('relative', path.join(parent, 'other'), { acquireDataAccess: vi.fn() })).rejects.toThrow('绝对路径');
    writeFileSync(path.join(source, 'backup-manifest.json'), '{}');
    expect(() => restoreWorkboardData(source, source)).toThrow('恢复目标目录必须尚不存在');
  });

  it('rejects semantic audit ordering failures', () => {
    const { source } = sourceFixture();
    const db = new DatabaseSync(path.join(source, 'taskboard.sqlite'));
    db.prepare('UPDATE audit_events SET created_at=?').run('2025-01-01T00:00:00.000Z');
    db.close();
    expect(() => verifyWorkboardData(source)).toThrow('审计动作时间早于');
  });

  it('rejects a terminal execution action without an earlier execution_started action', () => {
    const { source } = sourceFixture();
    const db = new DatabaseSync(path.join(source, 'taskboard.sqlite'));
    db.prepare('INSERT INTO audit_events VALUES (?,?,?)').run('task-1', '2026-01-01T00:00:02.000Z', 'execution_completed');
    db.close();
    expect(() => verifyWorkboardData(source)).toThrow('关键执行动作时间顺序无效');
  });

  it('copies optional WAL and SHM files and excludes credential material', async () => {
    const { parent, source } = sourceFixture();
    writeFileSync(path.join(source, 'taskboard.sqlite-wal'), 'wal');
    writeFileSync(path.join(source, 'taskboard.sqlite-shm'), 'shm');
    writeFileSync(path.join(source, '.env'), 'secret');
    writeFileSync(path.join(source, 'credentials.json'), 'secret');
    const backup = path.join(parent, 'backup');
    await backupWorkboardData(source, backup, { acquireDataAccess: () => ({ release: vi.fn() }) });
    expect(existsSync(path.join(backup, 'taskboard.sqlite-wal'))).toBe(true);
    expect(existsSync(path.join(backup, 'taskboard.sqlite-shm'))).toBe(true);
    expect(existsSync(path.join(backup, '.env'))).toBe(false);
    expect(existsSync(path.join(backup, 'credentials.json'))).toBe(false);
  });

  it('refuses a backup while a real writer lease is active and releases after validation failure', async () => {
    const { parent, source } = sourceFixture();
    const writer = acquireDataAccess(source, 'writer');
    await expect(backupWorkboardData(source, path.join(parent, 'blocked'), { acquireDataAccess })).rejects.toThrow('正在被应用');
    writer.release();
    const release = vi.fn();
    const db = new DatabaseSync(path.join(source, 'taskboard.sqlite'));
    db.exec('DROP TABLE audit_events');
    db.close();
    await expect(backupWorkboardData(source, path.join(parent, 'invalid'), { acquireDataAccess: () => ({ release }) })).rejects.toThrow('缺少核心表');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('validates a backup before restore and leaves no partial target on copy failure', async () => {
    const { parent, source } = sourceFixture();
    const backup = path.join(parent, 'backup');
    await backupWorkboardData(source, backup, { acquireDataAccess: () => ({ release: vi.fn() }) });
    writeFileSync(path.join(backup, 'unexpected.txt'), 'tampered');
    const target = path.join(parent, 'restored');
    expect(() => restoreWorkboardData(backup, target)).toThrow('备份文件与清单不一致');
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a database without the required Workboard tables', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-invalid-'));
    const db = new DatabaseSync(path.join(root, 'taskboard.sqlite'));
    db.exec('CREATE TABLE unrelated(id TEXT)');
    db.close();
    expect(() => verifyWorkboardData(root)).toThrow('缺少核心表');
  });
});
