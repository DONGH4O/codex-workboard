import os from 'node:os';
import path from 'node:path';

export function defaultWorkboardUserData(platform = process.platform, env = process.env, homeDirectory = os.homedir()) {
  if (platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA.trim() ? env.APPDATA : path.join(homeDirectory, 'AppData', 'Roaming');
    return path.resolve(appData, 'Codex Workboard');
  }
  if (platform === 'darwin') return path.resolve(homeDirectory, 'Library', 'Application Support', 'Codex Workboard');
  const configRoot = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(homeDirectory, '.config');
  return path.resolve(configRoot, 'Codex Workboard');
}

export function resolveWorkboardUserData(env = process.env, platform = process.platform, homeDirectory = os.homedir()) {
  const explicit = env.WORKBOARD_USER_DATA_DIR;
  return explicit && explicit.trim() ? path.resolve(explicit) : defaultWorkboardUserData(platform, env, homeDirectory);
}
