import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type DataAccessRole = 'writer' | 'backup';

export interface DataAccessLease {
  role: DataAccessRole;
  lockPath: string;
  release(): void;
}

export function acquireDataAccess(dataDir: string, role: DataAccessRole): DataAccessLease {
  if (!path.isAbsolute(dataDir)) throw new Error('Workboard 数据目录必须是绝对路径');
  const resolved = path.resolve(dataDir);
  const runtimeDir = path.join(resolved, '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, 'data-access.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx');
  } catch (error) {
    const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (reason === 'EEXIST') throw new Error('Workboard 数据目录正在被应用、维护或备份任务使用');
    throw error;
  }
  writeFileSync(descriptor, JSON.stringify({ version: 1, role, pid: process.pid, createdAt: new Date().toISOString() }));
  let released = false;
  return {
    role,
    lockPath,
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      try { unlinkSync(lockPath); } catch (error) {
        const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (reason !== 'ENOENT') throw error;
      }
    },
  };
}
