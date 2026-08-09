import { describe, expect, it } from 'vitest';
import { inferConversationCategory } from './classifier.js';

describe('inferConversationCategory', () => {
  it('keeps foreign-rate projects separate from generic rate forecasting', () => {
    expect(inferConversationCategory({ name: '美元 SOFR 路径', cwd: '/Documents/外币利率预测项目' })).toBe('外币利率');
  });

  it('classifies Codex workflow conversations before generic project paths', () => {
    expect(inferConversationCategory({ preview: '升级 Codex 任务面板', cwd: '/Documents/Codex/new-chat' })).toBe('Codex 工作流');
  });

  it('falls back to project and uncategorized buckets', () => {
    expect(inferConversationCategory({ cwd: '/Documents/普通项目' })).toBe('其他项目');
    expect(inferConversationCategory({})).toBe('未分类');
  });
});
