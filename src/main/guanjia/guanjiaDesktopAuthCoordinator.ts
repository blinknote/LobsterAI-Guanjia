import * as crypto from 'crypto';
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  GuanjiaDesktopAuthBindParams,
  GuanjiaDesktopAuthBindResult,
  GuanjiaDesktopAuthLoginResult,
  GuanjiaDesktopAuthStatus,
  GuanjiaDesktopAuthUnbindParams,
  GuanjiaDesktopAuthUnbindResult,
  GuanjiaDesktopBindingInfo,
  GuanjiaDesktopBindingState,
  RegisterBusinessTokenParams,
  RegisterBusinessTokenResult,
} from '../../shared/guanjia/desktopAuth';
import { isTestModeEnabled } from '../libs/endpoints';
import { GuanjiaSession } from './guanjiaSession';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';
import { GuanjiaSessionSnapshot } from './types';

const OFFICIAL_PROFILE_URL = 'https://lobsterai-server.youdao.com/api/user/profile';

interface PersistedIssuanceAttempt {
  requestId: string;
  encryptedRevokeSecret: string | null;
  createdAt: number;
  status: 'pending' | 'active' | 'revoked';
}

interface PersistedOwnedToken {
  tokenHash: string;
  encryptedToken: string | null;
  source: 'sso' | 'password' | 'restoration';
  createdAt: number;
  employeeNo?: string;
  tenantId?: string;
}

interface PersistedState {
  logoutSuppressed: boolean;
  issuanceAttempts: PersistedIssuanceAttempt[];
  ownedTokens: PersistedOwnedToken[];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class GuanjiaDesktopAuthCoordinator {
  private static instance: GuanjiaDesktopAuthCoordinator | null = null;

  private officialOwner: string | null = null;
  private officialGeneration = 0;
  private logoutSuppressed = false;

  private bindingState: GuanjiaDesktopBindingState = 'not_checked';
  private bindingInfo: GuanjiaDesktopBindingInfo | null = null;
  private lastError: string | undefined = undefined;

  // In-memory secrets & tokens cache
  private inMemoryRevokeSecrets = new Map<string, string>(); // requestId -> raw secret
  private inMemoryOwnedTokens = new Map<string, { token: string; source: 'sso' | 'password' | 'restoration'; employeeNo?: string; tenantId?: string; createdAt: number }>(); // tokenHash -> entry
  private issuanceAttempts = new Map<string, { requestId: string; status: 'pending' | 'active' | 'revoked'; createdAt: number }>();

  private inFlightSync: Promise<GuanjiaDesktopAuthStatus> | null = null;
  private desktopSessionRestoreCompleted = false;
  private inFlightRestore: Promise<GuanjiaSessionSnapshot> | null = null;
  private isStartupIntentActive = true;
  private startupExpectedBusinessGeneration: number | null = null;
  private attemptedRecoveryOwnerKeys = new Set<string>();

  private listeners = new Set<(status: GuanjiaDesktopAuthStatus) => void>();

  private officialTokenGetter: (() => string | null) | null = null;
  private officialUserGetter: (() => Record<string, unknown> | null) | null = null;
  private storageFilePath: string;

  private constructor() {
    this.storageFilePath = path.join(app.getPath('userData'), 'guanjia-desktop-auth-state.json');
    this.loadPersistedState();
  }

  public static getInstance(): GuanjiaDesktopAuthCoordinator {
    if (!GuanjiaDesktopAuthCoordinator.instance) {
      GuanjiaDesktopAuthCoordinator.instance = new GuanjiaDesktopAuthCoordinator();
    }
    return GuanjiaDesktopAuthCoordinator.instance;
  }

  public setOfficialAccessors(
    getToken: () => string | null,
    getUser: () => Record<string, unknown> | null,
  ): void {
    this.officialTokenGetter = getToken;
    this.officialUserGetter = getUser;
  }

  public subscribe(listener: (status: GuanjiaDesktopAuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyStatusChanged(): void {
    const status = this.getStatusSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[DesktopAuthCoordinator] Listener error:', err);
      }
    }
  }

  // =========================================================================
  // 共享启动会话恢复与 GetUser 补救恢复
  // =========================================================================
  /**
   * 共享启动恢复逻辑 (单进程只执行一次非破坏性恢复，并发调用共享同一个 inFlight Promise)
   */
  public restoreDesktopSession(): Promise<GuanjiaSessionSnapshot> {
    if (this.desktopSessionRestoreCompleted) {
      return Promise.resolve(GuanjiaSession.getInstance().getSnapshot());
    }
    if (this.inFlightRestore) {
      return this.inFlightRestore;
    }
    const initialBusinessGen = GuanjiaSession.getInstance().getGeneration();
    const restorePromise = Promise.resolve().then(() => this.performRestoreDesktopSession(initialBusinessGen));
    this.inFlightRestore = restorePromise;
    const cleanup = (): void => {
      if (this.inFlightRestore === restorePromise) {
        this.inFlightRestore = null;
      }
    };
    void restorePromise.then(cleanup, cleanup);
    return restorePromise;
  }

  private async performRestoreDesktopSession(invokedBusinessGen: number): Promise<GuanjiaSessionSnapshot> {
    const sessionService = GuanjiaSession.getInstance();
    const capturedOfficialGen = this.officialGeneration;

    try {
      // 若用户已主动退出管家 (logoutSuppressed === true)，跳过 cookie restore 与后续静默换取
      // 若在启动恢复被调用前/微任务执行前业务代次已推进（非初始作用域，如已有手动登录尝试），跳过恢复
      if (
        !this.isStartupIntentActive ||
        this.logoutSuppressed ||
        invokedBusinessGen !== 0 ||
        sessionService.getGeneration() !== invokedBusinessGen
      ) {
        this.isStartupIntentActive = false;
        return sessionService.getSnapshot();
      }

      this.startupExpectedBusinessGeneration = invokedBusinessGen;

      let currentSnapshot = sessionService.getSnapshot();
      // 若初始状态已认证或正在 restoring，视为已有初始手动登录意图，关闭启动意图并跳过恢复
      if (currentSnapshot.status === 'authenticated' || currentSnapshot.status === 'restoring') {
        this.isStartupIntentActive = false;
        return currentSnapshot;
      }

      // 尝试非破坏性真实 cookie 恢复
      const manager = GuanjiaWorkspaceManager.getInstance();
      const cookieToken = await manager.getRestorableToken().catch((): string | null => null);

      if (
        cookieToken &&
        !this.logoutSuppressed &&
        this.officialGeneration === capturedOfficialGen &&
        this.isStartupIntentActive &&
        sessionService.getGeneration() === invokedBusinessGen
      ) {
        const source = this.getOwnedTokenSource(cookieToken) || 'restoration';
        this.trackOwnedToken(cookieToken, source);

        try {
          const verified = await sessionService.verify(cookieToken);
          if (
            this.officialGeneration === capturedOfficialGen &&
            this.isStartupIntentActive &&
            sessionService.getGeneration() === invokedBusinessGen &&
            !this.logoutSuppressed
          ) {
            const adoptPromise = sessionService.adoptCandidate(
              cookieToken,
              verified.user,
              null,
              source,
            );
            const reservedGen = sessionService.getGeneration();
            const adoptedSnapshot = await adoptPromise;
            const currentCreds = sessionService.getCredentials();
            const isAdoptSuccess =
              adoptedSnapshot.status === 'authenticated' &&
              adoptedSnapshot.generation === reservedGen &&
              sessionService.getGeneration() === reservedGen &&
              this.officialGeneration === capturedOfficialGen &&
              this.isStartupIntentActive &&
              !this.logoutSuppressed &&
              currentCreds?.token === cookieToken &&
              adoptedSnapshot.user != null &&
              verified.user != null &&
              String(adoptedSnapshot.user.id) === String(verified.user.id) &&
              String(adoptedSnapshot.user.tenantId) === String(verified.user.tenantId);

            if (isAdoptSuccess) {
              this.startupExpectedBusinessGeneration = reservedGen;
            }
          }
        } catch {
          console.warn('[DesktopAuth] Cookie session restore unverified');
        }
      }

      currentSnapshot = sessionService.getSnapshot();

      // postawait 检查：若业务仍未认证且未主动退出抑制，且未在 restoring，转真实官方静默同步与换取
      if (
        this.officialGeneration === capturedOfficialGen &&
        this.isStartupIntentActive &&
        !this.logoutSuppressed &&
        sessionService.getGeneration() === this.startupExpectedBusinessGeneration
      ) {
        if (
          currentSnapshot.status !== 'authenticated' &&
          currentSnapshot.status !== 'restoring'
        ) {
          await this.syncDesktopAuthSilent({
            allowAdoption: true,
            intent: 'startup',
          }).catch(() => {
            console.warn('[DesktopAuth] Startup silent auth sync failed');
          });
        }
      }
    } finally {
      this.desktopSessionRestoreCompleted = true;
    }

    return sessionService.getSnapshot();
  }

  /**
   * 针对官方已登录但管家会话缺失/过期的有界补救恢复 (由成功持久化的 GetUser 触发)
   */
  public async recoverRestoredOfficialSession(verifiedOfficialId?: number): Promise<GuanjiaDesktopAuthStatus> {
    if (this.logoutSuppressed || !this.isStartupIntentActive) {
      return this.getStatusSnapshot();
    }

    if (
      typeof verifiedOfficialId !== 'number' ||
      !Number.isSafeInteger(verifiedOfficialId) ||
      verifiedOfficialId <= 0
    ) {
      return this.getStatusSnapshot();
    }
    const sessionService = GuanjiaSession.getInstance();
    const currentSnapshot = sessionService.getSnapshot();
    if (currentSnapshot.status === 'authenticated' || currentSnapshot.status === 'restoring') {
      return this.getStatusSnapshot();
    }

    if (
      this.startupExpectedBusinessGeneration !== null &&
      sessionService.getGeneration() !== this.startupExpectedBusinessGeneration
    ) {
      this.isStartupIntentActive = false;
      return this.getStatusSnapshot();
    }

    const capturedOfficialGen = this.officialGeneration;
    const quotaKey = `${verifiedOfficialId}:${capturedOfficialGen}`;

    if (this.attemptedRecoveryOwnerKeys.has(quotaKey)) {
      return this.getStatusSnapshot();
    }

    // 每次进程针对已核验的 owner+officialGen 配额最多尝试一次；在 await 之前提前保留尝试配额
    this.attemptedRecoveryOwnerKeys.add(quotaKey);

    if (this.inFlightRestore) {
      await this.inFlightRestore.catch(() => {});
    } else if (!this.desktopSessionRestoreCompleted) {
      await this.restoreDesktopSession().catch(() => {});
    }

    if (
      this.officialGeneration !== capturedOfficialGen ||
      !this.isStartupIntentActive ||
      this.logoutSuppressed
    ) {
      return this.getStatusSnapshot();
    }

    const postSnapshot = sessionService.getSnapshot();
    if (postSnapshot.status === 'authenticated' || postSnapshot.status === 'restoring') {
      return this.getStatusSnapshot();
    }

    if (
      this.startupExpectedBusinessGeneration !== null &&
      sessionService.getGeneration() !== this.startupExpectedBusinessGeneration
    ) {
      this.isStartupIntentActive = false;
      return this.getStatusSnapshot();
    }

    return this.syncDesktopAuthSilent({ allowAdoption: true, intent: 'startup' });
  }

  // =========================================================================
  // 安全持久化状态存储 (safeStorage 加密，无明文落盘)
  // =========================================================================
  private loadPersistedState(): void {
    try {
      if (!fs.existsSync(this.storageFilePath)) return;
      const raw = fs.readFileSync(this.storageFilePath, 'utf8');
      const data = JSON.parse(raw) as PersistedState;
      this.logoutSuppressed = Boolean(data.logoutSuppressed);

      const canDecrypt = safeStorage.isEncryptionAvailable();

      if (Array.isArray(data.issuanceAttempts)) {
        for (const attempt of data.issuanceAttempts) {
          this.issuanceAttempts.set(attempt.requestId, {
            requestId: attempt.requestId,
            status: attempt.status,
            createdAt: attempt.createdAt,
          });
          if (canDecrypt && attempt.encryptedRevokeSecret) {
            try {
              const secret = safeStorage.decryptString(Buffer.from(attempt.encryptedRevokeSecret, 'base64'));
              this.inMemoryRevokeSecrets.set(attempt.requestId, secret);
            } catch {
              // 忽略解密失败
            }
          }
        }
      }

      if (Array.isArray(data.ownedTokens)) {
        for (const owned of data.ownedTokens) {
          if (canDecrypt && owned.encryptedToken) {
            try {
              const token = safeStorage.decryptString(Buffer.from(owned.encryptedToken, 'base64'));
              this.inMemoryOwnedTokens.set(owned.tokenHash, {
                token,
                source: owned.source,
                employeeNo: owned.employeeNo,
                tenantId: owned.tenantId,
                createdAt: owned.createdAt,
              });
            } catch {
              // 忽略解密失败
            }
          }
        }
      }
    } catch (err) {
      console.warn('[DesktopAuthCoordinator] Failed to load persisted state:', err);
    }
  }

  private savePersistedState(options?: { requireEncryption?: boolean; throwOnError?: boolean }): void {
    try {
      const canEncrypt = safeStorage.isEncryptionAvailable();
      if (options?.requireEncryption && !canEncrypt) {
        throw new Error('系统安全存储不可用，无法安全持久化凭证撤销密钥');
      }
      const attempts: PersistedIssuanceAttempt[] = [];
      for (const [requestId, meta] of this.issuanceAttempts.entries()) {
        let encryptedRevokeSecret: string | null = null;
        const secret = this.inMemoryRevokeSecrets.get(requestId);
        if (canEncrypt && secret) {
          encryptedRevokeSecret = safeStorage.encryptString(secret).toString('base64');
        }
        attempts.push({
          requestId,
          encryptedRevokeSecret,
          createdAt: meta.createdAt,
          status: meta.status,
        });
      }

      const tokens: PersistedOwnedToken[] = [];
      for (const [tokenHash, meta] of this.inMemoryOwnedTokens.entries()) {
        let encryptedToken: string | null = null;
        if (canEncrypt && meta.token) {
          encryptedToken = safeStorage.encryptString(meta.token).toString('base64');
        }
        tokens.push({
          tokenHash,
          encryptedToken,
          source: meta.source,
          createdAt: meta.createdAt,
          employeeNo: meta.employeeNo,
          tenantId: meta.tenantId,
        });
      }

      const state: PersistedState = {
        logoutSuppressed: this.logoutSuppressed,
        issuanceAttempts: attempts,
        ownedTokens: tokens,
      };

      const tempPath = `${this.storageFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.storageFilePath);
    } catch (err) {
      if (options?.requireEncryption || options?.throwOnError) throw err;
      console.warn('[DesktopAuthCoordinator] Failed to save non-critical state:', err);
    }
  }

  public trackOwnedToken(
    token: string,
    source: 'sso' | 'password' | 'restoration',
    meta?: { employeeNo?: string; tenantId?: string },
  ): void {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) throw new Error('无法登记无效业务 Token');
    const tokenHash = sha256(trimmed);
    const existing = this.inMemoryOwnedTokens.get(tokenHash);
    this.inMemoryOwnedTokens.set(tokenHash, {
      token: trimmed,
      source: source || existing?.source || 'password',
      employeeNo: meta?.employeeNo ?? existing?.employeeNo,
      tenantId: meta?.tenantId ?? existing?.tenantId,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    this.savePersistedState({ requireEncryption: true, throwOnError: true });
  }

  public getOwnedTokenSource(token: string): 'sso' | 'password' | 'restoration' | undefined {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) return undefined;
    return this.inMemoryOwnedTokens.get(sha256(trimmed))?.source;
  }

  // =========================================================================
  // 官方身份核验 (固定生产 profile, 严格数值 code === 0, 正整数 data.id)
  // =========================================================================
  private async verifyOfficialProfile(token: string): Promise<{ success: boolean; userId?: string; error?: string }> {
    try {
      if (isTestModeEnabled()) {
        return { success: false, error: '当前处于测试环境，禁止向官方生产认证服务发送凭证' };
      }

      const response = await fetch(OFFICIAL_PROFILE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        return { success: false, error: '官方认证服务响应异常' };
      }
      if (!response.body) {
        return { success: false, error: '官方认证响应内容为空' };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const MAX_BYTES = 64 * 1024;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BYTES) {
            try { await reader.cancel(); } catch {
              // ignore cancel error
            }
            return { success: false, error: '官方认证响应大小超出安全限制' };
          }
          chunks.push(value);
        }
      }

      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!body || body.code !== 0) {
        return { success: false, error: '官方身份核验失败' };
      }
      const data = record(body.data);
      if (!data || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.id === 'boolean') {
        return { success: false, error: '官方身份标识无效' };
      }
      return { success: true, userId: String(data.id) };
    } catch {
      return { success: false, error: '官方认证连接超时或失败' };
    }
  }

  // =========================================================================
  // 后端认证接口调用 (精确 5 条路由)
  // =========================================================================
  private getBackendUrl(route: string): URL {
    const base = GuanjiaWorkspaceManager.getInstance().getDefaultUrl();
    return new URL(route, base);
  }

  /**
   * 1. 查询绑定状态
   * POST /api/c/auth/youdao/binding/status
   */
  public async fetchBindingStatus(officialToken: string): Promise<{
    success: boolean;
    status?: GuanjiaDesktopBindingState;
    binding?: GuanjiaDesktopBindingInfo | null;
    error?: string;
  }> {
    if (isTestModeEnabled()) {
      return { success: false, status: 'unavailable', error: '测试环境禁止向生产服务发送凭据' };
    }

    try {
      const response = await fetch(this.getBackendUrl('/api/c/auth/youdao/binding/status'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${officialToken}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        return { success: false, status: 'unavailable', error: `查询绑定状态服务异常 (HTTP ${response.status})` };
      }
      const body = record(await response.json());
      if (!body || body.success !== true) {
        const errObj = record(body?.error);
        const msg = typeof errObj?.message === 'string' ? errObj.message : '查询绑定状态失败';
        return { success: false, status: 'unavailable', error: msg };
      }
      const data = record(body.data);
      const rawStatus = typeof data?.status === 'string' ? data.status : '';
      let bindingState: GuanjiaDesktopBindingState = 'unavailable';
      if (rawStatus === 'bound') bindingState = 'bound';
      else if (rawStatus === 'unbound') bindingState = 'unbound';
      else if (rawStatus === 'requires_reverification') bindingState = 'requires_reverification';
      else return { success: false, status: 'unavailable', error: '后端返回未知的绑定状态' };

      let binding: GuanjiaDesktopBindingInfo | null = null;
      if (bindingState === 'bound' || bindingState === 'requires_reverification') {
        const empNo = typeof data?.employee_no === 'string' ? data.employee_no.trim() : '';
        if (empNo) {
          binding = {
            bindingId: typeof data?.binding_id === 'string' ? data.binding_id : undefined,
            tenantId: data?.tenant_id ? String(data.tenant_id) : undefined,
            employeeId: typeof data?.employee_id === 'number' ? data.employee_id : undefined,
            employeeNo: empNo,
            employeeName: typeof data?.employee_name === 'string' ? data.employee_name : undefined,
            boundAt: data?.bound_at as number | string | undefined,
          };
        }
      }
      return { success: true, status: bindingState, binding };
    } catch (err) {
      return { success: false, status: 'unavailable', error: err instanceof Error ? err.message : '网络连接失败' };
    }
  }

  /**
   * 2. 首次员工密码自助绑定
   * POST /api/c/auth/youdao/bind
   */
  public async bind(params: GuanjiaDesktopAuthBindParams): Promise<GuanjiaDesktopAuthBindResult> {
    if (isTestModeEnabled()) {
      return { success: false, error: '测试环境禁止向生产服务发送凭据' };
    }

    const officialToken = this.officialTokenGetter?.();
    if (!officialToken) {
      return { success: false, error: '请先登录 LobsterAI 官方账号' };
    }
    const empNo = params.employeeNo?.trim();
    if (!empNo || !params.password) {
      return { success: false, error: '员工账号和密码不能为空' };
    }

    const capturedOfficialGen = this.officialGeneration;
    const sessionService = GuanjiaSession.getInstance();
    const capturedBusinessGen = sessionService.getGeneration();
    const requestId = crypto.randomUUID();
    try {
      const response = await fetch(this.getBackendUrl('/api/c/auth/youdao/bind'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${officialToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          employee_no: empNo,
          password: params.password,
          request_id: requestId,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });

      const body = record(await response.json());

      // After await JSON: recheck official and businessgens before mutations
      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        return { success: false, error: '认证状态已变更，绑定结果已丢弃' };
      }

      if (!response.ok || body?.success !== true) {
        const errObj = record(body?.error);
        const msg = typeof errObj?.message === 'string' ? errObj.message : typeof body?.error === 'string' ? body.error : '绑定失败，请核对员工账号和密码';
        return { success: false, error: msg };
      }
      const data = record(body?.data);
      const returnedEmpNo = typeof data?.employee_no === 'string' && data.employee_no.trim() ? data.employee_no.trim() : null;
      if (!data || !returnedEmpNo) {
        return { success: false, error: '服务端绑定响应缺少有效员工账号信息' };
      }

      const boundAt = typeof data.bound_at === 'number' || (typeof data.bound_at === 'string' && data.bound_at.trim()) ? data.bound_at : undefined;
      const employeeId = typeof data.employee_id === 'number' && Number.isSafeInteger(data.employee_id) ? data.employee_id : undefined;

      const binding: GuanjiaDesktopBindingInfo = {
        bindingId: typeof data?.binding_id === 'string' ? data.binding_id : undefined,
        tenantId: data?.tenant_id ? String(data.tenant_id) : undefined,
        employeeId,
        employeeNo: returnedEmpNo,
        employeeName: typeof data?.employee_name === 'string' && data.employee_name.trim() ? data.employee_name.trim() : undefined,
        boundAt,
      };

      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        return { success: false, error: '认证状态已变更，绑定结果已丢弃' };
      }

      this.bindingState = 'bound';
      this.bindingInfo = binding;
      this.lastError = undefined;
      this.logoutSuppressed = false;
      this.savePersistedState();
      this.notifyStatusChanged();

      return { success: true, bindingState: 'bound', binding };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '绑定请求失败' };
    }
  }

  /**
   * 3. 桌面自助解绑
   * POST /api/c/auth/youdao/unbind
   */
  public async unbind(params: GuanjiaDesktopAuthUnbindParams): Promise<GuanjiaDesktopAuthUnbindResult> {
    if (isTestModeEnabled()) {
      return { success: false, unbound: false, error: '测试环境禁止向生产服务发送凭据' };
    }

    const officialToken = this.officialTokenGetter?.();
    if (!officialToken) {
      return { success: false, unbound: false, error: '请先登录 LobsterAI 官方账号' };
    }
    if (!params.password) {
      return { success: false, unbound: false, error: '请输入当前绑定员工密码以核验解绑' };
    }

    const capturedOfficialGen = this.officialGeneration;
    const sessionService = GuanjiaSession.getInstance();
    const capturedBusinessGen = sessionService.getGeneration();
    const requestId = crypto.randomUUID();
    try {
      const response = await fetch(this.getBackendUrl('/api/c/auth/youdao/unbind'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${officialToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: params.password,
          request_id: requestId,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });

      const body = record(await response.json());
      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        return { success: false, unbound: false, error: '官方或业务认证状态已变更，解绑已丢弃' };
      }

      if (!response.ok || body?.success !== true) {
        const errObj = record(body?.error);
        const msg = typeof errObj?.message === 'string' ? errObj.message : typeof body?.error === 'string' ? body.error : '解绑失败，密码核验未通过';
        return { success: false, unbound: false, error: msg };
      }

      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        return { success: false, unbound: false, error: '官方或业务认证状态已变更，解绑已丢弃' };
      }

      this.bindingState = 'unbound';
      this.bindingInfo = null;
      this.lastError = undefined;

      // 若当前业务会话为 SSO 会话，则失效该会话
      const creds = sessionService.getCredentials() as { source?: string } | null;
      if (creds && (creds as { source?: string }).source === 'sso') {
        sessionService.invalidate('账号已解除绑定');
      }

      this.savePersistedState();
      this.notifyStatusChanged();

      return { success: true, unbound: true };
    } catch (err) {
      return { success: false, unbound: false, error: err instanceof Error ? err.message : '解绑请求失败' };
    }
  }

  /**
   * 4. 签发尝试撤销 (补偿撤销墓碑)
   * POST /api/c/auth/youdao/issuance/revoke
   */
  public async compensateRevokeIssuance(requestId: string, revokeSecret: string): Promise<boolean> {
    try {
      const response = await fetch(this.getBackendUrl('/api/c/auth/youdao/issuance/revoke'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          revoke_secret: revokeSecret,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const body = record(await response.json());
      const revoked = response.ok && body?.success === true;
      if (revoked) {
        const meta = this.issuanceAttempts.get(requestId);
        if (meta) meta.status = 'revoked';
        this.savePersistedState();
      }
      return Boolean(revoked);
    } catch (err) {
      console.warn('[DesktopAuthCoordinator] Compensate revoke error:', err);
      return false;
    }
  }

  /**
   * 5. 业务凭据换取与非破坏性采用
   * POST /api/c/auth/youdao/exchange
   */
  public async exchangeAndAdopt(): Promise<GuanjiaDesktopAuthLoginResult> {
    if (isTestModeEnabled()) {
      return { success: false, error: '测试环境禁止向生产服务发送凭据' };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '系统安全存储不可用，无法安全签发业务凭据' };
    }

    const officialToken = this.officialTokenGetter?.();
    if (!officialToken) {
      return { success: false, error: '未登录官方账号' };
    }

    const capturedOfficialGen = this.officialGeneration;
    const sessionService = GuanjiaSession.getInstance();
    const capturedBusinessGen = sessionService.getGeneration();

    const requestId = crypto.randomUUID();
    const revokeSecret = crypto.randomBytes(32).toString('hex');

    // 发送前持久化登记 pending 签发尝试
    this.issuanceAttempts.set(requestId, {
      requestId,
      status: 'pending',
      createdAt: Date.now(),
    });
    this.inMemoryRevokeSecrets.set(requestId, revokeSecret);
    try {
      this.savePersistedState({ requireEncryption: true });
    } catch {
      this.issuanceAttempts.delete(requestId);
      this.inMemoryRevokeSecrets.delete(requestId);
      return { success: false, error: '持久化撤销密钥失败，已终止凭据签发' };
    }

    let candidateToken: string | null = null;
    try {
      const response = await fetch(this.getBackendUrl('/api/c/auth/youdao/exchange'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${officialToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          request_id: requestId,
          revoke_secret: revokeSecret,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const body = record(await response.json());
      const data = record(body?.data);
      if (!response.ok || body?.success !== true || typeof data?.token !== 'string' || !data.token.trim()) {
        const errObj = record(body?.error);
        const msg = typeof errObj?.message === 'string' ? errObj.message : typeof body?.error === 'string' ? body.error : '会话换取失败';
        throw new Error(msg);
      }

      candidateToken = data.token.trim();

      // 收到 Token 先登记归属到持久 ownedToken
      this.trackOwnedToken(candidateToken, 'sso', {
        employeeNo: typeof data.employee_no === 'string' ? data.employee_no : undefined,
        tenantId: data?.tenant_id ? String(data.tenant_id) : undefined,
      });
      const attempt = this.issuanceAttempts.get(requestId);
      if (attempt) attempt.status = 'active';
      this.savePersistedState();

      // 代次校验：若请求期间官方代次或业务代次已变更，立即补偿撤销
      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        void this.compensateRevokeIssuance(requestId, revokeSecret);
        void this.revokeTokenDirect(candidateToken);
        return { success: false, error: '认证代次已变更，旧换取结果已撤销' };
      }

      // 非破坏性候选核验 (GET /api/c/rbac/me)
      const verified = await sessionService.verify(candidateToken);

      // 再次代次核验
      if (this.officialGeneration !== capturedOfficialGen || sessionService.getGeneration() !== capturedBusinessGen) {
        void this.compensateRevokeIssuance(requestId, revokeSecret);
        void this.revokeTokenDirect(candidateToken);
        return { success: false, error: '核验期间状态变更，旧换取结果已撤销' };
      }

      const currentSnapshot = sessionService.getSnapshot();
      // 账号自动采用规则 (R11/A12):
      // 若当前有效员工与候选员工相同：基于权威 employeeId + tenantId 进行对比
      if (
        currentSnapshot.status === 'authenticated' &&
        currentSnapshot.user?.id != null &&
        currentSnapshot.user &&
        String(currentSnapshot.user.id) === String(verified.user.id) &&
        String(currentSnapshot.user.tenantId) === String(verified.user.tenantId)
      ) {
        // 同员工保原 Token/source，撤销多余候选
        void this.compensateRevokeIssuance(requestId, revokeSecret);
        void this.revokeTokenDirect(candidateToken);
        this.notifyStatusChanged();
        return { success: true, session: currentSnapshot };
      }

      // 若员工不同或当前未认证：自动采用候选会话
      const adoptionPromise = sessionService.adoptCandidate(
        candidateToken,
        verified.user,
        null,
        'sso',
      );
      const adoptionGeneration = sessionService.getGeneration();
      const newSnapshot = await adoptionPromise;

      const currentCreds = sessionService.getCredentials();
      const isAdoptSuccess =
        newSnapshot.status === 'authenticated' &&
        newSnapshot.generation === adoptionGeneration &&
        sessionService.getGeneration() === adoptionGeneration &&
        newSnapshot.user != null &&
        verified.user != null &&
        String(newSnapshot.user.id) === String(verified.user.id) &&
        String(newSnapshot.user.tenantId) === String(verified.user.tenantId) &&
        currentCreds?.token === candidateToken &&
        this.officialGeneration === capturedOfficialGen;

      if (!isAdoptSuccess) {
        void this.compensateRevokeIssuance(requestId, revokeSecret);
        if (candidateToken !== currentCreds?.token) {
          void this.revokeTokenDirect(candidateToken);
        }
        return { success: false, error: newSnapshot.error || '静默登录会话采用失败或已被新代次覆盖' };
      }

      if (this.isStartupIntentActive && !this.logoutSuppressed) {
        this.startupExpectedBusinessGeneration = adoptionGeneration;
      }

      this.notifyStatusChanged();
      return { success: true, session: newSnapshot };
    } catch (err) {
      // 换取或核验失败：无论 candidateToken 是否为空，均补偿撤销已持久化的签发尝试，避免孤儿 pending/active 泄漏
      void this.compensateRevokeIssuance(requestId, revokeSecret);
      if (candidateToken) {
        void this.revokeTokenDirect(candidateToken);
      }
      return { success: false, error: err instanceof Error ? err.message : '静默登录失败' };
    }
  }

  public async revokeTokenDirect(token: string): Promise<boolean> {
    try {
      const response = await fetch(this.getBackendUrl('/api/c/logout'), {
        method: 'POST',
        headers: { 'X-Token': token },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const body = record(await response.json());
      const success = response.ok && body?.success === true;
      if (success) {
        const tokenHash = sha256(token);
        this.inMemoryOwnedTokens.delete(tokenHash);
        this.savePersistedState();
      }
      return success;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // 网页端单向受信 Token 登记
  // =========================================================================
  public async registerBusinessToken(params: RegisterBusinessTokenParams): Promise<RegisterBusinessTokenResult> {
    const sessionService = GuanjiaSession.getInstance();
    const capturedBusinessGen = sessionService.getGeneration();
    const capturedOfficialGen = this.officialGeneration;

    const token = typeof params.token === 'string' ? params.token.trim() : '';
    if (!token) {
      return {
        success: false,
        registered: false,
        adopted: false,
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: capturedBusinessGen,
        error: 'Token 不能为空',
      };
    }

    if (params?.source !== 'password' && params?.source !== 'restoration') {
      return {
        success: false,
        registered: false,
        adopted: false,
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: capturedBusinessGen,
        error: '无效的凭证来源类型',
      };
    }

    let operationId: string | undefined = undefined;
    if (params.operationId !== undefined) {
      if (
        typeof params.operationId !== 'string' ||
        !params.operationId ||
        params.operationId.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(params.operationId)
      ) {
        return {
          success: false,
          registered: false,
          adopted: false,
          startingHostGeneration: capturedBusinessGen,
          hostGeneration: capturedBusinessGen,
          error: '无效的操作标识符 (operationId)',
        };
      }
      operationId = params.operationId;
    }

    if (params.adopt !== undefined && typeof params.adopt !== 'boolean') {
      return {
        success: false,
        registered: false,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: capturedBusinessGen,
        error: 'adopt 参数必须为布尔值',
      };
    }

    if (
      typeof params?.hostGeneration !== 'number' ||
      !Number.isSafeInteger(params.hostGeneration) ||
      params.hostGeneration < 0
    ) {
      return {
        success: false,
        registered: false,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: capturedBusinessGen,
        error: '缺少有效的宿主代次',
      };
    }

    try {
      this.trackOwnedToken(token, params.source);
    } catch (err) {
      return {
        success: false,
        registered: false,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: capturedBusinessGen,
        error: err instanceof Error ? err.message : '业务凭据安全登记失败',
      };
    }

    if (params.adopt === false) {
      const currentCreds = sessionService.getCredentials();
      if (token !== currentCreds?.token) {
        await this.revokeTokenDirect(token);
      }
      return {
        success: true,
        registered: true,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: sessionService.getGeneration(),
      };
    }

    if (params.hostGeneration !== capturedBusinessGen) {
      const currentCreds = sessionService.getCredentials();
      const revoked = token !== currentCreds?.token ? await this.revokeTokenDirect(token) : false;
      return {
        success: false,
        registered: false,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: sessionService.getGeneration(),
        error: revoked ? '宿主代次已过期，业务凭据已撤销' : '宿主代次已过期，旧凭据已被忽略',
      };
    }

    try {
      const verified = await sessionService.verify(token);
      const tokenHash = sha256(token);
      const existing = this.inMemoryOwnedTokens.get(tokenHash);
      if (existing) {
        existing.employeeNo = verified.user.employeeNo;
        existing.tenantId = String(verified.user.tenantId);
        this.savePersistedState();
      }

      // 代次与退出守卫：
      const isStale =
        sessionService.getGeneration() !== capturedBusinessGen ||
        this.officialGeneration !== capturedOfficialGen ||
        params.hostGeneration !== capturedBusinessGen;

      if (isStale) {
        const currentCreds = sessionService.getCredentials();
        const revoked = token !== currentCreds?.token ? await this.revokeTokenDirect(token) : false;
        return {
          success: false,
          registered: false,
          adopted: false,
          ...(operationId ? { operationId } : {}),
          startingHostGeneration: capturedBusinessGen,
          hostGeneration: sessionService.getGeneration(),
          error: revoked ? '代次已变更，业务凭据已撤销' : '代次已变更，旧凭据已被忽略',
        };
      }

      // 3. 若用户已主动退出管家 (logoutSuppressed === true)，restoration 来源绝不能复活会话
      if (this.logoutSuppressed && params.source === 'restoration') {
        return {
          success: true,
          registered: true,
          adopted: false,
          ...(operationId ? { operationId } : {}),
          startingHostGeneration: capturedBusinessGen,
          hostGeneration: sessionService.getGeneration(),
        };
      }

      // 4. 判断是否采用候选会话
      const current = sessionService.getSnapshot();
      const shouldAdopt = params.source === 'password' || current.status !== 'authenticated';
      if (!shouldAdopt) {
        return {
          success: true,
          registered: true,
          adopted: false,
          ...(operationId ? { operationId } : {}),
          startingHostGeneration: capturedBusinessGen,
          hostGeneration: sessionService.getGeneration(),
        };
      }

      const adoptionPromise = sessionService.adoptCandidate(
        token,
        verified.user,
        null,
        params.source,
        operationId,
      );
      const adoptionGeneration = sessionService.getGeneration();
      const adoptedSnapshot = await adoptionPromise;

      const currentSnapshot = sessionService.getSnapshot();
      const currentCreds = sessionService.getCredentials();
      const currentGen = sessionService.getGeneration();

      const isAdoptedSuccess =
        adoptedSnapshot.status === 'authenticated' &&
        adoptedSnapshot.generation === adoptionGeneration &&
        currentSnapshot.status === 'authenticated' &&
        currentSnapshot.generation === adoptionGeneration &&
        currentGen === adoptionGeneration &&
        adoptedSnapshot.user != null &&
        String(adoptedSnapshot.user.id) === String(verified.user.id) &&
        String(adoptedSnapshot.user.tenantId) === String(verified.user.tenantId) &&
        currentSnapshot.user != null &&
        String(currentSnapshot.user.id) === String(verified.user.id) &&
        String(currentSnapshot.user.tenantId) === String(verified.user.tenantId) &&
        currentCreds?.token === token &&
        this.officialGeneration === capturedOfficialGen;

      if (!isAdoptedSuccess) {
        if (token !== sessionService.getCredentials()?.token) {
          await this.revokeTokenDirect(token);
        }
        return {
          success: false,
          registered: false,
          adopted: false,
          ...(operationId ? { operationId } : {}),
          startingHostGeneration: capturedBusinessGen,
          hostGeneration: sessionService.getGeneration(),
          error: adoptedSnapshot.error || currentSnapshot.error || '业务凭据采用失败或已被新会话覆盖',
        };
      }

      if (params.source === 'password') {
        this.logoutSuppressed = false;
        this.savePersistedState();
      }

      this.notifyStatusChanged();
      return {
        success: true,
        registered: true,
        adopted: true,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: adoptedSnapshot.generation,
        session: adoptedSnapshot,
      };
    } catch (err) {
      const currentCreds = sessionService.getCredentials();
      if (token !== currentCreds?.token) {
        try {
          await this.revokeTokenDirect(token);
        } catch {
          // ignore
        }
      }
      return {
        success: false,
        registered: false,
        adopted: false,
        ...(operationId ? { operationId } : {}),
        startingHostGeneration: capturedBusinessGen,
        hostGeneration: sessionService.getGeneration(),
        error: err instanceof Error ? err.message : '业务凭据核验登记失败',
      };
    }
  }

  // =========================================================================
  // 官方生命周期挂点处理
  // =========================================================================
  /**
   * 启动恢复 / 静默同步
   */
  public async syncDesktopAuthSilent(options?: {
    allowAdoption?: boolean;
    intent?: 'official_login' | 'startup' | 'status_refresh';
  }): Promise<GuanjiaDesktopAuthStatus> {
    const allowAdoption = options?.allowAdoption ?? (options?.intent !== 'status_refresh');
    const intent = options?.intent ?? (allowAdoption ? 'startup' : 'status_refresh');

    if (this.inFlightSync) {
      await this.inFlightSync.catch(() => {});
    }
    const syncPromise = this.performSyncDesktopAuthSilent(allowAdoption, intent);
    this.inFlightSync = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (this.inFlightSync === syncPromise) {
        this.inFlightSync = null;
      }
    }
  }

  private async performSyncDesktopAuthSilent(
    allowAdoption = true,
    intent: 'official_login' | 'startup' | 'status_refresh' = 'startup',
  ): Promise<GuanjiaDesktopAuthStatus> {
    const officialToken = this.officialTokenGetter?.();
    if (!officialToken) {
      this.bindingState = 'not_checked';
      this.bindingInfo = null;
      this.notifyStatusChanged();
      return this.getStatusSnapshot();
    }

    const capturedOfficialGen = this.officialGeneration;
    const sessionService = GuanjiaSession.getInstance();
    const capturedBusinessGen = intent === 'startup' ? sessionService.getGeneration() : null;

    if (intent === 'startup') {
      if (
        !this.isStartupIntentActive ||
        this.logoutSuppressed ||
        (this.startupExpectedBusinessGeneration !== null &&
          capturedBusinessGen !== this.startupExpectedBusinessGeneration)
      ) {
        if (
          this.startupExpectedBusinessGeneration !== null &&
          capturedBusinessGen !== this.startupExpectedBusinessGeneration
        ) {
          this.isStartupIntentActive = false;
        }
        return this.getStatusSnapshot();
      }
    }

    // 1. 严格核验官方生产 profile
    const profile = await this.verifyOfficialProfile(officialToken);
    if (this.officialGeneration !== capturedOfficialGen) {
      return this.getStatusSnapshot();
    }

    if (intent === 'startup') {
      const currentGen = sessionService.getGeneration();
      if (
        !this.isStartupIntentActive ||
        this.logoutSuppressed ||
        capturedBusinessGen === null ||
        currentGen !== capturedBusinessGen ||
        (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
      ) {
        if (
          currentGen !== capturedBusinessGen ||
          (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
        ) {
          this.isStartupIntentActive = false;
        }
        return this.getStatusSnapshot();
      }
    }

    if (!profile.success || !profile.userId) {
      this.bindingState = 'unavailable';
      this.lastError = profile.error;
      this.notifyStatusChanged();
      return this.getStatusSnapshot();
    }

    this.officialOwner = profile.userId;

    // 2. 查询绑定状态
    const bindingRes = await this.fetchBindingStatus(officialToken);
    if (this.officialGeneration !== capturedOfficialGen) {
      return this.getStatusSnapshot();
    }

    if (intent === 'startup') {
      const currentGen = sessionService.getGeneration();
      if (
        !this.isStartupIntentActive ||
        this.logoutSuppressed ||
        capturedBusinessGen === null ||
        currentGen !== capturedBusinessGen ||
        (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
      ) {
        if (
          currentGen !== capturedBusinessGen ||
          (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
        ) {
          this.isStartupIntentActive = false;
        }
        return this.getStatusSnapshot();
      }
    }

    if (!bindingRes.success) {
      this.bindingState = 'unavailable';
      this.lastError = bindingRes.error;
      this.notifyStatusChanged();
      return this.getStatusSnapshot();
    }

    this.bindingState = bindingRes.status || 'unavailable';
    this.bindingInfo = bindingRes.binding || null;
    this.lastError = undefined;

    // 3. 自动采用逻辑
    if (allowAdoption && this.bindingState === 'bound' && !this.logoutSuppressed && this.bindingInfo) {
      if (intent === 'startup') {
        const currentGen = sessionService.getGeneration();
        if (
          !this.isStartupIntentActive ||
          this.logoutSuppressed ||
          capturedBusinessGen === null ||
          currentGen !== capturedBusinessGen ||
          (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
        ) {
          if (
            currentGen !== capturedBusinessGen ||
            (this.startupExpectedBusinessGeneration !== null && currentGen !== this.startupExpectedBusinessGeneration)
          ) {
            this.isStartupIntentActive = false;
          }
          return this.getStatusSnapshot();
        }
      }

      const currentSnapshot = sessionService.getSnapshot();
      if (currentSnapshot.status === 'restoring') {
        return this.getStatusSnapshot();
      }
      const currentCreds = sessionService.getCredentials() as { source?: string } | null;

      const isSameEmployee =
        currentSnapshot.status === 'authenticated' &&
        Boolean(currentSnapshot.user) &&
        this.bindingInfo.employeeId != null &&
        Boolean(this.bindingInfo.tenantId) &&
        currentSnapshot.user?.id != null &&
        String(currentSnapshot.user.id) === String(this.bindingInfo.employeeId) &&
        String(currentSnapshot.user.tenantId) === String(this.bindingInfo.tenantId);

      if (isSameEmployee) {
        // 同员工保原状态，不重复换取
      } else if (intent === 'official_login') {
        // 官方账号切换可撤销旧的 SSO scope；独立密码会话必须保留，直到新候选完成真实核验。
        if (currentSnapshot.status === 'authenticated' && currentCreds?.source === 'sso') {
          sessionService.invalidate('官方账号已切换');
        }
        const preExchangeBusinessGen = sessionService.getGeneration();
        if (this.officialGeneration === capturedOfficialGen) {
          const adoptRes = await this.exchangeAndAdopt();
          if (
            this.officialGeneration === capturedOfficialGen &&
            sessionService.getGeneration() === preExchangeBusinessGen &&
            !this.logoutSuppressed &&
            !adoptRes.success &&
            adoptRes.error
          ) {
            this.lastError = adoptRes.error;
          }
        }
      } else {
        if (
          currentSnapshot.status !== 'authenticated' ||
          !isSameEmployee
        ) {
          if (this.officialGeneration === capturedOfficialGen) {
            const adoptRes = await this.exchangeAndAdopt();
            if (
              this.officialGeneration === capturedOfficialGen &&
              !this.logoutSuppressed &&
              (intent !== 'startup' || (capturedBusinessGen !== null && sessionService.getGeneration() === capturedBusinessGen)) &&
              !adoptRes.success &&
              adoptRes.error
            ) {
              this.lastError = adoptRes.error;
            }
          }
        }
      }
    }

    if (this.officialGeneration !== capturedOfficialGen) {
      return this.getStatusSnapshot();
    }

    this.notifyStatusChanged();
    return this.getStatusSnapshot();
  }

  /**
   * 显式官方登录或切换账号
   */
  public handleOfficialLoginOrAccountChanged(officialUser?: Record<string, unknown> | null): void {
    this.officialGeneration += 1;
    this.logoutSuppressed = false;
    this.lastError = undefined;
    this.isStartupIntentActive = false;
    this.savePersistedState();

    // 若官方用户变更，重置绑定状态
    const newUserId = officialUser && typeof officialUser.id === 'number' ? String(officialUser.id) : null;
    if (newUserId && this.officialOwner !== newUserId) {
      this.officialOwner = newUserId;
      this.bindingState = 'not_checked';
      this.bindingInfo = null;
    }

    void this.syncDesktopAuthSilent({ allowAdoption: true, intent: 'official_login' });
  }

  public handleOfficialLoginSuccess(officialUser?: Record<string, unknown> | null): void {
    this.handleOfficialLoginOrAccountChanged(officialUser);
  }

  /**
   * 官方 Token Exchange 回滚
   */
  public handleOfficialExchangeRollback(): void {
    this.officialGeneration += 1;
    this.isStartupIntentActive = false;
  }

  /**
   * 官方账号退出 (所有来源联动退出)
   */
  public async handleOfficialLogout(): Promise<void> {
    this.officialGeneration += 1;
    this.officialOwner = null;
    this.bindingState = 'not_checked';
    this.bindingInfo = null;
    this.lastError = undefined;
    this.isStartupIntentActive = false;

    // 1. 本地管家会话立即失效
    GuanjiaSession.getInstance().invalidate('官方账号已退出');

    // 2. 撤销已登记的 ownedTokens 和 issuanceAttempts (仅成功远端撤销才移除本地登记)
    await this.revokeAllOwnedTokensAndAttempts();
    this.notifyStatusChanged();
  }

  private async revokeAllOwnedTokensAndAttempts(): Promise<void> {
    const revokePromises: Promise<unknown>[] = [];

    const tokensToRevoke = Array.from(this.inMemoryOwnedTokens.entries());
    for (const [hash, owned] of tokensToRevoke) {
      revokePromises.push((async () => {
        const success = await this.revokeTokenDirect(owned.token);
        if (success) {
          this.inMemoryOwnedTokens.delete(hash);
        }
      })());
    }

    const attemptsToRevoke = Array.from(this.issuanceAttempts.entries()).filter(([_, m]) => m.status !== 'revoked');
    for (const [requestId] of attemptsToRevoke) {
      const secret = this.inMemoryRevokeSecrets.get(requestId);
      if (secret) {
        revokePromises.push(this.compensateRevokeIssuance(requestId, secret));
      }
    }

    await Promise.allSettled(revokePromises);
    this.savePersistedState();
  }

  /**
   * 官方终端刷新失效 / 企业资格撤销
   */
  public async handleOfficialSessionInvalidated(reason: string): Promise<void> {
    this.officialGeneration += 1;
    this.bindingState = 'unavailable';
    this.lastError = reason;
    this.isStartupIntentActive = false;
    GuanjiaSession.getInstance().invalidate(reason);
    await this.revokeAllOwnedTokensAndAttempts();
    this.notifyStatusChanged();
  }

  /**
   * 主动退出管家业务会话 (持久抑制自动交换)
   */
  public setLogoutSuppressed(suppressed: boolean): void {
    this.logoutSuppressed = suppressed;
    this.savePersistedState();
    this.notifyStatusChanged();
  }

  // =========================================================================
  // 状态快照获取 (严格无 Token)
  // =========================================================================
  public getStatusSnapshot(): GuanjiaDesktopAuthStatus {
    const officialToken = this.officialTokenGetter?.();
    const officialUser = this.officialUserGetter?.();
    const sessionSnapshot = GuanjiaSession.getInstance().getSnapshot();

    let officialUserId: string | undefined = undefined;
    if (this.officialOwner) {
      officialUserId = this.officialOwner;
    } else if (officialUser && typeof officialUser.id === 'number') {
      officialUserId = String(officialUser.id);
    }

    return {
      officialAuthenticated: Boolean(officialToken),
      officialUserId,
      bindingState: this.bindingState,
      binding: this.bindingInfo ? { ...this.bindingInfo } : null,
      businessSessionStatus: sessionSnapshot.status,
      businessEmployeeNo: sessionSnapshot.user?.employeeNo,
      businessEmployeeName: sessionSnapshot.user?.name,
      hostGeneration: sessionSnapshot.generation,
      logoutSuppressed: this.logoutSuppressed,
      error: this.lastError,
    };
  }

  public async getStatus(): Promise<GuanjiaDesktopAuthStatus> {
    const officialToken = this.officialTokenGetter?.();
    if (officialToken && this.bindingState === 'not_checked') {
      await this.syncDesktopAuthSilent({ allowAdoption: false, intent: 'status_refresh' });
    }
    return this.getStatusSnapshot();
  }
}
