import { contextBridge, ipcRenderer } from 'electron';

import type { RegisterBusinessTokenParams } from '../../shared/guanjia/desktopAuth';
import { GuanjiaNativeIpcChannel, OpenAssistantParams, ReportSessionEventParams } from '../../shared/guanjia/native';
import {
  GuanjiaActionRequest,
  GuanjiaActionResult,
  GuanjiaIpcChannel,
  GuanjiaSsoCredentials,
  GuanjiaWorkspaceContext,
} from './types';

// =========================================================================
// 1. document-start: 免密注入 SSO 凭证
// =========================================================================
let cachedSsoCredentials: GuanjiaSsoCredentials | null = null;
try {
  cachedSsoCredentials = ipcRenderer.sendSync(GuanjiaIpcChannel.GetSsoCredentialsSync);
} catch {
  // IPC 同步获取失败时优雅降级
}

window.addEventListener('guanjia:auth-expired', () => { cachedSsoCredentials = null; });
window.addEventListener('guanjia:host-session-cleared', () => { cachedSsoCredentials = null; });

if (cachedSsoCredentials && cachedSsoCredentials.token) {
  try {
    const applyStorageCredentials = () => {
      try {
        const isHttpsOrLocal = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (isHttpsOrLocal && window.sessionStorage && cachedSsoCredentials) {
          window.sessionStorage.setItem('guanjia_token', cachedSsoCredentials.token);
          if (cachedSsoCredentials.shopId) window.sessionStorage.setItem('guanjia_store_id', cachedSsoCredentials.shopId);
          else window.sessionStorage.removeItem('guanjia_store_id');
          if (cachedSsoCredentials.storeCode) window.sessionStorage.setItem('guanjia_store_code', cachedSsoCredentials.storeCode);
          else window.sessionStorage.removeItem('guanjia_store_code');
        }
      } catch {
        // Storage unavailable; no credential fallback.
      }
    };

    // document-start 立即尝试写入
    applyStorageCredentials();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyStorageCredentials, { once: true });
    } else {
      applyStorageCredentials();
    }
  } catch (err) {
    console.warn('[GuanjiaPreload] Failed to inject session credentials:', err);
  }
}

// =========================================================================
// 2. 禁止保存密码弹窗 (主世界/Preload 彻底覆盖重写 navigator.credentials.store 与 preventDefault 密码保存提示)
// =========================================================================
// 2.1 Preload 隔离世界重写
try {
  if (navigator.credentials) {
    navigator.credentials.store = () => Promise.resolve();
    navigator.credentials.create = () => Promise.resolve(null);
    navigator.credentials.preventSilentAccess = () => Promise.resolve();
  }
} catch {
  // 忽略防篡改抛错
}

// 2.2 在主世界中彻底覆盖重写 navigator.credentials.store 与 preventDefault 密码保存提示
const injectMainWorldPasswordShield = () => {
  try {
    const script = document.createElement('script');
    script.textContent = `
(function() {
  try {
    if (window.navigator && window.navigator.credentials) {
      window.navigator.credentials.store = function() { return Promise.resolve(); };
      window.navigator.credentials.create = function() { return Promise.resolve(null); };
      window.navigator.credentials.preventSilentAccess = function() { return Promise.resolve(); };
    }
  } catch (e) {}

  // 拦截密码表单事件并 preventDefault 阻止密码保存提示
  try {
    window.addEventListener('submit', function(e) {
      var form = e.target;
      if (form && form.querySelector && form.querySelector('input[type="password"]')) {
        var pwdInputs = form.querySelectorAll('input[type="password"]');
        for (var i = 0; i < pwdInputs.length; i++) {
          pwdInputs[i].setAttribute('autocomplete', 'new-password');
          pwdInputs[i].setAttribute('data-form-type', 'other');
        }
      }
    }, true);
  } catch (e) {}
})();
`;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(script);
      script.remove();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        try {
          const t = document.head || document.documentElement;
          if (t) {
            t.appendChild(script);
            script.remove();
          }
        } catch {
          // ignore
        }
      }, { once: true });
    }
  } catch {
    // DOM 挂载安全降级
  }
};

injectMainWorldPasswordShield();

// 监控页面密码框并禁用自动填充提示
const disablePasswordSavePrompt = () => {
  try {
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    passwordInputs.forEach((input) => {
      input.setAttribute('autocomplete', 'new-password');
      input.setAttribute('data-form-type', 'other');
    });
  } catch {
    // DOM 遍历安全降级
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', disablePasswordSavePrompt, { once: true });
} else {
  disablePasswordSavePrompt();
}

// =========================================================================
// 3. 只读上下文提取逻辑
// =========================================================================
function extractWorkspaceContext(): GuanjiaWorkspaceContext {
  // 提取页面错误提示
  let pageError: string | null = null;
  const errorSelectors = [
    '.ant-message-error',
    '.el-message--error',
    '.van-toast--fail',
    '.error-message',
    '.alert-danger',
    '[role="alert"]',
  ];
  for (const sel of errorSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent) {
      const text = el.textContent.trim();
      if (text) {
        pageError = text;
        break;
      }
    }
  }

  // 提取待办/告警数量
  let pendingCount: number | null = null;
  const badgeEl = document.querySelector('.pending-badge, .badge-count, .ant-badge-count, .el-badge__content');
  if (badgeEl && badgeEl.textContent) {
    const num = parseInt(badgeEl.textContent.trim(), 10);
    if (!Number.isNaN(num)) {
      pendingCount = num;
    }
  }

  // 用户与门店信息
  const currentUser = cachedSsoCredentials
    ? {
        id: cachedSsoCredentials.userId,
        name: cachedSsoCredentials.realName || cachedSsoCredentials.username,
        role: cachedSsoCredentials.role,
        shopName: cachedSsoCredentials.shopName,
      }
    : null;

  const currentShop = cachedSsoCredentials?.shopId
    ? {
        id: cachedSsoCredentials.shopId,
        name: cachedSsoCredentials.shopName,
      }
    : null;

  return {
    currentUrl: window.location.href,
    pathname: window.location.pathname,
    pageTitle: document.title || '智慧管家',
    currentUser,
    currentShop,
    pageError,
    pendingCount,
    timestamp: Date.now(),
  };
}

// =========================================================================
// 4. 动账动作判定与拦截逻辑 (统一引用 types.ts 中的判定函数与集合)
// =========================================================================
async function handleExecuteAction(action: GuanjiaActionRequest): Promise<GuanjiaActionResult> {
  return { success: false, actionType: action.type, error: '旧页面动作执行接口已停用' };
}

// =========================================================================
// 5. 暴露 Bridge (只读上下文 + 动作执行 + 交班清场)
// =========================================================================
const guanjiaBridge = {
  getCapabilities: async () => {
    return ipcRenderer.invoke(GuanjiaNativeIpcChannel.GetCapabilities);
  },

  openAssistant: async (params: OpenAssistantParams) => {
    return ipcRenderer.invoke(GuanjiaNativeIpcChannel.OpenAssistant, params);
  },

  reportSessionEvent: async (params: ReportSessionEventParams) => {
    return ipcRenderer.invoke(GuanjiaNativeIpcChannel.ReportSessionEvent, params);
  },

  getDesktopAuthStatus: async () => {
    return ipcRenderer.invoke(GuanjiaIpcChannel.DesktopAuthGetStatus);
  },

  registerBusinessToken: async (params: RegisterBusinessTokenParams) => {
    return ipcRenderer.invoke(GuanjiaIpcChannel.DesktopAuthRegisterBusinessToken, params);
  },

  /**
   * 只读上下文提取：仅提供页面当前状态读取，不可修改任何数据
   */
  getWorkspaceContext: (): GuanjiaWorkspaceContext => {
    return extractWorkspaceContext();
  },
  readContext: (): GuanjiaWorkspaceContext => {
    return extractWorkspaceContext();
  },

  /**
   * 动作执行 Bridge：动账操作若无明确确认则会被强制拦截
   */
  executeAction: async (action: GuanjiaActionRequest): Promise<GuanjiaActionResult> => {
    return handleExecuteAction(action);
  },

  /**
   * 交班清场 Bridge：交班或退出时静默清空助理会话，不弹窗，不动管家台账
   */
  clearAssistantSession: async (): Promise<{ success: boolean; clearedCount: number }> => {
    return ipcRenderer.invoke(GuanjiaIpcChannel.ClearAssistantSession);
  },
  onShiftHandover: async (): Promise<{ success: boolean; clearedCount: number }> => {
    return ipcRenderer.invoke(GuanjiaIpcChannel.ClearAssistantSession);
  },
};

// 通过 contextBridge 安全暴露到页面环境
contextBridge.exposeInMainWorld('guanjiaBridge', guanjiaBridge);

export type GuanjiaBridge = typeof guanjiaBridge;
