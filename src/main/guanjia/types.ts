/**
 * 智慧管家融合数据模型与类型定义
 * 满足《智慧管家融合-需求说明-v1.2.md》
 */

export const GUANJIA_WORKSPACE_PARTITION = 'persist:guanjia-workspace';

export interface GuanjiaSsoCredentials {
  token: string;
  refreshToken?: string;
  userId: string;
  username: string;
  realName?: string;
  role: 'manager' | 'frontdesk' | 'admin' | string;
  shopId: string;
  shopName: string;
  tenantId?: string;
  expiredAt?: number;
}

export interface GuanjiaLoginPayload {
  account: string;
  password: string;
}

export interface GuanjiaLoginUserInfo {
  employee_id: string | number;
  employee_no: string;
  employee_name: string;
  role: string;
  store_code?: string;
  store_name?: string;
  [key: string]: unknown;
}

export interface GuanjiaLoginResult {
  success: boolean;
  data?: {
    token: string;
    userInfo: GuanjiaLoginUserInfo;
  };
  credentials?: GuanjiaSsoCredentials;
  error?: string;
}

export interface GuanjiaWorkspaceContext {
  currentUrl: string;
  pathname: string;
  pageTitle: string;
  currentUser: {
    id: string;
    name: string;
    role: string;
    shopName: string;
  } | null;
  currentShop: {
    id: string;
    name: string;
  } | null;
  pageError: string | null;
  pendingCount: number;
  timestamp: number;
}

export interface FinancialDetails {
  amount: number | string;
  reason: string;
  orderId?: string;
  customerName?: string;
  targetAccount?: string;
  actionType: 'refund' | 'recharge' | 'submit_order' | 'cancel_order' | 'settlement' | 'void' | 'other';
}

export interface GuanjiaActionRequest {
  type: 'click' | 'input' | 'navigate' | 'submit_order' | 'refund' | 'recharge' | 'cancel_order' | 'settlement' | 'custom';
  selector?: string;
  value?: string;
  url?: string;
  // 动账落定标记
  isFinancialAction?: boolean;
  financialDetails?: FinancialDetails;
  confirmed?: boolean;
  confirmedBy?: string;
}

export const FINANCIAL_ACTION_TYPES: ReadonlySet<string> = new Set([
  'submit_order',
  'refund',
  'recharge',
  'cancel_order',
  'settlement',
]);

export const FINANCIAL_KEYWORDS: readonly string[] = [
  '退款',
  '扣款',
  '充值',
  '结账',
  '收款',
  '作废',
  '核销',
  '确认支付',
  '结算',
];

export function isFinancialAction(action: GuanjiaActionRequest): boolean {
  if (action.isFinancialAction) return true;
  if (action.type && FINANCIAL_ACTION_TYPES.has(action.type)) return true;
  if (action.financialDetails) return true;

  const contentToCheck = `${action.selector || ''} ${action.value || ''} ${action.type || ''}`;
  return FINANCIAL_KEYWORDS.some((kw) => contentToCheck.includes(kw));
}

export interface GuanjiaActionResult {
  success: boolean;
  actionType: string;
  requiresConfirmation?: boolean;
  financialDetails?: FinancialDetails;
  message?: string;
  data?: unknown;
  error?: string;
}

export interface GuanjiaFinancialAuditLog {
  id: string;
  actionType: string;
  amount: string | number;
  reason: string;
  operatorName: string;
  confirmedBy: string;
  shopId: string;
  timestamp: number;
  status: 'executed' | 'cancelled' | 'intercepted';
  extra?: Record<string, unknown>;
}

export interface GuanjiaModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  priority: number; // 优先级，数字越小优先级越高
  enabled: boolean;
  protocol: 'anthropic' | 'gemini_native' | 'openai';
  costPer1kTokens: number; // 实际后台成本（元/千Token）
  rateMultiplier: number; // 消耗积分转换比率
}

export interface PrepayReservation {
  reservationId: string;
  userId: string;
  shopId: string;
  model: string;
  estimatedCredits: number;
  actualCredits?: number;
  refundCredits?: number;
  providerId?: string;
  actualCost?: number;
  createdAt: number;
  settledAt?: number;
  status: 'reserved' | 'settled' | 'refunded' | 'failed';
}

export interface GuanjiaCreditLedgerRecord {
  id: string;
  reservationId: string;
  userId: string;
  shopId: string;
  providerId: string;
  model: string;
  estimatedCredits: number;
  actualCredits: number;
  refundCredits: number;
  actualCost: number; // 后台实际成本，用来算毛利
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
}

export const GuanjiaIpcChannel = {
  // Workspace WebContentsView 管理
  AttachView: 'guanjia:workspace:attach-view',
  DetachView: 'guanjia:workspace:detach-view',
  SetBounds: 'guanjia:workspace:set-bounds',
  ShowView: 'guanjia:workspace:show-view',
  HideView: 'guanjia:workspace:hide-view',
  LoadUrl: 'guanjia:workspace:load-url',
  Reload: 'guanjia:workspace:reload',
  SetDefaultUrl: 'guanjia:workspace:set-default-url',
  GetDefaultUrl: 'guanjia:workspace:get-default-url',
  GoBack: 'guanjia:workspace:go-back',
  GoForward: 'guanjia:workspace:go-forward',
  GetNavigationState: 'guanjia:workspace:get-nav-state',

  // SSO 凭证
  SetSsoCredentials: 'guanjia:sso:set-credentials',
  GetSsoCredentialsSync: 'guanjia:sso:get-credentials-sync',
  ClearSsoCredentials: 'guanjia:sso:clear-credentials',

  // 只读上下文与动作
  GetContext: 'guanjia:workspace:get-context',
  ExecuteAction: 'guanjia:workspace:execute-action',
  GetAuditLogs: 'guanjia:workspace:get-audit-logs',

  // 交班清场
  ClearAssistantSession: 'guanjia:session:clear-assistant',

  // 模型路由与预扣退费
  GetCreditBalance: 'guanjia:model:get-balance',
  RouteAndInvokeModel: 'guanjia:model:route-and-invoke',
  GetLedgerRecords: 'guanjia:model:get-ledger',

  // 真实账号密码认证与会话
  Login: 'guanjia:auth:login',
  Logout: 'guanjia:auth:logout',
} as const;
