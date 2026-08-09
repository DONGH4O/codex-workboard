export type Lane = 'plan' | 'execution' | 'review';
export type Substatus = 'idea' | 'ready' | 'claimed' | 'running' | 'blocked' | 'pending_review' | 'rework' | 'accepted' | 'closed';

export function defaultSubstatus(lane: Lane): Substatus {
  if (lane === 'plan') return 'ready';
  if (lane === 'execution') return 'claimed';
  return 'pending_review';
}

export function assertReviewSeparation(executor: string | null, auditor: string): void {
  const normalizedAuditor = auditor.trim().toLocaleLowerCase();
  const normalizedExecutor = executor?.trim().toLocaleLowerCase();
  if (!normalizedAuditor) throw new Error('验收人不能为空');
  if (normalizedExecutor && normalizedExecutor === normalizedAuditor) {
    throw new Error('验收人必须独立于执行人');
  }
}

export function laneForDecision(decision: 'accepted' | 'rework' | 'closed'): Lane {
  return decision === 'rework' ? 'execution' : 'review';
}

