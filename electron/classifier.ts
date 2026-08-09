export const DEFAULT_CATEGORIES = [
  'Codex 工作流',
  '人民币利率',
  '外币利率',
  '知识库',
  '报告与材料',
  '交易与回测',
  '其他项目',
  '未分类',
] as const;

export function inferConversationCategory(input: { name?: unknown; preview?: unknown; cwd?: unknown }): string {
  const text = [input.name, input.preview, input.cwd]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLocaleLowerCase();

  if (/codex|taskboard|任务面板|工作面板|app server|插件|plugin|skill|自动化|agent/.test(text)) return 'Codex 工作流';
  if (/外币|美元|usd|sofr|effr|ust|foreign|fed|美债/.test(text)) return '外币利率';
  if (/人民币|cny|wind|债券|国债|同业存单|利率预测|货币政策|shibor/.test(text)) return '人民币利率';
  if (/知识库|obsidian|ima|笔记|资料库|knowledge/.test(text)) return '知识库';
  if (/报告|汇报|材料|ppt|演示|word|领导|李总|调研/.test(text)) return '报告与材料';
  if (/股票|交易|回测|量化|仓位|策略|选股|backtest/.test(text)) return '交易与回测';
  if (typeof input.cwd === 'string' && input.cwd.trim()) return '其他项目';
  return '未分类';
}
