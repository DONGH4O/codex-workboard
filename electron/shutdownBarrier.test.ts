import { describe, expect, it, vi } from 'vitest';
import { createShutdownBarrier } from './shutdownBarrier.js';

describe('application shutdown barrier', () => {
  it('prevents every quit request and runs cleanup and exit exactly once', async () => {
    let finish!: () => void;
    const closeResources = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const exit = vi.fn();
    const barrier = createShutdownBarrier(closeResources, exit);
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    const pending = barrier(first);
    const samePending = barrier(second);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(closeResources).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await Promise.all([pending, samePending]);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
