import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const cookieSetMock = mock(async (_cookie: any) => {});
const cookieRemoveMock = mock(async (_url: string, _name: string) => {});

const sessionMock = {
  setPermissionRequestHandler: mock((_cb) => {}),
  cookies: {
    set: cookieSetMock,
    remove: cookieRemoveMock,
  },
};

const executeJsMock = mock(async (_code: string) => ({ success: true }));

const ipcHandlers = new Map<string, (...args: any[]) => any>();
const ipcMainMock = {
  handle: mock((channel: string, handler: (...args: any[]) => any) => {
    ipcHandlers.set(channel, handler);
  }),
  on: mock((channel: string, handler: (...args: any[]) => any) => {
    ipcHandlers.set(channel, handler);
  }),
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
      getURL: () => 'https://guanjia.qszy.me/',
      getTitle: () => '智慧管家',
      loadURL: mock(() => {}),
      reload: mock(() => {}),
      reloadIgnoringCache: mock(() => {}),
      on: mock(() => {}),
      executeJavaScript: executeJsMock,
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
  ipcMain: ipcMainMock,
};

mock.module('electron', () => electronMock);

let GuanjiaWorkspaceManager: any;
let registerGuanjiaIpcHandlers: any;
let GuanjiaIpcChannel: any;

beforeAll(async () => {
  const wsMod = await import('./guanjiaWorkspaceManager');
  GuanjiaWorkspaceManager = wsMod.GuanjiaWorkspaceManager;

  const ipcMod = await import('./ipcHandlers');
  registerGuanjiaIpcHandlers = ipcMod.registerGuanjiaIpcHandlers;

  const typesMod = await import('./types');
  GuanjiaIpcChannel = typesMod.GuanjiaIpcChannel;

  registerGuanjiaIpcHandlers();
});

beforeEach(() => {
  cookieSetMock.mockClear();
  cookieRemoveMock.mockClear();
  executeJsMock.mockClear();
});

describe('Guanjia Auth & Session Direct Injection', () => {
  it('should reject invalid or missing login parameters', async () => {
    const loginHandler = ipcHandlers.get(GuanjiaIpcChannel.Login);
    expect(loginHandler).toBeDefined();

    // 空参数
    const res1 = await loginHandler!({}, null);
    expect(res1.success).toBe(false);
    expect(res1.error).toContain('参数无效');

    // 缺少密码
    const res2 = await loginHandler!({}, { account: 'admin', password: '' });
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('不能为空');

    // 缺少账号
    const res3 = await loginHandler!({}, { account: '   ', password: '123' });
    expect(res3.success).toBe(false);
    expect(res3.error).toContain('不能为空');
  });

  it('should handle server error response gracefully', async () => {
    const loginHandler = ipcHandlers.get(GuanjiaIpcChannel.Login);
    const originalFetch = globalThis.fetch;

    // 模拟服务端返回 401 错误
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: '工号或密码错误' }),
    })) as any;

    try {
      const res = await loginHandler!({}, { account: 'A001', password: 'wrongpassword' });
      expect(res.success).toBe(false);
      expect(res.error).toBe('工号或密码错误');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should successfully login, construct GuanjiaSsoCredentials and inject cookies and storage', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    // 创建活跃 view 以便测试 storage 注入
    manager.getOrCreateView();

    const loginHandler = ipcHandlers.get(GuanjiaIpcChannel.Login);
    const originalFetch = globalThis.fetch;

    // 模拟服务端真实接口成功返回
    globalThis.fetch = mock(async (url: any, options: any) => {
      expect(String(url)).toContain('/api/c/login');
      const body = JSON.parse(options.body);
      expect(body.employee_no).toBe('E8888');
      expect(body.password).toBe('mypassword123');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            token: 'test-guanjia-jwt-token-xyz',
            userInfo: {
              employee_id: 66,
              employee_no: 'E8888',
              employee_name: '王经理',
              role: 'manager',
              store_code: 'STORE_01',
              store_name: '青盛堂旗舰店',
            },
          },
        }),
      };
    }) as any;

    try {
      const res = await loginHandler!({}, { account: 'E8888', password: 'mypassword123' });
      expect(res.success).toBe(true);
      expect(res.data.token).toBe('test-guanjia-jwt-token-xyz');
      expect(res.data.userInfo.employee_name).toBe('王经理');
      expect(res.data.userInfo.role).toBe('manager');
      expect(res.data.userInfo.store_name).toBe('青盛堂旗舰店');

      // 验证主进程凭证已更新
      const ssoCreds = manager.getSsoCredentials();
      expect(ssoCreds).not.toBeNull();
      expect(ssoCreds?.token).toBe('test-guanjia-jwt-token-xyz');
      expect(ssoCreds?.userId).toBe('66');
      expect(ssoCreds?.username).toBe('E8888');
      expect(ssoCreds?.realName).toBe('王经理');
      expect(ssoCreds?.shopName).toBe('青盛堂旗舰店');
      expect(ssoCreds?.shopId).toBe('STORE_01');

      // 验证 session cookie 注入（至少包含 guanjia_token 与 token）
      expect(cookieSetMock).toHaveBeenCalled();
      const setCalls = cookieSetMock.mock.calls;
      const cookieNames = setCalls.map((call: any[]) => call[0].name);
      expect(cookieNames).toContain('guanjia_token');
      expect(cookieNames).toContain('token');

      // 验证活跃视图中执行了 Storage 写入
      expect(executeJsMock).toHaveBeenCalled();
      const jsCallArg = executeJsMock.mock.calls[0][0];
      expect(jsCallArg).toContain('guanjia_token');
      expect(jsCallArg).toContain('test-guanjia-jwt-token-xyz');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should logout and clear credentials, cookies and storage', async () => {
    const manager = GuanjiaWorkspaceManager.getInstance();
    const logoutHandler = ipcHandlers.get(GuanjiaIpcChannel.Logout);
    expect(logoutHandler).toBeDefined();

    const res = await logoutHandler!();
    expect(res.success).toBe(true);

    // 凭据已清空
    expect(manager.getSsoCredentials()).toBeNull();

    // cookies 已移除
    expect(cookieRemoveMock).toHaveBeenCalled();
    const removeCalls = cookieRemoveMock.mock.calls;
    const removedNames = removeCalls.map((call: any[]) => call[1]);
    expect(removedNames).toContain('guanjia_token');
    expect(removedNames).toContain('token');

    // Storage 已清空
    expect(executeJsMock).toHaveBeenCalled();
    const jsCallArg = executeJsMock.mock.calls[0][0];
    expect(jsCallArg).toContain('removeItem');
    expect(jsCallArg).toContain('guanjia_token');
  });
});
