import type { GuanjiaSessionSnapshot, GuanjiaSessionStatus } from './native';

export type { GuanjiaSessionSnapshot, GuanjiaSessionStatus };

/**
 * 智慧管家桌面专属官方账号绑定状态
 */
export type GuanjiaDesktopBindingState =
  | 'unbound'
  | 'bound'
  | 'requires_reverification'
  | 'not_checked'
  | 'unavailable';

/**
 * 绑定的管家员工摘要信息 (无凭据)
 */
export interface GuanjiaDesktopBindingInfo {
  bindingId?: string;
  tenantId?: string | number;
  employeeId?: number;
  employeeNo: string;
  employeeName?: string;
  boundAt?: number | string;
}

/**
 * 桌面端权威认证与绑定综合状态快照 (严格无 Token)
 */
export interface GuanjiaDesktopAuthStatus {
  officialAuthenticated: boolean;
  officialUserId?: string;
  bindingState: GuanjiaDesktopBindingState;
  binding?: GuanjiaDesktopBindingInfo | null;
  businessSessionStatus: GuanjiaSessionStatus;
  businessEmployeeNo?: string;
  businessEmployeeName?: string;
  hostGeneration: number;
  logoutSuppressed?: boolean;
  error?: string;
}

/**
 * 首次自助绑定请求参数
 */
export interface GuanjiaDesktopAuthBindParams {
  employeeNo: string;
  password: string;
}

/**
 * 首次自助绑定结果 (仅返回绑定关系，不直接登录)
 */
export interface GuanjiaDesktopAuthBindResult {
  success: boolean;
  bindingState?: GuanjiaDesktopBindingState;
  binding?: GuanjiaDesktopBindingInfo | null;
  error?: string;
}

/**
 * 桌面自助解绑请求参数 (需验证当前绑定员工密码)
 */
export interface GuanjiaDesktopAuthUnbindParams {
  password: string;
}

/**
 * 桌面自助解绑结果
 */
export interface GuanjiaDesktopAuthUnbindResult {
  success: boolean;
  unbound: boolean;
  error?: string;
}

/**
 * 静默登录已绑定账号结果
 */
export interface GuanjiaDesktopAuthLoginResult {
  success: boolean;
  session?: GuanjiaSessionSnapshot;
  error?: string;
}

/**
 * 内嵌网页端单向受信凭证登记参数
 */
export interface RegisterBusinessTokenParams {
  token: string;
  source: 'password' | 'restoration';
  hostGeneration?: number;
  operationId?: string;
  adopt?: boolean;
}

/**
 * 内嵌网页端单向受信凭证登记结果
 */
export interface RegisterBusinessTokenResult {
  success: boolean;
  registered?: boolean;
  adopted?: boolean;
  operationId?: string;
  startingHostGeneration?: number;
  hostGeneration?: number;
  session?: GuanjiaSessionSnapshot;
  error?: string;
}

/**
 * window.electron.guanjia.desktopAuth API 接口定义
 */
export interface DesktopAuthApi {
  getStatus: () => Promise<GuanjiaDesktopAuthStatus>;
  onStatusChanged: (callback: (status: GuanjiaDesktopAuthStatus) => void) => () => void;
  bind: (params: GuanjiaDesktopAuthBindParams) => Promise<GuanjiaDesktopAuthBindResult>;
  unbind: (params: GuanjiaDesktopAuthUnbindParams) => Promise<GuanjiaDesktopAuthUnbindResult>;
  loginBound: () => Promise<GuanjiaDesktopAuthLoginResult>;
}
