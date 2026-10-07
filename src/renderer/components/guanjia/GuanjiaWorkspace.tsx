import React, { useCallback,useEffect, useRef, useState } from 'react';

export interface GuanjiaWorkspaceProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isAssistantOpen: boolean;
  onToggleAssistant: () => void;
  storeName?: string;
  currentUser?: string;
  currentPageName?: string;
  todoCount?: number;
  iframeUrl?: string;
  isVisible?: boolean;
  onStoreNameChange?: (name: string) => void;
  onTodoCountChange?: (count: number) => void;
}

/**
 * 智慧管家主工作区
 * - 主区与右侧助理抽屉采用 Flex 7:3 弹性收窄并排布局
 * - 抽屉展开时主区自动弹性收窄，绝不浮层遮挡管家右侧操作
 * - 通过 IPC (AttachView/DetachView/SetBounds/ShowView/HideView) 联动真实 WebContentsView
 * - 监听窗口 resize 及右侧助理抽屉展开/收缩过渡完成，动态获取容器 DOMRect 并更新 SetBounds
 * - 交班结账按钮直通 window.guanjiaBridge.clearAssistantSession()，静默清场无弹窗
 * - 内置骨架屏加载状态，切走不卸载保持草稿与现场
 * - 包含顶栏(#guanjia-topbar)、主区(#guanjia-main-container)无障碍焦点锚点
 */
export const GuanjiaWorkspace: React.FC<GuanjiaWorkspaceProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  isAssistantOpen,
  onToggleAssistant,
  storeName = '青盛堂旗舰店',
  currentUser = '李店长',
  currentPageName = '收银结账',
  todoCount = 3,
  iframeUrl = 'https://guanjia.qszy.me/',
  isVisible = true,
  onStoreNameChange,
  onTodoCountChange,
}) => {
  // 骨架屏加载状态
  const [isLoading, setIsLoading] = useState(true);
  // WebContentsView 真实视图附加状态
  const [isViewAttached, setIsViewAttached] = useState(false);
  // 助理输入框内容
  const [assistantInput, setAssistantInput] = useState('');
  // 助理操作流记录
  const [actionHistory, setActionHistory] = useState<Array<{ id: string; text: string; time: string; type: 'step' | 'confirm' | 'done' }>>([
    { id: '1', text: '定位订单 #20261024-082（顾客：张先生，足浴 70 分钟）', time: '14:28', type: 'step' },
    { id: '2', text: '核对账单原付金额 ¥198，已填报退款事由：技师超时未到岗', time: '14:29', type: 'step' },
  ]);
  // 当前悬停或落定确认状态
  const [pendingConfirm, setPendingConfirm] = useState<{
    active: boolean;
    amount: number;
    reason: string;
    resolved?: 'confirmed' | 'cancelled';
  }>({
    active: true,
    amount: 198,
    reason: '技师超时未到岗',
  });

  // DOM 容器引用
  const mainContainerRef = useRef<HTMLElement>(null);
  const viewContainerRef = useRef<HTMLDivElement>(null);
  const isAttachedRef = useRef<boolean>(false);

  // 模拟初次加载骨架屏过渡
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIsLoading(false);
    }, 450);
    return () => window.clearTimeout(timer);
  }, []);

  // IPC 接口调用封装（兼容 window.guanjiaBridge 与 window.electron.guanjia）
  const ipcAttachView = useCallback(async (bounds: { x: number; y: number; width: number; height: number }, url?: string) => {
    if (typeof window !== 'undefined') {
      if (window.guanjiaBridge?.attachView) {
        return window.guanjiaBridge.attachView({ bounds, initialUrl: url });
      }
      if (window.electron?.guanjia?.attachView) {
        return window.electron.guanjia.attachView({ bounds, initialUrl: url });
      }
    }
    return { success: false, error: 'IPC not available' };
  }, []);

  const ipcSetBounds = useCallback(async (bounds: { x: number; y: number; width: number; height: number }) => {
    if (typeof window !== 'undefined') {
      if (window.guanjiaBridge?.setBounds) {
        return window.guanjiaBridge.setBounds(bounds);
      }
      if (window.electron?.guanjia?.setBounds) {
        return window.electron.guanjia.setBounds(bounds);
      }
    }
    return { success: false };
  }, []);

  const ipcShowView = useCallback(async () => {
    if (typeof window !== 'undefined') {
      if (window.guanjiaBridge?.showView) {
        return window.guanjiaBridge.showView();
      }
      if (window.electron?.guanjia?.showView) {
        return window.electron.guanjia.showView();
      }
    }
    return { success: false };
  }, []);

  const ipcHideView = useCallback(async () => {
    if (typeof window !== 'undefined') {
      if (window.guanjiaBridge?.hideView) {
        return window.guanjiaBridge.hideView();
      }
      if (window.electron?.guanjia?.hideView) {
        return window.electron.guanjia.hideView();
      }
    }
    return { success: false };
  }, []);

  const ipcGetContext = useCallback(async () => {
    if (typeof window !== 'undefined') {
      if (window.guanjiaBridge?.getWorkspaceContext) {
        return window.guanjiaBridge.getWorkspaceContext();
      }
      if (window.electron?.guanjia?.getContext) {
        return await window.electron.guanjia.getContext();
      }
    }
    return null;
  }, []);

  // 加载工作区上下文并通知顶层状态更新
  useEffect(() => {
    if (isLoading || !isVisible) return;
    let isCancelled = false;

    const fetchContext = async () => {
      try {
        const ctx: any = await ipcGetContext();
        if (isCancelled || !ctx) return;
        const resolvedStoreName = ctx.currentShop?.name || ctx.currentUser?.shopName;
        if (resolvedStoreName && onStoreNameChange) {
          onStoreNameChange(resolvedStoreName);
        }
        if (typeof ctx.pendingCount === 'number' && onTodoCountChange) {
          onTodoCountChange(ctx.pendingCount);
        }
      } catch (err) {
        console.warn('[GuanjiaWorkspace] Failed to fetch workspace context:', err);
      }
    };

    fetchContext();

    return () => {
      isCancelled = true;
    };
  }, [isLoading, isVisible, ipcGetContext, onStoreNameChange, onTodoCountChange]);

  // 动态获取容器 DOMRect 并调用 SetBounds 更新视图大小
  const updateBounds = useCallback(() => {
    if (!isVisible) return;
    const container = viewContainerRef.current || mainContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      ipcSetBounds(bounds).catch(err => {
        console.warn('[GuanjiaWorkspace] setBounds failed:', err);
      });
    }
  }, [isVisible, ipcSetBounds]);

  // WebContentsView 真实联动：挂载、显隐与切走现场保持
  useEffect(() => {
    if (isLoading) return;

    const container = viewContainerRef.current || mainContainerRef.current;
    if (!container) return;

    if (!isVisible) {
      if (isAttachedRef.current) {
        ipcHideView().catch(console.error);
      }
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };

      if (!isAttachedRef.current) {
        ipcAttachView(bounds, iframeUrl || 'https://guanjia.qszy.me/')
          .then(res => {
            if (res.success) {
              isAttachedRef.current = true;
              setIsViewAttached(true);
            }
          })
          .catch(console.error);
      } else {
        ipcShowView().catch(console.error);
        ipcSetBounds(bounds).catch(console.error);
      }
    }

    return () => {
      ipcHideView().catch(console.error);
    };
  }, [isLoading, isVisible, iframeUrl, ipcAttachView, ipcShowView, ipcHideView, ipcSetBounds]);

  // 监听窗口 resize
  useEffect(() => {
    const handleResize = () => {
      updateBounds();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateBounds]);

  // 监听容器 ResizeObserver
  useEffect(() => {
    const container = viewContainerRef.current || mainContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      updateBounds();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [updateBounds]);

  // 监听右侧助理抽屉展开/收缩过渡完成
  useEffect(() => {
    if (isLoading || !isVisible) return;
    const timer1 = window.setTimeout(updateBounds, 100);
    const timer2 = window.setTimeout(updateBounds, 220);
    return () => {
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
    };
  }, [isAssistantOpen, isSidebarCollapsed, isLoading, isVisible, updateBounds]);

  // 主视区过渡完成事件
  const handleTransitionEnd = (e: React.TransitionEvent<HTMLElement>) => {
    if (e.target === mainContainerRef.current) {
      updateBounds();
    }
  };

  // 交班结账：接入 window.guanjiaBridge.clearAssistantSession()，静默清场无弹窗
  const handleShiftHandover = async () => {
    try {
      if (typeof window !== 'undefined') {
        if (window.guanjiaBridge?.clearAssistantSession) {
          await window.guanjiaBridge.clearAssistantSession();
        } else if (window.electron?.guanjia?.clearAssistantSession) {
          await window.electron.guanjia.clearAssistantSession();
        }
      }
    } catch (err) {
      console.warn('[GuanjiaWorkspace] Failed to silently clear assistant session:', err);
    }

    // 静默清空助理操作流记录与待确认卡片，不弹窗无干扰
    setActionHistory([]);
    setPendingConfirm({
      active: false,
      amount: 0,
      reason: '',
      resolved: 'cancelled',
    });
  };

  // 发送助理指令
  const handleSendAssistantMessage = () => {
    const trimmed = assistantInput.trim();
    if (!trimmed) return;
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    setActionHistory(prev => [
      ...prev,
      { id: Date.now().toString(), text: trimmed, time: timeStr, type: 'step' },
    ]);
    setAssistantInput('');
  };

  // 确认退款动作
  const handleConfirmAction = () => {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    setPendingConfirm(prev => ({ ...prev, active: false, resolved: 'confirmed' }));
    setActionHistory(prev => [
      ...prev,
      { id: Date.now().toString(), text: `已完成退款 ¥${pendingConfirm.amount}，流水已记入管家台账`, time: timeStr, type: 'done' },
    ]);
  };

  // 取消退款动作
  const handleCancelAction = () => {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    setPendingConfirm(prev => ({ ...prev, active: false, resolved: 'cancelled' }));
    setActionHistory(prev => [
      ...prev,
      { id: Date.now().toString(), text: '已取消退款操作，原订单状态保持不变', time: timeStr, type: 'done' },
    ]);
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {/* 顶栏 (Top Bar) - 支持快捷键聚焦 */}
      <header
        id="guanjia-topbar"
        tabIndex={0}
        aria-label={`智慧管家顶栏，当前门店：${storeName}，当前页面：${currentPageName}`}
        className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3 focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <div className="flex items-center gap-2.5">
          {isSidebarCollapsed && (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="展开侧栏"
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary/10 text-xs text-primary" aria-hidden="true">
              🏪
            </span>
            <span className="text-xs font-semibold text-foreground">
              {storeName}
            </span>
            <span className="text-secondary text-xs">/</span>
            <span className="text-xs text-secondary font-medium">
              {currentPageName}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-secondary">
            当前人：{currentUser}
          </span>
          {/* 切换助理抽屉按钮 */}
          <button
            type="button"
            onClick={onToggleAssistant}
            aria-expanded={isAssistantOpen}
            aria-label={isAssistantOpen ? '收起智慧管家助理' : '展开智慧管家助理'}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all ${
              isAssistantOpen
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'border border-border bg-surface-raised text-foreground hover:bg-surface-overlay'
            }`}
          >
            <span aria-hidden="true">🧭</span>
            <span>智慧管家助理</span>
            {todoCount > 0 && (
              <span className="ml-0.5 rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] text-white">
                {todoCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* 主体并排 Flex 容器：Flex 7:3 弹性收窄并排布局 */}
      <div className="relative flex flex-1 min-h-0 w-full flex-row overflow-hidden">
        {/* 左侧管家主视区：抽屉展开时弹性收窄至 70% (flex 7)，收起时 100% (flex 1) */}
        <main
          id="guanjia-main-container"
          ref={mainContainerRef}
          onTransitionEnd={handleTransitionEnd}
          tabIndex={0}
          aria-label="智慧管家主操作区"
          className="relative flex h-full flex-col overflow-hidden transition-[flex] duration-200 ease-out focus:outline-none focus:ring-1 focus:ring-primary"
          style={{
            flex: isAssistantOpen ? 7 : 1,
            minWidth: 0,
          }}
        >
          {isLoading ? (
            /* 骨架屏（Skeleton）加载占位，平滑过渡不转圈 */
            <div className="flex h-full w-full flex-col gap-4 p-4 animate-pulse bg-background" aria-busy="true" aria-label="管家界面加载中">
              <div className="h-10 w-full rounded-lg bg-surface-raised" />
              <div className="grid grid-cols-4 gap-3">
                <div className="h-20 rounded-lg bg-surface-raised" />
                <div className="h-20 rounded-lg bg-surface-raised" />
                <div className="h-20 rounded-lg bg-surface-raised" />
                <div className="h-20 rounded-lg bg-surface-raised" />
              </div>
              <div className="flex-1 w-full rounded-lg bg-surface-raised" />
            </div>
          ) : (
            /* WebContentsView 挂载区域：左侧 DOM 容器，真实挂载老秦主进程管理的 WebContentsView */
            <div
              id="guanjia-view-container"
              ref={viewContainerRef}
              tabIndex={isViewAttached ? -1 : 0}
              aria-label={isViewAttached ? "智慧管家原生工作区视图" : "智慧管家工作区视图"}
              className="relative flex h-full w-full flex-col overflow-hidden bg-background"
            >
              {/* 兜底与内嵌看板：展示开钟、收银、技师台账与右侧操作栏；真实 WebContentsView 加载后作为静默兜底，不与原生视区产生焦点与事件冲突 */}
              <div
                className={`flex h-full w-full flex-col overflow-y-auto bg-background p-4 text-foreground transition-opacity duration-150 ${
                  isViewAttached ? "pointer-events-none select-none opacity-0" : "opacity-100"
                }`}
                aria-hidden={isViewAttached}
              >
                {/* 顶部营收指标条 */}
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <div className="text-[11px] text-secondary">今日实收</div>
                    <div className="mt-1 text-lg font-bold text-foreground">¥8,460.00</div>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <div className="text-[11px] text-secondary">当前在钟</div>
                    <div className="mt-1 text-lg font-bold text-primary">12 台</div>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <div className="text-[11px] text-secondary">空闲技师</div>
                    <div className="mt-1 text-lg font-bold text-foreground">6 位</div>
                  </div>
                  <div className="rounded-lg border border-border bg-surface p-3">
                    <div className="text-[11px] text-secondary">待结台数</div>
                    <div className="mt-1 text-lg font-bold text-amber-500">2 台</div>
                  </div>
                </div>

                {/* 核心业务：开台/房态/收银看板与右侧操作栏 */}
                <div className="flex flex-1 flex-col rounded-lg border border-border bg-surface p-3.5">
                  <div className="mb-3 flex items-center justify-between border-b border-border pb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">房态看板</span>
                      <span className="text-[11px] text-secondary">（共 18 间房间）</span>
                    </div>
                    {/* 右侧核心高频操作按钮：弹性收窄时依然完全可见且可操作 */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        tabIndex={isViewAttached ? -1 : 0}
                        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-xs hover:bg-primary-hover active:scale-95 transition-all"
                      >
                        快速开台
                      </button>
                      <button
                        type="button"
                        tabIndex={isViewAttached ? -1 : 0}
                        className="rounded border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-overlay active:scale-95 transition-all"
                      >
                        挂单管理
                      </button>
                      <button
                        type="button"
                        tabIndex={isViewAttached ? -1 : 0}
                        onClick={handleShiftHandover}
                        aria-label="交班结账"
                        className="rounded border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-overlay active:scale-95 transition-all"
                      >
                        交班结账
                      </button>
                    </div>
                  </div>

                  {/* 房间列表网格 */}
                  <div className="grid flex-1 grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 overflow-y-auto">
                    {[
                      { room: '801 养生包', status: '在钟', time: '剩 25 分', master: '808号技师' },
                      { room: '802 足道房', status: '在钟', time: '剩 12 分', master: '812号技师' },
                      { room: '803 VIP房', status: '空闲', time: '可安排', master: '无' },
                      { room: '805 推拿室', status: '待结账', time: '已到钟', master: '805号技师' },
                      { room: '806 泰式房', status: '在钟', time: '剩 45 分', master: '816号技师' },
                      { room: '808 旗舰包', status: '打扫中', time: '整理中', master: '保洁' },
                      { room: '809 舒适双人间', status: '空闲', time: '可安排', master: '无' },
                      { room: '810 静心室', status: '在钟', time: '剩 18 分', master: '803号技师' },
                    ].map((item, idx) => (
                      <div
                        key={idx}
                        className={`flex flex-col justify-between rounded-lg border p-2.5 text-xs ${
                          item.status === '在钟'
                            ? 'border-blue-500/40 bg-blue-500/5'
                            : item.status === '待结账'
                            ? 'border-amber-500/60 bg-amber-500/5'
                            : 'border-border bg-surface-raised'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground">{item.room}</span>
                          <span
                            className={`rounded px-1 text-[10px] ${
                              item.status === '在钟'
                                ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                : item.status === '待结账'
                                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                : 'bg-surface-overlay text-secondary'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[11px] text-secondary">
                          <span>{item.master}</span>
                          <span>{item.time}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* 右侧助理抽屉：Flex 7:3 并排布局，宽度约 30%，抽屉展开时不遮挡管家右侧操作 */}
        {isAssistantOpen && (
          <aside
            id="guanjia-assistant-drawer"
            aria-label="智慧管家助理操作抽屉"
            className="relative flex h-full flex-col border-l border-border bg-surface transition-[flex] duration-200 ease-out"
            style={{
              flex: 3,
              minWidth: '320px',
              maxWidth: '420px',
            }}
          >
            {/* 抽屉头部 */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-sm">🧭</span>
                <span className="text-xs font-semibold text-foreground">智慧管家助理</span>
              </div>
              <button
                type="button"
                onClick={onToggleAssistant}
                aria-label="关闭智慧管家助理抽屉"
                className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 上下文条（浅灰底）：展示当前页面、当前人、当前店 */}
            <div className="flex flex-col gap-0.5 border-b border-border bg-surface-raised px-3 py-2 text-[11px] text-secondary">
              <div className="flex items-center justify-between">
                <span>当前：{currentPageName}</span>
                <span>当前店：{storeName}</span>
              </div>
              <div>当前人：{currentUser}</div>
            </div>

            {/* 对话与操作历史区 */}
            <div className="flex flex-1 flex-col space-y-3 overflow-y-auto p-3 text-xs">
              {actionHistory.map(item => (
                <div
                  key={item.id}
                  className={`rounded-lg border p-2.5 ${
                    item.type === 'done'
                      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300'
                      : 'border-border bg-surface-raised text-foreground'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-secondary">
                    <span>步骤记录</span>
                    <span>{item.time}</span>
                  </div>
                  <div className="mt-1 leading-relaxed">{item.text}</div>
                </div>
              ))}

              {/* “落定”确认卡片：凡是提交、扣款、退款、作废等动作，停下来等店员确认 */}
              {pendingConfirm.active && (
                <div className="rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 shadow-xs">
                  <div className="font-medium text-amber-900 dark:text-amber-200">
                    我已经填好原因了，要退这笔 ¥{pendingConfirm.amount} 吗？
                  </div>
                  <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    事由：{pendingConfirm.reason}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleConfirmAction}
                      className="inline-flex items-center justify-center rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-amber-600 active:scale-95 transition-all"
                    >
                      确认退款
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelAction}
                      className="inline-flex items-center justify-center rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised active:scale-95 transition-all"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 底部输入框：与宿主聊天框视觉规范一致 */}
            <div className="border-t border-border p-2.5 bg-surface">
              <div className="flex items-center rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-2xs focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                <input
                  type="text"
                  value={assistantInput}
                  onChange={(e) => setAssistantInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSendAssistantMessage();
                    }
                  }}
                  placeholder="问一句…"
                  className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSendAssistantMessage}
                  disabled={!assistantInput.trim()}
                  aria-label="发送给智慧管家助理"
                  className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:text-primary disabled:opacity-40 transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};

export default GuanjiaWorkspace;
