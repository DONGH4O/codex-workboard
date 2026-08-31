export interface BootstrapConversationResult<T> {
  threads: T[];
  error: string;
  stale: boolean;
}

export async function loadBootstrapConversations<T, R = T>(input: {
  skipCodexSync: boolean;
  loadStored: () => T[];
  loadRemote: () => Promise<R[]>;
  persistRemote: (threads: R[]) => T[];
}): Promise<BootstrapConversationResult<T>> {
  if (input.skipCodexSync) {
    return { threads: input.loadStored(), error: '', stale: false };
  }
  try {
    const remote = await input.loadRemote();
    return { threads: input.persistRemote(remote), error: '', stale: false };
  } catch (cause) {
    return {
      threads: input.loadStored(),
      error: cause instanceof Error ? cause.message : String(cause),
      stale: true,
    };
  }
}
