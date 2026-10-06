import { describe, expect, it, mock, beforeAll } from 'bun:test';

const sessionMock = {
  setPermissionRequestHandler: mock((_cb) => {}),
};
const electronMock = {
  app: {
    isPackaged: false,
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
      on: mock(() => {}),
      executeJavaScript: mock(async () => ({ success: true, message: 'executed' })),
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
    };
    setBounds = mock(() => {});
    setVisible = mock(() => {});
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
  },
};
mock.module('electron', () => electronMock);

let GuanjiaModelRouter: any;
let GuanjiaWorkspaceManager: any;
let GUANJIA_WORKSPACE_PARTITION: any;

beforeAll(async () => {
  const modelMod = await import('./guanjiaModelRouter');
  GuanjiaModelRouter = modelMod.GuanjiaModelRouter;

  const wsMod = await import('./guanjiaWorkspaceManager');
  GuanjiaWorkspaceManager = wsMod.GuanjiaWorkspaceManager;

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
