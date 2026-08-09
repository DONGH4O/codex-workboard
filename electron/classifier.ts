export const DEFAULT_CATEGORIES = [
  '人民币利率',
  '外币利率',
  '知识库',
  '资产负债与风险',
  '同业对标',
  '报告与材料',
  '交易与回测',
  'Codex 工作流',
  '硬件与系统',
  '其他项目',
  '未分类',
] as const;

export function inferConversationCategory(input: { name?: unknown; preview?: unknown; cwd?: unknown }): string {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const preview = typeof input.preview === 'string' ? input.preview.trim() : '';
  // App Server previews for internal agents can contain an entire transcript.
  // Only the leading request describes the thread; later text is classification noise.
  const title = (name || preview).slice(0, 500).toLocaleLowerCase();
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim().toLocaleLowerCase() : '';

  // Stable project roots beat incidental keywords in prompts and generated summaries.
  if (/外币利率预测项目/.test(cwd)) return '外币利率';
  if (/知识库构建/.test(cwd)) return '知识库';
  if (/资产负债综合测算模块/.test(cwd)) return '资产负债与风险';
  if (/世界一流银行同业对比数据库/.test(cwd)) return '同业对标';
  if (/股票交易/.test(cwd)) return '交易与回测';
  if (/lofree|ble-usb-bridge|hid-bridge/.test(cwd)) return '硬件与系统';

  if (/codex 工作面板|codex对话管理|codex 任务|taskboard|任务面板|工作面板|app server|插件|plugin|skill|gpt-?5|glm coding|pro 20x|api成本/.test(title)) return 'Codex 工作流';
  if (/人民币|cny/.test(title)) return '人民币利率';
  if (/外币|美元|usd|sofr|effr|ust|foreign|fed|美债|美国利率/.test(title)) return '外币利率';
  if (/利率预测/.test(title)) return '人民币利率';
  if (/ble|hid|键盘|快捷键|wifi|wi-fi|vpn|网络排查|测试网络|硬件|固件/.test(title)) return '硬件与系统';
  if (/股票|基差交易|量化|仓位|选股|backtest|回测.*策略|交易策略/.test(title)) return '交易与回测';
  if (/资产负债|\balm\b|irrbb|流动性风险|利率汇率风险|综合测算/.test(title)) return '资产负债与风险';
  if (/同业对标|四大行|国股银行|银行对比|同业比较/.test(title)) return '同业对标';
  if (/wind|债券|国债|同业存单|利率预测|债市|货币政策|shibor|宏观|基本面|情景生成|ols|dfm|dns|投资组合|收益率|利率风险|风险指数|利率走势|模型池|观点发布/.test(title)) return '人民币利率';

  // Generic UI/report tasks inside these worktrees still belong to the CNY platform.
  if (/\/codex\/2026-06-(17|18)\/new-chat|\/codex\/2026-06-23\/nen/.test(cwd)) return '人民币利率';
  if (/知识库|obsidian|ima|笔记|资料库|knowledge|会计准则|机构观点/.test(title)) return '知识库';
  if (/报告|汇报|材料|ppt|演示|word|领导|李总|调研/.test(title)) return '报告与材料';
  if (cwd) return '其他项目';
  return '未分类';
}

export function parentConversationId(input: Record<string, unknown>): string | null {
  const seen = new Set<object>();
  const search = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['parent_thread_id', 'parentThreadId']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
    for (const nested of Object.values(record)) {
      const found = search(nested, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return search(input.source ?? input.threadSource, 0);
}
