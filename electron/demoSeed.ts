import type { ExecutionSnapshot } from './executionTracker.js';
import type { TaskStore } from './taskStore.js';

type DemoExecutionStore = Pick<TaskStore, 'saveExecutionSnapshot' | 'markExecutionStarted'>;

export function saveDemoExecution(store: DemoExecutionStore, snapshot: ExecutionSnapshot): ExecutionSnapshot {
  if (!snapshot.turnId) throw new Error('演示执行快照必须包含回合标识');
  const saved = store.saveExecutionSnapshot(snapshot);
  store.markExecutionStarted(snapshot.taskId, snapshot.turnId);
  return saved;
}
