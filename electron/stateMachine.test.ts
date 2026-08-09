import { describe, expect, it } from 'vitest';
import { assertReviewSeparation, defaultSubstatus, laneForDecision } from './stateMachine.js';

describe('task state machine', () => {
  it('derives governed lane defaults', () => {
    expect(defaultSubstatus('plan')).toBe('ready');
    expect(defaultSubstatus('execution')).toBe('claimed');
    expect(defaultSubstatus('review')).toBe('pending_review');
  });

  it('prevents an executor accepting their own work', () => {
    expect(() => assertReviewSeparation('Alice', ' alice ')).toThrow('验收人必须独立于执行人');
    expect(() => assertReviewSeparation('Alice', 'Bob')).not.toThrow();
  });

  it('routes rework back to execution', () => {
    expect(laneForDecision('rework')).toBe('execution');
    expect(laneForDecision('accepted')).toBe('review');
  });
});
