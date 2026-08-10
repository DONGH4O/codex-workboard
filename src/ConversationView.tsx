import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Folder,
  Link2,
  MessageSquareText,
  Pin,
  Plus,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import type { CodexThreadSummary } from './types';

function titleOf(thread: CodexThreadSummary): string {
  return thread.name?.trim() || thread.preview?.trim() || '未命名对话';
}

function shortPath(path?: string | null): string {
  if (!path) return '未设置项目';
  return path.split('/').filter(Boolean).slice(-2).join('/');
}

function timeOf(value?: number | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value * 1000));
}

function statusLabel(status: string): string {
  if (status === 'active') return '执行中';
  if (status === 'idle') return '已就绪';
  if (status === 'systemError') return '异常';
  return '未载入';
}

function categoryTone(category: string): string {
  const tones: Record<string, string> = {
    'Codex 工作流': 'blue',
    '人民币利率': 'mint',
    '外币利率': 'cyan',
    '知识库': 'violet',
    '资产负债与风险': 'coral',
    '同业对标': 'amber',
    '报告与材料': 'amber',
    '交易与回测': 'coral',
    '硬件与系统': 'slate',
    '未分类': 'gray',
  };
  return tones[category] ?? 'slate';
}

export function ConversationView({ threads, categories, archivedOnly, filter, selectedId, onSelect, onBulkCreate, bulkBusy }: {
  threads: CodexThreadSummary[];
  categories: string[];
  archivedOnly: boolean;
  filter: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onBulkCreate(): void;
  bulkBusy: boolean;
}) {
  const [category, setCategory] = useState('全部分类');
  useEffect(() => setCategory('全部分类'), [archivedOnly]);

  const scoped = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return threads.filter((thread) => {
      if (thread.archived !== archivedOnly) return false;
      if (category !== '全部分类' && thread.category !== category) return false;
      if (!query) return true;
      return `${titleOf(thread)} ${thread.preview} ${thread.cwd ?? ''} ${thread.category} ${thread.tags.join(' ')}`.toLocaleLowerCase().includes(query);
    });
  }, [archivedOnly, category, filter, threads]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    threads.filter((thread) => thread.archived === archivedOnly).forEach((thread) => map.set(thread.category, (map.get(thread.category) ?? 0) + 1));
    return map;
  }, [archivedOnly, threads]);

  return (
    <section className="conversation-manager" aria-label={archivedOnly ? '已归档对话' : '全部对话'}>
      <aside className="category-rail">
        <div className="category-rail-title"><strong>分类</strong><span>{counts.size}</span></div>
        <button type="button" className={category === '全部分类' ? 'active' : ''} onClick={() => setCategory('全部分类')}>
          <span className="category-dot tone-all" />全部分类<b>{Array.from(counts.values()).reduce((sum, value) => sum + value, 0)}</b>
        </button>
        {categories.filter((item) => counts.has(item)).map((item) => (
          <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>
            <span className={`category-dot tone-${categoryTone(item)}`} />{item}<b>{counts.get(item)}</b>
          </button>
        ))}
        <div className="category-note"><Sparkles size={14} /><span>首次同步按主题自动归类；右侧详情可人工调整。</span></div>
      </aside>

      <div className="conversation-list-pane">
        <div className="conversation-list-header">
          <div><strong>{archivedOnly ? '已归档对话' : category}</strong><span>{scoped.length} 个结果</span></div>
          <div className="conversation-list-header-actions">
            <span>按最近更新排序</span>
            <button type="button" className="bulk-task-button" onClick={onBulkCreate} disabled={bulkBusy}>
              <Plus size={13} />{bulkBusy ? '正在生成…' : '批量转为任务'}
            </button>
          </div>
        </div>
        <div className="conversation-list" role="list">
          {scoped.map((thread) => (
            <button
              type="button"
              className={`conversation-row ${selectedId === thread.id ? 'selected' : ''}`}
              key={thread.id}
              onClick={() => onSelect(thread.id)}
              role="listitem"
            >
              <span className={`conversation-avatar tone-${categoryTone(thread.category)}`}><MessageSquareText size={16} /></span>
              <span className="conversation-copy">
                <span className="conversation-title">{titleOf(thread)}{thread.isPinned && <Pin size={12} />}</span>
                <span className="conversation-preview">{thread.preview || '暂无摘要'}</span>
                <span className="conversation-meta"><Folder size={12} />{shortPath(thread.cwd)}<i />{thread.category}{thread.linkedTaskCount > 0 && <><i /><Link2 size={12} />{thread.linkedTaskCount} 个任务</>}</span>
              </span>
              <span className="conversation-state"><span className={`runtime-dot runtime-${thread.runtimeStatus}`} />{statusLabel(thread.runtimeStatus)}<small>{timeOf(thread.updatedAt)}</small></span>
            </button>
          ))}
          {!scoped.length && (
            <div className="conversation-empty"><Archive size={20} /><strong>{archivedOnly ? '没有已归档对话' : '此分类暂无对话'}</strong><span>尝试切换分类或清除搜索条件。</span></div>
          )}
        </div>
      </div>
    </section>
  );
}

export function ConversationPanel({ thread, categories, onClose, onUpdate, onCreateTask, onOpen }: {
  thread: CodexThreadSummary;
  categories: string[];
  onClose(): void;
  onUpdate(thread: CodexThreadSummary): void;
  onCreateTask(threadId: string): void;
  onOpen(threadId: string): void;
}) {
  const [category, setCategory] = useState(thread.category);
  const [tags, setTags] = useState(thread.tags.join(', '));
  const [note, setNote] = useState(thread.note);

  useEffect(() => {
    setCategory(thread.category);
    setTags(thread.tags.join(', '));
    setNote(thread.note);
  }, [thread]);

  async function save(input: { category?: string; tags?: string[]; note?: string }) {
    onUpdate(await window.codexTaskboard.updateConversation(thread.id, input));
  }

  return (
    <aside className="detail-panel conversation-detail">
      <div className="panel-header"><strong>对话详情</strong><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div>
      <div className="panel-scroll">
        <div className="conversation-heading">
          <span className={`category-badge tone-${categoryTone(thread.category)}`}>{thread.category}</span>
          <h2>{titleOf(thread)}</h2>
          <p>{thread.preview || '暂无对话摘要。'}</p>
        </div>
        <div className="conversation-actions">
          <button type="button" className="primary-button" onClick={() => onCreateTask(thread.id)}><Plus size={15} />转为任务</button>
          <button type="button" className="secondary-button" onClick={() => onOpen(thread.id)}><ExternalLink size={14} />在 Codex 打开</button>
        </div>
        <div className="detail-section">
          <h3>分类管理</h3>
          <label className="panel-field"><span><Tag size={14} />分类</span><input list="conversation-categories" value={category} onChange={(event) => setCategory(event.target.value)} onBlur={() => void save({ category })} /><datalist id="conversation-categories">{categories.map((item) => <option value={item} key={item} />)}</datalist></label>
          <label className="panel-field"><span><Tag size={14} />标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} onBlur={() => void save({ tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })} placeholder="逗号分隔，最多 12 个" /></label>
          <label className="panel-note"><span>管理备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} onBlur={() => void save({ note })} rows={4} placeholder="记录该对话的用途、下一步或交接信息" /></label>
        </div>
        <div className="detail-section">
          <h3>对话信息</h3>
          <div className="property-row"><span><Folder size={14} />项目</span><strong>{shortPath(thread.cwd)}</strong></div>
          <div className="property-row"><span><Bot size={14} />来源</span><strong>{thread.sourceKind || thread.modelProvider || 'Codex'}</strong></div>
          <div className="property-row"><span><Clock3 size={14} />最近更新</span><strong>{timeOf(thread.updatedAt)}</strong></div>
          <div className="property-row"><span><CheckCircle2 size={14} />分类来源</span><strong>{thread.classificationSource === 'manual' ? '人工维护' : '规则自动分类'}</strong></div>
          <div className="property-row"><span><Link2 size={14} />关联任务</span><strong>{thread.linkedTaskCount} 个</strong></div>
        </div>
      </div>
    </aside>
  );
}
