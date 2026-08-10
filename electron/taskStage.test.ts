import { describe, expect, it } from 'vitest';
import { conversationTaskTitle, inferConversationStage } from './taskStage.js';

describe('conversation task staging', () => {
  it('routes archived and review-oriented conversations to acceptance', () => {
    expect(inferConversationStage({ name: '历史任务', archived: true }).lane).toBe('review');
    expect(inferConversationStage({ name: '核查利率风险波动值', archived: false }).lane).toBe('review');
  });

  it('separates planning from execution work', () => {
    expect(inferConversationStage({ name: '制定美元利率预测迁移计划' }).lane).toBe('plan');
    expect(inferConversationStage({ name: '修复 OLS 入模因子' })).toMatchObject({ lane: 'execution', substatus: 'claimed' });
    expect(inferConversationStage({ name: 'Codex 工作面板｜计划·执行·验收和回顾' }).lane).toBe('execution');
  });

  it('extracts a concise task title from an ambient browser preview', () => {
    expect(conversationTaskTitle({
      preview: '<in-app-browser-context>ignore</in-app-browser-context>\n## My request:\n升级任务工作面板',
    })).toBe('升级任务工作面板');
  });
});
