import React from 'react';

import { tGuanjia } from '../../services/guanjiaI18n';

export type GuanjiaCardStatus = 'idle' | 'active' | 'pending';

export interface GuanjiaSidebarCardProps {
  /** 是否处于激活选中状态 */
  isActive?: boolean;
  /** 显式指定状态，未传则依据 isActive 与 todoCount 计算 */
  status?: GuanjiaCardStatus;
  /** 门店名称 */
  storeName?: string | null;
  /** 待办事项数量，未获取或未知时为 null/undefined，不以 0 冒充 */
  todoCount?: number | null;
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
  storeName,
  todoCount,
  onClick,
  onAskAssistant,
  className = '',
}) => {
  // 计算当前卡片状态
  const computedStatus: GuanjiaCardStatus = React.useMemo(() => {
    if (propStatus) return propStatus;
    if (isActive) return 'active';
    if (typeof todoCount === 'number' && todoCount > 0) return 'pending';
    return 'idle';
  }, [propStatus, isActive, todoCount]);

  // 生成屏幕阅读器播报文本
  const ariaLabel = React.useMemo(() => {
    const storeInfo = storeName ? `，门店${storeName}` : '';
    switch (computedStatus) {
      case 'idle':
        return `${tGuanjia('guanjiaWorkspaceTitle')}，${tGuanjia('guanjiaSidebarCardIdle')}${storeInfo}`;
      case 'active':
        return `${tGuanjia('guanjiaWorkspaceTitle')}，${tGuanjia('guanjiaSidebarCardActive')}${storeInfo}`;
      case 'pending':
        return typeof todoCount === 'number' && todoCount > 0
          ? `${tGuanjia('guanjiaWorkspaceTitle')}，${tGuanjia('guanjiaSidebarCardPending')}${todoCount}条${storeInfo}`
          : `${tGuanjia('guanjiaWorkspaceTitle')}，${tGuanjia('guanjiaSidebarCardPending')}${storeInfo}`;
      default:
        return `${tGuanjia('guanjiaWorkspaceTitle')}${storeInfo}`;
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
      className={`group relative flex w-full cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary/60 ${statusStyles} ${className}`}
    >
      {/* 头部：图标与名称 */}
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm" aria-hidden="true" role="presentation">
            🏪
          </span>
          <span className="truncate text-xs font-semibold text-foreground">
            {tGuanjia('guanjiaWorkspaceTitle')}
          </span>
        </div>

        {/* 状态徽标 */}
        {computedStatus === 'idle' && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
            {tGuanjia('guanjiaSidebarCardIdle')}
          </span>
        )}
        {computedStatus === 'active' && (
          <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
            {tGuanjia('guanjiaSidebarCardActive')}
          </span>
        )}
        {computedStatus === 'pending' && typeof todoCount === 'number' && todoCount > 0 && (
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
              aria-label={tGuanjia('guanjiaSidebarAskAssistant')}
              className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-xs hover:bg-amber-600 active:scale-95 transition-all"
            >
              {tGuanjia('guanjiaSidebarAskAssistant')}
            </button>
          </div>
        )}
      </div>

      {/* 次要信息：门店名 */}
      {storeName ? (
        <div className="mt-1 flex items-center justify-between text-[11px] text-secondary">
          <span className="truncate">{storeName}</span>
        </div>
      ) : null}
    </div>
  );
};

export default GuanjiaSidebarCard;
