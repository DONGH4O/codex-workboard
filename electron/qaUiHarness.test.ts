import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isQaUiHarnessEnabled, validateQaBridgeEvent, validateQaWindowProfile } from './qaUiHarness.js';

const enabled = {
  env: {
    WORKBOARD_QA_UI_HARNESS: '1',
    WORKBOARD_SKIP_CODEX_SYNC: '1',
    WORKBOARD_SKIP_LEGACY_MIGRATION: '1',
    WORKBOARD_SEED_DEMO: '1',
  },
  userData: path.join(path.parse(process.cwd()).root, 'tmp', 'governed-ui-123', 'user-data'),
  isPackaged: true,
};

describe('packaged isolated UI harness', () => {
  it('requires packaged mode, every isolation gate, and the dedicated temporary root', () => {
    expect(isQaUiHarnessEnabled(enabled)).toBe(true);
    expect(isQaUiHarnessEnabled({ ...enabled, isPackaged: false })).toBe(false);
    expect(isQaUiHarnessEnabled({ ...enabled, env: { ...enabled.env, WORKBOARD_SKIP_CODEX_SYNC: '0' } })).toBe(false);
    expect(isQaUiHarnessEnabled({ ...enabled, userData: path.join(path.parse(process.cwd()).root, 'tmp', 'real-data') })).toBe(false);
  });

  it('accepts only governed demo events', () => {
    expect(validateQaBridgeEvent({
      method: 'item/agentMessage/delta',
      params: { threadId: 'demo-live-thread', turnId: 'demo-turn', delta: '受控消息' },
    })).toMatchObject({ method: 'item/agentMessage/delta' });
    expect(() => validateQaBridgeEvent({ method: 'unknown/method', params: {} })).toThrow('方法不受允许');
    expect(() => validateQaBridgeEvent({ method: 'turn/started', params: { threadId: 'real-thread' } })).toThrow('只能作用于演示会话');
  });

  it('accepts only the explicit window and zoom matrix', () => {
    expect(validateQaWindowProfile({ width: 1050, height: 680, zoomFactor: 0.8 })).toEqual({ width: 1050, height: 680, zoomFactor: 0.8 });
    expect(validateQaWindowProfile({ width: 1280, height: 800, zoomFactor: 1 })).toEqual({ width: 1280, height: 800, zoomFactor: 1 });
    expect(validateQaWindowProfile({ width: 1540, height: 940, zoomFactor: 1.25 })).toEqual({ width: 1540, height: 940, zoomFactor: 1.25 });
    expect(() => validateQaWindowProfile({ width: 900, height: 600, zoomFactor: 2 })).toThrow('不在批准矩阵');
  });
});
