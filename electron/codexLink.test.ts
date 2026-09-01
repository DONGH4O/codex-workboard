import { describe, expect, it, vi } from 'vitest';
import { openCodexThread, validateCodexThreadId } from './codexLink.js';

describe('Codex deep-link fallback', () => {
  it('opens a validated Codex thread link without touching the clipboard', async () => {
    const openExternal = vi.fn(async () => undefined);
    const copyText = vi.fn();

    await expect(openCodexThread('thread-123', openExternal, copyText)).resolves.toEqual({
      opened: true,
      fallbackCopied: false,
      instruction: '',
    });
    expect(openExternal).toHaveBeenCalledWith('codex://threads/thread-123');
    expect(copyText).not.toHaveBeenCalled();
  });

  it('copies the exact thread id and returns manual guidance when the deep link fails', async () => {
    const openExternal = vi.fn(async () => { throw new Error('protocol unavailable'); });
    const copyText = vi.fn();

    const result = await openCodexThread('thread-fallback', openExternal, copyText);

    expect(copyText).toHaveBeenCalledWith('thread-fallback');
    expect(result).toEqual({
      opened: false,
      fallbackCopied: true,
      instruction: 'Codex 深链接未能打开；会话标识已复制，请在 Codex 中手动打开该会话。',
    });
  });

  it('rejects an invalid thread id before opening or copying', async () => {
    const openExternal = vi.fn(async () => undefined);
    const copyText = vi.fn();

    expect(() => validateCodexThreadId('../thread')).toThrow('无效的对话 ID');
    await expect(openCodexThread('../thread', openExternal, copyText)).rejects.toThrow('无效的对话 ID');
    expect(openExternal).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
  });
});
