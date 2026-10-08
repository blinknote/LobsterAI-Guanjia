import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GuanjiaAssistantType } from '../../../shared/guanjia/native';
import { tGuanjia } from '../../services/guanjiaI18n';
import {
  GuanjiaMessageMetadataKey,
  guanjiaNativeService,
  GuanjiaPendingAction,
  OpenAssistantParams,
} from '../../services/guanjiaNativeService';
import { useGuanjiaSession } from '../../services/guanjiaSession';
import type { CoworkMessage } from '../../types/cowork';
import MarkdownContent from '../MarkdownContent';

function decodeVerifiedMemberAssets(action: GuanjiaPendingAction) {
  const rawDetails = action.rawDetails as Record<string, unknown> | undefined;
  const assets = (action.verifiedAssets || rawDetails?.verified_member_assets || rawDetails?.verifiedAssets) as Record<string, unknown> | undefined;
  if (!assets && !action.memberName && action.amount == null) return null;

  const rawMemberName = action.memberName || assets?.member_name || assets?.memberName;
  const balance = assets?.balance ?? assets?.total_balance;
  const principal = assets?.principal ?? assets?.principal_balance;
  const bonus = assets?.bonus ?? assets?.gift_balance ?? assets?.bonus_balance;
  const remainingTimes = assets?.remainingTimes ?? assets?.remaining_times;
  const originalAmount = assets?.originalAmount ?? assets?.original_amount ?? action.amount;
  const discount = assets?.discount;

  if (!rawMemberName && balance == null && principal == null && bonus == null && remainingTimes == null && originalAmount == null && discount == null) {
    return null;
  }

  return {
    memberName: rawMemberName ? String(rawMemberName) : undefined,
    balance: balance != null ? String(balance) : undefined,
    principal: principal != null ? String(principal) : undefined,
    bonus: bonus != null ? String(bonus) : undefined,
    remainingTimes: remainingTimes != null ? String(remainingTimes) : undefined,
    originalAmount: originalAmount != null ? String(originalAmount) : undefined,
    discount: discount != null ? String(discount) : undefined,
  };
}

function mergeRawMessages(local: CoworkMessage[], incoming: CoworkMessage[]): CoworkMessage[] {
  const localMap = new Map<string, CoworkMessage>();
  for (const m of local) {
    localMap.set(m.id, m);
  }

  const result: CoworkMessage[] = [];
  for (const inc of incoming) {
    const existing = localMap.get(inc.id);
    if (existing) {
      localMap.delete(inc.id);
      const incDisplay = inc.metadata?.[GuanjiaMessageMetadataKey.DisplayContent];
      const existDisplay = existing.metadata?.[GuanjiaMessageMetadataKey.DisplayContent];
      const displayContent =
        typeof incDisplay === 'string'
          ? incDisplay
          : typeof existDisplay === 'string'
          ? existDisplay
          : undefined;
      result.push({
        ...inc,
        metadata: {
          ...existing.metadata,
          ...inc.metadata,
          ...(displayContent !== undefined ? { [GuanjiaMessageMetadataKey.DisplayContent]: displayContent } : {}),
        },
      });
    } else {
      result.push(inc);
    }
  }

  for (const remaining of localMap.values()) {
    result.push(remaining);
  }

  return result;
}

export interface GuanjiaNativeAssistantProps {
  onClose: () => void;
  storeName?: string | null;
  currentUser?: string | null;
  currentPageName?: string | null;
  isExpanded?: boolean;
  onFocusWorkspace?: () => void;
  openAssistantPayload?: OpenAssistantParams | null;
  onClearOpenAssistantPayload?: () => void;
}

export const GuanjiaNativeAssistant: React.FC<GuanjiaNativeAssistantProps> = ({
  onClose,
  storeName,
  currentUser,
  currentPageName,
  isExpanded = true,
  onFocusWorkspace,
  openAssistantPayload,
  onClearOpenAssistantPayload,
}) => {
  const guanjiaSession = useGuanjiaSession();
  const prevGenerationRef = useRef(guanjiaSession.generation);

  const [scopeEpoch, setScopeEpoch] = useState(0);
  const scopeEpochRef = useRef(0);
  const hydrateRevisionRef = useRef(0);
  const isTerminalRef = useRef(false);
  const pendingOptimisticIdRef = useRef<string | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReconcileTimeRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const openclawKeyRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<CoworkMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingActions, setPendingActions] = useState<GuanjiaPendingAction[]>([]);
  const [actionProcessingId, setActionProcessingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);

  const drawerRef = useRef<HTMLElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeAssistantTypeRef = useRef<GuanjiaAssistantType>('general');

  const updateMessages = useCallback(
    (updater: CoworkMessage[] | ((prev: CoworkMessage[]) => CoworkMessage[])) => {
      setMessages(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        knownMessageIdsRef.current = new Set(next.map(m => m.id));
        return next;
      });
    },
    []
  );

  const resetScope = useCallback(() => {
    scopeEpochRef.current += 1;
    hydrateRevisionRef.current += 1;
    isTerminalRef.current = false;
    pendingOptimisticIdRef.current = null;
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = null;
    }
    knownMessageIdsRef.current.clear();
    sessionIdRef.current = null;
    openclawKeyRef.current = null;
    setMessages([]);
    setPendingActions([]);
    setIsStreaming(false);
    setServiceError(null);
    setActionError(null);
    setActionProcessingId(null);
    setScopeEpoch(e => e + 1);
  }, []);

  // 会话 generation 变化时重置所有状态并升级 epoch，防止跨代与跨账号污染
  useEffect(() => {
    if (prevGenerationRef.current !== guanjiaSession.generation) {
      prevGenerationRef.current = guanjiaSession.generation;
      resetScope();
      onClearOpenAssistantPayload?.();
    }
  }, [guanjiaSession.generation, onClearOpenAssistantPayload, resetScope]);

  // 仅渲染用户消息与非 thinking 助手回复，隐藏 system、tool_use、tool_result 与 reasoning
  const renderableMessages = useMemo(() => {
    return messages.filter(msg => {
      if (msg.type === 'user') return true;
      if (msg.type === 'assistant') {
        if (msg.metadata?.isThinking === true) return false;
        return true;
      }
      return false;
    });
  }, [messages]);

  // 自动滚动至最新消息
  const scrollToBottom = useCallback(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [renderableMessages, pendingActions, scrollToBottom]);

  // 展开抽屉时自动聚焦输入框，但宿主模态框关闭或挂起时避免聚焦
  useEffect(() => {
    if (!isExpanded) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const timer = window.setTimeout(() => {
      if (drawerRef.current && drawerRef.current.offsetParent !== null) {
        inputRef.current?.focus();
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [isExpanded]);

  // 键盘 Escape 键快速关闭并退回工作区焦点
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        e.preventDefault();
        onClose();
        onFocusWorkspace?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, onClose, onFocusWorkspace]);

  // 对话抽屉无障碍焦点陷阱 (Focus Trap)
  useEffect(() => {
    if (!isExpanded) return;
    const drawerElement = drawerRef.current;
    if (!drawerElement) return;

    const handleTabTrap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = drawerElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    drawerElement.addEventListener('keydown', handleTabTrap);
    return () => {
      drawerElement.removeEventListener('keydown', handleTabTrap);
    };
  }, [isExpanded]);

  // 刷新待确认动作（带 epoch 校验）
  const refreshPendingActions = useCallback(
    async (activeSessionId?: string) => {
      const targetId = activeSessionId || sessionIdRef.current;
      if (!targetId) return;
      const epoch = scopeEpochRef.current;
      const res = await guanjiaNativeService.getPendingRuns(targetId);
      if (scopeEpochRef.current !== epoch) return;
      const actions = res.runs || res.pendingActions;
      if (res.success && actions) {
        setPendingActions(actions);
      }
    },
    []
  );

  // 执行水合与调和（受 epoch 与 revision 守卫保护）
  const performReconciliation = useCallback(
    async (targetSessionId: string, expectedRevision?: number) => {
      if (!targetSessionId) return;
      const epoch = scopeEpochRef.current;
      const currentRev = hydrateRevisionRef.current;
      const res = await guanjiaNativeService.get(targetSessionId);
      if (scopeEpochRef.current !== epoch) return;
      if (expectedRevision !== undefined && currentRev < expectedRevision) return;
      if (currentRev < hydrateRevisionRef.current) return;

      if (res.success) {
        if (Array.isArray(res.messages) && res.messages.length > 0) {
          updateMessages(prev => mergeRawMessages(prev, res.messages as CoworkMessage[]));
        }
        if (res.session?.status) {
          if (res.session.status !== 'running') {
            setIsStreaming(false);
            isTerminalRef.current = true;
          } else if (!isTerminalRef.current) {
            setIsStreaming(true);
          }
        }
        void refreshPendingActions(targetSessionId);
      }
    },
    [refreshPendingActions, updateMessages]
  );

  // 合并防抖触发未知消息水合
  const triggerCoalescedReconcile = useCallback(
    (targetSessionId: string) => {
      if (!targetSessionId) return;
      if (reconcileTimerRef.current) return;

      const now = Date.now();
      const delay = Math.max(0, 80 - (now - lastReconcileTimeRef.current));
      const capturedRev = hydrateRevisionRef.current;

      reconcileTimerRef.current = setTimeout(() => {
        reconcileTimerRef.current = null;
        lastReconcileTimeRef.current = Date.now();
        void performReconciliation(targetSessionId, capturedRev);
      }, delay);
    },
    [performReconciliation]
  );

  // 监听真实 Cowork 流式事件，通过 scopeEpoch 重新绑定并废弃旧回调
  useEffect(() => {
    const currentEpoch = scopeEpoch;

    const unsubscribe = guanjiaNativeService.subscribeCoworkStream({
      onMessage: ({ sessionId: eventSessionId, message }) => {
        if (scopeEpoch !== currentEpoch || scopeEpochRef.current !== currentEpoch) return;
        if (eventSessionId !== openclawKeyRef.current && eventSessionId !== sessionIdRef.current) return;
        hydrateRevisionRef.current += 1;

        updateMessages(prev => {
          const optId = pendingOptimisticIdRef.current;
          const existingIdx = prev.findIndex(m => m.id === message.id || (optId && m.id === optId && message.type === 'user'));
          if (existingIdx >= 0) {
            const copy = [...prev];
            const prevMeta = copy[existingIdx].metadata;
            const incDisplay = message.metadata?.[GuanjiaMessageMetadataKey.DisplayContent];
            const prevDisplay = prevMeta ? prevMeta[GuanjiaMessageMetadataKey.DisplayContent] : undefined;
            const displayContent =
              typeof incDisplay === 'string'
                ? incDisplay
                : typeof prevDisplay === 'string'
                ? prevDisplay
                : undefined;
            copy[existingIdx] = {
              ...message,
              metadata: {
                ...prevMeta,
                ...message.metadata,
                ...(displayContent !== undefined ? { [GuanjiaMessageMetadataKey.DisplayContent]: displayContent } : {}),
              },
            };
            if (optId && prev[existingIdx].id === optId) {
              pendingOptimisticIdRef.current = null;
            }
            return copy;
          }
          return [...prev, message];
        });
      },

      onMessageUpdate: ({ sessionId: eventSessionId, messageId, content, metadata }) => {
        if (scopeEpoch !== currentEpoch || scopeEpochRef.current !== currentEpoch) return;
        if (eventSessionId !== openclawKeyRef.current && eventSessionId !== sessionIdRef.current) return;
        hydrateRevisionRef.current += 1;

        if (knownMessageIdsRef.current.has(messageId)) {
          updateMessages(prev => {
            const index = prev.findIndex(m => m.id === messageId);
            if (index < 0) return prev;
            const copy = [...prev];
            copy[index] = {
              ...copy[index],
              content,
              metadata: {
                ...copy[index].metadata,
                ...metadata,
              },
            };
            return copy;
          });
        } else {
          // 未知消息 ID 不伪造 assistant，纯函数外部触发 coalesced reconcile
          const activeId = sessionIdRef.current;
          if (activeId) {
            triggerCoalescedReconcile(activeId);
          }
        }
      },

      onSessionStatus: ({ sessionId: eventSessionId, status }) => {
        if (scopeEpoch !== currentEpoch || scopeEpochRef.current !== currentEpoch) return;
        if (eventSessionId !== openclawKeyRef.current && eventSessionId !== sessionIdRef.current) return;
        hydrateRevisionRef.current += 1;

        if (status === 'running') {
          isTerminalRef.current = false;
          setIsStreaming(true);
        } else if (status === 'idle' || status === 'completed' || status === 'error') {
          isTerminalRef.current = true;
          setIsStreaming(false);
          const activeId = sessionIdRef.current;
          if (activeId) {
            void performReconciliation(activeId);
          }
        }
      },

      onComplete: ({ sessionId: eventSessionId }) => {
        if (scopeEpoch !== currentEpoch || scopeEpochRef.current !== currentEpoch) return;
        if (eventSessionId !== openclawKeyRef.current && eventSessionId !== sessionIdRef.current) return;
        hydrateRevisionRef.current += 1;

        isTerminalRef.current = true;
        setIsStreaming(false);
        const activeId = sessionIdRef.current;
        if (activeId) {
          void performReconciliation(activeId);
        }
      },

      onError: ({ sessionId: eventSessionId, error }) => {
        if (scopeEpoch !== currentEpoch || scopeEpochRef.current !== currentEpoch) return;
        if (eventSessionId !== openclawKeyRef.current && eventSessionId !== sessionIdRef.current) return;
        hydrateRevisionRef.current += 1;

        isTerminalRef.current = true;
        setIsStreaming(false);
        setServiceError(error || tGuanjia('guanjiaGenerationInterrupted'));
        const activeId = sessionIdRef.current;
        if (activeId) {
          void performReconciliation(activeId);
        }
      },
    });

    return () => {
      unsubscribe();
      if (reconcileTimerRef.current) {
        clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, [scopeEpoch, performReconciliation, triggerCoalescedReconcile, updateMessages]);

  // 响应来自外部或内嵌网页的打开助手负载，检测 assistantType 变化以切换作用域
  useEffect(() => {
    if (!openAssistantPayload) return;
    const targetType = openAssistantPayload.assistantType || 'general';
    if (activeAssistantTypeRef.current !== targetType) {
      activeAssistantTypeRef.current = targetType;
      resetScope();
    } else {
      activeAssistantTypeRef.current = targetType;
    }
    if (openAssistantPayload?.initialMessage) {
      setInputValue(openAssistantPayload.initialMessage);
    }
  }, [openAssistantPayload, resetScope]);

  // 发送消息
  const handleSendMessage = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

    const optimisticUserMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pendingOptimisticIdRef.current = optimisticUserMsgId;
    const userMsg: CoworkMessage = {
      id: optimisticUserMsgId,
      type: 'user',
      content: trimmed,
      timestamp: Date.now(),
      metadata: {
        [GuanjiaMessageMetadataKey.DisplayContent]: trimmed,
      },
    };

    updateMessages(prev => [...prev, userMsg]);
    setInputValue('');
    setIsStreaming(true);
    isTerminalRef.current = false;
    hydrateRevisionRef.current += 1;
    const turnRevision = hydrateRevisionRef.current;
    const opEpoch = scopeEpochRef.current;
    setServiceError(null);

    const activeId = sessionIdRef.current;
    if (!activeId) {
      const targetAssistantType = openAssistantPayload?.assistantType || activeAssistantTypeRef.current;
      activeAssistantTypeRef.current = targetAssistantType;
      const context = {
        storeName: storeName ?? undefined,
        currentUser: currentUser ?? undefined,
        currentPageName: currentPageName ?? undefined,
        ...(openAssistantPayload?.context || {}),
      };
      const res = await guanjiaNativeService.start({
        assistantType: targetAssistantType,
        initialMessage: trimmed,
        storeId: openAssistantPayload?.storeId || (guanjiaSession.store?.id ? String(guanjiaSession.store.id) : undefined),
        storeCode: openAssistantPayload?.storeCode || guanjiaSession.store?.code,
        currentUrl: openAssistantPayload?.currentUrl,
        context,
      });

      if (scopeEpochRef.current !== opEpoch) return;

      if (res.success && res.sessionId) {
        const newSessionId = res.sessionId;
        sessionIdRef.current = newSessionId;
        openclawKeyRef.current = res.openclawSessionKey ?? null;
        if (res.userMessageId && res.userMessageId !== optimisticUserMsgId) {
          pendingOptimisticIdRef.current = null;
          updateMessages(prev =>
            prev.map(m => (m.id === optimisticUserMsgId ? { ...m, id: res.userMessageId! } : m))
          );
        }
        onClearOpenAssistantPayload?.();
        await performReconciliation(newSessionId, turnRevision);
      } else {
        setIsStreaming(false);
        isTerminalRef.current = true;
        setServiceError(res.error || tGuanjia('guanjiaServiceUnavailable'));
      }
    } else {
      const res = await guanjiaNativeService.continue({
        sessionId: activeId,
        message: trimmed,
        context: openAssistantPayload?.context,
      });
      if (scopeEpochRef.current !== opEpoch) return;
      if (res.success) {
        if (res.userMessageId && res.userMessageId !== optimisticUserMsgId) {
          pendingOptimisticIdRef.current = null;
          updateMessages(prev =>
            prev.map(m => (m.id === optimisticUserMsgId ? { ...m, id: res.userMessageId! } : m))
          );
        }
        await performReconciliation(activeId, turnRevision);
      } else {
        setIsStreaming(false);
        isTerminalRef.current = true;
        setServiceError(res.error || tGuanjia('guanjiaServiceUnavailable'));
      }
    }
  };

  // 停止生成
  const handleStopGenerating = async () => {
    const activeId = sessionIdRef.current;
    if (!activeId || !isStreaming) return;
    const opEpoch = scopeEpochRef.current;
    const res = await guanjiaNativeService.stop({ sessionId: activeId });
    if (scopeEpochRef.current !== opEpoch || sessionIdRef.current !== activeId) return;
    if (res.success) {
      isTerminalRef.current = true;
      setIsStreaming(false);
    } else {
      setServiceError(res.error || tGuanjia('guanjiaServiceUnavailable'));
    }
  };

  // 确认执行真实待确认动作
  const handleConfirmAction = async (action: GuanjiaPendingAction) => {
    setActionProcessingId(action.runId);
    setActionError(null);
    const opEpoch = scopeEpochRef.current;
    try {
      const res = await guanjiaNativeService.confirmRun(action.runId);
      if (scopeEpochRef.current !== opEpoch) return;
      const nextStatus =
        res.status === 'completed'
          ? 'confirmed'
          : res.status === 'failed'
          ? 'failed'
          : res.status === 'in_progress'
          ? 'in_progress'
          : res.status === 'unknown'
          ? 'unknown'
          : 'pending';
      setPendingActions(prev =>
        prev.map(item =>
          item.runId === action.runId ? { ...item, status: nextStatus } : item
        )
      );
      if (!res.success) {
        setActionError(res.error || res.message || tGuanjia('guanjiaConfirmFailed'));
      } else if (res.status === 'unknown') {
        setActionError(tGuanjia('guanjiaPendingActionStatusUnknown'));
      }
    } catch (err) {
      if (scopeEpochRef.current !== opEpoch) return;
      setPendingActions(prev =>
        prev.map(item => item.runId === action.runId ? { ...item, status: 'unknown' } : item)
      );
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (scopeEpochRef.current === opEpoch) {
        setActionProcessingId(current => (current === action.runId ? null : current));
      }
    }
  };

  // 取消待确认动作：仅撤销宿主确认资格，保持未执行
  const handleCancelAction = async (action: GuanjiaPendingAction) => {
    setActionProcessingId(action.runId);
    setActionError(null);
    const opEpoch = scopeEpochRef.current;
    try {
      const res = await guanjiaNativeService.cancelRun(action.runId);
      if (scopeEpochRef.current !== opEpoch) return;
      const nextStatus =
        res.status === 'cancelled' || res.status === 'unexecuted'
          ? 'cancelled'
          : 'unknown';
      setPendingActions(prev =>
        prev.map(item =>
          item.runId === action.runId ? { ...item, status: nextStatus } : item
        )
      );
      if (!res.success) {
        setActionError(res.error || res.message || tGuanjia('guanjiaCancelFailed'));
      } else if (res.status === 'unknown') {
        setActionError(tGuanjia('guanjiaCancelActionStatusUnknown'));
      }
    } catch (err) {
      if (scopeEpochRef.current !== opEpoch) return;
      setPendingActions(prev =>
        prev.map(item => item.runId === action.runId ? { ...item, status: 'unknown' } : item)
      );
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (scopeEpochRef.current === opEpoch) {
        setActionProcessingId(current => (current === action.runId ? null : current));
      }
    }
  };

  return (
    <section
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={tGuanjia('guanjiaAssistantDrawerLabel')}
      className="flex h-full w-full flex-col overflow-hidden bg-surface text-foreground"
    >
      {/* 抽屉头部 */}
      <header
        className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3"
        role="region"
        aria-label={tGuanjia('guanjiaAssistantTitle')}
      >
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" role="presentation" className="text-sm">
            🧭
          </span>
          <span className="text-xs font-semibold text-foreground">
            {tGuanjia('guanjiaAssistantTitle')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            onClose();
            onFocusWorkspace?.();
          }}
          aria-label={tGuanjia('guanjiaAssistantCloseDrawer')}
          className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-surface-raised hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60 transition-colors"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" role="presentation">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      {/* 上下文信息条 */}
      {(storeName || currentUser || currentPageName) && (
        <div className="flex flex-col gap-0.5 border-b border-border bg-surface-raised px-3 py-1.5 text-[11px] text-secondary">
          <div className="flex items-center justify-between">
            {currentPageName ? <span>当前：{currentPageName}</span> : null}
            {storeName ? <span>当前店：{storeName}</span> : null}
          </div>
          {currentUser ? <div>当前人：{currentUser}</div> : null}
        </div>
      )}

      {/* 消息与待确认卡片滚动区 */}
      <div
        ref={messagesContainerRef}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-label={tGuanjia('guanjiaConversationLog')}
        className="flex flex-1 flex-col space-y-3 overflow-y-auto p-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        {serviceError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-destructive text-[11px]" role="alert">
            {serviceError}
          </div>
        )}

        {actionError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-destructive text-[11px]" role="alert">
            {actionError}
          </div>
        )}

        {renderableMessages.length === 0 && !serviceError && (
          <div className="flex flex-1 items-center justify-center text-center text-secondary py-8 text-xs">
            {tGuanjia('guanjiaEmptyAssistantHint')}
          </div>
        )}

        {/* 仅渲染用户消息与非 thinking 助手，保持真实 Markdown 与确认卡片 */}
        {renderableMessages.map(msg => {
          const isUser = msg.type === 'user';
          const raw = msg.metadata?.[GuanjiaMessageMetadataKey.DisplayContent];
          const displayContent = isUser && typeof raw === 'string' ? raw : msg.content;

          return (
            <div
              key={msg.id}
              className={`rounded-lg p-2.5 text-xs ${
                isUser
                  ? 'ml-auto max-w-[85%] bg-primary text-primary-foreground'
                  : 'border border-border bg-surface-raised text-foreground'
              }`}
            >
              {isUser ? (
                <div className="whitespace-pre-wrap break-words">{displayContent}</div>
              ) : (
                <div className="prose prose-xs dark:prose-invert max-w-none break-words">
                  <MarkdownContent content={displayContent} />
                </div>
              )}
            </div>
          );
        })}

        {/* 服务端真实待确认卡片 */}
        {pendingActions.map(action => {
          const isPending = action.status === 'pending';
          const isConfirmed = action.status === 'confirmed';
          const isCancelled = action.status === 'cancelled';
          const isFailed = action.status === 'failed';
          const isExpired = action.status === 'expired';
          const isProcessing = actionProcessingId === action.runId;

          return (
            <div
              key={action.runId}
              className={`rounded-lg border p-3 shadow-2xs ${
                isPending
                  ? 'border-amber-500/60 bg-amber-500/10 text-foreground'
                  : isConfirmed
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                  : isCancelled
                  ? 'border-border bg-surface-raised text-secondary'
                  : isExpired
                  ? 'border-border bg-surface-raised text-secondary'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
              role="region"
              aria-label={action.title || tGuanjia('guanjiaActionSummary')}
            >
              <div className="font-medium text-xs">
                {action.title || action.description || tGuanjia('guanjiaActionSummary')}
              </div>

              {/* 仅展示经服务端真实核验的资产字段，完整解码 verified_member_assets，严禁模型虚构金额 */}
              {(() => {
                const decoded = decodeVerifiedMemberAssets(action);
                if (!decoded) return null;
                return (
                  <div className="mt-1.5 flex flex-wrap gap-2 text-[11px] opacity-90">
                    {decoded.memberName && (
                      <span>{tGuanjia('guanjiaMemberLabel')}：{decoded.memberName}</span>
                    )}
                    {decoded.balance != null && (
                      <span>{tGuanjia('guanjiaVerifiedBalance')}：¥{decoded.balance}</span>
                    )}
                    {decoded.principal != null && (
                      <span>{tGuanjia('guanjiaPrincipalBalance')}：¥{decoded.principal}</span>
                    )}
                    {decoded.bonus != null && (
                      <span>{tGuanjia('guanjiaBonusBalance')}：¥{decoded.bonus}</span>
                    )}
                    {decoded.remainingTimes != null && (
                      <span>{tGuanjia('guanjiaRemainingTimesCard')}：{decoded.remainingTimes}{tGuanjia('guanjiaTimesCardUnit')}</span>
                    )}
                    {decoded.originalAmount != null && (
                      <span>{tGuanjia('guanjiaOriginalAmount')}：¥{decoded.originalAmount}</span>
                    )}
                    {decoded.discount != null && (
                      <span>{tGuanjia('guanjiaDiscount')}：{decoded.discount}</span>
                    )}
                  </div>
                );
              })()}

              {isPending && action.requiresConfirmation && (
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => void handleConfirmAction(action)}
                    aria-label={`${tGuanjia('guanjiaConfirmAction')}：${action.title || action.runId}`}
                    className="inline-flex items-center justify-center rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60 disabled:opacity-50 active:scale-95 transition-all"
                  >
                    {isProcessing ? tGuanjia('guanjiaConfirming') : tGuanjia('guanjiaConfirmAction')}
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => void handleCancelAction(action)}
                    aria-label={`${tGuanjia('guanjiaCancelAction')}：${action.title || action.runId}`}
                    className="inline-flex items-center justify-center rounded border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary/60 disabled:opacity-50 active:scale-95 transition-all"
                  >
                    {isProcessing ? tGuanjia('guanjiaCancelling') : tGuanjia('guanjiaCancelAction')}
                  </button>
                </div>
              )}

              {isConfirmed && (
                <div className="mt-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  {tGuanjia('guanjiaConfirmedSuccess')}
                </div>
              )}

              {isCancelled && (
                <div className="mt-1.5 text-[11px] text-secondary">
                  {tGuanjia('guanjiaCancelledNotice')}
                </div>
              )}

              {action.status === 'in_progress' && (
                <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {tGuanjia('guanjiaPendingActionInProgress')}
                </div>
              )}

              {action.status === 'unknown' && (
                <div className="mt-1.5 text-[11px] text-secondary">
                  {tGuanjia('guanjiaPendingActionUnknown')}
                </div>
              )}

              {isFailed && (
                <div className="mt-1.5 text-[11px] font-medium text-destructive">
                  {tGuanjia('guanjiaPendingActionFailed')}
                </div>
              )}

              {isExpired && (
                <div className="mt-1.5 text-[11px] text-secondary">
                  {tGuanjia('guanjiaPendingActionExpired')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部输入控制条 */}
      <div className="border-t border-border p-2.5 bg-surface">
        <label htmlFor="guanjia-assistant-input" className="sr-only">
          {tGuanjia('guanjiaAssistantInputLabel')}
        </label>
        <div className="flex items-center rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-2xs focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/60">
          <input
            id="guanjia-assistant-input"
            ref={inputRef}
            type="text"
            value={inputValue}
            disabled={isStreaming}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSendMessage();
              }
            }}
            placeholder={tGuanjia('guanjiaAskInputPlaceholder')}
            aria-label={tGuanjia('guanjiaAssistantInputLabel')}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-primary/40 rounded px-1"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStopGenerating}
              aria-label={tGuanjia('guanjiaStopGenerating')}
              className="flex h-6 w-6 items-center justify-center rounded text-amber-500 hover:text-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60 transition-colors"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true" role="presentation">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSendMessage()}
              disabled={!inputValue.trim()}
              aria-label={tGuanjia('guanjiaSendMessage')}
              className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/60 disabled:opacity-40 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true" role="presentation">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          )}
        </div>
      </div>
  </section>
  );
};

export default GuanjiaNativeAssistant;
