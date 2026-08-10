import type { Lane, Substatus } from './stateMachine.js';

export interface ConversationStageInput {
  name?: unknown;
  preview?: unknown;
  archived?: unknown;
}

export interface ConversationStage {
  lane: Lane;
  substatus: Substatus;
  executor: string | null;
  acceptanceCriteria: string;
}

function textOf(input: ConversationStageInput): string {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const preview = typeof input.preview === 'string' ? input.preview.trim() : '';
  return (name || preview).slice(0, 240).toLocaleLowerCase();
}

export function inferConversationStage(input: ConversationStageInput): ConversationStage {
  const text = textOf(input);
  const lane: Lane = input.archived === true
    ? 'review'
    : /codex.*工作面板|工作面板.*计划.*执行/.test(text)
      ? 'execution'
    : /复核|验收|回顾|审计|核查|全面检查|检查.*(?:错误|问题)|验证|review/.test(text)
      ? 'review'
      : /制定|规划|计划|梳理|调研|查找|确认|分析|评估|解释|估算|设计|方案|建议|为什么|如何|可行性|研究/.test(text)
        ? 'plan'
        : /修复|优化|开发|更新|刷新|继续|完成|完善|增加|添加|接入|配置|搭建|构造|重构|制作|同步|补齐|改进|排查|设置|恢复|推动|统一|修改|调整|改成|改为|放在|移到|删除|去掉|显示|隐藏|解决|实施|执行|创建|整理|统计|测试|建立|安装|迁移|承接|跟进/.test(text)
          ? 'execution'
          : 'plan';

  if (lane === 'execution') {
    return {
      lane,
      substatus: 'claimed',
      executor: 'Codex 对话执行',
      acceptanceCriteria: '关联对话已形成可验证产出，阻塞项和遗留问题已记录。',
    };
  }
  if (lane === 'review') {
    return {
      lane,
      substatus: 'pending_review',
      executor: 'Codex 对话执行',
      acceptanceCriteria: '由独立审计角色核对关联对话的结果、证据和遗留问题。',
    };
  }
  return {
    lane,
    substatus: 'ready',
    executor: null,
    acceptanceCriteria: '目标、范围、优先级和下一步已明确，可以进入执行阶段。',
  };
}

export function conversationTaskTitle(input: ConversationStageInput): string {
  if (typeof input.name === 'string' && input.name.trim()) return shorten(input.name.trim());
  let preview = typeof input.preview === 'string' ? input.preview : '';
  preview = preview.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, ' ');
  const request = preview.match(/## My request(?: for Codex)?:\s*([\s\S]+)/i)?.[1];
  if (request?.trim()) preview = request;
  const normalized = preview.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  return shorten(normalized || '未命名 Codex 对话');
}

function shorten(value: string): string {
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}
