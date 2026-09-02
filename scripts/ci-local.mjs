import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtimeRoot = path.resolve(root, '..', 'runtime');
const localEnvironment = {
  ...process.env,
  npm_config_cache: path.join(runtimeRoot, 'npm-cache'),
  ELECTRON_CACHE: path.join(runtimeRoot, 'electron-cache'),
  ELECTRON_BUILDER_CACHE: path.join(runtimeRoot, 'electron-builder-cache'),
};
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
export function localCiCommands(platform) {
  const common = [['run', 'verify:npm'], ['test'], ['run', 'build'], ['run', 'verify:ci'], ['run', 'precommit:check']];
  if (platform === 'win32') return [...common, ['run', 'pack:win'], ['run', 'verify:win-package'], ['run', 'test:ui:packaged']];
  if (platform === 'darwin') return [...common, ['run', 'pack:mac'], ['run', 'test:ui:packaged']];
  throw new Error(`本地 CI 模拟暂不支持平台 ${platform}`);
}

export function runLocalCi(options = {}) {
  const platform = options.platform ?? process.platform;
  for (const args of localCiCommands(platform)) {
    const command = [corepack, 'npm', ...args];
    const executable = platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : corepack;
    const executableArgs = platform === 'win32' ? ['/d', '/s', '/c', command.join(' ')] : ['npm', ...args];
    const result = (options.spawn ?? spawnSync)(executable, executableArgs, { cwd: root, env: localEnvironment, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`本地 CI 模拟失败：npm ${args.join(' ')}`);
  }
  return platform;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const platform = runLocalCi();
  console.log(`LOCAL_CI_NO_INSTALL_SIMULATION_OK platform=${platform} existing_dependencies=true network_audit=false`);
}
