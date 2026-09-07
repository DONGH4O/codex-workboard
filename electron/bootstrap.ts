export interface BootstrapConversationResult<T> {
  threads: T[];
  error: string;
  stale: boolean;
  skipped: boolean;
}

export interface ConversationDirectoryInput<T, R = T> {
  skipCodexSync: boolean;
  loadStored: () => T[];
  loadRemote: () => Promise<R[]>;
  persistRemote: (threads: R[]) => T[];
}

export async function loadConversationDirectory<T, R = T>(input: ConversationDirectoryInput<T, R>): Promise<{ threads: T[]; skipped: boolean }> {
  if (input.skipCodexSync) {
    return { threads: input.loadStored(), skipped: true };
  }
  return { threads: input.persistRemote(await input.loadRemote()), skipped: false };
}

export async function loadBootstrapConversations<T, R = T>(input: ConversationDirectoryInput<T, R>): Promise<BootstrapConversationResult<T>> {
  try {
    const result = await loadConversationDirectory(input);
    return { ...result, error: '', stale: false };
  } catch (cause) {
    return {
      threads: input.loadStored(),
      error: cause instanceof Error ? cause.message : String(cause),
      stale: true,
      skipped: false,
    };
  }
}
