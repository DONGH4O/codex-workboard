export interface QuitEventLike {
  preventDefault(): void;
}

export function createShutdownBarrier(closeResources: () => Promise<void>, exit: () => void) {
  let pending: Promise<void> | null = null;
  return (event: QuitEventLike): Promise<void> => {
    event.preventDefault();
    if (!pending) {
      pending = closeResources()
        .catch(() => undefined)
        .finally(exit);
    }
    return pending;
  };
}
