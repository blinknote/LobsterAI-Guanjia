import { XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { localizeDesktopAuthError, useGuanjiaDesktopAuth } from '../../services/guanjiaDesktopAuth';
import { tGuanjia } from '../../services/guanjiaI18n';
import Modal from '../common/Modal';

export interface GuanjiaBindingModalProps {
  isOpen: boolean;
  mode: 'bind' | 'unbind';
  onClose: () => void;
  currentBoundEmployee?: {
    employeeNo: string;
    employeeName?: string;
  } | null;
  onBindSuccess?: () => void;
  onUnbindSuccess?: () => void;
}

/**
 * 智慧管家桌面专属账号绑定与解绑弹窗
 * - 遵从【禁止冗余教育性 UI 提示】：仅展示字段、状态/结果与可执行操作
 * - 绑定与登录结果分离呈现：绑定成功后尝试登录，登录失败时明确保留绑定成果并提供重试
 * - 解绑必须核验当前员工密码
 * - 键盘 Tab 焦点陷阱与关闭后焦点恢复
 */
export const GuanjiaBindingModal: React.FC<GuanjiaBindingModalProps> = ({
  isOpen,
  mode,
  onClose,
  currentBoundEmployee,
  onBindSuccess,
  onUnbindSuccess,
}) => {
  const { status, bind, unbind, loginBound } = useGuanjiaDesktopAuth();
  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingInBound, setIsLoggingInBound] = useState(false);
  const [bindSucceededLoginError, setBindSucceededLoginError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const employeeNoInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  // 打开时记录前置聚焦元素、聚焦初始输入框、清理状态
  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement | null;
      setErrorMessage('');
      setBindSucceededLoginError(null);
      setIsSubmitting(false);
      setIsLoggingInBound(false);
      setPassword('');
      if (mode === 'unbind') {
        setEmployeeNo(currentBoundEmployee?.employeeNo || '');
        const timer = window.setTimeout(() => {
          passwordInputRef.current?.focus();
        }, 60);
        return () => window.clearTimeout(timer);
      } else {
        setEmployeeNo('');
        const timer = window.setTimeout(() => {
          employeeNoInputRef.current?.focus();
        }, 60);
        return () => window.clearTimeout(timer);
      }
    }
  }, [isOpen, mode, currentBoundEmployee]);

  // 关闭时恢复焦点
  const handleClose = useCallback(() => {
    setPassword('');
    setEmployeeNo('');
    setErrorMessage('');
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

  // 仅重试静默登录（绑定已成功的情景）
  const handleRetryLoginBound = useCallback(async () => {
    if (isLoggingInBound) return;
    const startHostGen = status.hostGeneration;
    setIsLoggingInBound(true);
    setErrorMessage('');
    try {
      const loginRes = await loginBound();
      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }
      if (loginRes.success) {
        onBindSuccess?.();
        handleClose();
      } else {
        setBindSucceededLoginError(localizeDesktopAuthError(loginRes.error || tGuanjia('guanjiaLoginBoundFailed')));
      }
    } catch (err) {
      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }
      setBindSucceededLoginError(localizeDesktopAuthError(err));
    } finally {
      if (mountedRef.current) {
        setIsLoggingInBound(false);
      }
    }
  }, [isLoggingInBound, loginBound, onBindSuccess, handleClose, status.hostGeneration]);

  // 提交绑定逻辑
  const handleSubmitBind = useCallback(async () => {
    const trimmedEmpNo = employeeNo.trim();
    if (!trimmedEmpNo) {
      setErrorMessage(tGuanjia('guanjiaAccountRequired'));
      employeeNoInputRef.current?.focus();
      return;
    }
    if (!password) {
      setErrorMessage(tGuanjia('guanjiaPasswordRequired'));
      passwordInputRef.current?.focus();
      return;
    }

    const currentPassword = password;
    setPassword(''); // 提交时立即清空密码字符串
    const startHostGen = status.hostGeneration;
    setIsSubmitting(true);
    setErrorMessage('');
    setBindSucceededLoginError(null);

    try {
      // 步骤 1: 提交绑定关系
      const bindRes = await bind({
        employeeNo: trimmedEmpNo,
        password: currentPassword,
      });

      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }

      if (!bindRes.success) {
        setErrorMessage(localizeDesktopAuthError(bindRes.error));
        setIsSubmitting(false);
        return;
      }

      // 步骤 2: 绑定成功后另起交换尝试登录，分离结果呈现
      setIsLoggingInBound(true);
      setIsSubmitting(false);
      try {
        const loginRes = await loginBound();
        if (!mountedRef.current || status.hostGeneration !== startHostGen) {
          return;
        }
        if (loginRes.success) {
          onBindSuccess?.();
          handleClose();
        } else {
          setBindSucceededLoginError(localizeDesktopAuthError(loginRes.error || tGuanjia('guanjiaLoginBoundFailed')));
        }
      } catch (loginErr) {
        if (!mountedRef.current || status.hostGeneration !== startHostGen) {
          return;
        }
        setBindSucceededLoginError(
          localizeDesktopAuthError(loginErr),
        );
      } finally {
        if (mountedRef.current) {
          setIsLoggingInBound(false);
        }
      }
    } catch (err) {
      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }
      setErrorMessage(localizeDesktopAuthError(err));
      setIsSubmitting(false);
      setIsLoggingInBound(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [employeeNo, password, bind, loginBound, onBindSuccess, handleClose, status.hostGeneration]);

  // 提交解绑逻辑
  const handleSubmitUnbind = useCallback(async () => {
    if (!password) {
      setErrorMessage(tGuanjia('guanjiaVerifyPasswordRequired'));
      passwordInputRef.current?.focus();
      return;
    }

    const currentPassword = password;
    setPassword(''); // 提交时立即清空密码字符串
    const startHostGen = status.hostGeneration;
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const unbindRes = await unbind({ password: currentPassword });
      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }
      if (!unbindRes.success) {
        setErrorMessage(localizeDesktopAuthError(unbindRes.error));
        return;
      }
      onUnbindSuccess?.();
      handleClose();
    } catch (err) {
      if (!mountedRef.current || status.hostGeneration !== startHostGen) {
        return;
      }
      setErrorMessage(localizeDesktopAuthError(err));
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false);
      }
    }
  }, [password, unbind, onUnbindSuccess, handleClose, status.hostGeneration]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isLoggingInBound) return;
    if (bindSucceededLoginError) {
      void handleRetryLoginBound();
      return;
    }
    if (mode === 'unbind') {
      void handleSubmitUnbind();
    } else {
      void handleSubmitBind();
    }
  };

  if (!isOpen) return null;

  const modalTitle = mode === 'unbind' ? tGuanjia('guanjiaUnbindTitle') : tGuanjia('guanjiaBindTitle');

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
          <h2 className="text-base font-semibold text-foreground">{modalTitle}</h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting || isLoggingInBound}
            aria-label={tGuanjia('guanjiaClose')}
            className="rounded p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <XMarkIcon aria-hidden="true" role="presentation" className="h-4 w-4" />
          </button>
        </div>

        {/* 表单区域 */}
        <form onSubmit={handleFormSubmit} className="flex flex-col gap-4">
          {/* 绑定模式：工号与密码输入 */}
          {mode === 'bind' && (
            <>
              <div className="flex flex-col gap-1.5 text-left">
                <label htmlFor="guanjia-bind-employee-no" className="text-xs font-medium text-foreground">
                  {tGuanjia('guanjiaEmployeeNo')}
                </label>
                <input
                  id="guanjia-bind-employee-no"
                  ref={employeeNoInputRef}
                  type="text"
                  value={employeeNo}
                  onChange={e => {
                    setEmployeeNo(e.target.value);
                    if (errorMessage) setErrorMessage('');
                  }}
                  disabled={isSubmitting || isLoggingInBound || Boolean(bindSucceededLoginError)}
                  placeholder={tGuanjia('guanjiaAccountRequired')}
                  aria-required="true"
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
              </div>

              <div className="flex flex-col gap-1.5 text-left">
                <label htmlFor="guanjia-bind-password" className="text-xs font-medium text-foreground">
                  {tGuanjia('guanjiaPassword')}
                </label>
                <input
                  id="guanjia-bind-password"
                  ref={passwordInputRef}
                  type="password"
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage('');
                  }}
                  disabled={isSubmitting || isLoggingInBound || Boolean(bindSucceededLoginError)}
                  placeholder={tGuanjia('guanjiaPasswordRequired')}
                  aria-required="true"
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
              </div>
            </>
          )}

          {/* 解绑模式：显示当前绑定员工，输入密码确认 */}
          {mode === 'unbind' && (
            <>
              <div className="flex flex-col gap-1 text-left rounded-md bg-surface-raised p-2.5">
                <div className="text-xs text-secondary">{tGuanjia('guanjiaBoundEmployee')}</div>
                <div className="text-sm font-semibold text-foreground">
                  {currentBoundEmployee?.employeeNo || employeeNo}
                  {currentBoundEmployee?.employeeName ? ` (${currentBoundEmployee.employeeName})` : ''}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 text-left">
                <label htmlFor="guanjia-unbind-password" className="text-xs font-medium text-foreground">
                  {tGuanjia('guanjiaVerifyPassword')}
                </label>
                <input
                  id="guanjia-unbind-password"
                  ref={passwordInputRef}
                  type="password"
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                  placeholder={tGuanjia('guanjiaVerifyPasswordRequired')}
                  aria-required="true"
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-secondary/60 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-50"
                />
              </div>
            </>
          )}

          {/* 绑定成功但静默登录失败时的独立结果与重试区 */}
          {bindSucceededLoginError && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-left">
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {tGuanjia('guanjiaBindSuccess')}
              </div>
              <div role="alert" aria-live="assertive" className="text-xs text-amber-700 dark:text-amber-300">
                {`${tGuanjia('guanjiaBindSuccessLoginFailed')}: ${bindSucceededLoginError}`}
              </div>
            </div>
          )}

          {/* 可执行错误提示 */}
          {errorMessage && (
            <div role="alert" aria-live="assertive" className="text-xs font-medium text-red-500 text-left">
              {errorMessage}
            </div>
          )}

          {/* 底部操作按钮 */}
          <div className="mt-2 flex items-center justify-end gap-2.5">
            {bindSucceededLoginError ? (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  {tGuanjia('guanjiaDone')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRetryLoginBound()}
                  disabled={isLoggingInBound}
                  className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isLoggingInBound ? tGuanjia('guanjiaLoggingInBound') : tGuanjia('guanjiaRetryLogin')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting || isLoggingInBound}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-surface px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {tGuanjia('guanjiaCancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || isLoggingInBound}
                  className={`inline-flex h-8 items-center justify-center rounded-md px-4 text-xs font-medium shadow-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    mode === 'unbind'
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {isSubmitting
                    ? mode === 'unbind'
                      ? tGuanjia('guanjiaUnbinding')
                      : tGuanjia('guanjiaBinding')
                    : isLoggingInBound
                      ? tGuanjia('guanjiaLoggingInBound')
                      : mode === 'unbind'
                        ? tGuanjia('guanjiaUnbindAction')
                        : tGuanjia('guanjiaBindAction')}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default GuanjiaBindingModal;
