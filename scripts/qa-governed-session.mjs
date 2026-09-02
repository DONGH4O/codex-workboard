import { combinePrimaryAndCleanupError, runCleanupActions } from './qa-runtime.mjs';

export async function establishGovernedSession(options) {
  const { session, sessions, waitForPort, waitForPage, connectPage, closeProcess, assertLeaseReleased } = options;
  sessions.push(session);
  try {
    const port = await waitForPort();
    const page = await waitForPage(port);
    Object.assign(session, await connectPage(page, (socket) => { session.socket = socket; }));
    return session;
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    const cleanupErrors = await runCleanupActions([
      ['早期 CDP 连接关闭', async () => session.socket?.close()],
      ['早期目录包进程退出', closeProcess],
      ['早期 writer lease 释放', assertLeaseReleased],
    ]);
    if (!cleanupErrors.length) session.closed = true;
    throw combinePrimaryAndCleanupError(primaryError, cleanupErrors);
  }
}

export async function cleanupGovernedSessions(options) {
  const { sessions, closeTrackedProcess, assertLeaseReleased } = options;
  const cleanupErrors = await runCleanupActions(sessions.map((session, index) => [
    `目录包进程 ${index + 1} 退出`,
    async () => {
      if (session.closed || session.child.exitCode !== null || session.child.signalCode !== null) return;
      const graceful = typeof session.request === 'function'
        ? () => session.request('Page.close').catch(() => session.child.kill('SIGTERM'))
        : () => session.child.kill('SIGTERM');
      await closeTrackedProcess(session, graceful);
    },
  ]));
  cleanupErrors.push(...await runCleanupActions([
    ['CDP 连接关闭', async () => { for (const session of sessions) session.socket?.close(); }],
    ['writer lease 释放', assertLeaseReleased],
  ]));
  return cleanupErrors;
}
