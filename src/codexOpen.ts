import type { CodexThreadOpenResult } from './types';

export type CodexOpenNotice = { tone: 'error' | 'success'; text: string };

export function codexOpenFallback(result: CodexThreadOpenResult | undefined): CodexOpenNotice | null {
  if (!result || result.opened) return null;
  return { tone: 'error', text: result.instruction };
}

export async function openCodexThreadWithNotice(
  threadId: string,
  openThread: (threadId: string) => Promise<CodexThreadOpenResult>,
  errorText: (error: unknown) => string,
): Promise<CodexOpenNotice | null> {
  try {
    return codexOpenFallback(await openThread(threadId));
  } catch (error) {
    return { tone: 'error', text: errorText(error) };
  }
}

export function codexHandoffNotice(result: CodexThreadOpenResult | undefined): CodexOpenNotice {
  return codexOpenFallback(result) ?? { tone: 'success', text: '已释放 Workboard 会话并转到 Codex，可在那里继续对话' };
}
