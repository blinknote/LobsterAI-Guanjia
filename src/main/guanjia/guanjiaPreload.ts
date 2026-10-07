import { contextBridge, ipcRenderer } from 'electron';
import {
  FINANCIAL_ACTION_TYPES,
  FinancialDetails,
  GuanjiaActionRequest,
  GuanjiaActionResult,
  GuanjiaIpcChannel,
  GuanjiaSsoCredentials,
  GuanjiaWorkspaceContext,
  isFinancialAction,
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

if (cachedSsoCredentials && cachedSsoCredentials.token) {
  try {
    // contextIsolation=true 下必须使用 contextBridge.exposeInMainWorld 暴露凭据到主世界
    contextBridge.exposeInMainWorld('__GUANJIA_SSO__', Object.freeze({ ...cachedSsoCredentials }));
  } catch (err) {
    console.warn('[GuanjiaPreload] Failed to expose __GUANJIA_SSO__ via contextBridge:', err);
  }

  try {
    // 同时在 Preload 隔离上下文挂载，保证 Preload 内部直接读取
    Object.defineProperty(window, '__GUANJIA_SSO__', {
      value: Object.freeze({ ...cachedSsoCredentials }),
      writable: false,
      configurable: false,
    });
  } catch {
    // 忽略定义失败
  }

  try {
    // 自动将 SSO token 及用户信息同步至 localStorage / sessionStorage
    const applyStorageCredentials = () => {
      try {
        if (window.localStorage && cachedSsoCredentials) {
          window.localStorage.setItem('guanjia_token', cachedSsoCredentials.token);
          window.localStorage.setItem('guanjia_sso_token', cachedSsoCredentials.token);
          window.localStorage.setItem('token', cachedSsoCredentials.token);
          window.localStorage.setItem('guanjia_user_id', cachedSsoCredentials.userId);
          window.localStorage.setItem('guanjia_shop_id', cachedSsoCredentials.shopId);
          window.localStorage.setItem('guanjia_shop_name', cachedSsoCredentials.shopName);
          window.localStorage.setItem('guanjia_user_role', cachedSsoCredentials.role);
        }
        if (window.sessionStorage && cachedSsoCredentials) {
          window.sessionStorage.setItem('guanjia_token', cachedSsoCredentials.token);
          window.sessionStorage.setItem('token', cachedSsoCredentials.token);
          window.sessionStorage.setItem('guanjia_sso_token', cachedSsoCredentials.token);
        }
      } catch {
        // storage 可能因策略暂时受限
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
    console.warn('[GuanjiaPreload] Failed to inject SSO credentials at document-start:', err);
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
        } catch (_) {
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
  let pendingCount = 0;
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

  const currentShop = cachedSsoCredentials
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
  const financial = isFinancialAction(action);
  const isConfirmed = Boolean(action.confirmed && action.confirmedBy && action.confirmedBy.trim());

  // 动账操作拦截：未确认或缺失 confirmedBy 前坚决硬拦截并报错，必须停下复述金额事由
  if (financial && !isConfirmed) {
    const details: FinancialDetails = action.financialDetails || {
      amount: '需核对金额',
      reason: '未注明事由',
      actionType: (action.type && FINANCIAL_ACTION_TYPES.has(action.type)) ? (action.type as any) : 'other',
    };

    // 通知主进程记录拦截状态
    ipcRenderer.invoke(GuanjiaIpcChannel.ExecuteAction, {
      action,
      intercepted: true,
      financialDetails: details,
    }).catch(() => {});

    const errorMsg = !action.confirmed
      ? `动账操作已拦截：必须向店员复述金额（${details.amount}）与事由（${details.reason}），等待明确确认后方可落定执行。`
      : `动账操作已拦截：动账确认人（confirmedBy）缺失或为空，坚决拦截。`;

    return {
      success: false,
      actionType: action.type,
      requiresConfirmation: true,
      financialDetails: details,
      message: errorMsg,
      error: !action.confirmed ? undefined : '动账确认人（confirmedBy）缺失或为空',
    };
  }

  // 执行实际 DOM 动作
  try {
    if (action.type === 'navigate' && action.url) {
      window.location.href = action.url;
      return { success: true, actionType: 'navigate', message: `已跳转至 ${action.url}` };
    }

    if (action.selector) {
      const targetEl = document.querySelector(action.selector) as HTMLElement | null;
      if (!targetEl) {
        return {
          success: false,
          actionType: action.type,
          error: `未找到目标元素: ${action.selector}`,
        };
      }

      if (action.type === 'click' || action.type === 'submit_order' || action.type === 'refund' || action.type === 'recharge') {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetEl.click();
      } else if (action.type === 'input') {
        if ('value' in targetEl && typeof action.value === 'string') {
          (targetEl as HTMLInputElement).value = action.value;
          targetEl.dispatchEvent(new Event('input', { bubbles: true }));
          targetEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    // 若为已确认的动账操作，上报主进程记录审计日志
    if (financial && isConfirmed) {
      await ipcRenderer.invoke(GuanjiaIpcChannel.ExecuteAction, {
        action,
        intercepted: false,
        executed: true,
      });
    }

    return {
      success: true,
      actionType: action.type,
      message: '动作执行成功',
    };
  } catch (error) {
    return {
      success: false,
      actionType: action.type,
      error: error instanceof Error ? error.message : '执行动作发生异常',
    };
  }
}

// =========================================================================
// 5. 暴露 Bridge (只读上下文 + 动作执行 + 交班清场)
// =========================================================================
const guanjiaBridge = {
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
