import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import electronExecutable from 'electron';

const projectRoot = path.resolve(import.meta.dirname, '..');
const defaultUserData = path.resolve(projectRoot, '..', 'runtime', 'workboard-dev');

const child = spawn(electronExecutable, ['.'], {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173',
    WORKBOARD_USER_DATA_DIR: process.env.WORKBOARD_USER_DATA_DIR || defaultUserData,
    WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
  },
  stdio: 'inherit',
  windowsHide: false,
});

child.once('error', (error) => {
  console.error(`Electron 开发进程启动失败：${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron 开发进程被信号 ${signal} 终止`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
