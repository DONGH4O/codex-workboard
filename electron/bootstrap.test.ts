import { describe, expect, it, vi } from 'vitest';
import { loadBootstrapConversations, loadConversationDirectory } from './bootstrap.js';

describe('bootstrap conversation loading', () => {
  it('does not call Codex when offline synchronization is explicitly skipped', async () => {
    const loadRemote = vi.fn(async () => [{ id: 'remote' }]);
    const persistRemote = vi.fn((threads: Array<{ id: string }>) => threads);
    const result = await loadBootstrapConversations({
      skipCodexSync: true,
      loadStored: () => [{ id: 'stored' }],
      loadRemote,
      persistRemote,
    });

    expect(result).toEqual({ threads: [{ id: 'stored' }], error: '', stale: false, skipped: true });
    expect(loadRemote).not.toHaveBeenCalled();
    expect(persistRemote).not.toHaveBeenCalled();
  });

  it('stores remote conversations when synchronization succeeds', async () => {
    const result = await loadBootstrapConversations({
      skipCodexSync: false,
      loadStored: () => [{ id: 'stored' }],
      loadRemote: async () => [{ id: 'remote' }],
      persistRemote: (threads) => threads.map((thread) => ({ ...thread, persisted: true })),
    });

    expect(result).toEqual({ threads: [{ id: 'remote', persisted: true }], error: '', stale: false, skipped: false });
  });

  it('returns stored conversations and a visible stale state when Codex fails', async () => {
    const result = await loadBootstrapConversations({
      skipCodexSync: false,
      loadStored: () => [{ id: 'stored' }],
      loadRemote: async () => { throw new Error('Codex unavailable'); },
      persistRemote: (threads) => threads,
    });

    expect(result).toEqual({ threads: [{ id: 'stored' }], error: 'Codex unavailable', stale: true, skipped: false });
  });

  it('keeps every isolated directory refresh local', async () => {
    const loadRemote = vi.fn(async () => [{ id: 'remote' }]);
    const persistRemote = vi.fn((threads: Array<{ id: string }>) => threads);

    const result = await loadConversationDirectory({
      skipCodexSync: true,
      loadStored: () => [{ id: 'stored' }],
      loadRemote,
      persistRemote,
    });

    expect(result).toEqual({ threads: [{ id: 'stored' }], skipped: true });
    expect(loadRemote).not.toHaveBeenCalled();
    expect(persistRemote).not.toHaveBeenCalled();
  });

  it('preserves ordinary remote directory synchronization', async () => {
    const loadRemote = vi.fn(async () => [{ id: 'remote' }]);
    const persistRemote = vi.fn((threads: Array<{ id: string }>) => threads.map((thread) => ({ ...thread, persisted: true })));

    await expect(loadConversationDirectory({
      skipCodexSync: false,
      loadStored: () => [{ id: 'stored' }],
      loadRemote,
      persistRemote,
    })).resolves.toEqual({ threads: [{ id: 'remote', persisted: true }], skipped: false });
    expect(loadRemote).toHaveBeenCalledOnce();
    expect(persistRemote).toHaveBeenCalledOnce();
  });
});
