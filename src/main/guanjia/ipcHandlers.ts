import { BrowserWindow, ipcMain, Rectangle } from 'electron';

import type { CoworkStore } from '../coworkStore';
import { GuanjiaModelRouter, InvokeModelRequest } from './guanjiaModelRouter';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';
import {
  GuanjiaActionRequest,
  GuanjiaIpcChannel,
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

  ipcMain.handle(GuanjiaIpcChannel.LoadUrl, async (_event, url: string) => {
    workspaceManager.loadUrl(url);
    return { success: true };
  });

  ipcMain.handle(GuanjiaIpcChannel.GetNavigationState, async () => {
    return workspaceManager.getNavigationState();
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
