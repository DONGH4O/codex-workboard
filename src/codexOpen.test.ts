import { describe, expect, it, vi } from 'vitest';
import { codexHandoffNotice, codexOpenFallback, openCodexThreadWithNotice } from './codexOpen';

const fallback = {
  opened: false,
  fallbackCopied: true,
  instruction: 'Codex 深链接未能打开；会话标识已复制，请在 Codex 中手动打开该会话。',
};

describe('Codex renderer open feedback', () => {
  it('returns no notice after a normal open succeeds', async () => {
    const openThread = vi.fn(async () => ({ opened: true, fallbackCopied: false, instruction: '' }));
    await expect(openCodexThreadWithNotice('thread-ok', openThread, String)).resolves.toBeNull();
    expect(openThread).toHaveBeenCalledWith('thread-ok');
  });

  it('shows the copied-id instruction for every ordinary open caller', async () => {
    const openThread = vi.fn(async () => fallback);
    await expect(openCodexThreadWithNotice('thread-fallback', openThread, String)).resolves.toEqual({ tone: 'error', text: fallback.instruction });
    expect(codexOpenFallback(fallback)).toEqual({ tone: 'error', text: fallback.instruction });
  });

  it('turns an IPC rejection into a visible error notice', async () => {
    const openThread = vi.fn(async () => { throw new Error('IPC unavailable'); });
    await expect(openCodexThreadWithNotice('thread-error', openThread, (error) => (error as Error).message)).resolves.toEqual({ tone: 'error', text: 'IPC unavailable' });
  });

  it('distinguishes a successful handoff from a copied-id fallback', () => {
    expect(codexHandoffNotice({ opened: true, fallbackCopied: false, instruction: '' })).toEqual({
      tone: 'success',
      text: '已释放 Workboard 会话并转到 Codex，可在那里继续对话',
    });
    expect(codexHandoffNotice(fallback)).toEqual({ tone: 'error', text: fallback.instruction });
  });
});
