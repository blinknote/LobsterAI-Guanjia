import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { localizeDesktopAuthError } from '../../services/guanjiaDesktopAuth';
import { tGuanjia } from '../../services/guanjiaI18n';
import { useGuanjiaSession } from '../../services/guanjiaSession';
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
 * - 遵从【禁止冗余教育性 UI 提示】：仅展示必要元素
 * - 支持键盘 Enter 快捷提交，ESC 关闭
 * - 接入真实业务会话 useGuanjiaSession，严禁任何 mock 数据与虚构配额
 */
export const GuanjiaLoginModal: React.FC<GuanjiaLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const { login, generation } = useGuanjiaSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 打开时记录前置聚焦元素、自动聚焦账号输入框，并清理错误提示
  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement | null;
      setErrorMessage('');
      setPassword('');
      const timer = window.setTimeout(() => {
        usernameInputRef.current?.focus();
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen]);

  // 关闭时恢复前置焦点
  const handleClose = useCallback(() => {
    setPassword('');
    setErrorMessage('');
    setUsername('');
    onClose();
    window.setTimeout(() => {
      triggerElementRef.current?.focus();
    }, 50);
  }, [onClose]);

  // 焦点陷阱：Tab 键在弹窗内循环
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusableElements.length > 0) {
          const firstElement = focusableElements[0];
          const lastElement = focusableElements[focusableElements.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === firstElement) {
              e.preventDefault();
              lastElement.focus();
            }
          } else {
            if (document.activeElement === lastElement) {
              e.preventDefault();
              firstElement.focus();
            }
          }
        }
      }
    },
    [],
  );

  // 提交登录逻辑
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      if (isSubmitting) return;

      const trimmedUsername = username.trim();
      if (!trimmedUsername) {
        setErrorMessage(tGuanjia('guanjiaAccountRequired'));
        usernameInputRef.current?.focus();
        return;
      }

      if (!password) {
        setErrorMessage(tGuanjia('guanjiaPasswordRequired'));
        return;
      }

      const currentPassword = password;
      setPassword(''); // 提交时立即清空密码字符串
      const startGen = generation;
      setIsSubmitting(true);
      setErrorMessage('');

      try {
        const snapshot = await login({
          account: trimmedUsername,
          password: currentPassword,
        });

        if (!mountedRef.current || snapshot.generation < startGen) {
          return;
        }

        if (snapshot.status !== 'authenticated' || !snapshot.user) {
          setErrorMessage(localizeDesktopAuthError(snapshot.error || tGuanjia('guanjiaLoginFailed')));
          return;
        }

        onLoginSuccess?.({
          username: snapshot.user.employeeNo,
          realName: snapshot.user.name || snapshot.user.employeeNo,
          role: snapshot.user.role,
          shopName: snapshot.store?.name || '',
          shopId: snapshot.store ? String(snapshot.store.id) : '',
        });

        handleClose();
      } catch (err: unknown) {
        if (!mountedRef.current) {
          return;
        }
        setErrorMessage(localizeDesktopAuthError(err));
      } finally {
        if (mountedRef.current) {
          setIsSubmitting(false);
        }
      }
    },
    [username, password, isSubmitting, login, generation, onLoginSuccess, handleClose],
  );

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onEscape={handleClose}
      className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl transition-all"
    >
      <div ref={modalRef} onKeyDown={handleKeyDown} className="relative flex flex-col">
        {/* 头部：标题与关闭按钮 */}
        <div className="flex items-center justify-between pb-4">
          <h2 className="text-base font-semibold text-foreground">{tGuanjia('guanjiaEmployeeLogin')}</h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label={tGuanjia('guanjiaClose')}
            className="rounded p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <XMarkIcon aria-hidden="true" role="presentation" className="h-4 w-4" />
          </button>
        </div>

        {/* 表单区域 */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* 账号/工号输入框 */}
          <div className="flex flex-col gap-1.5 text-left">
            <label htmlFor="guanjia-username" className="text-xs font-medium text-foreground">
              {tGuanjia('guanjiaAccount')}
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
              placeholder={tGuanjia('guanjiaAccountRequired')}
              aria-required="true"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
          </div>

          {/* 密码输入框 */}
          <div className="flex flex-col gap-1.5 text-left">
            <label htmlFor="guanjia-password" className="text-xs font-medium text-foreground">
              {tGuanjia('guanjiaPassword')}
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
              placeholder={tGuanjia('guanjiaPasswordRequired')}
              aria-required="true"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
          </div>

          {/* 可执行错误提示 */}
          {errorMessage && (
            <div role="alert" aria-live="assertive" className="text-xs font-medium text-red-500 text-left">
              {errorMessage}
            </div>
          )}

          {/* 操作按钮组 */}
          <div className="mt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {tGuanjia('guanjiaCancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? tGuanjia('guanjiaLoggingIn') : tGuanjia('guanjiaLogin')}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default GuanjiaLoginModal;
