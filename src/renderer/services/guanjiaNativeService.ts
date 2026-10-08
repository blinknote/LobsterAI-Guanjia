import {
  type CancelActionResult,
  type CancelPendingActionParams,
  type ConfirmActionResult,
  type ConfirmPendingActionParams,
  type ContinueScopedSessionParams,
  type ContinueScopedSessionResult,
  type GetPendingActionsResult,
  type GetScopedSessionResult,
  GuanjiaMessageMetadataKey,
  type GuanjiaPendingAction,
  type GuanjiaScopedSession,
  type OpenAssistantParams,
  type ScopedNativeApi,
  type StartScopedSessionParams,
  type StartScopedSessionResult,
  type StopScopedSessionParams,
  type StopScopedSessionResult,
} from '../../shared/guanjia/native';
import type { CoworkMessage } from '../types/cowork';

export { GuanjiaMessageMetadataKey };
export type {
  CancelActionResult,
  CancelPendingActionParams,
  ConfirmActionResult,
  ConfirmPendingActionParams,
  ContinueScopedSessionParams,
  ContinueScopedSessionResult,
  GetPendingActionsResult,
  GetScopedSessionResult,
  GuanjiaPendingAction,
  GuanjiaScopedSession,
  OpenAssistantParams,
  ScopedNativeApi,
  StartScopedSessionParams,
  StartScopedSessionResult,
  StopScopedSessionParams,
  StopScopedSessionResult,
};

class GuanjiaNativeService {
  private get nativeApi(): ScopedNativeApi | undefined {
    if (typeof window === 'undefined') return undefined;
    const win = window as unknown as { electron?: { guanjia?: { native?: ScopedNativeApi } } };
    return win.electron?.guanjia?.native;
  }

  isAvailable(): boolean {
    return typeof this.nativeApi?.start === 'function';
  }

  async start(params: StartScopedSessionParams): Promise<StartScopedSessionResult> {
    const api = this.nativeApi;
    if (!api?.start) {
      return { success: false, error: '原生管家助手服务未就绪' };
    }
    try {
      return await api.start(params);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async continue(params: ContinueScopedSessionParams): Promise<ContinueScopedSessionResult> {
    const api = this.nativeApi;
    if (!api?.continue) {
      return { success: false, error: '原生管家助手服务未就绪' };
    }
    try {
      return await api.continue(params);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async get(sessionId: string): Promise<GetScopedSessionResult> {
    const api = this.nativeApi;
    if (!api?.get) {
      return { success: false, error: '原生管家助手服务未就绪' };
    }
    try {
      return await api.get(sessionId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(params: StopScopedSessionParams): Promise<StopScopedSessionResult> {
    const api = this.nativeApi;
    if (!api?.stop) {
      return { success: false, error: '原生管家助手服务未就绪' };
    }
    try {
      return await api.stop(params.sessionId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPendingRuns(sessionId?: string): Promise<GetPendingActionsResult> {
    const api = this.nativeApi;
    if (!api?.getPendingRuns) {
      return { success: false, error: '原生待核验查询未就绪' };
    }
    try {
      return await api.getPendingRuns(sessionId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async confirmRun(runId: string, note?: string): Promise<ConfirmActionResult> {
    const api = this.nativeApi;
    if (!api?.confirmRun) {
      return {
        success: false,
        runId,
        status: 'failed',
        error: '原生确认通道未就绪',
      };
    }
    try {
      return await api.confirmRun(runId, note);
    } catch (err) {
      return {
        success: false,
        runId,
        status: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async cancelRun(runId: string, reason?: string): Promise<CancelActionResult> {
    const api = this.nativeApi;
    if (!api?.cancelRun) {
      return {
        success: false,
        runId,
        status: 'unknown',
        error: '原生取消通道未就绪',
      };
    }
    try {
      return await api.cancelRun(runId, reason);
    } catch (err) {
      return {
        success: false,
        runId,
        status: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  onOpenAssistant(callback: (params: OpenAssistantParams) => void): () => void {
    return this.onAssistantOpened(callback);
  }

  onAssistantOpened(callback: (params: OpenAssistantParams) => void): () => void {
    const api = this.nativeApi;
    if (typeof api?.onOpenAssistant === 'function') {
      return api.onOpenAssistant(callback);
    }
    const handler = (e: CustomEvent<OpenAssistantParams>) => {
      if (e.detail) {
        callback(e.detail);
      }
    };
    window.addEventListener('guanjia:open-assistant' as unknown as string, handler as EventListener);
    return () => {
      window.removeEventListener('guanjia:open-assistant' as unknown as string, handler as EventListener);
    };
  }

  /**
   * 挂钩真实 Cowork 消息流式事件
   * 监听来自 OpenClaw 的真实会话消息推送与更新
   */
  subscribeCoworkStream(handlers: {
    onMessage?: (data: { sessionId: string; message: CoworkMessage }) => void;
    onMessageUpdate?: (data: {
      sessionId: string;
      messageId: string;
      content: string;
      metadata?: Record<string, unknown>;
    }) => void;
    onSessionStatus?: (data: { sessionId: string; status: string }) => void;
    onComplete?: (data: { sessionId: string; claudeSessionId?: string | null }) => void;
    onError?: (data: { sessionId: string; error: string }) => void;
  }): () => void {
    const cowork = (window as unknown as { electron?: { cowork?: Record<string, unknown> } })?.electron?.cowork;
    if (!cowork) return () => {};

    const unsubs: Array<() => void> = [];

    if (typeof cowork.onStreamMessage === 'function' && handlers.onMessage) {
      unsubs.push((cowork.onStreamMessage as (cb: unknown) => () => void)(handlers.onMessage));
    }
    if (typeof cowork.onStreamMessageUpdate === 'function' && handlers.onMessageUpdate) {
      unsubs.push((cowork.onStreamMessageUpdate as (cb: unknown) => () => void)(handlers.onMessageUpdate));
    }
    if (typeof cowork.onStreamSessionStatus === 'function' && handlers.onSessionStatus) {
      unsubs.push((cowork.onStreamSessionStatus as (cb: unknown) => () => void)(handlers.onSessionStatus));
    }
    if (typeof cowork.onStreamComplete === 'function' && handlers.onComplete) {
      unsubs.push((cowork.onStreamComplete as (cb: unknown) => () => void)(handlers.onComplete));
    }
    if (typeof cowork.onStreamError === 'function' && handlers.onError) {
      unsubs.push((cowork.onStreamError as (cb: unknown) => () => void)(handlers.onError));
    }

    return () => {
      unsubs.forEach(fn => fn());
    };
  }
}

export const guanjiaNativeService = new GuanjiaNativeService();
