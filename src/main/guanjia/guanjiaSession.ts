import {
  getCachedGuanjiaModelConfig,
  getEffectiveGuanjiaSystemBuiltinModelRef,
  isGuanjiaSystemModelActive,
  setCachedGuanjiaModelConfig,
  setGuanjiaAuthenticated,
  setGuanjiaSessionTokenGetter,
} from './guanjiaModelConfig';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';
import { GuanjiaClientModelConfig, GuanjiaIpcChannel, GuanjiaLoginPayload, GuanjiaSessionSnapshot, GuanjiaSsoCredentials, GuanjiaStoreSnapshot, GuanjiaUserSnapshot } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identity(value: unknown): { user: GuanjiaUserSnapshot; storeIds: Set<string>; homeStoreId: string | null } {
  const body = record(value);
  const me = record(body?.data);
  const id = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  const employeeId = id(me?.employee_id);
  const tenantId = id(me?.tenant_id);
  if (body?.success !== true || !me || !employeeId || !tenantId || typeof me.employee_no !== 'string' || !me.employee_no.trim() || typeof me.role !== 'string' || !me.role.trim() || !Array.isArray(me.store_ids)) throw new Error('服务端身份核验失败：缺少有效员工、租户或门店权限字段');
  const stores = me.store_ids.map((v) => typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null);
  if (stores.some((v) => v === null)) throw new Error('服务端门店权限数据无效');
  const systemName = typeof me.system_name === 'string' && me.system_name.trim() ? me.system_name.trim() : undefined;
  const tenantName = typeof me.tenant_name === 'string' && me.tenant_name.trim() ? me.tenant_name.trim() : undefined;
  const homeStoreId = id(me?.home_store_id);
  return { user: { id: employeeId, employeeNo: me.employee_no.trim(), name: typeof me.name === 'string' && me.name.trim() ? me.name.trim() : undefined, role: me.role.trim(), tenantId, systemName, tenantName }, storeIds: new Set(stores as string[]), homeStoreId };
}
export class GuanjiaSession {
  public static readonly CANONICAL_CHANNEL = GuanjiaIpcChannel.SessionChanged;
  private static instance: GuanjiaSession | null = null;
  private generation = 0;
  private snapshot: GuanjiaSessionSnapshot = { status: 'unauthenticated', generation: 0, user: null, store: null, systemName: undefined, updatedAt: Date.now() };
  private credentials: { token: string; userId: string; username: string; source?: string } | null = null;
  private listeners = new Set<(snapshot: GuanjiaSessionSnapshot) => void>();
  private restorePromise: Promise<GuanjiaSessionSnapshot> | null = null;
  private constructor() {}
  public static getInstance(): GuanjiaSession {
    if (!GuanjiaSession.instance) {
      GuanjiaSession.instance = new GuanjiaSession();
      setGuanjiaSessionTokenGetter(() => GuanjiaSession.instance?.getCredentials()?.token || null);
    }
    return GuanjiaSession.instance;
  }
  public getSnapshot(): GuanjiaSessionSnapshot {
    return { ...this.snapshot, user: this.snapshot.user ? { ...this.snapshot.user } : null, store: this.snapshot.store ? { ...this.snapshot.store } : null, systemName: this.snapshot.systemName };
  }
  public getGeneration(): number {
    return this.generation;
  }
  public getCredentials(): { token: string; userId: string; username: string } | null {
    return this.snapshot.status === 'authenticated' && this.credentials ? { ...this.credentials } : null;
  }
  public getCachedModelConfig(): GuanjiaClientModelConfig | null {
    return getCachedGuanjiaModelConfig();
  }
  public setCachedModelConfig(config: GuanjiaClientModelConfig | null): void {
    setCachedGuanjiaModelConfig(config);
  }
  public isSystemBuiltinActive(): boolean {
    return isGuanjiaSystemModelActive();
  }
  public getSystemBuiltinModelRef(): string | null {
    return getEffectiveGuanjiaSystemBuiltinModelRef();
  }
  public subscribe(listener: (snapshot: GuanjiaSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(snapshot: GuanjiaSessionSnapshot): GuanjiaSessionSnapshot {
    this.snapshot = { ...snapshot, updatedAt: Date.now() };
    setGuanjiaAuthenticated(snapshot.status === 'authenticated');
    for (const listener of this.listeners) {
      try { listener(this.getSnapshot()); } catch (err) { console.error('[GuanjiaSession] Listener failed:', err); }
    }
    return this.getSnapshot();
  }
  private begin(): number {
    this.credentials = null;
    this.restorePromise = null;
    setGuanjiaAuthenticated(false);
    const generation = ++this.generation;
    this.publish({ status: 'restoring', generation, user: null, store: null, systemName: undefined });
    return generation;
  }
  private fail(generation: number, error: unknown): GuanjiaSessionSnapshot {
    if (generation !== this.generation) return this.getSnapshot();
    this.credentials = null;
    setGuanjiaAuthenticated(false);
    GuanjiaWorkspaceManager.getInstance().clearSsoCredentials();
    void GuanjiaWorkspaceManager.getInstance().clearSessionCredentials(generation).catch(() => {});
    return this.publish({ status: 'temporarily_unavailable', generation, user: null, store: null, systemName: undefined, error: error instanceof Error ? error.message : '服务暂不可用，请重试' });
  }
  public async verify(token: string): Promise<{ user: GuanjiaUserSnapshot; storeIds: Set<string>; homeStoreId: string | null }> {
    const base = GuanjiaWorkspaceManager.getInstance().getDefaultUrl();
    const response = await fetch(new URL('/api/c/rbac/me', base), { headers: { 'X-Token': token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status === 401) { const error = new Error('会话已失效，请重新登录'); error.name = 'SessionExpired'; throw error; }
    if (!response.ok) throw new Error('会话核验失败 (HTTP ' + response.status + ')');
    return identity(await response.json());
  }
  public async resolveDefaultStore(
    token: string,
    user: GuanjiaUserSnapshot,
    homeStoreId?: string | null,
    storeIds?: Set<string>,
  ): Promise<GuanjiaStoreSnapshot | null> {
    const isChainAdmin = user.role === 'tenant_admin' || user.role === 'super_admin';
    if (isChainAdmin) {
      return {
        id: 0,
        code: 'all',
        name: user.tenantName ? `${user.tenantName}（连锁总部）` : '连锁总部',
      };
    }
    try {
      const base = GuanjiaWorkspaceManager.getInstance().getDefaultUrl();
      const response = await fetch(new URL('/api/c/stores', base), {
        headers: { 'X-Token': token },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const body = record(await response.json());
        const list = Array.isArray(body?.data) ? body.data : [];
        if (list.length > 0) {
          let matched: Record<string, unknown> | null = null;
          if (homeStoreId) {
            matched = (list.find((s) => record(s) && String(record(s)?.id) === String(homeStoreId)) as Record<string, unknown>) || null;
          }
          if (!matched && storeIds && storeIds.size > 0) {
            matched = (list.find((s) => record(s) && storeIds.has(String(record(s)?.id))) as Record<string, unknown>) || null;
          }
          if (!matched && record(list[0])) {
            matched = record(list[0]);
          }
          if (matched && matched.id !== undefined && matched.id !== null) {
            return {
              id: matched.id as string | number,
              code: typeof matched.store_code === 'string' ? matched.store_code : '',
              name: typeof matched.store_name === 'string' ? matched.store_name : (typeof matched.name === 'string' ? matched.name : '默认门店'),
            };
          }
        }
      }
    } catch (err) {
      console.warn('[GuanjiaSession] resolveDefaultStore failed:', err);
    }
    if (homeStoreId) {
      return { id: homeStoreId, code: '', name: '主属门店' };
    }
    if (storeIds && storeIds.size > 0) {
      const firstId = Array.from(storeIds)[0];
      if (firstId && firstId !== '*') {
        return { id: firstId, code: '', name: '默认门店' };
      }
    }
    return null;
  }
  private async commit(
    token: string,
    user: GuanjiaUserSnapshot,
    store: GuanjiaStoreSnapshot | null,
    generation: number,
    source: 'sso' | 'password' | 'restoration' = 'password',
    operationId?: string,
    syncWorkspace = true,
  ): Promise<GuanjiaSessionSnapshot> {
    if (generation !== this.generation) return this.getSnapshot();
    const manager = GuanjiaWorkspaceManager.getInstance();
    const isChainAdmin = user.role === 'tenant_admin' || user.role === 'super_admin';
    const effectiveStore =
      store ??
      (isChainAdmin ? { id: 0, code: 'all', name: user.tenantName ? `${user.tenantName}（连锁总部）` : '连锁总部' } : null);
    const sso: GuanjiaSsoCredentials = { token, userId: String(user.id), username: user.employeeNo, realName: user.name, role: user.role, tenantId: String(user.tenantId), shopId: effectiveStore ? String(effectiveStore.id) : '', shopName: effectiveStore?.name || '', storeCode: effectiveStore?.code };
    try {
      if (syncWorkspace) {
        await manager.injectSessionCredentials(sso, generation, operationId);
      } else {
        manager.setSsoCredentials(sso);
      }
    } catch (err) {
      return this.handleFailure(generation, err);
    }
    if (generation !== this.generation) return this.getSnapshot();
    this.credentials = { token, userId: String(user.id), username: user.employeeNo, source };
    setCachedGuanjiaModelConfig({
      client_ai_provider: 'system_builtin',
      provider_name: 'system_builtin',
      model_name: 'gemini-3.8-flash-high',
      display_name: '智慧管家助手模型',
      balance: 0,
      hide_youdao_models: true,
      api_base_url: 'https://guanjia.duanyangdao.com/api/c/ai/v1',
      api_key: '',
      api_type: 'openai',
    });
    return this.publish({ status: 'authenticated', generation, user, store: effectiveStore, systemName: user.systemName });
  }
  public async adoptCandidate(
    token: string,
    user: GuanjiaUserSnapshot,
    store: GuanjiaStoreSnapshot | null = null,
    source: 'sso' | 'password' | 'restoration' = 'sso',
    operationId?: string,
    homeStoreId?: string | null,
    storeIds?: Set<string>,
  ): Promise<GuanjiaSessionSnapshot> {
    const generation = this.begin();
    let effectiveStore = store;
    if (!effectiveStore) {
      effectiveStore = await this.resolveDefaultStore(token, user, homeStoreId, storeIds);
    }
    return this.commit(token, user, effectiveStore, generation, source, operationId);
  }
  public async login(payload: GuanjiaLoginPayload): Promise<GuanjiaSessionSnapshot> {
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.clearSsoCredentials();
    const generation = this.begin();
    try {
      await manager.clearSessionCredentials();
      if (generation !== this.generation) return this.getSnapshot();
      if (!payload?.account?.trim() || !payload.password) throw new Error('账号和密码不能为空');
      const response = await fetch(new URL('/api/c/login', manager.getDefaultUrl()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_no: payload.account.trim(), password: payload.password }), redirect: 'error', signal: AbortSignal.timeout(15000) });
      const body = record(await response.json());
      const data = record(body?.data);
      if (!response.ok || body?.success !== true || typeof data?.token !== 'string' || !data.token.trim()) {
        const error = record(body?.error);
        throw new Error(typeof error?.message === 'string' ? error.message : typeof body?.error === 'string' ? body.error : '登录失败，请核对账号和密码');
      }
      const rawToken = data.token.trim();
      try {
        const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
        GuanjiaDesktopAuthCoordinator.getInstance().trackOwnedToken(rawToken, 'password');
      } catch (err) {
        return this.handleFailure(generation, err);
      }
      if (generation !== this.generation) {
        try {
          const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
          void GuanjiaDesktopAuthCoordinator.getInstance().revokeTokenDirect(rawToken);
        } catch {
          // ignore
        }
        return this.getSnapshot();
      }
      const verified = await this.verify(rawToken);
      if (generation !== this.generation) {
        try {
          const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
          void GuanjiaDesktopAuthCoordinator.getInstance().revokeTokenDirect(rawToken);
        } catch {
          // ignore
        }
        return this.getSnapshot();
      }
      const defaultStore = await this.resolveDefaultStore(rawToken, verified.user, verified.homeStoreId, verified.storeIds);
      const snapshot = await this.commit(rawToken, verified.user, defaultStore, generation, 'password');
      if (snapshot.status === 'authenticated' && snapshot.generation === generation) {
        try {
          const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
          const current = this.getSnapshot();
          if (
            generation !== this.generation ||
            current.status !== 'authenticated' ||
            current.generation !== generation ||
            !current.user ||
            String(current.user.id) !== String(verified.user.id) ||
            String(current.user.tenantId) !== String(verified.user.tenantId)
          ) return snapshot;
          GuanjiaDesktopAuthCoordinator.getInstance().setLogoutSuppressed(false);
        } catch {
          // ignore coordinator error
        }
      }
      return snapshot;
    } catch (error) { return this.handleFailure(generation, error); }
  }
  private handleFailure(generation: number, error: unknown): GuanjiaSessionSnapshot {
    if (generation !== this.generation) return this.getSnapshot();
    this.credentials = null;
    if (error instanceof Error && error.name === 'SessionExpired') { this.invalidate(error.message); return this.getSnapshot(); }
    return this.fail(generation, error);
  }
  public async logout(options?: { suppressAutoLogin?: boolean }): Promise<void> {
    const suppress = options?.suppressAutoLogin ?? true;
    try {
      const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
      if (suppress) {
        GuanjiaDesktopAuthCoordinator.getInstance().setLogoutSuppressed(true);
      }
      GuanjiaDesktopAuthCoordinator.getInstance().cancelProactiveRenewal();
    } catch {
      // ignore
    }
    const token = this.credentials?.token;
    this.credentials = null;
    this.restorePromise = null;
    setGuanjiaAuthenticated(false);
    const generation = ++this.generation;
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.clearSsoCredentials();
    this.publish({ status: 'unauthenticated', generation, user: null, store: null });
    await manager.clearSessionCredentials(generation);
    if (!token) return;
    try {
      const response = await fetch(new URL('/api/c/logout', manager.getDefaultUrl()), { method: 'POST', headers: { 'X-Token': token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const body = record(await response.json());
      if (!response.ok || body?.success !== true) console.warn('[GuanjiaSession] Remote logout not confirmed by server');
    } catch (err) {
      console.warn('[GuanjiaSession] Remote logout network error:', err);
    }
  }
  public restore(): Promise<GuanjiaSessionSnapshot> {
    if (this.restorePromise) return this.restorePromise;
    const promise = this.performRestore();
    this.restorePromise = promise;
    void promise.finally(() => { if (this.restorePromise === promise) this.restorePromise = null; });
    return promise;
  }
  private async performRestore(): Promise<GuanjiaSessionSnapshot> {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const existingToken = this.credentials?.token;
    const existingSource = this.credentials?.source as 'sso' | 'password' | 'restoration' | undefined;
    const generation = this.begin();
    try {
      const token = existingToken || await manager.getRestorableToken();
      if (token) {
        const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
        const coordinator = GuanjiaDesktopAuthCoordinator.getInstance();
        const source = existingToken && existingSource ? existingSource : coordinator.getOwnedTokenSource(token) || 'restoration';
        coordinator.trackOwnedToken(token, source);
      }
      if (generation !== this.generation) return this.getSnapshot();
      if (!token) return this.publish({ status: 'unauthenticated', generation, user: null, store: null });
      const verified = await this.verify(token);
      if (generation !== this.generation) return this.getSnapshot();
      let source: 'sso' | 'password' | 'restoration' = 'restoration';
      if (existingToken && existingSource) {
        source = existingSource;
      } else {
        try {
          const { GuanjiaDesktopAuthCoordinator } = await import('./guanjiaDesktopAuthCoordinator');
          const ownedSource = GuanjiaDesktopAuthCoordinator.getInstance().getOwnedTokenSource(token);
          if (ownedSource) source = ownedSource;
        } catch {
          // ignore
        }
      }
      const snapshot = await this.commit(token, verified.user, null, generation, source);
      return snapshot;
    } catch (error) { return this.handleFailure(generation, error); }
  }
  public async setStore(
    store: { id: string | number; code?: string; name?: string } | null,
    options?: { syncWorkspace?: boolean },
  ): Promise<GuanjiaSessionSnapshot> {
    if (this.snapshot.status !== 'authenticated' || !this.snapshot.user || !this.credentials) return this.getSnapshot();
    const currentSource = (this.credentials?.source as 'sso' | 'password' | 'restoration') || 'password';
    const token = this.credentials.token;
    const syncWorkspace = options?.syncWorkspace ?? true;
    const isChainAdmin = this.snapshot.user.role === 'tenant_admin' || this.snapshot.user.role === 'super_admin';
    if (store === null) {
      const targetStore = isChainAdmin
        ? { id: 0, code: 'all', name: this.snapshot.user.tenantName ? `${this.snapshot.user.tenantName}（连锁总部）` : '连锁总部' }
        : null;
      if (this.snapshot.store === targetStore || (this.snapshot.store !== null && targetStore !== null && String(this.snapshot.store.id) === String(targetStore.id))) return this.getSnapshot();
      const { user } = this.snapshot;
      const generation = ++this.generation;
      this.publish({ status: 'authenticated', generation, user, store: targetStore });
      return this.commit(token, user, targetStore, generation, currentSource, undefined, syncWorkspace).catch((error) => this.handleFailure(generation, error));
    }
    if (!store || !['string', 'number'].includes(typeof store.id) || (store.code !== undefined && typeof store.code !== 'string') || (store.name !== undefined && typeof store.name !== 'string')) return { ...this.getSnapshot(), error: '门店参数无效' };
    if (this.snapshot.store && String(this.snapshot.store.id) === String(store.id) && this.snapshot.store.code === store.code) return this.getSnapshot();
    const generation = this.begin();
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.clearSsoCredentials();
    try {
      const verified = await this.verify(token);
      if (generation !== this.generation) return this.getSnapshot();
      const id = String(store.id).trim();
      const verifiedIsChainAdmin = verified.user.role === 'super_admin' || verified.user.role === 'tenant_admin';
      if (!verifiedIsChainAdmin && !verified.storeIds.has('*') && !verified.storeIds.has('0') && !verified.storeIds.has(id)) throw new Error('无权访问所选门店');
      return await this.commit(token, verified.user, { id, code: store.code, name: store.name }, generation, currentSource, undefined, syncWorkspace);
    } catch (error) { return this.handleFailure(generation, error); }
  }
  public invalidate(reason?: string): void {
    this.credentials = null;
    this.restorePromise = null;
    setGuanjiaAuthenticated(false);
    const generation = ++this.generation;
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.clearSsoCredentials();
    this.publish({ status: 'expired', generation, user: null, store: null, error: reason || '会话已过期，请重新登录' });
    void manager.clearSessionCredentials(generation).catch((error) => console.warn('[GuanjiaSession] Credential clearing failed:', error));
  }
}

export {
  getCachedGuanjiaModelConfig,
  getEffectiveGuanjiaSystemBuiltinModelRef,
  isGuanjiaSessionAuthenticated,
  isGuanjiaSystemModelActive,
  setCachedGuanjiaModelConfig,
  setGuanjiaAuthenticated,
} from './guanjiaModelConfig';
