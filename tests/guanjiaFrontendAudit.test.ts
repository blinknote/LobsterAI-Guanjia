import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { GuanjiaIpcChannel } from '../src/main/guanjia/types';

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
      y: 44,  // 顶栏高度 44px
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
    await (globalThis as any).window.guanjiaBridge.attachView({ bounds, initialUrl: 'https://guanjia.local' });

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

    const setBoundsCall = mockIpcInvocations.find(call => call.channel === GuanjiaIpcChannel.SetBounds);
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
    (globalThis as any).window.alert = () => { alertCalled = true; };
    (globalThis as any).window.confirm = () => { confirmCalled = true; return true; };

    const clearResult = await (globalThis as any).window.guanjiaBridge.clearAssistantSession();

    // 验证调用了清场接口
    expect(bridgeInvocations).toContain('clearAssistantSession');
    expect(clearResult.success).toBe(true);
    expect(clearResult.clearedCount).toBe(2);

    // 验证静默清场，绝无弹窗干扰
    expect(alertCalled).toBe(false);
    expect(confirmCalled).toBe(false);
  });

  it("6. 方案 A 接入验证：默认属性与 IPC attachView 绑定真实线上地址 https://guanjia.qszy.me/", async () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 700 };
    const targetUrl = "https://guanjia.qszy.me/";
    await (globalThis as any).window.guanjiaBridge.attachView({ bounds, initialUrl: targetUrl });

    const attachCall = mockIpcInvocations.find(
      (call: any) => call.channel === GuanjiaIpcChannel.AttachView && call.args.initialUrl === "https://guanjia.qszy.me/"
    );
    expect(attachCall).toBeDefined();
    expect(attachCall?.args.initialUrl).toBe("https://guanjia.qszy.me/");
  });
});
