import { describe, expect, it } from 'vitest';
import { buildThreadResumeParams, buildThreadStartParams, buildTurnInterruptParams, buildTurnStartParams, buildTurnSteerParams, codexExecutableCandidates, isThreadNotFoundError, isValidApprovalRequestId, isValidRequestId, resolveCodexExecutable } from './codexBridge.js';

describe('Codex turn permissions', () => {
  it('accepts zero as a valid JSON-RPC approval request id', () => {
    expect(isValidApprovalRequestId(0)).toBe(true);
    expect(isValidApprovalRequestId(1)).toBe(true);
    expect(isValidApprovalRequestId(-1)).toBe(false);
    expect(isValidApprovalRequestId(Number.NaN)).toBe(false);
    expect(isValidRequestId('request-1')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
  });

  it('maps full access to no approvals and dangerFullAccess sandbox', () => {
    expect(buildTurnStartParams({
      threadId: 'thread-1',
      text: 'run',
      cwd: '/tmp/project',
      permissionPreset: 'full-access',
    })).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      cwd: '/tmp/project',
    });
  });

  it('always restores workspaceWrite when leaving full access', () => {
    expect(buildTurnStartParams({
      threadId: 'thread-1',
      text: 'continue',
      cwd: '/tmp/project',
      permissionPreset: 'on-request',
    })).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/project'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    });
    expect(() => buildTurnStartParams({ threadId: 'thread-1', text: 'continue', cwd: 'relative/project' })).toThrow('绝对路径');
  });

  it('passes real service tiers to new threads and turns', () => {
    expect(buildThreadStartParams({ title: '新任务', model: 'gpt-5.6-sol', serviceTier: 'priority', cwd: '/tmp/project' })).toEqual({
      model: 'gpt-5.6-sol',
      serviceTier: 'priority',
      cwd: '/tmp/project',
    });
    expect(buildTurnStartParams({ threadId: 'thread-1', text: 'run', serviceTier: 'priority' })).toMatchObject({ serviceTier: 'priority' });
    expect(buildTurnStartParams({ threadId: 'thread-1', text: 'run', serviceTier: null })).toHaveProperty('serviceTier', null);
  });

  it('resumes a persisted thread before starting another turn', () => {
    expect(buildThreadResumeParams('thread-1')).toEqual({ threadId: 'thread-1' });
    expect(() => buildThreadResumeParams('')).toThrow('缺少要恢复的对话 ID');
    expect(isThreadNotFoundError(new Error('thread not found: thread-1'))).toBe(true);
    expect(isThreadNotFoundError(new Error('connection failed'))).toBe(false);
  });

  it('steers the exact active turn without starting a new turn', () => {
    expect(buildTurnSteerParams({ threadId: 'thread-1', turnId: 'turn-1', text: '  改为先验证数据  ' })).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: '改为先验证数据', text_elements: [] }],
    });
    expect(() => buildTurnSteerParams({ threadId: 'thread-1', turnId: '', text: '继续' })).toThrow('缺少要引导的执行回合 ID');
  });

  it('sends local screenshots with new turns and active-turn guidance', () => {
    expect(buildTurnStartParams({ threadId: 'thread-1', text: '请看截图', images: [{ path: '/tmp/screen.png', detail: 'original' }] })).toMatchObject({
      input: [
        { type: 'text', text: '请看截图', text_elements: [] },
        { type: 'localImage', path: '/tmp/screen.png', detail: 'original' },
      ],
    });
    expect(buildTurnSteerParams({ threadId: 'thread-1', turnId: 'turn-1', text: '', images: [{ path: '/tmp/pasted.png' }] })).toMatchObject({
      input: [{ type: 'localImage', path: '/tmp/pasted.png' }],
    });
  });

  it('targets the exact turn when handing execution back to Codex', () => {
    expect(buildTurnInterruptParams('thread-1', 'turn-1')).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(() => buildTurnInterruptParams('thread-1', '')).toThrow('缺少要转交的执行回合');
  });

  it('discovers Codex without relying on a login shell PATH', () => {
    const candidates = codexExecutableCandidates({ platform: 'linux', explicitPath: '/custom/codex', pathValue: '/first/bin:/second/bin', home: '/tmp/tester' });
    expect(candidates.slice(0, 3)).toEqual(['/custom/codex', '/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']);
    expect(candidates).toContain('/first/bin/codex');
    expect(candidates).toContain('/second/bin/codex');
    expect(candidates).toContain('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(resolveCodexExecutable({ platform: process.platform, explicitPath: process.execPath, pathValue: '', home: '/definitely/missing' })).toBe(process.execPath);
  });
});
