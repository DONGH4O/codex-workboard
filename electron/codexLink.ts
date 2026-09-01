export interface CodexThreadOpenResult {
  opened: boolean;
  fallbackCopied: boolean;
  instruction: string;
}

export function validateCodexThreadId(threadId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error('无效的对话 ID');
  return threadId;
}

export async function openCodexThread(
  threadId: string,
  openExternal: (url: string) => Promise<void>,
  copyText: (text: string) => void,
): Promise<CodexThreadOpenResult> {
  const validated = validateCodexThreadId(threadId);
  try {
    await openExternal(`codex://threads/${encodeURIComponent(validated)}`);
    return { opened: true, fallbackCopied: false, instruction: '' };
  } catch {
    copyText(validated);
    return {
      opened: false,
      fallbackCopied: true,
      instruction: 'Codex 深链接未能打开；会话标识已复制，请在 Codex 中手动打开该会话。',
    };
  }
}
