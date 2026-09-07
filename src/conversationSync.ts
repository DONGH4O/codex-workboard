import type { CodexThreadSummary } from './types';

export async function refreshThreadsAfterTaskCreation(input: {
  createConversation: boolean;
  threadId: string | null;
  syncSkipped: boolean;
  listThreads: () => Promise<CodexThreadSummary[]>;
}): Promise<CodexThreadSummary[] | null> {
  if (!input.createConversation || !input.threadId || input.syncSkipped) return null;
  return input.listThreads();
}
