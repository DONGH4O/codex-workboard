import type { BrowserWindowConstructorOptions } from 'electron';

export const WINDOWS_APP_USER_MODEL_ID = 'com.codexworkboard.desktop';

export function browserWindowPlatformOptions(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'trafficLightPosition'> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 16 },
    };
  }
  return { titleBarStyle: 'default' };
}

export function shouldQuitWhenAllWindowsClose(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

export function shouldSkipCodexSync(environment: NodeJS.ProcessEnv): boolean {
  return environment.WORKBOARD_SKIP_CODEX_SYNC === '1';
}
