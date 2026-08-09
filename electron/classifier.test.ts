import { describe, expect, it } from 'vitest';
import { inferConversationCategory, parentConversationId } from './classifier.js';

describe('inferConversationCategory', () => {
  it('keeps foreign-rate projects separate from generic rate forecasting', () => {
    expect(inferConversationCategory({ name: '美元 SOFR 路径', cwd: '/Documents/外币利率预测项目' })).toBe('外币利率');
  });

  it('does not mistake the generic Codex worktree path for a Codex workflow topic', () => {
    expect(inferConversationCategory({ preview: '升级 Codex 任务面板', cwd: '/Documents/Codex/new-chat' })).toBe('Codex 工作流');
    expect(inferConversationCategory({ name: '修复宏观情景生成器逻辑', cwd: '/Documents/Codex/2026-06-18/new-chat' })).toBe('人民币利率');
    expect(inferConversationCategory({ preview: '为什么风险指数和利率走势不一致', cwd: '/Documents/Codex/thread-copy' })).toBe('人民币利率');
  });

  it('uses stable project roots for knowledge, ALM, peer, trading, and hardware work', () => {
    expect(inferConversationCategory({ name: '每日更新', cwd: '/Documents/知识库构建' })).toBe('知识库');
    expect(inferConversationCategory({ name: '综合测算模块V1', cwd: '/Documents/资产负债综合测算模块' })).toBe('资产负债与风险');
    expect(inferConversationCategory({ name: '更新美国四大行报告', cwd: '/Documents/世界一流银行同业对比数据库' })).toBe('同业对标');
    expect(inferConversationCategory({ name: '制定并回测基差交易策略', cwd: '/Documents/股票交易' })).toBe('交易与回测');
    expect(inferConversationCategory({ name: '设置 Windows 快捷键', cwd: '/Documents/Codex/lofree-ble-usb-bridge' })).toBe('硬件与系统');
  });

  it('extracts the parent conversation from subagent source metadata', () => {
    expect(parentConversationId({ source: { subAgent: { thread_spawn: { parent_thread_id: 'parent-1' } } } })).toBe('parent-1');
  });

  it('falls back to project and uncategorized buckets', () => {
    expect(inferConversationCategory({ cwd: '/Documents/普通项目' })).toBe('其他项目');
    expect(inferConversationCategory({})).toBe('未分类');
  });
});
