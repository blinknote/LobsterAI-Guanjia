import { BrowserWindow, ipcMain, Rectangle } from 'electron';

import type { CoworkStore } from '../coworkStore';
import { GuanjiaModelRouter, InvokeModelRequest } from './guanjiaModelRouter';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';
import {
  GuanjiaActionRequest,
  GuanjiaIpcChannel,
  GuanjiaLoginPayload,
  GuanjiaLoginResult,
  GuanjiaSsoCredentials,
} from './types';

export interface RegisterGuanjiaHandlersOptions {
  getCoworkStore?: () => CoworkStore;
  getMainWindow?: () => BrowserWindow | null;
}

export function registerGuanjiaIpcHandlers(options?: RegisterGuanjiaHandlersOptions): void {
  const workspaceManager = GuanjiaWorkspaceManager.getInstance();
  const modelRouter = GuanjiaModelRouter.getInstance();

  if (options?.getCoworkStore) {
    workspaceManager.setCoworkStoreGetter(options.getCoworkStore);
  }

  // =========================================================================
  // 1. WebContentsView 生命周期与布局管理
  // =========================================================================
  ipcMain.handle(
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

  ipcMain.handle(GuanjiaIpcChannel.DetachView, async () => {
    workspaceManager.hideView();
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.SetBounds, async (_event, bounds: Rectangle) => {
    workspaceManager.setBounds(bounds);
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.ShowView, async () => {
    const targetWin = options?.getMainWindow ? options.getMainWindow() : BrowserWindow.getFocusedWindow();
    workspaceManager.showView(targetWin || undefined);
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.HideView, async () => {
    workspaceManager.hideView();
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.LoadUrl, async (_event, url?: string) => {
    workspaceManager.loadUrl(url);
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.Reload, async (_event, ignoreCache?: boolean) => {
    workspaceManager.reload(Boolean(ignoreCache));
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.SetDefaultUrl, async (_event, url: string) => {
    workspaceManager.setDefaultUrl(url);
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.GetDefaultUrl, async () => {
    return { success: true, url: workspaceManager.getDefaultUrl() };
  });

  ipcMain.handle(GuanjiaIpcChannel.GoBack, async () => {
    workspaceManager.goBack();
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.GoForward, async () => {
    workspaceManager.goForward();
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.GetNavigationState, async () => {
    return workspaceManager.getNavigationState();
  });

  // =========================================================================
  // 真实账号密码认证与会话凭据直达
  // =========================================================================
  ipcMain.handle(
    GuanjiaIpcChannel.Login,
    async (
      _event,
      args: { account?: string; password?: string; [key: string]: unknown },
    ): Promise<GuanjiaLoginResult> => {
      // 1. 外部输入校验
      if (!args || typeof args !== 'object') {
        return { success: false, error: '请求参数无效' };
      }
      const account = typeof args.account === 'string' ? args.account.trim() : '';
      const password = typeof args.password === 'string' ? args.password : '';
      if (!account || !password) {
        return { success: false, error: '账号和密码不能为空' };
      }

      try {
        // 2. 服务端调用 /api/c/login 校验
        const baseUrl = workspaceManager.getDefaultUrl() || 'https://guanjia.qszy.me/';
        const loginUrl = new URL('/api/c/login', baseUrl).toString();

        const response = await fetch(loginUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            employee_no: account,
            password: password,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          let errorMsg = `登录失败 (HTTP ${response.status})`;
          try {
            const errData = (await response.json()) as any;
            if (errData && (errData.message || errData.error || errData.msg)) {
              errorMsg = errData.message || errData.error || errData.msg;
            }
          } catch {
            // 忽略非 json
          }
          return { success: false, error: errorMsg };
        }

        const resData = (await response.json()) as any;
        if (!resData || (!resData.success && resData.code !== 200 && resData.code !== 0)) {
          return {
            success: false,
            error: resData?.message || resData?.msg || resData?.error || '登录失败，请核对账号与密码',
          };
        }

        const data = resData.data || resData;
        const token = data.token;
        if (!token || typeof token !== 'string') {
          return { success: false, error: resData.message || '登录失败：服务端未返回有效令牌' };
        }

        const userInfo = data.userInfo || data.user || {};
        const employeeId = String(userInfo.employee_id ?? userInfo.id ?? userInfo.userId ?? '');
        const employeeNo = String(userInfo.employee_no ?? userInfo.username ?? account);
        const employeeName = String(userInfo.employee_name ?? userInfo.realName ?? userInfo.name ?? employeeNo);
        const role = String(userInfo.role ?? 'frontdesk');
        const storeCode = String(userInfo.store_code ?? userInfo.shop_id ?? userInfo.shopId ?? '');
        const storeName = String(userInfo.store_name ?? userInfo.shop_name ?? userInfo.shopName ?? '');

        // 3. 构造 GuanjiaSsoCredentials
        const credentials: GuanjiaSsoCredentials = {
          token,
          userId: employeeId,
          username: employeeNo,
          realName: employeeName,
          role,
          shopId: storeCode,
          shopName: storeName,
        };

        // 4. 调用 GuanjiaWorkspaceManager.getInstance().setSsoCredentials(...) 并注入会话凭据
        workspaceManager.setSsoCredentials(credentials);
        await workspaceManager.injectSessionCredentials(credentials);

        return {
          success: true,
          data: {
            token,
            userInfo: {
              employee_id: employeeId,
              employee_no: employeeNo,
              employee_name: employeeName,
              role,
              store_code: storeCode,
              store_name: storeName,
              ...userInfo,
            },
          },
          credentials,
        };
      } catch (err: any) {
        console.error('[GuanjiaIpcHandlers] Login exception:', err instanceof Error ? err.message : err);
        const isTimeout =
          err?.name === 'TimeoutError' ||
          err?.name === 'AbortError' ||
          (err instanceof Error && /timeout|aborted|timed out/i.test(err.message));
        if (isTimeout) {
          return {
            success: false,
            error: '登录请求超时（超过 15 秒），请检查网络连接后重试',
          };
        }
        return {
          success: false,
          error: err instanceof Error ? err.message : '网络请求失败，请检查网络连接',
        };
      }
    },
  );

  ipcMain.handle(GuanjiaIpcChannel.Logout, async (): Promise<{ success: boolean; error?: string }> => {
    try {
      workspaceManager.clearSsoCredentials();
      await workspaceManager.clearSessionCredentials();
      return { success: true };
    } catch (err) {
      console.error('[GuanjiaIpcHandlers] Logout exception:', err instanceof Error ? err.message : err);
      return {
        success: false,
        error: err instanceof Error ? err.message : '登出失败',
      };
    }
  });

  // =========================================================================
  // 2. SSO 凭据管理 (document-start 同步注入)
  // =========================================================================
  ipcMain.handle(GuanjiaIpcChannel.SetSsoCredentials, async (_event, credentials: GuanjiaSsoCredentials) => {
    workspaceManager.setSsoCredentials(credentials);
    return { success: true };
  });

  // 供 guanjiaPreload 在 document-start 时同步拉取免密凭证
  ipcMain.on(GuanjiaIpcChannel.GetSsoCredentialsSync, (event) => {
    event.returnValue = workspaceManager.getSsoCredentials();
  });

  ipcMain.handle(GuanjiaIpcChannel.ClearSsoCredentials, async () => {
    workspaceManager.clearSsoCredentials();
    return { success: true };
  });

  // =========================================================================
  // 3. 只读上下文与动作执行 (含动账拦截)
  // =========================================================================
  ipcMain.handle(GuanjiaIpcChannel.GetContext, async () => {
    return workspaceManager.getWorkspaceContext();
  });

  ipcMain.handle(GuanjiaIpcChannel.ExecuteAction, async (_event, payload: {
    action: GuanjiaActionRequest;
    intercepted?: boolean;
    executed?: boolean;
    financialDetails?: unknown;
  }) => {
    if (payload.action) {
      return workspaceManager.executeAction(payload.action);
    }
    return { success: false, error: 'Invalid action payload' };
  });

  ipcMain.handle(GuanjiaIpcChannel.GetAuditLogs, async () => {
    return workspaceManager.getAuditLogs();
  });

  // =========================================================================
  // 4. 交班清场：静默清空助理会话
  // =========================================================================
  ipcMain.handle(GuanjiaIpcChannel.ClearAssistantSession, async () => {
    return workspaceManager.clearAssistantSession();
  });

  // =========================================================================
  // 5. 模型路由与预扣退费
  // =========================================================================
  ipcMain.handle(GuanjiaIpcChannel.GetCreditBalance, async (_event, args?: { userId?: string; shopId?: string }) => {
    const userId = args?.userId || 'default';
    const shopId = args?.shopId || 'default';
    return modelRouter.getBalance(userId, shopId);
  });

  ipcMain.handle(GuanjiaIpcChannel.RouteAndInvokeModel, async (_event, request: InvokeModelRequest) => {
    return modelRouter.routeAndInvokeModel(request);
  });

  ipcMain.handle(GuanjiaIpcChannel.GetLedgerRecords, async () => {
    return modelRouter.getLedgerRecords();
  });
}
