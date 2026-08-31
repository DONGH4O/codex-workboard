import { describe, expect, it } from 'vitest';
import { browserWindowPlatformOptions, shouldQuitWhenAllWindowsClose, shouldSkipCodexSync, WINDOWS_APP_USER_MODEL_ID } from './platform.js';

describe('desktop platform behavior', () => {
  it('keeps the inset title bar only on macOS', () => {
    expect(browserWindowPlatformOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 16 },
    });
    expect(browserWindowPlatformOptions('win32')).toEqual({ titleBarStyle: 'default' });
    expect(browserWindowPlatformOptions('linux')).toEqual({ titleBarStyle: 'default' });
  });

  it('uses normal application shutdown semantics outside macOS', () => {
    expect(shouldQuitWhenAllWindowsClose('darwin')).toBe(false);
    expect(shouldQuitWhenAllWindowsClose('win32')).toBe(true);
    expect(shouldQuitWhenAllWindowsClose('linux')).toBe(true);
  });

  it('treats offline UI mode as an explicit Codex synchronization boundary', () => {
    expect(shouldSkipCodexSync({ WORKBOARD_SKIP_CODEX_SYNC: '1' })).toBe(true);
    expect(shouldSkipCodexSync({ WORKBOARD_SKIP_CODEX_SYNC: '0' })).toBe(false);
    expect(shouldSkipCodexSync({})).toBe(false);
  });

  it('uses the stable Windows application identifier', () => {
    expect(WINDOWS_APP_USER_MODEL_ID).toBe('com.codexworkboard.desktop');
  });
});
