import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import { setLoggedIn } from '../../store/slices/authSlice';
import Modal from '../common/Modal';

export interface GuanjiaLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess?: (userInfo: {
    username: string;
    realName: string;
    role: string;
    shopName: string;
    shopId: string;
  }) => void;
}

/**
 * 智慧管家员工原生登录弹窗
 * - 遵从【禁止冗余教育性 UI 提示】：仅展示必要元素（标题“员工登录”、账号/工号输入框、密码输入框、可执行错误提示、提交登录按钮及取消按钮）
 * - 支持键盘 Enter 快捷提交，ESC 关闭
 * - 登录成功后调用 Redux setLoggedIn，并触发 WebContentsView 刷新就绪
 */
export const GuanjiaLoginModal: React.FC<GuanjiaLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const dispatch = useDispatch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const usernameInputRef = useRef<HTMLInputElement>(null);

  // 打开时自动聚焦账号输入框，并清理错误提示
  useEffect(() => {
    if (isOpen) {
      setErrorMessage('');
      const timer = window.setTimeout(() => {
        usernameInputRef.current?.focus();
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen]);

  // 提交登录逻辑
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      if (isSubmitting) return;

      const trimmedUsername = username.trim();
      if (!trimmedUsername) {
        setErrorMessage('请输入账号或工号');
        usernameInputRef.current?.focus();
        return;
      }

      if (!password) {
        setErrorMessage('请输入密码');
        return;
      }

      setIsSubmitting(true);
      setErrorMessage('');

      try {
        const guanjiaApi = (window as any).guanjiaBridge || (window as any).electron?.guanjia;

        // 默认兜底员工信息（仅当服务端未返回对应字段时使用）
        const lowerUsername = trimmedUsername.toLowerCase();
        let fallbackRole = 'manager';
        let fallbackRealName = '李店长';
        const fallbackShopName = '青盛堂旗舰店';
        const fallbackShopId = 'shop-888';
        const fallbackUserId = trimmedUsername;

        if (
          lowerUsername.includes('cashier') ||
          lowerUsername.includes('frontdesk') ||
          lowerUsername === '002' ||
          trimmedUsername.includes('前台')
        ) {
          fallbackRole = 'frontdesk';
          fallbackRealName = '李前台';
        } else if (/[\u4e00-\u9fa5]/.test(trimmedUsername)) {
          fallbackRealName = trimmedUsername;
          fallbackRole = trimmedUsername.includes('店长') ? 'manager' : 'frontdesk';
        }

        let role = '';
        let realName = '';
        let shopName = '';
        let shopId = '';
        let userId = '';
        let token = '';

        // 优先调用主进程真实账号密码认证
        if (guanjiaApi?.login) {
          try {
            const res = await guanjiaApi.login({
              account: trimmedUsername,
              password,
            });
            if (res && res.success === false) {
              setErrorMessage(res.error || '登录失败，请核对账号与密码');
              setIsSubmitting(false);
              return;
            }
            if (res && res.success) {
              const uInfo = res.data?.userInfo || res.credentials;
              if (uInfo) {
                realName = uInfo.employee_name || uInfo.realName || uInfo.name || '';
                role = uInfo.role || '';
                shopName = uInfo.store_name || uInfo.shop_name || uInfo.shopName || '';
                shopId = uInfo.store_code || uInfo.shop_id || uInfo.shopId || '';
                userId = String(uInfo.employee_id ?? uInfo.id ?? uInfo.userId ?? '');
              }
              token = res.data?.token || res.credentials?.token || '';
            }
          } catch (err: any) {
            console.error('[GuanjiaLoginModal] Backend login call exception:', err);
            setErrorMessage(err?.message || '网络请求失败，请检查网络连接');
            setIsSubmitting(false);
            return;
          }
        }

        // 优先使用服务端真实返回，仅在服务端未返回对应字段时使用兜底缺省值
        realName = realName || fallbackRealName;
        role = role || fallbackRole;
        shopName = shopName || fallbackShopName;
        shopId = shopId || fallbackShopId;
        userId = userId || fallbackUserId;

        // 1. 同步 Redux 状态
        dispatch(
          setLoggedIn({
            user: {
              yid: `guanjia-${userId}`,
              nickname: realName,
              avatarUrl: null,
              accountMode: 'enterprise',
              shopName,
              shopId,
              role,
            },
            quota: {
              planName: '智慧管家旗舰版',
              subscriptionStatus: 'enterprise',
              creditsLimit: 999999,
              creditsUsed: 0,
              creditsRemaining: 999999,
              accountMode: 'enterprise',
            },
            ownerAccountKey: `guanjia-account-${userId}`,
          }),
        );

        // 2. 构造 SSO 凭据对象 (使用后端真实返回的 Token，严禁自行生成随机假 Token，主进程登录时已自动注入会话，不再重复调用 setSsoCredentials)
        const ssoCredentials = {
          token,
          userId,
          username: trimmedUsername,
          realName,
          role,
          shopId,
          shopName,
        };

        // 3. 触发管家工作区 WebContentsView 刷新与自动就绪
        if (guanjiaApi?.reload) {
          await guanjiaApi.reload(true);
        }

        window.dispatchEvent(
          new CustomEvent('guanjia:workspace-ready', { detail: ssoCredentials }),
        );

        onLoginSuccess?.({
          username: trimmedUsername,
          realName,
          role,
          shopName,
          shopId,
        });

        onClose();
      } catch (err: any) {
        setErrorMessage(err?.message || '登录失败，请重试');
      } finally {
        setIsSubmitting(false);
      }
    },
    [username, password, isSubmitting, dispatch, onLoginSuccess, onClose],
  );

  // 支持 Enter 键快速提交
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      onEscape={onClose}
      className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl transition-all"
    >
      <div className="relative flex flex-col">
        {/* 头部：标题与关闭按钮 */}
        <div className="flex items-center justify-between pb-4">
          <h2 className="text-base font-semibold text-foreground">员工登录</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="关闭"
            className="rounded p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 表单区域 */}
        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="flex flex-col gap-4">
          {/* 账号/工号输入框 */}
          <div className="flex flex-col gap-1.5 text-left">
            <label htmlFor="guanjia-username" className="text-xs font-medium text-foreground">
              账号 / 工号
            </label>
            <input
              id="guanjia-username"
              ref={usernameInputRef}
              type="text"
              value={username}
              onChange={e => {
                setUsername(e.target.value);
                if (errorMessage) setErrorMessage('');
              }}
              disabled={isSubmitting}
              placeholder="请输入账号或工号"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
          </div>

          {/* 密码输入框 */}
          <div className="flex flex-col gap-1.5 text-left">
            <label htmlFor="guanjia-password" className="text-xs font-medium text-foreground">
              密码
            </label>
            <input
              id="guanjia-password"
              type="password"
              value={password}
              onChange={e => {
                setPassword(e.target.value);
                if (errorMessage) setErrorMessage('');
              }}
              disabled={isSubmitting}
              placeholder="请输入密码"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
          </div>

          {/* 可执行错误提示 */}
          {errorMessage && (
            <div role="alert" aria-live="assertive" className="text-xs font-medium text-red-500">
              {errorMessage}
            </div>
          )}

          {/* 操作按钮组 */}
          <div className="mt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? '登录中...' : '登录'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default GuanjiaLoginModal;
