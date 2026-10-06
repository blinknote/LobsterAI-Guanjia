import React from 'react';

export type GuanjiaCardStatus = 'idle' | 'active' | 'pending';

export interface GuanjiaSidebarCardProps {
  /** 是否处于激活选中状态 */
  isActive?: boolean;
  /** 显式指定状态，未传则依据 isActive 与 todoCount 计算 */
  status?: GuanjiaCardStatus;
  /** 门店名称，默认“青盛堂旗舰店” */
  storeName?: string;
  /** 待办事项数量，默认 0 */
  todoCount?: number;
  /** 点击卡片回调 */
  onClick?: () => void;
  /** 点击问助手按钮回调 */
  onAskAssistant?: () => void;
  className?: string;
}

/**
 * 智慧管家置顶常驻卡片
 * - 常驻在侧栏顶部，不受下方会话列表滚动影响
 * - 支持三种状态：未打开 / 使用中 / 待办
 * - 完整无障碍支持（aria-label 朗读与键盘聚焦可达性）
 */
export const GuanjiaSidebarCard: React.FC<GuanjiaSidebarCardProps> = ({
  isActive = false,
  status: propStatus,
  storeName = '青盛堂旗舰店',
  todoCount = 0,
  onClick,
  onAskAssistant,
  className = '',
}) => {
  // 计算当前卡片状态
  const computedStatus: GuanjiaCardStatus = React.useMemo(() => {
    if (propStatus) return propStatus;
    if (isActive) return 'active';
    if (todoCount > 0) return 'pending';
    return 'idle';
  }, [propStatus, isActive, todoCount]);

  // 生成屏幕阅读器播报文本
  const ariaLabel = React.useMemo(() => {
    switch (computedStatus) {
      case 'idle':
        return `智慧管家，未打开，门店${storeName}`;
      case 'active':
        return `智慧管家，使用中，门店${storeName}`;
      case 'pending':
        return `智慧管家，待办${todoCount}条，门店${storeName}`;
      default:
        return `智慧管家，门店${storeName}`;
    }
  }, [computedStatus, storeName, todoCount]);

  // 键盘操作响应
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  // 根据状态获取边框与背景样式
  const statusStyles = React.useMemo(() => {
    switch (computedStatus) {
      case 'idle':
        return 'border-blue-500/40 bg-surface hover:border-blue-500 hover:bg-surface-raised';
      case 'active':
        return 'border-blue-500 bg-blue-500/10 shadow-sm';
      case 'pending':
        return 'border-amber-500/80 bg-amber-500/5 hover:border-amber-500';
      default:
        return 'border-border bg-surface';
    }
  }, [computedStatus]);

  return (
    <div
      id="guanjia-sidebar-card"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={`group relative flex w-full cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary/40 ${statusStyles} ${className}`}
    >
      {/* 头部：图标与名称 */}
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm" aria-hidden="true">
            🏪
          </span>
          <span className="truncate text-xs font-semibold text-foreground">
            智慧管家
          </span>
        </div>

        {/* 状态徽标 */}
        {computedStatus === 'idle' && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
            未打开
          </span>
        )}
        {computedStatus === 'active' && (
          <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
            使用中
          </span>
        )}
        {computedStatus === 'pending' && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              待办 {todoCount}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAskAssistant?.();
              }}
              aria-label="问助手"
              className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-xs hover:bg-amber-600 active:scale-95 transition-all"
            >
              问助手
            </button>
          </div>
        )}
      </div>

      {/* 次要信息：门店名 */}
      <div className="mt-1 flex items-center justify-between text-[11px] text-secondary">
        <span className="truncate">{storeName}</span>
      </div>
    </div>
  );
};

export default GuanjiaSidebarCard;
