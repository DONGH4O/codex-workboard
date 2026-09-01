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
    const lease = { release: vi.fn(() => order.push('release')) };
    await runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      createStore: () => store,
      createBridge: () => bridge,
      acquireDataAccess: () => lease,
      output: vi.fn(),
    });
    expect(order).toEqual(['stop-start', 'stop-end', 'close', 'release']);
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
    const lease = { release: vi.fn(() => order.push('release')) };
    await expect(runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      createStore: () => store,
      createBridge: () => bridge,
      acquireDataAccess: () => lease,
      output: vi.fn(),
    })).rejects.toBe(stopError);
    expect(order).toEqual(['stop', 'close', 'release']);
  });

  it('releases the data lease when store construction fails', async () => {
    const creationError = new Error('store creation failed');
    const lease = { release: vi.fn() };
    await expect(runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      acquireDataAccess: () => lease,
      createStore: () => { throw creationError; },
      createBridge: vi.fn(),
      output: vi.fn(),
    })).rejects.toBe(creationError);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the primary work error while still attempting every cleanup step', async () => {
    const primary = new Error('list failed');
    const store = { syncConversations: vi.fn(), runDailyMaintenance: vi.fn(), close: vi.fn(() => { throw new Error('close failed'); }) };
    const bridge = { listThreads: vi.fn(async () => { throw primary; }), stop: vi.fn(async () => { throw new Error('stop failed'); }) };
    const lease = { release: vi.fn(() => { throw new Error('release failed'); }) };
    await expect(runDailyMaintenance({
      env: { WORKBOARD_USER_DATA_DIR: 'F:\\isolated\\daily' },
      acquireDataAccess: () => lease,
      createStore: () => store,
      createBridge: () => bridge,
      output: vi.fn(),
    })).rejects.toBe(primary);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
