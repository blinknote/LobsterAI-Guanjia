import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useGuanjiaDesktopAuth } from '../../services/guanjiaDesktopAuth';
import { tGuanjia } from '../../services/guanjiaI18n';
import type { OpenAssistantParams } from '../../services/guanjiaNativeService';
import {
  type GuanjiaSessionStatus,
  useGuanjiaSession,
} from '../../services/guanjiaSession';
import GuanjiaNativeAssistant from './GuanjiaNativeAssistant';

export interface GuanjiaWorkspaceProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isAssistantOpen: boolean;
  onToggleAssistant: () => void;
  storeName?: string | null;
  currentUser?: string | null;
  currentPageName?: string | null;
  todoCount?: number | null;
  iframeUrl?: string;
  isVisible?: boolean;
  onStoreNameChange?: (name: string) => void;
  onTodoCountChange?: (count: number | null) => void;
  openAssistantPayload?: OpenAssistantParams | null;
  onClearOpenAssistantPayload?: () => void;
}

const getSessionStatusMessage = (status: GuanjiaSessionStatus): string => {
  switch (status) {
    case 'expired':
      return tGuanjia('guanjiaReverificationRequired');
    case 'temporarily_unavailable':
    case 'unavailable':
      return tGuanjia('guanjiaAuthUnavailable');
    case 'unauthenticated':
    default:
      return tGuanjia('guanjiaNotLoggedIn');
  }
};

const checkHasHostModal = (): boolean => {
  if (typeof document === 'undefined') return false;
  return Boolean(document.body.querySelector('[data-app-modal]'));
};

/**
 * 智慧管家主工作区
 * - 主区与右侧助理抽屉采用 Flex 7:3 弹性收窄并排布局
 * - 抽屉展开时主区自动弹性收窄，不遮挡管家主视区操作
 * - 通过 IPC (AttachView/DetachView/SetBounds/ShowView/HideView) 联动真实 WebContentsView
 * - 监听窗口 resize 及右侧助理抽屉展开/收缩过渡完成，动态获取容器 DOMRect 并更新 SetBounds
 * - 右侧内嵌原生 GuanjiaNativeAssistant 抽屉组件，对接真实 OpenClaw 与服务端受限工具
 * - 彻底移除虚构业务兜底看板，使用真实的 WebContentsView 连接与错误呈现
 */
export const GuanjiaWorkspace: React.FC<GuanjiaWorkspaceProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  isAssistantOpen,
  onToggleAssistant,
  storeName,
  currentUser,
  currentPageName,
  todoCount,
  iframeUrl = 'https://guanjia.qszy.me/',
  isVisible = true,
  onStoreNameChange,
  onTodoCountChange,
  openAssistantPayload,
  onClearOpenAssistantPayload,
}) => {
  const guanjiaSession = useGuanjiaSession();
  const sessionStatus = guanjiaSession.status;
  const sessionGeneration = guanjiaSession.generation;
  const isAuthenticated = sessionStatus === 'authenticated';
  const desktopAuth = useGuanjiaDesktopAuth();
  const isConfirmedUnbound = Boolean(
    !isAuthenticated &&
      desktopAuth.status.officialAuthenticated &&
      desktopAuth.status.bindingState === 'unbound',
  );

  // 宿主模态框检测：Modal 组件 portal 到 document.body 并携带 [data-app-modal]
  const [hasHostModal, setHasHostModal] = useState<boolean>(() => checkHasHostModal());

  // 真实业务有效可见性判定：业务已鉴权 + 顶层可见 + 宿主无弹窗遮挡
  const isEffectiveVisible = Boolean(isVisible && isAuthenticated && !hasHostModal);

  // WebContentsView 视图附加生命周期
  const [attachStatus, setAttachStatus] = useState<'idle' | 'attaching' | 'attached' | 'error'>('idle');
  const [attachError, setAttachError] = useState<string | null>(null);

  // DOM 容器引用
  const mainContainerRef = useRef<HTMLElement>(null);
  const viewContainerRef = useRef<HTMLDivElement>(null);
  const isAttachedRef = useRef<boolean>(false);
  const isAttachingRef = useRef<boolean>(false);

  // 有效可见性最新引用（同步守卫所有异步回调与事件触发）
  const effectiveVisibilityRef = useRef<boolean>(isEffectiveVisible);
  effectiveVisibilityRef.current = isEffectiveVisible;
  const currentGenerationRef = useRef<number>(sessionGeneration);
  currentGenerationRef.current = sessionGeneration;

  // IPC 接口调用封装（兼容 window.guanjiaBridge 与 window.electron.guanjia）
  const ipcAttachView = useCallback(async (bounds: { x: number; y: number; width: number; height: number }, url?: string) => {
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        guanjiaBridge?: { attachView?: (args: { bounds: { x: number; y: number; width: number; height: number }; initialUrl?: string }) => Promise<{ success: boolean; error?: string }> };
        electron?: { guanjia?: { attachView?: (args: { bounds: { x: number; y: number; width: number; height: number }; initialUrl?: string }) => Promise<{ success: boolean; error?: string }> } };
      };
      if (win.guanjiaBridge?.attachView) {
        return win.guanjiaBridge.attachView({ bounds, initialUrl: url });
      }
      if (win.electron?.guanjia?.attachView) {
        return win.electron.guanjia.attachView({ bounds, initialUrl: url });
      }
    }
    return { success: false, error: 'IPC not available' };
  }, []);

  const ipcSetBounds = useCallback(async (bounds: { x: number; y: number; width: number; height: number }) => {
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        guanjiaBridge?: { setBounds?: (b: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }> };
        electron?: { guanjia?: { setBounds?: (b: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }> } };
      };
      if (win.guanjiaBridge?.setBounds) {
        return win.guanjiaBridge.setBounds(bounds);
      }
      if (win.electron?.guanjia?.setBounds) {
        return win.electron.guanjia.setBounds(bounds);
      }
    }
    return { success: false };
  }, []);

  const ipcShowView = useCallback(async () => {
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        guanjiaBridge?: { showView?: () => Promise<{ success: boolean }> };
        electron?: { guanjia?: { showView?: () => Promise<{ success: boolean }> } };
      };
      if (win.guanjiaBridge?.showView) {
        return win.guanjiaBridge.showView();
      }
      if (win.electron?.guanjia?.showView) {
        return win.electron.guanjia.showView();
      }
    }
    return { success: false };
  }, []);

  const ipcHideView = useCallback(async () => {
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        guanjiaBridge?: { hideView?: () => Promise<{ success: boolean }> };
        electron?: { guanjia?: { hideView?: () => Promise<{ success: boolean }> } };
      };
      if (win.guanjiaBridge?.hideView) {
        return win.guanjiaBridge.hideView();
      }
      if (win.electron?.guanjia?.hideView) {
        return win.electron.guanjia.hideView();
      }
    }
    return { success: false };
  }, []);

  const ipcGetContext = useCallback(async () => {
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        guanjiaBridge?: { getWorkspaceContext?: () => Promise<unknown> };
        electron?: { guanjia?: { getContext?: () => Promise<unknown> } };
      };
      if (win.guanjiaBridge?.getWorkspaceContext) {
        return win.guanjiaBridge.getWorkspaceContext();
      }
      if (win.electron?.guanjia?.getContext) {
        return await win.electron.guanjia.getContext();
      }
    }
    return null;
  }, []);

  // 监听 document.body 下 [data-app-modal] 模态框变化（仅限当前 app 所属 body）
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return undefined;

    let prevHasModal = checkHasHostModal();
    if (prevHasModal) {
      effectiveVisibilityRef.current = false;
      ipcHideView().catch(console.error);
    }

    const observer = new MutationObserver(() => {
      const hasModal = checkHasHostModal();
      if (hasModal !== prevHasModal) {
        prevHasModal = hasModal;
        if (hasModal) {
          effectiveVisibilityRef.current = false;
          ipcHideView().catch(console.error);
        }
        setHasHostModal(hasModal);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [ipcHideView]);

  // 有效可见性改变时，若变为不可见则在渲染上屏前立即隐藏原生视图（保留实例）
  useLayoutEffect(() => {
    effectiveVisibilityRef.current = isEffectiveVisible;
    if (!isEffectiveVisible) {
      ipcHideView().catch(console.error);
    }
  }, [isEffectiveVisible, ipcHideView]);

  // 加载工作区上下文并通知顶层状态更新
  useEffect(() => {
    if (!isEffectiveVisible) return;
    let isCancelled = false;
    const requestGeneration = sessionGeneration;

    const fetchContext = async () => {
      try {
        if (!effectiveVisibilityRef.current || currentGenerationRef.current !== requestGeneration) return;
        const ctx = (await ipcGetContext()) as {
          currentShop?: { name?: string };
          currentUser?: { shopName?: string };
          pendingCount?: number;
        } | null;
        if (
          isCancelled ||
          !effectiveVisibilityRef.current ||
          currentGenerationRef.current !== requestGeneration
        ) {
          return;
        }
        if (!ctx) {
          if (!isCancelled && onTodoCountChange) {
            onTodoCountChange(null);
          }
          return;
        }
        const resolvedStoreName = ctx.currentShop?.name || ctx.currentUser?.shopName;
        if (resolvedStoreName && onStoreNameChange) {
          onStoreNameChange(resolvedStoreName);
        }
        if (typeof ctx.pendingCount === 'number' && onTodoCountChange) {
          onTodoCountChange(ctx.pendingCount);
        } else if (onTodoCountChange) {
          onTodoCountChange(null);
        }
      } catch (err) {
        console.warn('[GuanjiaWorkspace] Failed to fetch workspace context:', err);
        if (
          !isCancelled &&
          onTodoCountChange &&
          effectiveVisibilityRef.current &&
          currentGenerationRef.current === requestGeneration
        ) {
          onTodoCountChange(null);
        }
      }
    };

    void fetchContext();

    return () => {
      isCancelled = true;
    };
  }, [isEffectiveVisible, sessionGeneration, ipcGetContext, onStoreNameChange, onTodoCountChange]);

  // 动态获取容器 DOMRect 并调用 SetBounds 更新视图大小
  const updateBounds = useCallback(() => {
    if (!effectiveVisibilityRef.current) return;
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
      ipcSetBounds(bounds).catch((err) => {
        console.warn('[GuanjiaWorkspace] setBounds failed:', err);
      });
    }
  }, [ipcSetBounds]);

  // 监听登录就绪事件：自动刷新上下文与就绪 WebContentsView
  useEffect(() => {
    const handleWorkspaceReady = () => {
      if (!effectiveVisibilityRef.current) return;
      updateBounds();
      ipcShowView()
        .then(() => {
          if (!effectiveVisibilityRef.current) {
            ipcHideView().catch(console.error);
          }
        })
        .catch(console.error);
    };
    window.addEventListener('guanjia:workspace-ready', handleWorkspaceReady);
    return () => {
      window.removeEventListener('guanjia:workspace-ready', handleWorkspaceReady);
    };
  }, [updateBounds, ipcShowView, ipcHideView]);

  // 附加 WebContentsView 视图
  const attachWorkspaceView = useCallback(() => {
    const container = viewContainerRef.current || mainContainerRef.current;
    if (!container) return;

    if (!effectiveVisibilityRef.current) {
      ipcHideView().catch(console.error);
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
        if (isAttachingRef.current) return;
        isAttachingRef.current = true;
        setAttachStatus('attaching');
        setAttachError(null);
        ipcAttachView(bounds, iframeUrl || 'https://guanjia.qszy.me/')
          .then((res) => {
            isAttachingRef.current = false;
            if (res.success) {
              isAttachedRef.current = true;
              setAttachStatus('attached');
              if (!effectiveVisibilityRef.current) {
                ipcHideView().catch(console.error);
              }
            } else {
              setAttachStatus('error');
              setAttachError(res.error || tGuanjia('guanjiaConnectFailed'));
            }
          })
          .catch((err) => {
            isAttachingRef.current = false;
            setAttachStatus('error');
            setAttachError(err instanceof Error ? err.message : String(err));
          });
      } else {
        ipcSetBounds(bounds)
          .then(() => {
            if (!effectiveVisibilityRef.current) {
              return ipcHideView().catch(console.error);
            }
            return ipcShowView().then(() => {
              if (!effectiveVisibilityRef.current) {
                ipcHideView().catch(console.error);
              }
            });
          })
          .catch(console.error);
      }
    }
  }, [iframeUrl, ipcAttachView, ipcShowView, ipcHideView, ipcSetBounds]);

  // 组件卸载生命周期清理：设置有效可见性为 false 并隐藏原生视图，防止异步回调残留展示
  useEffect(() => {
    return () => {
      effectiveVisibilityRef.current = false;
      ipcHideView().catch(console.error);
    };
  }, [ipcHideView]);

  // WebContentsView 真实联动：有效可见时附加/展示，不可见时仅隐藏保持现场
  useEffect(() => {
    if (isEffectiveVisible) {
      attachWorkspaceView();
    } else {
      ipcHideView().catch(console.error);
    }

    return () => {
      ipcHideView().catch(console.error);
    };
  }, [isEffectiveVisible, attachWorkspaceView, ipcHideView]);

  // 监听窗口 resize
  useEffect(() => {
    const handleResize = () => {
      if (effectiveVisibilityRef.current) {
        updateBounds();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateBounds]);

  // 监听容器 ResizeObserver
  useEffect(() => {
    const container = viewContainerRef.current || mainContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      if (effectiveVisibilityRef.current) {
        updateBounds();
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [updateBounds]);

  // 监听右侧助理抽屉展开/收缩过渡完成
  useEffect(() => {
    if (!isEffectiveVisible) return;
    const timer1 = window.setTimeout(() => {
      if (effectiveVisibilityRef.current) updateBounds();
    }, 100);
    const timer2 = window.setTimeout(() => {
      if (effectiveVisibilityRef.current) updateBounds();
    }, 220);
    return () => {
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
    };
  }, [isAssistantOpen, isSidebarCollapsed, isEffectiveVisible, updateBounds]);

  // 主视区过渡完成事件
  const handleTransitionEnd = (e: React.TransitionEvent<HTMLElement>) => {
    if (e.target === mainContainerRef.current && effectiveVisibilityRef.current) {
      updateBounds();
    }
  };

  // 重试连接 WebContentsView
  const handleRetryAttach = () => {
    isAttachedRef.current = false;
    isAttachingRef.current = false;
    attachWorkspaceView();
  };

  // 触发原生登录弹窗（通过已注册在 LoginButton 的标准事件）
  const handleOpenNativeLogin = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('guanjia:open-login'));
    }
  }, []);

  // 触发原生绑定弹窗（通过已注册在 LoginButton 的标准事件）
  const handleOpenNativeBind = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('guanjia:open-bind'));
    }
  }, []);

  // 清除本地助理会话
  const handleClearAssistantSession = async () => {
    try {
      if (typeof window !== 'undefined') {
        const win = window as unknown as {
          guanjiaBridge?: { clearAssistantSession?: () => Promise<unknown> };
          electron?: { guanjia?: { clearAssistantSession?: () => Promise<unknown> } };
        };
        if (win.guanjiaBridge?.clearAssistantSession) {
          await win.guanjiaBridge.clearAssistantSession();
        } else if (win.electron?.guanjia?.clearAssistantSession) {
          await win.electron.guanjia.clearAssistantSession();
        }
      }
    } catch (err) {
      console.warn('[GuanjiaWorkspace] Failed to silently clear assistant session:', err);
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {/* 顶栏 (Top Bar) - 支持快捷键聚焦 */}
      <header
        id="guanjia-topbar"
        tabIndex={0}
        aria-label={`${tGuanjia('guanjiaTopbarLabel')}${storeName ? `，当前门店：${storeName}` : ''}${currentPageName ? `，当前页面：${currentPageName}` : ''}${currentUser ? `，当前人：${currentUser}` : ''}`}
        className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3 focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <div className="flex items-center gap-2.5">
          {isSidebarCollapsed && (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={tGuanjia('guanjiaExpandSidebar')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true" role="presentation">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary/10 text-xs text-primary" aria-hidden="true" role="presentation">
              🏪
            </span>
            <span className="text-xs font-semibold text-foreground">
              {storeName || tGuanjia('guanjiaWorkspaceTitle')}
            </span>
            {currentPageName ? (
              <>
                <span className="text-secondary text-xs" aria-hidden="true">/</span>
                <span className="text-xs text-secondary font-medium">
                  {currentPageName}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {currentUser ? (
            <span className="text-[11px] text-secondary">
              当前人：{currentUser}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void handleClearAssistantSession()}
            aria-label={tGuanjia('guanjiaClearSession')}
            className="inline-flex h-7 items-center rounded border border-border bg-surface px-2 text-xs font-medium text-secondary hover:bg-surface-raised hover:text-foreground active:scale-95 transition-all"
          >
            {tGuanjia('guanjiaClearSession')}
          </button>
          {/* 切换助理抽屉按钮 */}
          <button
            type="button"
            onClick={onToggleAssistant}
            aria-expanded={isAssistantOpen}
            aria-label={isAssistantOpen ? tGuanjia('guanjiaAssistantClose') : tGuanjia('guanjiaAssistantOpen')}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all ${
              isAssistantOpen
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'border border-border bg-surface-raised text-foreground hover:bg-surface-overlay'
            }`}
          >
            <span aria-hidden="true" role="presentation">🧭</span>
            <span>{tGuanjia('guanjiaAssistantTitle')}</span>
            {typeof todoCount === 'number' && todoCount > 0 && (
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
          aria-label={tGuanjia('guanjiaMainAreaLabel')}
          className="relative flex h-full flex-col overflow-hidden transition-[flex] duration-200 ease-out focus:outline-none focus:ring-1 focus:ring-primary"
          style={{
            flex: isAssistantOpen ? 7 : 1,
            minWidth: 0,
          }}
        >
          {/* WebContentsView 挂载区域：左侧 DOM 容器，真实承载主进程管理的 WebContentsView */}
          <div
            id="guanjia-view-container"
            ref={viewContainerRef}
            tabIndex={attachStatus === 'attached' && isEffectiveVisible ? -1 : 0}
            aria-label={tGuanjia('guanjiaViewLabel')}
            className="relative flex h-full w-full flex-col overflow-hidden bg-background"
          >
            {sessionStatus === 'restoring' ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-4"
                role="status"
                aria-busy="true"
                aria-label={tGuanjia('guanjiaConnecting')}
              >
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" role="presentation" />
                <span className="text-xs text-secondary">{tGuanjia('guanjiaConnecting')}</span>
              </div>
            ) : !isAuthenticated ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-4 text-center"
                role="status"
                aria-label={isConfirmedUnbound ? tGuanjia('guanjiaUnbound') : getSessionStatusMessage(sessionStatus)}
              >
                <div className="text-xs font-medium text-secondary">
                  {isConfirmedUnbound ? tGuanjia('guanjiaUnbound') : getSessionStatusMessage(sessionStatus)}
                </div>
                <button
                  type="button"
                  onClick={isConfirmedUnbound ? handleOpenNativeBind : handleOpenNativeLogin}
                  aria-label={isConfirmedUnbound ? tGuanjia('guanjiaBindAccount') : tGuanjia('guanjiaLogin')}
                  className="rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised active:scale-95 transition-all"
                >
                  {isConfirmedUnbound ? tGuanjia('guanjiaBindAccount') : tGuanjia('guanjiaLogin')}
                </button>
              </div>
            ) : attachStatus === 'attaching' ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-4"
                role="status"
                aria-busy="true"
                aria-label={tGuanjia('guanjiaViewLoadingLabel')}
              >
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" role="presentation" />
                <span className="text-xs text-secondary">{tGuanjia('guanjiaConnecting')}</span>
              </div>
            ) : attachStatus === 'error' ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-4 text-center"
                role="alert"
                aria-label={tGuanjia('guanjiaConnectFailed')}
              >
                <div className="text-xs font-medium text-destructive">
                  {attachError || tGuanjia('guanjiaConnectFailed')}
                </div>
                <button
                  type="button"
                  onClick={handleRetryAttach}
                  aria-label={tGuanjia('guanjiaRetryConnect')}
                  className="rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised active:scale-95 transition-all"
                >
                  {tGuanjia('guanjiaRetryConnect')}
                </button>
              </div>
            ) : null}
          </div>
        </main>

        {/* 右侧助理抽屉：始终挂载保持现场与会话状态，关闭时仅隐藏 DOM 与停止焦点捕获 */}
          <aside
            id="guanjia-assistant-drawer"
            aria-label={tGuanjia('guanjiaAssistantDrawerLabel')}
          aria-hidden={!isAssistantOpen || !isVisible}
          className={`relative h-full flex-col border-l border-border bg-surface transition-[flex] duration-200 ease-out ${
            isAssistantOpen ? 'flex' : 'hidden'
          }`}
            style={{
            flex: isAssistantOpen ? 3 : 0,
            minWidth: isAssistantOpen ? '320px' : '0px',
              maxWidth: '420px',
            }}
          >
            <GuanjiaNativeAssistant
              onClose={onToggleAssistant}
              storeName={storeName}
              currentUser={currentUser}
              currentPageName={currentPageName}
              isExpanded={isAssistantOpen && isEffectiveVisible}
              onFocusWorkspace={() => {
                if (effectiveVisibilityRef.current) {
                  mainContainerRef.current?.focus();
                }
              }}
              openAssistantPayload={openAssistantPayload}
              onClearOpenAssistantPayload={onClearOpenAssistantPayload}
            />
          </aside>
      </div>
    </div>
  );
};

export default GuanjiaWorkspace;
