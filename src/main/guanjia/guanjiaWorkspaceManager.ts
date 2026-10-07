import * as crypto from 'crypto';
import { app, BrowserWindow, Rectangle, session, WebContentsView } from 'electron';
import path from 'path';

import { AgentId } from '../../shared/agent/constants';
import type { CoworkStore } from '../coworkStore';
import {
  FINANCIAL_ACTION_TYPES,
  FinancialDetails,
  GUANJIA_WORKSPACE_PARTITION,
  GuanjiaActionRequest,
  GuanjiaActionResult,
  GuanjiaFinancialAuditLog,
  GuanjiaSsoCredentials,
  GuanjiaWorkspaceContext,
  isFinancialAction,
} from './types';

export const DEFAULT_GUANJIA_URL = 'https://guanjia.qszy.me/';

export class GuanjiaWorkspaceManager {
  private static instance: GuanjiaWorkspaceManager | null = null;
  private view: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private currentBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private isVisible: boolean = false;
  private defaultUrl: string = DEFAULT_GUANJIA_URL;

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

    const preloadPath = app.isPackaged
      ? path.join(__dirname, 'guanjiaPreload.js')
      : path.join(__dirname, '../dist-electron/guanjiaPreload.js');

    this.view = new WebContentsView({
      webPreferences: {
        partition: GUANJIA_WORKSPACE_PARTITION,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    // 监听导航事件，保持状态
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.warn(`[GuanjiaWorkspaceView] Page load failed (${errorCode}): ${errorDescription}`);
    });

    return this.view;
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

    const targetUrl = initialUrl || this.defaultUrl;
    if (targetUrl && (view.webContents.getURL() !== targetUrl || view.webContents.getURL() === 'about:blank')) {
      view.webContents.loadURL(targetUrl);
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
    if (!targetWindow) return;
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
    if (url && typeof url === 'string') {
      this.defaultUrl = url.trim();
    }
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
    this.currentSsoCredentials = { ...credentials };
  }

  public getSsoCredentials(): GuanjiaSsoCredentials | null {
    return this.currentSsoCredentials;
  }

  public clearSsoCredentials(): void {
    this.currentSsoCredentials = null;
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
        currentShop: this.currentSsoCredentials
          ? {
              id: this.currentSsoCredentials.shopId,
              name: this.currentSsoCredentials.shopName,
            }
          : null,
        pageError: null,
        pendingCount: 0,
        timestamp: Date.now(),
      };
    }

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
      pendingCount: 0,
      timestamp: Date.now(),
    };
  }

  // =========================================================================
  // 动作执行与动账拦截
  // =========================================================================
  public async executeAction(action: GuanjiaActionRequest): Promise<GuanjiaActionResult> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return {
        success: false,
        actionType: action.type,
        error: '智慧管家工作区视图未创建或已关闭',
      };
    }

    // 动账操作拦截校验：统一通过 isFinancialAction 匹配，严格校验 confirmed 与 confirmedBy
    const isFinancial = isFinancialAction(action);
    const isConfirmed = Boolean(action.confirmed && action.confirmedBy && action.confirmedBy.trim());

    if (isFinancial && !isConfirmed) {
      const details = action.financialDetails || {
        amount: '需核对金额',
        reason: '未注明事由',
        actionType: (action.type && FINANCIAL_ACTION_TYPES.has(action.type)) ? (action.type as any) : ('other' as const),
      };

      this.recordAuditLog({
        actionType: action.type,
        amount: details.amount,
        reason: details.reason,
        operatorName: (action.confirmedBy && action.confirmedBy.trim()) || this.currentSsoCredentials?.realName || '未知店员',
        confirmedBy: '',
        shopId: this.currentSsoCredentials?.shopId || '',
        status: 'intercepted',
      });

      const message = !action.confirmed
        ? `动账操作拦截：必须停下复述金额（${details.amount}）与事由（${details.reason}），店员确认后方可落定。`
        : `动账操作拦截：动账确认人（confirmedBy）缺失或为空，坚决拦截。`;

      return {
        success: false,
        actionType: action.type,
        requiresConfirmation: true,
        financialDetails: details,
        message,
        error: !action.confirmed ? undefined : '动账确认人（confirmedBy）缺失或为空',
      };
    }

    try {
      const result = (await this.view.webContents.executeJavaScript(
        `window.guanjiaBridge ? window.guanjiaBridge.executeAction(${JSON.stringify(action)}) : { success: false, error: 'Bridge not available' }`,
      )) as GuanjiaActionResult;

      if (isFinancial && isConfirmed && result.success) {
        this.recordAuditLog({
          actionType: action.type,
          amount: action.financialDetails?.amount || 0,
          reason: action.financialDetails?.reason || '',
          operatorName: this.currentSsoCredentials?.realName || '当前店员',
          confirmedBy: action.confirmedBy!.trim(),
          shopId: this.currentSsoCredentials?.shopId || '',
          status: 'executed',
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        actionType: action.type,
        error: error instanceof Error ? error.message : '动作执行失败',
      };
    }
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
  public async clearAssistantSession(): Promise<{ success: boolean; clearedCount: number }> {
    const store = this.getStoreInstance();
    if (!store) {
      console.warn('[GuanjiaWorkspaceManager] coworkStore not configured for clearing assistant session');
      return { success: false, clearedCount: 0 };
    }

    try {
      const deletedSessionIds = store.clearAgentSessions(AgentId.GuanjiaAssistant);
      return {
        success: true,
        clearedCount: deletedSessionIds.length,
      };
    } catch (err) {
      console.error('[GuanjiaWorkspaceManager] Failed to clear guanjia assistant sessions silently:', err);
      return { success: false, clearedCount: 0 };
    }
  }
}
