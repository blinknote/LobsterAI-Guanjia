import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type {
  DesktopAuthApi,
  GuanjiaDesktopAuthBindParams,
  GuanjiaDesktopAuthBindResult,
  GuanjiaDesktopAuthLoginResult,
  GuanjiaDesktopAuthStatus,
  GuanjiaDesktopAuthUnbindParams,
  GuanjiaDesktopAuthUnbindResult,
  GuanjiaDesktopBindingInfo,
  GuanjiaDesktopBindingState,
} from '../../shared/guanjia/desktopAuth';
import { tGuanjia } from './guanjiaI18n';

export type {
  DesktopAuthApi,
  GuanjiaDesktopAuthBindParams,
  GuanjiaDesktopAuthBindResult,
  GuanjiaDesktopAuthLoginResult,
  GuanjiaDesktopAuthStatus,
  GuanjiaDesktopAuthUnbindParams,
  GuanjiaDesktopAuthUnbindResult,
  GuanjiaDesktopBindingInfo,
  GuanjiaDesktopBindingState,
};

/**
 * 将网桥或服务端可能返回的英文或未知错误转义为标准本地化文案
 */
export function localizeDesktopAuthError(error: unknown): string {
  if (!error) return tGuanjia('guanjiaLoginFailed');
  const msg = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  if (!msg) return tGuanjia('guanjiaLoginFailed');
  if (/bridge.*unavailable/i.test(msg) || /api.*unavailable/i.test(msg) || /not available/i.test(msg)) {
    return tGuanjia('guanjiaAuthUnavailable');
  }
  if (/network|fetch|timeout|abort|connect/i.test(msg) || /failed to fetch/i.test(msg)) {
    return tGuanjia('guanjiaConnectFailed');
  }
  if (/password|account|credential|invalid/i.test(msg)) {
    return tGuanjia('guanjiaLoginFailed');
  }
  return msg;
}

const defaultStatus: GuanjiaDesktopAuthStatus = {
  officialAuthenticated: false,
  bindingState: 'not_checked',
  binding: null,
  businessSessionStatus: 'unauthenticated',
  hostGeneration: 0,
};

function getDesktopAuthApi(): DesktopAuthApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const win = window as unknown as {
    electron?: {
      guanjia?: {
        desktopAuth?: DesktopAuthApi;
      };
    };
  };
  return win.electron?.guanjia?.desktopAuth;
}

class GuanjiaDesktopAuthService {
  private status: GuanjiaDesktopAuthStatus = defaultStatus;
  private listeners = new Set<() => void>();
  private unsubscribeIpc: (() => void) | null = null;
  private initPromise: Promise<GuanjiaDesktopAuthStatus> | null = null;

  constructor() {
    this.setupSubscription();
  }

  private setupSubscription(): void {
    if (typeof window === 'undefined' || this.unsubscribeIpc) return;
    const api = getDesktopAuthApi();
    if (api?.onStatusChanged) {
      this.unsubscribeIpc = api.onStatusChanged((nextStatus) => {
        this.updateStatus(nextStatus);
      });
    }
  }

  private updateStatus(nextStatus: GuanjiaDesktopAuthStatus): void {
    if (!nextStatus) return;
    if (
      typeof nextStatus.hostGeneration === 'number' &&
      nextStatus.hostGeneration < this.status.hostGeneration
    ) {
      return;
    }
    this.status = nextStatus;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public getStatus = (): GuanjiaDesktopAuthStatus => {
    return this.status;
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public async init(): Promise<GuanjiaDesktopAuthStatus> {
    if (this.initPromise) return this.initPromise;
    this.setupSubscription();
    this.initPromise = this.refresh().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  public async refresh(): Promise<GuanjiaDesktopAuthStatus> {
    const api = getDesktopAuthApi();
    if (!api) {
      this.updateStatus({
        ...this.status,
        bindingState: 'unavailable',
        error: tGuanjia('guanjiaAuthUnavailable'),
      });
      return this.status;
    }
    try {
      if (api.getStatus) {
        const res = await api.getStatus();
        this.updateStatus(res);
      }
    } catch (err) {
      console.warn('[GuanjiaDesktopAuthService] refresh failed, marking unavailable:', err);
      this.updateStatus({
        ...this.status,
        bindingState: 'unavailable',
        error: localizeDesktopAuthError(err),
      });
    }
    return this.status;
  }

  public async bind(params: GuanjiaDesktopAuthBindParams): Promise<GuanjiaDesktopAuthBindResult> {
    const api = getDesktopAuthApi();
    if (!api?.bind) {
      throw new Error(tGuanjia('guanjiaAuthUnavailable'));
    }
    const result = await api.bind(params);
    if (result.success) {
      if (result.bindingState) {
        this.updateStatus({
          ...this.status,
          bindingState: result.bindingState,
          binding: result.binding ?? this.status.binding,
        });
      }
      try {
        if (api.getStatus) {
          const fresh = await api.getStatus();
          this.updateStatus(fresh);
        }
      } catch (statusErr) {
        console.warn('[GuanjiaDesktopAuthService] follow-up getStatus failed after bind:', statusErr);
      }
    }
    return result;
  }

  public async unbind(params: GuanjiaDesktopAuthUnbindParams): Promise<GuanjiaDesktopAuthUnbindResult> {
    const api = getDesktopAuthApi();
    if (!api?.unbind) {
      throw new Error(tGuanjia('guanjiaAuthUnavailable'));
    }
    const result = await api.unbind(params);
    if (result.success) {
      this.updateStatus({
        ...this.status,
        bindingState: 'unbound',
        binding: null,
      });
      try {
        if (api.getStatus) {
          const fresh = await api.getStatus();
          this.updateStatus(fresh);
        }
      } catch (statusErr) {
        console.warn('[GuanjiaDesktopAuthService] follow-up getStatus failed after unbind:', statusErr);
      }
    }
    return result;
  }

  public async loginBound(): Promise<GuanjiaDesktopAuthLoginResult> {
    const api = getDesktopAuthApi();
    if (!api?.loginBound) {
      throw new Error(tGuanjia('guanjiaAuthUnavailable'));
    }
    const result = await api.loginBound();
    if (result.success) {
      try {
        if (api.getStatus) {
          const fresh = await api.getStatus();
          this.updateStatus(fresh);
        }
      } catch (statusErr) {
        console.warn('[GuanjiaDesktopAuthService] follow-up getStatus failed after loginBound:', statusErr);
      }
    }
    return result;
  }
}

export const guanjiaDesktopAuthService = new GuanjiaDesktopAuthService();

export function useGuanjiaDesktopAuth() {
  const status = useSyncExternalStore(
    guanjiaDesktopAuthService.subscribe,
    guanjiaDesktopAuthService.getStatus,
    guanjiaDesktopAuthService.getStatus,
  );

  useEffect(() => {
    void guanjiaDesktopAuthService.init();
  }, []);

  const bind = useCallback((params: GuanjiaDesktopAuthBindParams) => {
    return guanjiaDesktopAuthService.bind(params);
  }, []);

  const unbind = useCallback((params: GuanjiaDesktopAuthUnbindParams) => {
    return guanjiaDesktopAuthService.unbind(params);
  }, []);

  const loginBound = useCallback(() => {
    return guanjiaDesktopAuthService.loginBound();
  }, []);

  const refresh = useCallback(() => {
    return guanjiaDesktopAuthService.refresh();
  }, []);

  return {
    status,
    bind,
    unbind,
    loginBound,
    refresh,
  };
}
