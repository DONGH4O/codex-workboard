import { describe, expect, it, vi } from 'vitest';
import { refreshThreadsAfterTaskCreation } from './conversationSync';

describe('conversation synchronization policy', () => {
  it('does not request the remote directory after isolated task creation', async () => {
    const listThreads = vi.fn(async () => []);

    const result = await refreshThreadsAfterTaskCreation({
      createConversation: true,
      threadId: 'new-thread',
      syncSkipped: true,
      listThreads,
    });

    expect(result).toBeNull();
    expect(listThreads).not.toHaveBeenCalled();
  });

  it('refreshes the directory after ordinary conversation creation', async () => {
    const threads = [{ id: 'new-thread', name: 'New thread' }];
    const listThreads = vi.fn(async () => threads);

    await expect(refreshThreadsAfterTaskCreation({
      createConversation: true,
      threadId: 'new-thread',
      syncSkipped: false,
      listThreads,
    })).resolves.toBe(threads);
    expect(listThreads).toHaveBeenCalledOnce();
  });

  it.each([
    ['task without a new conversation', false, 'new-thread'],
    ['conversation creation without a returned thread', true, null],
  ])('does not refresh for %s', async (_label, createConversation, threadId) => {
    const listThreads = vi.fn(async () => []);

    await expect(refreshThreadsAfterTaskCreation({
      createConversation,
      threadId,
      syncSkipped: false,
      listThreads,
    })).resolves.toBeNull();
    expect(listThreads).not.toHaveBeenCalled();
  });
});
