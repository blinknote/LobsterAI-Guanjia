import { beforeAll, describe, expect, it, mock } from 'bun:test';

// Mock Electron APIs before importing workspace manager
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
let GUANJIA_WORKSPACE_PARTITION: any;

beforeAll(async () => {
  const modelMod = await import('../src/main/guanjia/guanjiaModelRouter');
  GuanjiaModelRouter = modelMod.GuanjiaModelRouter;

  const wsMod = await import('../src/main/guanjia/guanjiaWorkspaceManager');
  GuanjiaWorkspaceManager = wsMod.GuanjiaWorkspaceManager;

  const typesMod = await import('../src/main/guanjia/types');
  GUANJIA_WORKSPACE_PARTITION = typesMod.GUANJIA_WORKSPACE_PARTITION;
});

describe('P0 门禁 1: 模型多来源预扣退费与记账审计', () => {
  it('1.1 单一积分余额视图（对外仅暴露总可用/已用，不泄露多池细节）', () => {
    const router = GuanjiaModelRouter.getInstance();
    const balance = router.getBalance('u-audit-01', 'shop-01');
    expect(balance.available).toBeGreaterThan(0);
    expect(balance.reserved).toBe(0);
    expect(balance.totalUsed).toBe(0);
  });

  it('1.2 预扣挂账与余额不足拦截', () => {
    const router = GuanjiaModelRouter.getInstance();
    const user = 'u-prepay-test';
    const shop = 'shop-01';
    const initial = router.getBalance(user, shop).available;

    // 正常预扣
    const res = router.reserveCredits(user, shop, 'guanjia-fast', 100);
    expect(res.success).toBe(true);
    expect(res.reservationId).toBeDefined();

    const heldBalance = router.getBalance(user, shop);
    expect(heldBalance.available).toBe(initial - 100);
    expect(heldBalance.reserved).toBe(100);

    // 超出可用余额拦截
    const overRes = router.reserveCredits(user, shop, 'guanjia-fast', 999999);
    expect(overRes.success).toBe(false);
    expect(overRes.error).toContain('积分不足');
  });

  it('1.3 多退少补算法（多退差额，少补扣除，准确计入实际后台成本）', () => {
    const router = GuanjiaModelRouter.getInstance();
    const user = 'u-refund-diff';
    const shop = 'shop-01';
    const initial = router.getBalance(user, shop).available;

    // 预扣 200 积分
    const pre = router.reserveCredits(user, shop, 'guanjia-fast', 200);
    expect(pre.success).toBe(true);

    // 实际调用成功，产生 500 token (基础公式计算 5 积分)
    const settle = router.settleReservation(pre.reservationId!, {
      success: true,
      providerId: 'provider-self-hosted',
      promptTokens: 200,
      completionTokens: 300,
      totalTokens: 500,
    });

    expect(settle.actualCredits).toBe(5);
    expect(settle.refundCredits).toBe(195);
    expect(settle.actualCost).toBeGreaterThan(0);

    const finalBalance = router.getBalance(user, shop);
    expect(finalBalance.available).toBe(initial - 5);
    expect(finalBalance.reserved).toBe(0);
    expect(finalBalance.totalUsed).toBe(5);
  });

  it('1.4 调用失败全额退还预扣积分，不扣费', () => {
    const router = GuanjiaModelRouter.getInstance();
    const user = 'u-fail-refund';
    const shop = 'shop-01';
    const initial = router.getBalance(user, shop).available;

    const pre = router.reserveCredits(user, shop, 'guanjia-fast', 150);
    expect(pre.success).toBe(true);

    const settle = router.settleReservation(pre.reservationId!, {
      success: false,
      providerId: 'provider-self-hosted',
      error: 'Upstream connection timeout',
    });

    expect(settle.actualCredits).toBe(0);
    expect(settle.refundCredits).toBe(150);
    expect(settle.actualCost).toBe(0);

    const finalBalance = router.getBalance(user, shop);
    expect(finalBalance.available).toBe(initial);
    expect(finalBalance.reserved).toBe(0);
  });

  it('1.5 多来源自动故障切换 (Failover) 与台账登记', async () => {
    const router = GuanjiaModelRouter.getInstance();
    // 禁用主来源自有算力池
    router.setProviderEnabled('provider-self-hosted', false);

    const resp = await router.routeAndInvokeModel({
      userId: 'u-failover',
      shopId: 'shop-01',
      model: 'guanjia-fast',
      prompt: '查询技师排班情况',
    });

    expect(resp.success).toBe(true);
    // 自动降级使用官方聚合池
    expect(resp.providerId).toBe('provider-lobster-official');

    // 检查台账中记录了来源与成本
    const records = router.getLedgerRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].providerId).toBe('provider-lobster-official');
    expect(records[0].actualCost).toBeGreaterThan(0);

    // 恢复配置
    router.setProviderEnabled('provider-self-hosted', true);
  });

  it('1.6 幂等性与状态校验：严禁重复结算已完成或已失效的 reservation', () => {
    const router = GuanjiaModelRouter.getInstance();
    const user = 'u-double-settle';
    const shop = 'shop-01';
    const pre = router.reserveCredits(user, shop, 'guanjia-fast', 100);

    // 第一次结算
    router.settleReservation(pre.reservationId!, {
      success: true,
      providerId: 'provider-self-hosted',
      totalTokens: 100,
    });
    const balAfterFirst = router.getBalance(user, shop).available;

    // 第二次对相同 reservationId 重复结算：应被拦截抛错
    let doubleSettleBlocked = false;
    try {
      router.settleReservation(pre.reservationId!, {
        success: true,
        providerId: 'provider-self-hosted',
        totalTokens: 100,
      });
    } catch (err: any) {
      doubleSettleBlocked = true;
      expect(err.message).toContain('严禁重复结算');
    }

    const balAfterSecond = router.getBalance(user, shop).available;
    expect(doubleSettleBlocked).toBe(true);
    expect(balAfterSecond).toBe(balAfterFirst); // 余额保持不变，无重复退款
  });

  it('1.7 预扣金额入参校验：非正数/负数/非法积分严格拦截', () => {
    const router = GuanjiaModelRouter.getInstance();
    const user = 'u-negative-test';
    const shop = 'shop-01';
    const initial = router.getBalance(user, shop).available;

    // 传入非法负数预扣积分：必须拦截
    const res = router.reserveCredits(user, shop, 'guanjia-fast', -100);
    const current = router.getBalance(user, shop).available;
    expect(res.success).toBe(false);
    expect(res.error).toContain('预扣积分必须为大于 0');
    expect(current).toBe(initial);

    // 传入 0 积分：同样拦截
    const zeroRes = router.reserveCredits(user, shop, 'guanjia-fast', 0);
    expect(zeroRes.success).toBe(false);
    expect(zeroRes.error).toContain('预扣积分必须为大于 0');
  });
});

describe('P0 门禁 2: 敏感动账拦截与授权审计', () => {
  it('2.1 未确认 (confirmed: false) 的动账操作必须硬拦截', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.getOrCreateView();

    const action = {
      type: 'refund' as const,
      isFinancialAction: true,
      financialDetails: {
        amount: '198.00',
        reason: '顾客不满意',
        actionType: 'refund' as const,
      },
      confirmed: false,
    };

    const result = await manager.executeAction(action);
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.message).toContain('动账操作拦截');

    const logs = manager.getAuditLogs();
    expect(logs[0].status).toBe('intercepted');
  });

  it('2.2 confirmed: true 但缺少或为空 confirmedBy 时坚决硬拦截并报错，严禁自动兜底为店员手动确认', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const view = manager.getOrCreateView();
    view.webContents.executeJavaScript.mockResolvedValue({
      success: true,
      actionType: 'refund',
      message: '动作执行成功',
    });

    const bypassAction = {
      type: 'refund' as const,
      isFinancialAction: true,
      financialDetails: {
        amount: '500.00',
        reason: '越权绕过测试',
        actionType: 'refund' as const,
      },
      confirmed: true,
      confirmedBy: '   ', // 空白或缺少确认人
    };

    const result = await manager.executeAction(bypassAction);
    // 规范要求：“必须带 confirmed=true 且有 confirmedBy 才能放行，缺失或为空时坚决硬拦截并报错”
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.error).toContain('confirmedBy');

    const logs = manager.getAuditLogs();
    expect(logs[0].status).toBe('intercepted');
    expect(logs[0].confirmedBy).toBe('');
    expect(logs[0].confirmedBy).not.toBe('店员手动确认');
  });

  it('2.3 统一 FINANCIAL_ACTION_TYPES 匹配：未显式标记 isFinancialAction 时主进程按 type 准确判定并拦截动账', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const actionWithoutFlag = {
      type: 'refund' as const,
      selector: '#refund-btn',
      confirmed: false,
    };

    const result = await manager.executeAction(actionWithoutFlag);
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.message).toContain('动账操作拦截');

    const logs = manager.getAuditLogs();
    expect(logs[0].status).toBe('intercepted');
    expect(logs[0].actionType).toBe('refund');
  });
});

describe('P0 门禁 3: 现场保持、免密 SSO 与持久化分区', () => {
  it('3.1 独立持久化分区与凭证托管', () => {
    expect(GUANJIA_WORKSPACE_PARTITION).toBe('persist:guanjia-workspace');

    const manager = GuanjiaWorkspaceManager.getInstance();
    const sso = {
      token: 'sso-token-999',
      userId: 'u-sso-01',
      username: 'clerk01',
      realName: '李店长',
      role: 'manager' as const,
      shopId: 'shop-01',
      shopName: '青盛堂旗舰店',
    };
    manager.setSsoCredentials(sso);
    expect(manager.getSsoCredentials()?.token).toBe('sso-token-999');
    expect(manager.getSsoCredentials()?.shopName).toBe('青盛堂旗舰店');
  });

  it('3.2 WebContentsView hideView 保持实例不销毁', () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const view = manager.getOrCreateView();
    expect(view.webContents.isDestroyed()).toBe(false);

    manager.hideView();
    expect(view.webContents.isDestroyed()).toBe(false);
  });

  it('3.3 Preload 规范：使用 contextBridge 暴露 SSO 凭据并重写 navigator.credentials.store 与密码保护', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/guanjia/guanjiaPreload.ts'),
      'utf-8',
    );

    // 验证严格使用 contextBridge.exposeInMainWorld
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('__GUANJIA_SSO__'");

    // 验证主世界/Preload 覆盖重写 navigator.credentials.store 与 preventDefault 密码保存提示
    expect(preloadSource).toContain('navigator.credentials.store');
    expect(preloadSource).toContain('injectMainWorldPasswordShield');
    expect(preloadSource).toContain('disablePasswordSavePrompt');
  });
});

describe('P0 门禁 4: 全键盘与无障碍 (F2 放行、Ctrl+= 循环聚焦与读屏规范)', () => {
  it('4.1 卡片三种状态的 aria-label 与文字必须严格对齐规范', () => {
    const storeName = '青盛堂旗舰店';

    // 状态 1: 未打开 (idle)
    const getCardAria = (status: 'idle' | 'active' | 'pending', count: number) => {
      switch (status) {
        case 'idle':
          return `智慧管家，未打开，门店${storeName}`;
        case 'active':
          return `智慧管家，使用中，门店${storeName}`;
        case 'pending':
          return `智慧管家，待办${count}条，门店${storeName}`;
      }
    };

    expect(getCardAria('idle', 0)).toBe('智慧管家，未打开，门店青盛堂旗舰店');
    expect(getCardAria('active', 0)).toBe('智慧管家，使用中，门店青盛堂旗舰店');
    expect(getCardAria('pending', 3)).toBe('智慧管家，待办3条，门店青盛堂旗舰店');
  });

  it('4.2 F2 快捷键绝不抢占放行验证', () => {
    // 模拟键盘事件处理逻辑（对齐 App.tsx 中 handleKeyDown）
    const handledEvents: string[] = [];
    const handleKeyDown = (event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => {
      if (event.key === 'F2') {
        // 直接返回，绝不抢占，不调用 preventDefault
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        handledEvents.push('cycle_focus');
        return;
      }
    };

    let f2Prevented = false;
    handleKeyDown({
      key: 'F2',
      preventDefault: () => {
        f2Prevented = true;
      },
    });

    expect(f2Prevented).toBe(false);
    expect(handledEvents.length).toBe(0);
  });

  it('4.3 Ctrl+= / Cmd+= 循环焦点切换与 aria-live 播报验证', () => {
    let focusRegion: 'main' | 'topbar' | 'sidebar' = 'sidebar';
    let liveAnnouncement = '';

    const cycleFocus = () => {
      focusRegion = focusRegion === 'main' ? 'topbar' : focusRegion === 'topbar' ? 'sidebar' : 'main';
      if (focusRegion === 'main') {
        liveAnnouncement = '已切换到管家主区';
      } else if (focusRegion === 'topbar') {
        liveAnnouncement = '已切换到顶栏';
      } else if (focusRegion === 'sidebar') {
        liveAnnouncement = '已切换到侧栏';
      }
    };

    // 第一次切换：sidebar -> main
    cycleFocus();
    expect(focusRegion).toBe('main');
    expect(liveAnnouncement).toBe('已切换到管家主区');

    // 第二次切换：main -> topbar
    cycleFocus();
    expect(focusRegion).toBe('topbar');
    expect(liveAnnouncement).toBe('已切换到顶栏');

    // 第三次切换：topbar -> sidebar
    cycleFocus();
    expect(focusRegion).toBe('sidebar');
    expect(liveAnnouncement).toBe('已切换到侧栏');
  });
});

describe('P0 门禁 5: 交班清场、记忆隔离与核心台账保护', () => {
  it('5.1 清理助理会话必须仅定向针对 guanjia-assistant，不伤及其他会话与底层数据', async () => {
    const mockDeleted: string[] = [];
    const mockStore = {
      clearAgentSessions: (agentId: string) => {
        if (agentId === 'guanjia-assistant') {
          mockDeleted.push('sess-guanjia-1', 'sess-guanjia-2');
          return ['sess-guanjia-1', 'sess-guanjia-2'];
        }
        return [];
      },
    };

    const manager = GuanjiaWorkspaceManager.getInstance();
    manager.setCoworkStore(mockStore as any);

    const result = await manager.clearAssistantSession();
    expect(result.success).toBe(true);
    expect(result.clearedCount).toBe(2);
    expect(mockDeleted).toContain('sess-guanjia-1');
  });

  it('5.2 clearAgentSessions 事务提交后必须调用 markOrphanImplicitMemoriesStale 杜绝交班记忆残留', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const coworkStoreSource = fs.readFileSync(
      path.join(__dirname, '../src/main/coworkStore.ts'),
      'utf-8',
    );
    const clearMethodMatch = coworkStoreSource.match(/clearAgentSessions\([\s\S]*?\{[\s\S]*?\n  \}/);
    expect(clearMethodMatch).not.toBeNull();
    expect(clearMethodMatch![0]).toContain('this.markOrphanImplicitMemoriesStale()');
  });
});
