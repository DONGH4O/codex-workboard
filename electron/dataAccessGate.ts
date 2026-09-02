import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type DataAccessRole = 'writer' | 'backup';

export interface DataAccessLease {
  role: DataAccessRole;
  lockPath: string;
  release(): void;
}

interface LockOwner {
  version: 2;
  leaseId: string;
  role: DataAccessRole;
  pid: number;
  createdAt: string;
}

interface LegacyLockOwner {
  version: 1;
  role: DataAccessRole;
  pid: number;
  createdAt: string;
}

export interface DataAccessRuntime {
  isProcessAlive?(pid: number): boolean;
  beforeStaleRename?(): void;
  afterStaleRename?(): void;
  beforeReleaseRename?(): void;
}

function parseOwner(contents: string): LockOwner | LegacyLockOwner {
  let owner: Record<string, unknown>;
  try { owner = JSON.parse(contents) as Record<string, unknown>; } catch { throw new Error('Workboard 数据访问锁格式无效，拒绝自动接管'); }
  const commonValid = ['writer', 'backup'].includes(String(owner.role ?? '')) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
    && typeof owner.createdAt === 'string' && !Number.isNaN(Date.parse(owner.createdAt));
  const versionValid = owner.version === 1
    ? !('leaseId' in owner)
    : owner.version === 2 && /^[a-zA-Z0-9-]{8,80}$/.test(String(owner.leaseId ?? ''));
  if (!commonValid || !versionValid) {
    throw new Error('Workboard 数据访问锁格式无效，拒绝自动接管');
  }
  return owner as unknown as LockOwner | LegacyLockOwner;
}

function defaultIsProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

function restoreForeignLock(lockPath: string, quarantinePath: string): void {
  if (!existsSync(lockPath)) renameSync(quarantinePath, lockPath);
}

export function acquireDataAccess(dataDir: string, role: DataAccessRole, runtime: DataAccessRuntime = {}): DataAccessLease {
  if (!path.isAbsolute(dataDir)) throw new Error('Workboard 数据目录必须是绝对路径');
  const resolved = path.resolve(dataDir);
  const runtimeDir = path.join(resolved, '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, 'data-access.lock');
  const owner: LockOwner = { version: 2, leaseId: randomUUID(), role, pid: process.pid, createdAt: new Date().toISOString() };
  let descriptor: number | undefined;
  let staleQuarantine: string | null = null;
  for (let attempt = 0; descriptor === undefined && attempt < 3; attempt += 1) {
    try { descriptor = openSync(lockPath, 'wx'); continue; } catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (reason !== 'EEXIST') throw error;
    }
    let staleContents: string;
    try { staleContents = readFileSync(lockPath, 'utf8'); } catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (reason === 'ENOENT') continue;
      throw error;
    }
    const staleOwner = parseOwner(staleContents);
    if ((runtime.isProcessAlive ?? defaultIsProcessAlive)(staleOwner.pid)) {
      throw new Error('Workboard 数据目录正在被应用、维护或备份任务使用');
    }
    runtime.beforeStaleRename?.();
    staleQuarantine = path.join(runtimeDir, `data-access.stale-${owner.leaseId}.lock`);
    try { renameSync(lockPath, staleQuarantine); } catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (reason === 'ENOENT') { staleQuarantine = null; continue; }
      throw error;
    }
    runtime.afterStaleRename?.();
    try {
      if (readFileSync(staleQuarantine, 'utf8') !== staleContents) {
        restoreForeignLock(lockPath, staleQuarantine);
        throw new Error('Workboard 数据访问锁在接管期间已换主');
      }
    } catch (error) {
      if (existsSync(staleQuarantine)) restoreForeignLock(lockPath, staleQuarantine);
      throw error;
    }
    try { descriptor = openSync(lockPath, 'wx'); } catch (takeoverError) {
      unlinkSync(staleQuarantine);
      staleQuarantine = null;
      const takeoverReason = takeoverError && typeof takeoverError === 'object' && 'code' in takeoverError ? String(takeoverError.code) : '';
      if (takeoverReason === 'EEXIST') throw new Error('Workboard 数据访问锁接管期间出现并发访问');
      throw takeoverError;
    }
  }
  if (descriptor === undefined) throw new Error('Workboard 数据访问锁竞争未能收敛');
  try {
    writeFileSync(descriptor, JSON.stringify(owner));
    if (staleQuarantine) unlinkSync(staleQuarantine);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch { /* preserve the primary write failure */ }
    throw error;
  }
  let released = false;
  return {
    role,
    lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      const quarantinePath = path.join(runtimeDir, `data-access.release-${owner.leaseId}.lock`);
      try {
        runtime.beforeReleaseRename?.();
        renameSync(lockPath, quarantinePath);
        let currentOwner: LockOwner | LegacyLockOwner;
        try { currentOwner = parseOwner(readFileSync(quarantinePath, 'utf8')); } catch (error) {
          restoreForeignLock(lockPath, quarantinePath);
          throw error;
        }
        if (currentOwner.version !== 2 || currentOwner.leaseId !== owner.leaseId) {
          restoreForeignLock(lockPath, quarantinePath);
          return;
        }
        unlinkSync(quarantinePath);
      } catch (error) {
        const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (reason !== 'ENOENT') throw error;
      }
    },
  };
}
