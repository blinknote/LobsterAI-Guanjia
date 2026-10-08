import * as crypto from 'crypto';
import { app, BrowserWindow, Rectangle, session, WebContentsView } from 'electron';
import path from 'path';

import type { CoworkStore } from '../coworkStore';
import {
  GUANJIA_WORKSPACE_PARTITION,
  GuanjiaActionRequest,
  GuanjiaActionResult,
  GuanjiaFinancialAuditLog,
  GuanjiaSsoCredentials,
  GuanjiaWorkspaceContext,
} from './types';

export const DEFAULT_GUANJIA_URL = 'https://guanjia.qszy.me/';

export class GuanjiaWorkspaceManager {
  private static instance: GuanjiaWorkspaceManager | null = null;
  private view: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private currentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private isVisible: boolean = false;
  private defaultUrl: string = DEFAULT_GUANJIA_URL;

  private credentialEpoch = 0;
  private currentSsoCredentials: GuanjiaSsoCredentials | null = null;
  private auditLogs: GuanjiaFinancialAuditLog[] = [];
  private coworkStore: CoworkStore | null = null;
  private coworkStoreGetter: (() => CoworkStore) | null = null;

  private constructor() {
    this.setupPartitionSession();
  }

  public static getInstance(): GuanjiaWorkspaceManager {
    if (!GuanjiaWorkspaceManager.instance) {
      GuanjiaWorkspaceManager.instance = new GuanjiaWorkspaceManager();
    }
    return GuanjiaWorkspaceManager.instance;
  }

  public setCoworkStore(store: CoworkStore): void {
    this.coworkStore = store;
  }

  public setCoworkStoreGetter(getter: () => CoworkStore): void {
    this.coworkStoreGetter = getter;
  }

  private getStoreInstance(): CoworkStore | null {
    if (this.coworkStore) return this.coworkStore;
    if (this.coworkStoreGetter) {
      try {
        return this.coworkStoreGetter();
      } catch (err) {
        console.warn('[GuanjiaWorkspaceManager] Failed to get coworkStore:', err);
      }
    }
    return null;
  }

  /**
   * 初始化 'persist:guanjia-workspace' 独立持久化分区
   * 禁用保存密码气泡与弹窗
   */
  private setupPartitionSession(): void {
    if (app && typeof app.isReady === 'function' && !app.isReady()) {
      if (typeof app.whenReady === 'function') {
        app.whenReady().then(() => this.setupPartitionSession());
      }
      return;
    }

    const ses = session.fromPartition(GUANJIA_WORKSPACE_PARTITION);

    // 拦截权限请求，禁用密码凭证捕获与多余通知
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  /**
   * 获取或懒加载 WebContentsView 单例
   * 保持 DOM 现场，绝不随意销毁
   */
  public getOrCreateView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }

    const preloadPath = path.join(__dirname, 'guanjiaPreload.js');

    this.view = new WebContentsView({
      webPreferences: {
        partition: GUANJIA_WORKSPACE_PARTITION,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        sandbox: true,
      },
    });

    // 监听导航事件，保持状态
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.warn(`[GuanjiaWorkspaceView] Page load failed (${errorCode}): ${errorDescription}`);
    });

    // 导航安全看门狗：防止意外跳转到外部非受信站点导致凭据泄露
    this.view.webContents.on('will-navigate', (event, navigationUrl) => {
      let isTrustedOrigin = false;
      try {
        const trustedOrigin = new URL(this.defaultUrl || DEFAULT_GUANJIA_URL).origin;
        isTrustedOrigin = new URL(navigationUrl).origin === trustedOrigin;
      } catch {
        isTrustedOrigin = false;
      }
      if (!isTrustedOrigin) {
        console.warn(`[GuanjiaWorkspaceManager] Blocked untrusted navigation to: ${navigationUrl}`);
        event.preventDefault();
      }
    });

    return this.view;
  }

  /**
   * 检查给定 WebContents 是否为当前智慧管家 WebContentsView
   */
  public isGuanjiaWebContents(wc: { id?: number } | null | undefined): boolean {
    if (!this.view || this.view.webContents.isDestroyed() || !wc) return false;
    return this.view.webContents.id === wc.id;
  }

  /**
   * 现场保持：将视图挂载到指定 BrowserWindow 主工作区
   */
  public attachView(window: BrowserWindow, bounds: Rectangle, initialUrl?: string): void {
    const view = this.getOrCreateView();
    this.attachedWindow = window;
    this.currentBounds = { ...bounds };

    // 添加到窗口的 contentView 中
    const contentView = window.contentView;
    if (contentView && !contentView.children.includes(view)) {
      contentView.addChildView(view);
    }

    view.setBounds(this.currentBounds);
    view.setVisible(true);
    this.isVisible = true;

    const currentUrl = view.webContents.getURL();
    const isFirstLoad = !currentUrl || currentUrl === 'about:blank';

    if (initialUrl) {
      if (currentUrl !== initialUrl) {
        if (!this.isTrustedUrl(initialUrl)) throw new Error('不可信的管家地址');
        void view.webContents.loadURL(initialUrl);
      }
    } else if (isFirstLoad) {
      const targetUrl = this.defaultUrl;
      if (targetUrl) {
        if (!this.isTrustedUrl(targetUrl)) throw new Error('不可信的管家地址');
        void view.webContents.loadURL(targetUrl);
      }
    }
  }

  /**
   * 现场保持：切走时不销毁 view，仅隐藏或从父容器摘除，保留表单输入与滚动现场
   */
  public hideView(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false);
      if (this.attachedWindow && this.attachedWindow.contentView) {
        try {
          this.attachedWindow.contentView.removeChildView(this.view);
        } catch {
          // 忽略已经不在 children 的错误
        }
      }
      this.isVisible = false;
    }
  }

  public showView(window?: BrowserWindow, bounds?: Rectangle): void {
    const targetWindow = window || this.attachedWindow;
    if (!targetWindow) throw new Error('Untrusted origin');
    const targetBounds = bounds || this.currentBounds;
    this.attachView(targetWindow, targetBounds);
  }

  public setBounds(bounds: Rectangle): void {
    this.currentBounds = { ...bounds };
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setBounds(this.currentBounds);
    }
  }

  public setDefaultUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.origin !== new URL(DEFAULT_GUANJIA_URL).origin || parsed.username || parsed.password) throw new Error('不可信的管家地址');
    this.defaultUrl = parsed.toString();
  }

  public isTrustedUrl(url: string): boolean {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.origin === new URL(DEFAULT_GUANJIA_URL).origin && !parsed.username && !parsed.password; } catch { return false; }
  }

  public async getRestorableToken(): Promise<string | null> {
    const cookies = await session.fromPartition(GUANJIA_WORKSPACE_PARTITION).cookies.get({ url: this.defaultUrl, name: 'guanjia_token' });
    return cookies.find((cookie) => cookie.secure && cookie.value)?.value || null;
  }

  public getDefaultUrl(): string {
    return this.defaultUrl;
  }

  public loadUrl(url?: string): void {
    const view = this.getOrCreateView();
    const targetUrl = url || this.defaultUrl;
    view.webContents.loadURL(targetUrl);
  }

  public reload(ignoreCache: boolean = false): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (ignoreCache) {
        this.view.webContents.reloadIgnoringCache();
      } else {
        this.view.webContents.reload();
      }
    } else {
      this.loadUrl(this.defaultUrl);
    }
  }

  public goBack(): void {
    if (this.view && !this.view.webContents.isDestroyed() && this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
  }

  public goForward(): void {
    if (this.view && !this.view.webContents.isDestroyed() && this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
  }

  public getNavigationState(): { url: string; title: string; canGoBack: boolean; canGoForward: boolean } {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return { url: '', title: '', canGoBack: false, canGoForward: false };
    }
    return {
      url: this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
      canGoBack: this.view.webContents.navigationHistory.canGoBack(),
      canGoForward: this.view.webContents.navigationHistory.canGoForward(),
    };
  }

  // =========================================================================
  // SSO 凭证托管
  // =========================================================================
  public setSsoCredentials(credentials: GuanjiaSsoCredentials): void {
    ++this.credentialEpoch;
    this.currentSsoCredentials = { ...credentials };
  }

  public getSsoCredentials(): GuanjiaSsoCredentials | null {
    return this.currentSsoCredentials;
  }

  public clearSsoCredentials(): void {
    ++this.credentialEpoch;
    this.currentSsoCredentials = null;
  }

  /**
   * 将凭证注入 persist:guanjia-workspace 当前活跃受信视图的 sessionStorage (不写入 Cookie，不写入 localStorage)
   */
  public async injectSessionCredentials(
    credentials: GuanjiaSsoCredentials,
    hostGeneration?: number,
    operationId?: string,
  ): Promise<void> {
    this.setSsoCredentials(credentials);
    const epoch = this.credentialEpoch;

    // 仅当处于可信来源时，注入到当前页面的 sessionStorage
    if (this.view && !this.view.webContents.isDestroyed()) {
      try {
        const currentUrl = this.view.webContents.getURL();
        const targetOrigin = new URL(this.defaultUrl || DEFAULT_GUANJIA_URL).origin;
        let isTrustedOrigin = false;
        try {
          isTrustedOrigin = new URL(currentUrl).origin === targetOrigin;
        } catch {
          isTrustedOrigin = false;
        }

        if (isTrustedOrigin) {
          if (epoch !== this.credentialEpoch) return;
          const gen = hostGeneration ?? 0;
          const readyDetail = JSON.stringify({
            hostGeneration: gen,
            ...(operationId ? { operationId } : {}),
          });
          await this.view.webContents.executeJavaScript(`
            (() => {
              try {
                if (window.__guanjia_credential_epoch && window.__guanjia_credential_epoch > ${epoch}) return;
                window.__guanjia_credential_epoch = ${epoch};
                if (window.sessionStorage) {
                  if (location.origin !== ${JSON.stringify(new URL(this.defaultUrl).origin)}) throw new Error('Untrusted origin');
                  window.sessionStorage.setItem('guanjia_token', ${JSON.stringify(credentials.token)});
                  if (${JSON.stringify(credentials.shopId)}) window.sessionStorage.setItem('guanjia_store_id', ${JSON.stringify(credentials.shopId)});
                  else window.sessionStorage.removeItem('guanjia_store_id');
                  if (${JSON.stringify(credentials.storeCode || '')}) window.sessionStorage.setItem('guanjia_store_code', ${JSON.stringify(credentials.storeCode || '')});
                  else window.sessionStorage.removeItem('guanjia_store_code');
                  window.dispatchEvent(new CustomEvent('guanjia:host-session-ready', { detail: ${readyDetail} }));
                }
              } catch (e) {}
            })();
          `);
        }
      } catch {
        throw new Error('内嵌凭据同步失败');
      }
    }
  }

  /**
   * 清除 persist:guanjia-workspace 分区的凭据、Cookies 以及 Storage
   */
  public async clearSessionCredentials(hostGeneration?: number): Promise<void> {
    this.clearSsoCredentials();
    const epoch = this.credentialEpoch;

    try {
      const ses = session.fromPartition(GUANJIA_WORKSPACE_PARTITION);
      const targetUrl = this.defaultUrl || DEFAULT_GUANJIA_URL;
      let cookieUrl: string;
      try {
        cookieUrl = new URL(targetUrl).origin;
      } catch {
        cookieUrl = new URL(DEFAULT_GUANJIA_URL).origin;
      }

      if (ses && ses.cookies && typeof ses.cookies.remove === 'function') {
        const cookieNames = ['guanjia_token', 'token', 'guanjia_sso_token'];
        for (const name of cookieNames) {
          try {
            if (epoch !== this.credentialEpoch) return;
            await ses.cookies.remove(cookieUrl, name);
          } catch {
            // 忽略
          }
        }
      }
    } catch (err) {
      console.warn('[GuanjiaWorkspaceManager] Failed to clear session cookies:', err);
    }

    if (epoch !== this.credentialEpoch) return;
    if (this.view && !this.view.webContents.isDestroyed() && this.isTrustedUrl(this.view.webContents.getURL())) {
      try {
        const gen = hostGeneration ?? 0;
        await this.view.webContents.executeJavaScript(`
          (() => {
            try {
              if (window.__guanjia_credential_epoch && window.__guanjia_credential_epoch > ${epoch}) return;
              window.__guanjia_credential_epoch = ${epoch};
              if (location.origin !== ${JSON.stringify(new URL(this.defaultUrl).origin)}) throw new Error('Untrusted origin');
              if (window.sessionStorage) {
                window.sessionStorage.removeItem('guanjia_token');
                window.sessionStorage.removeItem('token');
                window.sessionStorage.removeItem('guanjia_sso_token');
                window.sessionStorage.removeItem('guanjia_store_id');
                window.sessionStorage.removeItem('guanjia_store_code');
                window.dispatchEvent(new CustomEvent('guanjia:host-session-cleared', { detail: { hostGeneration: ${gen} } }));
              }
              // 清理历史遗留键，不再写入
              if (window.localStorage) {
                window.localStorage.removeItem('guanjia_token');
                window.localStorage.removeItem('token');
                window.localStorage.removeItem('guanjia_sso_token');
                window.localStorage.removeItem('guanjia_user_id');
                window.localStorage.removeItem('guanjia_shop_id');
                window.localStorage.removeItem('guanjia_shop_name');
                window.localStorage.removeItem('guanjia_user_role');
              }
            } catch (e) {}
          })();
        `);
      } catch {
        // 忽略
      }
    }
  }

  // =========================================================================
  // 只读上下文提取
  // =========================================================================
  public async getWorkspaceContext(): Promise<GuanjiaWorkspaceContext> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return {
        currentUrl: '',
        pathname: '',
        pageTitle: '',
        currentUser: this.currentSsoCredentials
          ? {
              id: this.currentSsoCredentials.userId,
              name: this.currentSsoCredentials.realName || this.currentSsoCredentials.username,
              role: this.currentSsoCredentials.role,
              shopName: this.currentSsoCredentials.shopName,
            }
          : null,
        currentShop: this.currentSsoCredentials?.shopId
          ? {
              id: this.currentSsoCredentials.shopId,
              name: this.currentSsoCredentials.shopName,
            }
          : null,
        pageError: null,
        pendingCount: null,
        timestamp: Date.now(),
      };
    }

    if (!this.isTrustedUrl(this.view.webContents.getURL())) throw new Error('不可信的管家页面');
    try {
      const context = await this.view.webContents.executeJavaScript(
        'window.guanjiaBridge ? window.guanjiaBridge.getWorkspaceContext() : null',
      );
      if (context) return context;
    } catch (e) {
      console.warn('[GuanjiaWorkspaceManager] Failed to extract context via Bridge:', e);
    }

    return {
      currentUrl: this.view.webContents.getURL(),
      pathname: '',
      pageTitle: this.view.webContents.getTitle(),
      currentUser: null,
      currentShop: null,
      pageError: null,
      pendingCount: null,
      timestamp: Date.now(),
    };
  }

  // =========================================================================
  // 动作执行与动账拦截
  // =========================================================================
  public async executeAction(action: GuanjiaActionRequest): Promise<GuanjiaActionResult> {
    return { success: false, actionType: action.type, error: '旧页面动作执行接口已停用' };
  }

  public recordAuditLog(log: Omit<GuanjiaFinancialAuditLog, 'id' | 'timestamp'>): GuanjiaFinancialAuditLog {
    const entry: GuanjiaFinancialAuditLog = {
      id: crypto.randomUUID(),
      ...log,
      timestamp: Date.now(),
    };
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > 500) {
      this.auditLogs.pop();
    }
    return entry;
  }

  public getAuditLogs(): GuanjiaFinancialAuditLog[] {
    return [...this.auditLogs];
  }

  // =========================================================================
  // 交班清场：静默清空助理会话，不弹窗，不动管家台账
  // =========================================================================
  public async clearAssistantSession(): Promise<{ success: boolean; clearedCount: number; error?: string }> {
    return {
      success: false,
      clearedCount: 0,
      error: '旧会话清空接口已停用，业务会话失效不会删除合法历史记录',
    };
  }
}
