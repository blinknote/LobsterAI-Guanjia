import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { GuanjiaPendingAction } from '../../../shared/guanjia/native';
import { tGuanjia } from '../../services/guanjiaI18n';
import { guanjiaNativeService } from '../../services/guanjiaNativeService';
import { guanjiaSessionService, useGuanjiaSession } from '../../services/guanjiaSession';

function decodeVerifiedMemberAssets(action: GuanjiaPendingAction) {
  const rawDetails = action.rawDetails as Record<string, unknown> | undefined;
  const assets = (action.verifiedAssets || rawDetails?.verified_member_assets || rawDetails?.verifiedAssets) as Record<string, unknown> | undefined;
  if (!assets || assets.verified_from_db !== true) return null;

  const rawMemberName = assets.member_name;
  const balance = assets.current_total_balance;
  const principal = assets.principal_balance;
  const bonus = assets.bonus_balance;
  const remainingTimes = assets.remaining_times;
  const deductAmount = assets.deduct_amount;
  const afterBalance = assets.after_total_balance;

  if (!rawMemberName && balance == null && principal == null && bonus == null && remainingTimes == null && deductAmount == null && afterBalance == null) {
    return null;
  }

  return {
    memberName: rawMemberName ? String(rawMemberName) : undefined,
    balance: balance != null ? String(balance) : undefined,
    principal: principal != null ? String(principal) : undefined,
    bonus: bonus != null ? String(bonus) : undefined,
    remainingTimes: remainingTimes != null ? String(remainingTimes) : undefined,
    deductAmount: deductAmount != null ? String(deductAmount) : undefined,
    afterBalance: afterBalance != null ? String(afterBalance) : undefined,
  };
}

export interface GuanjiaConversationActionsProps {
  sessionId?: string | null;
  className?: string;
}

export const GuanjiaConversationActions: React.FC<GuanjiaConversationActionsProps> = ({
  sessionId,
  className,
}) => {
  const guanjiaSession = useGuanjiaSession();
  const generation = guanjiaSession.generation;

  const [pendingActions, setPendingActions] = useState<GuanjiaPendingAction[]>([]);
  const [actionProcessingId, setActionProcessingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scopeEpochRef = useRef(0);
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  const generationRef = useRef<number>(generation);
  const pendingRequestRef = useRef<symbol | null>(null);

  // Immediate reset on sessionId or scope generation changes
  useLayoutEffect(() => {
    scopeEpochRef.current += 1;
    sessionIdRef.current = sessionId ?? null;
    generationRef.current = generation;
    pendingRequestRef.current = null;
    setPendingActions([]);
    setActionProcessingId(null);
    setActionError(null);
  }, [sessionId, generation, guanjiaSession.status]);

  const refreshPendingActions = useCallback(async (targetSessionId: string) => {
    const snapshot = guanjiaSessionService.getSnapshot();
    if (!targetSessionId || pendingRequestRef.current || snapshot.status !== 'authenticated'
      || snapshot.generation !== generationRef.current) return;
    const epoch = scopeEpochRef.current;
    const request = Symbol();
    pendingRequestRef.current = request;
    try {
      const res = await guanjiaNativeService.getPendingRuns(targetSessionId);
      if (scopeEpochRef.current !== epoch || sessionIdRef.current !== targetSessionId) return;
      setPendingActions(res.success ? res.pendingActions || [] : []);
    } catch {
      if (scopeEpochRef.current === epoch && sessionIdRef.current === targetSessionId) setPendingActions([]);
    } finally {
      if (pendingRequestRef.current === request) pendingRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!sessionId || guanjiaSession.status !== 'authenticated') return;
    const currentEpoch = scopeEpochRef.current;
    const targetSessionId = sessionId;

    void refreshPendingActions(targetSessionId);

    // Subscribe to existing cowork stream events
    const unsubscribeStream = guanjiaNativeService.subscribeCoworkStream({
      onMessage: ({ sessionId: evSessionId }) => {
        if (scopeEpochRef.current !== currentEpoch || sessionIdRef.current !== targetSessionId) return;
        if (evSessionId === targetSessionId) {
          void refreshPendingActions(targetSessionId);
        }
      },
      onSessionStatus: ({ sessionId: evSessionId }) => {
        if (scopeEpochRef.current !== currentEpoch || sessionIdRef.current !== targetSessionId) return;
        if (evSessionId === targetSessionId) {
          void refreshPendingActions(targetSessionId);
        }
      },
      onComplete: ({ sessionId: evSessionId }) => {
        if (scopeEpochRef.current !== currentEpoch || sessionIdRef.current !== targetSessionId) return;
        if (evSessionId === targetSessionId) {
          void refreshPendingActions(targetSessionId);
        }
      },
    });

    // Subscribe to native onPendingChanged if supported
    const nativeApi = (window as unknown as { electron?: { guanjia?: { native?: { onPendingChanged?: (cb: (actions: GuanjiaPendingAction[]) => void) => () => void } } } })?.electron?.guanjia?.native;
    let unsubPending: (() => void) | undefined;
    if (typeof nativeApi?.onPendingChanged === 'function') {
      unsubPending = nativeApi.onPendingChanged(() => {
        if (scopeEpochRef.current !== currentEpoch || sessionIdRef.current !== targetSessionId) return;
        void refreshPendingActions(targetSessionId);
      });
    }

    // Bounded periodic refresh for timely updates
    const pollTimer = setInterval(() => {
      if (scopeEpochRef.current !== currentEpoch || sessionIdRef.current !== targetSessionId) return;
      void refreshPendingActions(targetSessionId);
    }, 2500);

    return () => {
      unsubscribeStream();
      unsubPending?.();
      clearInterval(pollTimer);
    };
  }, [sessionId, generation, guanjiaSession.status, refreshPendingActions]);

  const handleConfirmAction = async (action: GuanjiaPendingAction) => {
    if (actionProcessingId || guanjiaSessionService.getSnapshot().status !== 'authenticated'
      || guanjiaSessionService.getSnapshot().generation !== generationRef.current) return;
    setActionProcessingId(action.runId);
    setActionError(null);
    const opEpoch = scopeEpochRef.current;
    const targetSessionId = sessionIdRef.current;
    try {
      const res = await guanjiaNativeService.confirmRun(action.runId);
      if (scopeEpochRef.current !== opEpoch || sessionIdRef.current !== targetSessionId) return;
      const isServerSuccess = Boolean(res.success && res.status === 'completed');
      const nextStatus =
        isServerSuccess
          ? 'confirmed'
          : res.status === 'failed' || (!res.success && res.status !== 'in_progress')
          ? 'failed'
          : res.status === 'in_progress'
          ? 'in_progress'
          : 'unknown';
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
      if (scopeEpochRef.current !== opEpoch || sessionIdRef.current !== targetSessionId) return;
      setPendingActions(prev =>
        prev.map(item => item.runId === action.runId ? { ...item, status: 'unknown' } : item)
      );
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (scopeEpochRef.current === opEpoch && sessionIdRef.current === targetSessionId) {
        setActionProcessingId(current => (current === action.runId ? null : current));
      }
    }
  };

  const handleCancelAction = async (action: GuanjiaPendingAction) => {
    if (actionProcessingId || guanjiaSessionService.getSnapshot().status !== 'authenticated'
      || guanjiaSessionService.getSnapshot().generation !== generationRef.current) return;
    setActionProcessingId(action.runId);
    setActionError(null);
    const opEpoch = scopeEpochRef.current;
    const targetSessionId = sessionIdRef.current;
    try {
      const res = await guanjiaNativeService.cancelRun(action.runId);
      if (scopeEpochRef.current !== opEpoch || sessionIdRef.current !== targetSessionId) return;
      const nextStatus =
        res.success && (res.status === 'cancelled' || res.status === 'unexecuted')
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
      if (scopeEpochRef.current !== opEpoch || sessionIdRef.current !== targetSessionId) return;
      setPendingActions(prev =>
        prev.map(item => item.runId === action.runId ? { ...item, status: 'unknown' } : item)
      );
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (scopeEpochRef.current === opEpoch && sessionIdRef.current === targetSessionId) {
        setActionProcessingId(current => (current === action.runId ? null : current));
      }
    }
  };

  if (pendingActions.length === 0) {
    return null;
  }

  return (
    <div
      className={`mb-3 space-y-2 ${className ?? ''}`}
      role="region"
      aria-label={tGuanjia('guanjiaActionSummary')}
    >
      {actionError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive" role="alert">
          {actionError}
        </div>
      )}

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
            className={`rounded-xl border p-3 shadow-2xs transition-colors ${
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
                  {decoded.deductAmount != null && (
                    <span>{tGuanjia('guanjiaDeductAmount')}：¥{decoded.deductAmount}</span>
                  )}
                  {decoded.afterBalance != null && (
                    <span>{tGuanjia('guanjiaAfterBalance')}：¥{decoded.afterBalance}</span>
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
                  className="inline-flex items-center justify-center rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-500/60 disabled:opacity-50 active:scale-95 transition-all"
                >
                  {isProcessing ? tGuanjia('guanjiaConfirming') : tGuanjia('guanjiaConfirmAction')}
                </button>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void handleCancelAction(action)}
                  aria-label={`${tGuanjia('guanjiaCancelAction')}：${action.title || action.runId}`}
                  className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary/60 disabled:opacity-50 active:scale-95 transition-all"
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
  );
};

export default GuanjiaConversationActions;
