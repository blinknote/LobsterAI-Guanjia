import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type {
  GuanjiaSessionSnapshot,
  GuanjiaSessionStatus,
  GuanjiaStoreSnapshot,
  GuanjiaUserSnapshot,
} from '../../shared/guanjia/native';

export type {
  GuanjiaSessionSnapshot,
  GuanjiaSessionStatus,
  GuanjiaStoreSnapshot,
  GuanjiaUserSnapshot,
};

export interface GuanjiaLoginPayload {
  account: string;
  password: string;
}

const defaultSnapshot: GuanjiaSessionSnapshot = {
  status: 'unauthenticated',
  generation: 0,
  user: null,
  store: null,
};

class GuanjiaSessionService {
  private snapshot: GuanjiaSessionSnapshot = defaultSnapshot;
  private listeners = new Set<() => void>();
  private initPromise: Promise<GuanjiaSessionSnapshot> | null = null;
  private unsubscribeIpc: (() => void) | null = null;

  constructor() {
    this.setupSubscription();
  }

  private setupSubscription(): void {
    if (typeof window === 'undefined' || this.unsubscribeIpc) return;
    const guanjia = window.electron?.guanjia;
    if (guanjia?.onSessionChanged) {
      this.unsubscribeIpc = guanjia.onSessionChanged((nextSnapshot) => {
        this.updateSnapshot(nextSnapshot);
      });
    } else if (guanjia?.onBusinessSessionChanged) {
      this.unsubscribeIpc = guanjia.onBusinessSessionChanged((nextSnapshot) => {
        this.updateSnapshot(nextSnapshot);
      });
    }
  }

  private updateSnapshot(nextSnapshot: GuanjiaSessionSnapshot): void {
    if (!nextSnapshot) return;
    // 防旧响应回退：若传入代际小于当前代际则忽略
    if (nextSnapshot.generation < this.snapshot.generation) return;
    this.snapshot = nextSnapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public getSnapshot = (): GuanjiaSessionSnapshot => {
    return this.snapshot;
  };

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public async init(): Promise<GuanjiaSessionSnapshot> {
    if (this.initPromise) return this.initPromise;
    this.setupSubscription();

    this.initPromise = (async () => {
      const guanjia = window.electron?.guanjia;
      if (guanjia?.restoreSession) {
        const res = await guanjia.restoreSession();
        this.updateSnapshot(res);
      } else if (guanjia?.getBusinessSession) {
        const res = await guanjia.getBusinessSession();
        this.updateSnapshot(res);
      }
      return this.snapshot;
    })().catch((err) => {
      console.warn('[GuanjiaSessionService] init error:', err);
      return this.snapshot;
    });

    return this.initPromise;
  }

  public async login(payload: GuanjiaLoginPayload): Promise<GuanjiaSessionSnapshot> {
    const guanjia = window.electron?.guanjia;
    if (!guanjia?.login) {
      throw new Error('Guanjia login API is unavailable');
    }
    const res = await guanjia.login(payload);
    this.updateSnapshot(res);
    return this.snapshot;
  }

  public async logout(): Promise<void> {
    const guanjia = window.electron?.guanjia;
    if (!guanjia?.logout) throw new Error('退出接口不可用');
    const result = await guanjia.logout();
    if (guanjia.getSessionSnapshot) this.updateSnapshot(await guanjia.getSessionSnapshot());
    if (!result.success) throw new Error(result.error || '本地已退出，服务端注销未确认');
  }

  public async restore(): Promise<GuanjiaSessionSnapshot> {
    const guanjia = window.electron?.guanjia;
    if (guanjia?.restoreSession) {
      const res = await guanjia.restoreSession();
      this.updateSnapshot(res);
    }
    return this.snapshot;
  }
}

export const guanjiaSessionService = new GuanjiaSessionService();

export function useGuanjiaSession() {
  const snapshot = useSyncExternalStore(
    guanjiaSessionService.subscribe,
    guanjiaSessionService.getSnapshot,
    guanjiaSessionService.getSnapshot,
  );
  useEffect(() => {
    void guanjiaSessionService.init();
  }, []);

  const login = useCallback((payload: GuanjiaLoginPayload) => {
    return guanjiaSessionService.login(payload);
  }, []);

  const logout = useCallback(() => {
    return guanjiaSessionService.logout();
  }, []);

  const restore = useCallback(() => {
    return guanjiaSessionService.restore();
  }, []);

  const init = useCallback(() => {
    return guanjiaSessionService.init();
  }, []);

  return {
    snapshot,
    status: snapshot.status,
    generation: snapshot.generation,
    user: snapshot.user,
    store: snapshot.store,
    error: snapshot.error,
    init,
    login,
    logout,
    restore,
  };
}
