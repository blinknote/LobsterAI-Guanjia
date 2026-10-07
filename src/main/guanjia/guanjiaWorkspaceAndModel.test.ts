import { beforeAll, describe, expect, it, mock } from 'bun:test';

const mockElectronState = ((globalThis as any).__guanjiaMockElectronState ??= {
  cookieSet: mock(async (_cookie: any) => {}),
  cookieRemove: mock(async (_url: string, _name: string) => {}),
  cookieGet: mock(async () => []),
  executeJs: mock(async (_code: string) => ({ success: true, message: 'executed' })),
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
});

const sessionMock = {
  setPermissionRequestHandler: mock((_cb) => {}),
  cookies: {
    set: mockElectronState.cookieSet,
    remove: mockElectronState.cookieRemove,
    get: mockElectronState.cookieGet,
  },
};
const electronMock = {
  app: {
    isPackaged: false,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp',
  },
  session: {
    fromPartition: mock(() => sessionMock),
  },
  WebContentsView: class {
    webContents = {
      isDestroyed: () => false,
      getURL: () => 'https://guanjia.example.com/cashier',
      getTitle: () => '收银结账 - 智慧管家',
      loadURL: mock(() => {}),
      reload: mock(() => {}),
      reloadIgnoringCache: mock(() => {}),
      on: mock(() => {}),
      executeJavaScript: mockElectronState.executeJs,
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: mock(() => {}),
        goForward: mock(() => {}),
      },
    };
    setBounds = mock(() => {});
    setVisible = mock(() => {});
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
  },
  ipcMain: {
    handle: mock((channel: string, handler: any) => {
      mockElectronState.ipcHandlers.set(channel, handler);
    }),
    on: mock((channel: string, handler: any) => {
      mockElectronState.ipcHandlers.set(channel, handler);
    }),
    removeHandler: mock((channel: string) => {
      mockElectronState.ipcHandlers.delete(channel);
    }),
  },
};
mock.module('electron', () => electronMock);

let GuanjiaModelRouter: any;
let GuanjiaWorkspaceManager: any;
let DEFAULT_GUANJIA_URL: any;
let GUANJIA_WORKSPACE_PARTITION: any;

beforeAll(async () => {
  const modelMod = await import('./guanjiaModelRouter');
  GuanjiaModelRouter = modelMod.GuanjiaModelRouter;

  const wsMod = await import('./guanjiaWorkspaceManager');
  GuanjiaWorkspaceManager = wsMod.GuanjiaWorkspaceManager;
  DEFAULT_GUANJIA_URL = wsMod.DEFAULT_GUANJIA_URL;

  const typesMod = await import('./types');
  GUANJIA_WORKSPACE_PARTITION = typesMod.GUANJIA_WORKSPACE_PARTITION;
});

import type { GuanjiaActionRequest, GuanjiaSsoCredentials } from './types';

describe('Guanjia Workspace Manager & Preload Security', () => {
  it('should use persist:guanjia-workspace partition and manage SSO credentials', () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    expect(GUANJIA_WORKSPACE_PARTITION).toBe('persist:guanjia-workspace');

    const credentials: GuanjiaSsoCredentials = {
      token: 'mock-sso-token-123456',
      userId: 'user-001',
      username: 'cashier01',
      realName: '李前台',
      role: 'frontdesk',
      shopId: 'shop-888',
      shopName: '青盛堂旗舰店',
    };

    manager.setSsoCredentials(credentials);
    expect(manager.getSsoCredentials()?.token).toBe('mock-sso-token-123456');
    expect(manager.getSsoCredentials()?.shopName).toBe('青盛堂旗舰店');
  });

  it('should intercept financial action if not confirmed', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.getOrCreateView();

    const refundAction: GuanjiaActionRequest = {
      type: 'refund',
      selector: '#btn-refund-submit',
      isFinancialAction: true,
      financialDetails: {
        amount: '198.00',
        reason: '顾客不满意申请退款',
        actionType: 'refund',
      },
      confirmed: false, // 未确认
    };

    const result = await manager.executeAction(refundAction);
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.message).toContain('动账操作拦截');
    expect(result.message).toContain('198.00');

    // 确认审计日志记录了拦截状态
    const logs = manager.getAuditLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].status).toBe('intercepted');
    expect(logs[0].amount).toBe('198.00');
  });


  it('should have DEFAULT_GUANJIA_URL pointing to the production domain', () => {
    expect(DEFAULT_GUANJIA_URL).toBe('https://guanjia.qszy.me/');
  });

  it('should support navigation configuration, reload and default url fallback', () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    expect(manager.getDefaultUrl()).toBe('https://guanjia.qszy.me/');

    // 测试动态修改默认 URL
    manager.setDefaultUrl('https://guanjia.qszy.me/dashboard');
    expect(manager.getDefaultUrl()).toBe('https://guanjia.qszy.me/dashboard');

    // 恢复默认
    manager.setDefaultUrl(DEFAULT_GUANJIA_URL);
    expect(manager.getDefaultUrl()).toBe('https://guanjia.qszy.me/');

    // 测试 loadUrl
    const view = manager.getOrCreateView();
    manager.loadUrl();
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://guanjia.qszy.me/');

    manager.loadUrl('https://guanjia.qszy.me/rooms');
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://guanjia.qszy.me/rooms');

    // 测试 reload
    manager.reload();
    expect(view.webContents.reload).toHaveBeenCalled();

    manager.reload(true);
    expect(view.webContents.reloadIgnoringCache).toHaveBeenCalled();
  });

  it('should allow financial action when confirmed and record audit log', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const view = manager.getOrCreateView();
    view.webContents.executeJavaScript = mock(async () => ({
      success: true,
      actionType: 'refund',
      message: '动作执行成功',
    }));

    const confirmedAction: GuanjiaActionRequest = {
      type: 'refund',
      selector: '#btn-refund-submit',
      isFinancialAction: true,
      financialDetails: {
        amount: '198.00',
        reason: '顾客不满意申请退款',
        actionType: 'refund',
      },
      confirmed: true, // 已明确确认
      confirmedBy: '李前台',
    };

    const result = await manager.executeAction(confirmedAction);
    expect(result.success).toBe(true);

    const logs = manager.getAuditLogs();
    expect(logs[0].status).toBe('executed');
    expect(logs[0].confirmedBy).toBe('李前台');
  });
});

describe('Guanjia Model Router & Prepay Refund Logic', () => {
  it('should provide single credit balance view', () => {
    const router = GuanjiaModelRouter.getInstance();
    const balance = router.getBalance('user-001', 'shop-888');
    expect(balance.available).toBeGreaterThan(0);
    expect(balance.reserved).toBe(0);
  });

  it('should hold credits on reservation and reject when insufficient', () => {
    const router = GuanjiaModelRouter.getInstance();

    // 1. 正常预扣
    const res = router.reserveCredits('user-001', 'shop-888', 'guanjia-fast', 100);
    expect(res.success).toBe(true);
    expect(res.reservationId).toBeDefined();

    const currentBalance = router.getBalance('user-001', 'shop-888');
    expect(currentBalance.reserved).toBe(100);

    // 2. 余额不足拦截
    const overRes = router.reserveCredits('user-001', 'shop-888', 'guanjia-fast', 999999);
    expect(overRes.success).toBe(false);
    expect(overRes.error).toContain('积分不足');
  });

  it('should refund difference when actual usage is less than reserved (多退少补)', () => {
    const router = GuanjiaModelRouter.getInstance();
    const initialBalance = router.getBalance('user-test-refund', 'shop-1').available;

    // 预扣 200 积分
    const pre = router.reserveCredits('user-test-refund', 'shop-1', 'guanjia-fast', 200);
    expect(pre.success).toBe(true);

    // 结算：实际消耗为 50 积分
    const settlement = router.settleReservation(pre.reservationId!, {
      success: true,
      providerId: 'provider-self-hosted',
      promptTokens: 200,
      completionTokens: 300,
      totalTokens: 500, // (500/1000)*1*10 = 5 积分
    });

    // 实际应扣 5 积分，退回 195 积分
    expect(settlement.actualCredits).toBe(5);
    expect(settlement.refundCredits).toBe(195);
    expect(settlement.actualCost).toBeGreaterThan(0);

    const finalBalance = router.getBalance('user-test-refund', 'shop-1');
    expect(finalBalance.available).toBe(initialBalance - 5);
    expect(finalBalance.reserved).toBe(0);
  });

  it('should fully refund reserved credits when model invocation fails', () => {
    const router = GuanjiaModelRouter.getInstance();
    const initialBalance = router.getBalance('user-test-fail', 'shop-1').available;

    const pre = router.reserveCredits('user-test-fail', 'shop-1', 'guanjia-fast', 150);
    expect(pre.success).toBe(true);

    const settlement = router.settleReservation(pre.reservationId!, {
      success: false,
      providerId: 'provider-self-hosted',
      error: 'Upstream gateway error',
    });

    expect(settlement.actualCredits).toBe(0);
    expect(settlement.refundCredits).toBe(150);

    const finalBalance = router.getBalance('user-test-fail', 'shop-1');
    expect(finalBalance.available).toBe(initialBalance);
    expect(finalBalance.reserved).toBe(0);
  });

  it('should record ledger entries for profit and cost auditing', () => {
    const router = GuanjiaModelRouter.getInstance();
    const ledger = router.getLedgerRecords();
    expect(Array.isArray(ledger)).toBe(true);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0].actualCost).toBeDefined();
    expect(ledger[0].providerId).toBeDefined();
  });
});
