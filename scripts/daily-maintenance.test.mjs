import { describe, expect, it, vi } from 'vitest';
import { runDailyMaintenance } from './daily-maintenance.mjs';

describe('daily maintenance resource lifecycle', () => {
  it('waits for bridge stop before closing the database', async () => {
    const order = [];
    const store = {
      syncConversations: vi.fn(() => []),
      runDailyMaintenance: vi.fn(() => ({ created: 0, archived: 0 })),
      close: vi.fn(() => order.push('close')),
    };
    const bridge = {
      listThreads: vi.fn(async () => []),
      stop: vi.fn(async () => { order.push('stop-start'); await Promise.resolve(); order.push('stop-end'); }),
    };
    await runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      createStore: () => store,
      createBridge: () => bridge,
      output: vi.fn(),
    });
    expect(order).toEqual(['stop-start', 'stop-end', 'close']);
  });

  it('still closes the database and preserves a bridge stop failure', async () => {
    const stopError = new Error('stop failed');
    const order = [];
    const store = {
      syncConversations: vi.fn(() => []),
      runDailyMaintenance: vi.fn(() => ({ created: 0, archived: 0 })),
      close: vi.fn(() => order.push('close')),
    };
    const bridge = {
      listThreads: vi.fn(async () => []),
      stop: vi.fn(async () => { order.push('stop'); throw stopError; }),
    };
    await expect(runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      createStore: () => store,
      createBridge: () => bridge,
      output: vi.fn(),
    })).rejects.toBe(stopError);
    expect(order).toEqual(['stop', 'close']);
  });
});
