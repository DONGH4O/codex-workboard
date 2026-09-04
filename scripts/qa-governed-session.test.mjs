import { describe, expect, it, vi } from 'vitest';
import { cleanupGovernedSessions, establishGovernedSession } from './qa-governed-session.mjs';

function fixture(overrides = {}) {
  const sessions = [];
  const session = { child: { pid: 42 }, tracked: { child: { pid: 42 } }, socket: null, closed: false };
  const closeProcess = vi.fn(async () => undefined);
  const assertLeaseReleased = vi.fn(async () => true);
  return {
    sessions,
    session,
    closeProcess,
    assertLeaseReleased,
    options: {
      session,
      sessions,
      waitForPort: vi.fn(async () => 9222),
      waitForPage: vi.fn(async () => ({ webSocketDebuggerUrl: 'ws://qa' })),
      connectPage: vi.fn(async () => ({ request: vi.fn(), evaluate: vi.fn(), waitUntil: vi.fn() })),
      closeProcess,
      assertLeaseReleased,
      ...overrides,
    },
  };
}

describe('governed packaged UI early launch lifecycle', () => {
  it('registers and closes the exact tracked child when DevTools port discovery fails', async () => {
    const data = fixture({
      waitForPort: vi.fn(async () => { throw new Error('port timeout'); }),
    });
    data.options.waitForPort = vi.fn(async () => {
      expect(data.sessions).toContain(data.session);
      throw new Error('port timeout');
    });
    await expect(establishGovernedSession(data.options)).rejects.toThrow('port timeout');
    expect(data.closeProcess).toHaveBeenCalledTimes(1);
    expect(data.assertLeaseReleased).toHaveBeenCalledTimes(1);
    expect(data.session.closed).toBe(true);
  });

  it('closes a partially created socket, child and lease when CDP connection fails', async () => {
    const socket = { close: vi.fn() };
    const data = fixture({
      connectPage: vi.fn(async (_page, registerSocket) => {
        registerSocket(socket);
        throw new Error('connect failed');
      }),
    });
    await expect(establishGovernedSession(data.options)).rejects.toThrow('connect failed');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(data.closeProcess).toHaveBeenCalledTimes(1);
    expect(data.assertLeaseReleased).toHaveBeenCalledTimes(1);
    expect(data.session.closed).toBe(true);
  });

  it('returns the registered session after all connection phases succeed', async () => {
    const data = fixture();
    await expect(establishGovernedSession(data.options)).resolves.toBe(data.session);
    expect(data.sessions).toEqual([data.session]);
    expect(data.closeProcess).not.toHaveBeenCalled();
    expect(data.session.request).toBeTypeOf('function');
  });

  it('runs outer cleanup after a fully settled port failure without fake socket or request errors', async () => {
    const data = fixture();
    data.options.waitForPort = vi.fn(async () => { throw new Error('port timeout'); });
    await expect(establishGovernedSession(data.options)).rejects.toThrow('port timeout');
    const closeTrackedProcess = vi.fn();
    const errors = await cleanupGovernedSessions({
      sessions: data.sessions,
      closeTrackedProcess,
      assertLeaseReleased: data.assertLeaseReleased,
    });
    expect(errors).toEqual([]);
    expect(closeTrackedProcess).not.toHaveBeenCalled();
    expect(data.assertLeaseReleased).toHaveBeenCalledTimes(2);
  });

  it('retries a partial session without CDP by terminating its exact tracked child', async () => {
    const data = fixture();
    data.session.child = { exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    data.session.tracked = { child: data.session.child };
    const firstCleanupFailure = vi.fn(async () => { throw new Error('first close failed'); });
    data.options.closeProcess = firstCleanupFailure;
    data.options.waitForPort = vi.fn(async () => { throw new Error('port timeout'); });
    let original;
    try { await establishGovernedSession(data.options); } catch (error) { original = error; }
    expect(original.message).toBe('port timeout');
    expect(original.cleanupFailures).toContain('早期目录包进程退出: first close failed');
    const closeTrackedProcess = vi.fn(async (_session, graceful) => { graceful(); });
    const errors = await cleanupGovernedSessions({
      sessions: data.sessions,
      closeTrackedProcess,
      assertLeaseReleased: data.assertLeaseReleased,
    });
    expect(errors).toEqual([]);
    expect(closeTrackedProcess).toHaveBeenCalledWith(data.session, expect.any(Function));
    expect(data.session.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses whole-application quit for macOS cleanup and window close for Windows cleanup', async () => {
    for (const [platform, expectedMethod] of [['darwin', 'Browser.close'], ['win32', 'Page.close']]) {
      const data = fixture();
      data.session.child = { exitCode: null, signalCode: null, kill: vi.fn() };
      data.session.request = vi.fn(async () => undefined);
      const closeTrackedProcess = vi.fn(async (_session, graceful) => graceful());
      const errors = await cleanupGovernedSessions({
        sessions: [data.session],
        closeTrackedProcess,
        assertLeaseReleased: data.assertLeaseReleased,
        platform,
      });
      expect(errors).toEqual([]);
      expect(data.session.request).toHaveBeenCalledWith(expectedMethod);
      expect(data.session.child.kill).not.toHaveBeenCalled();
    }
  });
});
