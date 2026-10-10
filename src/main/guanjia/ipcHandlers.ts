import { BrowserWindow, ipcMain, IpcMainInvokeEvent, Rectangle } from 'electron';

import type { CoworkStore } from '../coworkStore';
import { requestGuanjiaBusinessApi } from './guanjiaBusinessApi';
import { GuanjiaDesktopAuthCoordinator } from './guanjiaDesktopAuthCoordinator';
import { GuanjiaSession } from './guanjiaSession';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';
import {
  GuanjiaClientModelConfig,
  GuanjiaDesktopAuthBindParams,
  GuanjiaDesktopAuthStatus,
  GuanjiaDesktopAuthUnbindParams,
  GuanjiaIpcChannel,
  GuanjiaSessionSnapshot,
  RegisterBusinessTokenParams,
} from './types';

function isTrustedMainRenderer(
  event: IpcMainInvokeEvent,
  getMainWindow?: () => BrowserWindow | null,
): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  try {
    const mainWin = getMainWindow ? getMainWindow() : BrowserWindow.getFocusedWindow();
    return Boolean(mainWin && !mainWin.isDestroyed() && event.sender === mainWin.webContents);
  } catch {
    return false;
  }
}

function isTrustedGuanjiaFrame(event: IpcMainInvokeEvent): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  const workspaceManager = GuanjiaWorkspaceManager.getInstance();
  if (!workspaceManager.isGuanjiaWebContents(event.sender)) {
    return false;
  }
  try {
    return workspaceManager.isTrustedUrl(event.senderFrame.url);
  } catch {
    return false;
  }
}

export interface RegisterGuanjiaHandlersOptions {
  getCoworkStore?: () => CoworkStore;
  getMainWindow?: () => BrowserWindow | null;
  syncOpenClawConfig?: (options: { reason: string; restartGatewayIfRunning?: boolean }) => Promise<unknown>;
}

export function registerGuanjiaIpcHandlers(options?: RegisterGuanjiaHandlersOptions): void {
  const workspaceManager = GuanjiaWorkspaceManager.getInstance();
  const sessionService = GuanjiaSession.getInstance();
  const coordinator = GuanjiaDesktopAuthCoordinator.getInstance();

  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedMainRenderer(event, options?.getMainWindow)) throw new Error('非法的调用来源');
      return listener(event, ...args);
    });
  };

  // 单一权威源广播会话快照变更到主渲染窗口 (无 Token)
  sessionService.subscribe((snapshot: GuanjiaSessionSnapshot) => {
    const targetWin = options?.getMainWindow ? options.getMainWindow() : BrowserWindow.getFocusedWindow();
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send(GuanjiaSession.CANONICAL_CHANNEL, snapshot);
    }
    if (snapshot.status === 'authenticated') {
      void (async () => {
        try {
          const res = await requestGuanjiaBusinessApi({
            path: '/api/c/ai/client-model-config',
            method: 'GET',
            expectedGeneration: snapshot.generation,
          });
          sessionService.setCachedModelConfig(res as unknown as GuanjiaClientModelConfig);
          if (options?.syncOpenClawConfig) {
            await options.syncOpenClawConfig({ reason: 'guanjia-model-config-updated' });
          }
        } catch (err) {
          console.warn('[Guanjia] Failed to prefetch client model config on auth:', err);
          if (options?.syncOpenClawConfig) {
            await options.syncOpenClawConfig({ reason: 'guanjia-model-config-fallback' });
          }
        }
      })();
    } else {
      sessionService.setCachedModelConfig(null);
      if (options?.syncOpenClawConfig) {
        void options.syncOpenClawConfig({ reason: 'guanjia-session-unauthenticated' });
      }
    }
  });

  handle(GuanjiaIpcChannel.GetClientModelConfig, async () => {
    try {
      const session = GuanjiaSession.getInstance();
      const snap = session.getSnapshot();
      if (snap.status !== 'authenticated') {
        session.setCachedModelConfig(null);
        return { success: false, error: '未认证' };
      }
      const res = await requestGuanjiaBusinessApi({
        path: '/api/c/ai/client-model-config',
        method: 'GET',
        expectedGeneration: snap.generation,
      });
      const modelConfig = res as unknown as GuanjiaClientModelConfig;
      session.setCachedModelConfig(modelConfig);
      if (options?.syncOpenClawConfig) {
        void options.syncOpenClawConfig({ reason: 'guanjia-model-config-updated' });
      }
      return { success: true, data: res };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 广播桌面专属认证绑定状态到主渲染窗口 (无 Token)
  coordinator.subscribe((status: GuanjiaDesktopAuthStatus) => {
    const targetWin = options?.getMainWindow ? options.getMainWindow() : BrowserWindow.getFocusedWindow();
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send(GuanjiaIpcChannel.DesktopAuthStatusChanged, status);
    }
  });

  if (options?.getCoworkStore) {
    workspaceManager.setCoworkStoreGetter(options.getCoworkStore);
  }

  // =========================================================================
  // 1. WebContentsView 生命周期与布局管理
  // =========================================================================
  handle(
    GuanjiaIpcChannel.AttachView,
    async (_event, args: { bounds: Rectangle; initialUrl?: string }) => {
      const targetWin = options?.getMainWindow ? options.getMainWindow() : BrowserWindow.getFocusedWindow();
      if (!targetWin) {
        return { success: false, error: 'No active BrowserWindow found' };
      }
      workspaceManager.attachView(targetWin, args.bounds, args.initialUrl);
      return { success: true };
    },
  );

  handle(GuanjiaIpcChannel.DetachView, async () => {
    workspaceManager.hideView();
    return { success: true };
  });

  handle(GuanjiaIpcChannel.SetBounds, async (_event, bounds: Rectangle) => {
    workspaceManager.setBounds(bounds);
    return { success: true };
  });

  handle(GuanjiaIpcChannel.ShowView, async () => {
    const targetWin = options?.getMainWindow ? options.getMainWindow() : BrowserWindow.getFocusedWindow();
    workspaceManager.showView(targetWin || undefined);
    return { success: true };
  });

  handle(GuanjiaIpcChannel.HideView, async () => {
    workspaceManager.hideView();
    return { success: true };
  });

  handle(GuanjiaIpcChannel.LoadUrl, async (_event, url?: string) => {
    workspaceManager.loadUrl(url);
    return { success: true };
  });

  handle(GuanjiaIpcChannel.Reload, async (_event, ignoreCache?: boolean) => {
    workspaceManager.reload(Boolean(ignoreCache));
    return { success: true };
  });

  handle(GuanjiaIpcChannel.SetDefaultUrl, async (_event, url: string) => {
    workspaceManager.setDefaultUrl(url);
    return { success: true };
  });

  handle(GuanjiaIpcChannel.GetDefaultUrl, async () => {
    return { success: true, url: workspaceManager.getDefaultUrl() };
  });

  handle(GuanjiaIpcChannel.GoBack, async () => {
    workspaceManager.goBack();
    return { success: true };
  });

  handle(GuanjiaIpcChannel.GoForward, async () => {
    workspaceManager.goForward();
    return { success: true };
  });

  handle(GuanjiaIpcChannel.GetNavigationState, async () => {
    return workspaceManager.getNavigationState();
  });

  // =========================================================================
  // 权威业务会话管理 (无 Token Snapshot，严格校验来源)
  // =========================================================================
  handle(
    GuanjiaIpcChannel.Login,
    async (
      event,
      args: { account?: string; password?: string; [key: string]: unknown },
    ): Promise<GuanjiaSessionSnapshot> => {
      if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
        throw new Error('非法的调用来源');
      }

      if (!args || typeof args !== 'object') {
        return { ...sessionService.getSnapshot(), error: '请求参数无效' };
      }
      const account = typeof args.account === 'string' ? args.account.trim() : '';
      const password = typeof args.password === 'string' ? args.password : '';
      if (!account || !password) {
        return { ...sessionService.getSnapshot(), error: '请求参数无效' };
      }

      return sessionService.login({ account, password });
    },
  );

  handle(GuanjiaIpcChannel.Logout, async (event): Promise<{ success: boolean; error?: string }> => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
      return { success: false, error: '非法的调用来源' };
    }
    try {
      await sessionService.logout();
      return { success: true };
    } catch (err) {
      console.error('[GuanjiaIpcHandlers] Logout exception:', err instanceof Error ? err.message : err);
      return { success: false, error: err instanceof Error ? err.message : '登出失败' };
    }
  });

  handle(GuanjiaIpcChannel.GetSessionSnapshot, async (event): Promise<GuanjiaSessionSnapshot> => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
      throw new Error('非法的调用来源');
    }
    return sessionService.getSnapshot();
  });

  handle(GuanjiaIpcChannel.GetBusinessSession, async (event): Promise<GuanjiaSessionSnapshot> => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
      throw new Error('非法的调用来源');
    }
    return sessionService.getSnapshot();
  });

  handle(GuanjiaIpcChannel.RestoreSession, async (event): Promise<GuanjiaSessionSnapshot> => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
      throw new Error('非法的调用来源');
    }
    return GuanjiaDesktopAuthCoordinator.getInstance().restoreDesktopSession();
  });

  handle(
    GuanjiaIpcChannel.SetStore,
    async (event, store: { id: string | number; code?: string; name?: string } | null): Promise<GuanjiaSessionSnapshot> => {
      if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
        throw new Error('非法的调用来源');
      }
      return sessionService.setStore(store);
    },
  );

  handle(GuanjiaIpcChannel.InvalidateSession, async (event, reason?: string) => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow)) {
      return { success: false, error: '非法的调用来源' };
    }
    sessionService.invalidate(reason);
    return { success: true };
  });

  // =========================================================================
  // 2. SSO 凭据管理 (仅允许 Guanjia view 主顶层 Frame 且来源匹配)
  // =========================================================================
  ipcMain.on(GuanjiaIpcChannel.GetSsoCredentialsSync, (event) => {
    if (!workspaceManager.isGuanjiaWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      event.returnValue = null;
      return;
    }
    let isTrustedOrigin = false;
    try {
      isTrustedOrigin = workspaceManager.isTrustedUrl(event.senderFrame.url);
    } catch {
      isTrustedOrigin = false;
    }
    if (!isTrustedOrigin) {
      event.returnValue = null;
      return;
    }
    event.returnValue = workspaceManager.getSsoCredentials();
  });

  // =========================================================================
  // 3. 只读上下文与动作执行 (含动账拦截)
  // =========================================================================
  handle(GuanjiaIpcChannel.GetContext, async () => {
    return workspaceManager.getWorkspaceContext();
  });

  handle(GuanjiaIpcChannel.ExecuteAction, async () => ({ success: false, error: '旧页面动作执行接口已停用' }));

  handle(GuanjiaIpcChannel.GetAuditLogs, async () => {
    return workspaceManager.getAuditLogs();
  });

  // =========================================================================
  // 4. 交班清场：静默清空助理会话
  // =========================================================================
  handle(GuanjiaIpcChannel.ClearAssistantSession, async () => {
    return workspaceManager.clearAssistantSession();
  });

  // =========================================================================
  // 5. 模型路由与预扣退费
  // =========================================================================
  handle(GuanjiaIpcChannel.GetCreditBalance, async () => {
    return { success: false, error: '智慧管家模型路由与模拟积分功能已停用' };
  });

  handle(GuanjiaIpcChannel.RouteAndInvokeModel, async () => {
    return { success: false, error: '模拟模型路由已停用：智慧管家已接入 Cowork 真实模型原生会话' };
  });

  handle(GuanjiaIpcChannel.GetLedgerRecords, async () => {
    return { success: false, error: '积分台账不可用' };
  });

  // =========================================================================
  // 6. 桌面专属官方绑定与静默登录 (Token-free)
  // =========================================================================
  ipcMain.handle(GuanjiaIpcChannel.DesktopAuthGetStatus, async (event): Promise<GuanjiaDesktopAuthStatus> => {
    if (!isTrustedMainRenderer(event, options?.getMainWindow) && !isTrustedGuanjiaFrame(event)) {
      throw new Error('非法的调用来源');
    }
    return coordinator.getStatus();
  });

  handle(
    GuanjiaIpcChannel.DesktopAuthBind,
    async (_event, params: GuanjiaDesktopAuthBindParams) => {
      return coordinator.bind(params);
    },
  );

  handle(
    GuanjiaIpcChannel.DesktopAuthUnbind,
    async (_event, params: GuanjiaDesktopAuthUnbindParams) => {
      return coordinator.unbind(params);
    },
  );

  handle(GuanjiaIpcChannel.DesktopAuthLoginBound, async () => {
    return coordinator.exchangeAndAdopt();
  });

  ipcMain.handle(GuanjiaIpcChannel.DesktopAuthRegisterBusinessToken, async (event, params: RegisterBusinessTokenParams) => {
    if (!isTrustedGuanjiaFrame(event)) {
      throw new Error('非法的调用来源');
    }
    return coordinator.registerBusinessToken(params);
  });
}
