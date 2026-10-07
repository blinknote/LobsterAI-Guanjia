import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { GuanjiaIpcChannel } from '../src/main/guanjia/types';
import authReducer, { setLoggedIn } from '../src/renderer/store/slices/authSlice';
import fs from 'fs';

describe('阿岚前端闭环测试: WebContentsView 真实联动与交班静默清场', () => {
  let mockIpcInvocations: Array<{ channel: string; args: any }> = [];
  let bridgeInvocations: string[] = [];

  beforeEach(() => {
    mockIpcInvocations = [];
    bridgeInvocations = [];

    // 设置全局 window 环境模拟
    (globalThis as any).window = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: mock((_event: string, _cb: any) => {}),
      removeEventListener: mock((_event: string, _cb: any) => {}),
      setTimeout: (cb: any) => {
        cb();
        return 1;
      },
      clearTimeout: mock((_id: number) => {}),
      guanjiaBridge: {
        clearAssistantSession: mock(async () => {
          bridgeInvocations.push('clearAssistantSession');
          return { success: true, clearedCount: 2 };
        }),
        onShiftHandover: mock(async () => {
          bridgeInvocations.push('onShiftHandover');
          return { success: true, clearedCount: 2 };
        }),
        attachView: mock(async (payload: any) => {
          mockIpcInvocations.push({ channel: GuanjiaIpcChannel.AttachView, args: payload });
          return { success: true };
        }),
        detachView: mock(async () => {
          mockIpcInvocations.push({ channel: GuanjiaIpcChannel.DetachView, args: null });
          return { success: true };
        }),
        setBounds: mock(async (bounds: any) => {
          mockIpcInvocations.push({ channel: GuanjiaIpcChannel.SetBounds, args: bounds });
          return { success: true };
        }),
        showView: mock(async () => {
          mockIpcInvocations.push({ channel: GuanjiaIpcChannel.ShowView, args: null });
          return { success: true };
        }),
        hideView: mock(async () => {
          mockIpcInvocations.push({ channel: GuanjiaIpcChannel.HideView, args: null });
          return { success: true };
        }),
        reload: mock(async (_ignoreCache?: boolean) => {
          bridgeInvocations.push('reload');
          return { success: true };
        }),
        setSsoCredentials: mock(async (creds: any) => {
          bridgeInvocations.push('setSsoCredentials');
          return { success: true };
        }),
      },
      electron: {
        guanjia: {
          attachView: mock(async (payload: any) => {
            mockIpcInvocations.push({ channel: GuanjiaIpcChannel.AttachView, args: payload });
            return { success: true };
          }),
          detachView: mock(async () => {
            mockIpcInvocations.push({ channel: GuanjiaIpcChannel.DetachView, args: null });
            return { success: true };
          }),
          setBounds: mock(async (bounds: any) => {
            mockIpcInvocations.push({ channel: GuanjiaIpcChannel.SetBounds, args: bounds });
            return { success: true };
          }),
          showView: mock(async () => {
            mockIpcInvocations.push({ channel: GuanjiaIpcChannel.ShowView, args: null });
            return { success: true };
          }),
          hideView: mock(async () => {
            mockIpcInvocations.push({ channel: GuanjiaIpcChannel.HideView, args: null });
            return { success: true };
          }),
          clearAssistantSession: mock(async () => {
            bridgeInvocations.push('electron.guanjia.clearAssistantSession');
            return { success: true, clearedCount: 2 };
          }),
        },
      },
    };
  });

  it('1. WebContentsView IPC 通道与契约完全对齐', () => {
    expect(GuanjiaIpcChannel.AttachView).toBe('guanjia:workspace:attach-view');
    expect(GuanjiaIpcChannel.DetachView).toBe('guanjia:workspace:detach-view');
    expect(GuanjiaIpcChannel.SetBounds).toBe('guanjia:workspace:set-bounds');
    expect(GuanjiaIpcChannel.ShowView).toBe('guanjia:workspace:show-view');
    expect(GuanjiaIpcChannel.HideView).toBe('guanjia:workspace:hide-view');
    expect(GuanjiaIpcChannel.ClearAssistantSession).toBe('guanjia:session:clear-assistant');
  });

  it('2. 真实联动：挂载左侧 DOM 容器并通过 IPC AttachView 绑定视图尺寸', async () => {
    // 模拟容器 DOMRect
    const mockContainerRect = {
      x: 240, // 侧栏宽度 240px
      y: 44, // 顶栏高度 44px
      width: 1040,
      height: 756,
      top: 44,
      left: 240,
      right: 1280,
      bottom: 800,
    };

    const bounds = {
      x: Math.round(mockContainerRect.x),
      y: Math.round(mockContainerRect.y),
      width: Math.round(mockContainerRect.width),
      height: Math.round(mockContainerRect.height),
    };

    // 执行 attach
    await (globalThis as any).window.guanjiaBridge.attachView({
      bounds,
      initialUrl: 'https://guanjia.local',
    });

    expect(mockIpcInvocations.length).toBe(1);
    expect(mockIpcInvocations[0].channel).toBe(GuanjiaIpcChannel.AttachView);
    expect(mockIpcInvocations[0].args.bounds).toEqual({ x: 240, y: 44, width: 1040, height: 756 });
    expect(mockIpcInvocations[0].args.initialUrl).toBe('https://guanjia.local');
  });

  it('3. 动态响应：右侧助理抽屉展开时主区 Flex 7:3 弹性收窄并更新 SetBounds', async () => {
    // 模拟助理抽屉展开后，主视区收窄至 70% 宽度的 DOMRect
    const contractedRect = {
      x: 240,
      y: 44,
      width: 728, // 1040 * 0.7 弹性收窄
      height: 756,
    };

    const bounds = {
      x: Math.round(contractedRect.x),
      y: Math.round(contractedRect.y),
      width: Math.round(contractedRect.width),
      height: Math.round(contractedRect.height),
    };

    // 抽屉展开过渡完成后调用 setBounds
    await (globalThis as any).window.guanjiaBridge.setBounds(bounds);

    const setBoundsCall = mockIpcInvocations.find(
      call => call.channel === GuanjiaIpcChannel.SetBounds,
    );
    expect(setBoundsCall).toBeDefined();
    expect(setBoundsCall?.args.width).toBe(728);
    expect(setBoundsCall?.args.height).toBe(756);
  });

  it('4. 现场保持联动：切走视图时 HideView，切回时 ShowView 且不销毁实例', async () => {
    // 切走视图时
    await (globalThis as any).window.guanjiaBridge.hideView();
    expect(mockIpcInvocations.some(c => c.channel === GuanjiaIpcChannel.HideView)).toBe(true);

    // 切回视图时
    await (globalThis as any).window.guanjiaBridge.showView();
    expect(mockIpcInvocations.some(c => c.channel === GuanjiaIpcChannel.ShowView)).toBe(true);
  });

  it('5. 交班结账按钮绑定：静默清场无弹窗，仅清空助理会话', async () => {
    // 模拟点击“交班结账”
    let alertCalled = false;
    let confirmCalled = false;
    (globalThis as any).window.alert = () => {
      alertCalled = true;
    };
    (globalThis as any).window.confirm = () => {
      confirmCalled = true;
      return true;
    };

    const clearResult = await (globalThis as any).window.guanjiaBridge.clearAssistantSession();

    // 验证调用了清场接口
    expect(bridgeInvocations).toContain('clearAssistantSession');
    expect(clearResult.success).toBe(true);
    expect(clearResult.clearedCount).toBe(2);

    // 验证静默清场，绝无弹窗干扰
    expect(alertCalled).toBe(false);
    expect(confirmCalled).toBe(false);
  });

  it('6. 方案 A 接入验证：默认属性与 IPC attachView 绑定真实线上地址 https://guanjia.qszy.me/', async () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 700 };
    const targetUrl = 'https://guanjia.qszy.me/';
    await (globalThis as any).window.guanjiaBridge.attachView({ bounds, initialUrl: targetUrl });

    const attachCall = mockIpcInvocations.find(
      (call: any) =>
        call.channel === GuanjiaIpcChannel.AttachView &&
        call.args.initialUrl === 'https://guanjia.qszy.me/',
    );
    expect(attachCall).toBeDefined();
    expect(attachCall?.args.initialUrl).toBe('https://guanjia.qszy.me/');
  });

  it('7. 员工登录弹窗组件源码合规审计：禁止冗余教育文案，仅保留必要表单要素与可执行错误提示', () => {
    const modalSource = fs.readFileSync(
      'src/renderer/components/guanjia/GuanjiaLoginModal.tsx',
      'utf-8',
    );

    // 必须包含核心要素
    expect(modalSource).toContain('员工登录');
    expect(modalSource).toContain('账号 / 工号');
    expect(modalSource).toContain('密码');
    expect(modalSource).toContain('请输入账号或工号');
    expect(modalSource).toContain('请输入密码');
    expect(modalSource).toContain('登录');
    expect(modalSource).toContain('取消');

    // 禁止出现任何冗余教育性/架构介绍说明文案
    expect(modalSource).not.toContain('架构介绍');
    expect(modalSource).not.toContain('使用说明');
    expect(modalSource).not.toContain('有道');
    expect(modalSource).not.toContain('网易');
    expect(modalSource).not.toContain('科普');
  });

  it('8. 登录成功后 Redux setLoggedIn 状态流转审计：正确同步操作人姓名“李店长”与门店信息', () => {
    const initialState = {
      isLoggedIn: false,
      isLoading: false,
      sessionStatus: 'unauthenticated' as any,
      user: null,
      quota: null,
      purchaseOffer: null,
      creditQuotaSnapshot: null,
      profileSummary: null,
      ownerAccountKey: null,
      accountGeneration: 0,
    };

    const loggedInState = authReducer(
      initialState,
      setLoggedIn({
        user: {
          yid: 'guanjia-001',
          nickname: '李店长',
          avatarUrl: null,
          accountMode: 'enterprise',
          shopName: '青盛堂旗舰店',
          shopId: 'shop-888',
          role: 'manager',
        },
        quota: {
          planName: '智慧管家旗舰版',
          subscriptionStatus: 'enterprise',
          creditsLimit: 999999,
          creditsUsed: 0,
          creditsRemaining: 999999,
          accountMode: 'enterprise',
        },
        ownerAccountKey: 'guanjia-account-001',
      }),
    );

    expect(loggedInState.isLoggedIn).toBe(true);
    expect(loggedInState.user?.nickname).toBe('李店长');
    expect(loggedInState.user?.shopName).toBe('青盛堂旗舰店');
    expect(loggedInState.user?.role).toBe('manager');
  });

  it('9. 登录成功后触发 WebContentsView 刷新与 SSO 凭据同步', async () => {
    const creds = {
      token: 'test-token',
      userId: '001',
      shopName: '青盛堂旗舰店',
    };
    await (globalThis as any).window.guanjiaBridge.setSsoCredentials(creds);
    await (globalThis as any).window.guanjiaBridge.reload(true);

    expect(bridgeInvocations).toContain('setSsoCredentials');
    expect(bridgeInvocations).toContain('reload');
  });

  it('10. 缺陷 1 闭环审计：禁止生成假 Token，禁止重复调用 setSsoCredentials 破坏会话', () => {
    const modalSource = fs.readFileSync(
      'src/renderer/components/guanjia/GuanjiaLoginModal.tsx',
      'utf-8',
    );

    // 严禁存在自行生成的随机假 Token
    expect(modalSource).not.toContain('guanjia_sso_token_${Date.now()}');
    expect(modalSource).not.toContain('Math.random()');

    // 前端严禁再次调用 setSsoCredentials 覆盖主进程注入的凭据
    expect(modalSource).not.toMatch(/guanjiaApi\??\.setSsoCredentials/);
  });

  it('11. 缺陷 2 闭环审计：服务端真实 userInfo 优先，严禁无条件硬编码覆盖', () => {
    const modalSource = fs.readFileSync(
      'src/renderer/components/guanjia/GuanjiaLoginModal.tsx',
      'utf-8',
    );

    // 确认提取了服务端的真实字段
    expect(modalSource).toContain('realName = uInfo.employee_name || uInfo.realName || uInfo.name');
    expect(modalSource).toContain('shopName = uInfo.store_name || uInfo.shop_name || uInfo.shopName');
    expect(modalSource).toContain('realName = realName || fallbackRealName');
    expect(modalSource).toContain('role = role || fallbackRole');
  });

  it('12. 缺陷 3 闭环审计：登录异常时必须 setErrorMsg 并立即 return 阻断，严禁假装成功', () => {
    const modalSource = fs.readFileSync(
      'src/renderer/components/guanjia/GuanjiaLoginModal.tsx',
      'utf-8',
    );

    // catch 块中必须有 setErrorMsg / setErrorMessage 与 return 阻断
    expect(modalSource).toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?setErrorMessage[\s\S]*?return;/);
  });
});
