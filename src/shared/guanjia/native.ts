/**
 * Guanjia Native AI & Host Bridge Contracts
 * Shared types, channels, constants, and scoping helpers for LobsterAI <-> Guanjia Native AI.
 */

/**
 * IPC Channel names for Guanjia Native AI
 */
export const GuanjiaNativeIpcChannel = {
  // Web <-> Preload / Host Bridge v1
  GetCapabilities: 'guanjia:native:get-capabilities',
  OpenAssistant: 'guanjia:native:open-assistant',
  OpenAssistantRequest: 'guanjia:native:open-assistant-request',
  ReportSessionEvent: 'guanjia:native:report-session-event',

  // Scoped Assistant Sessions (Renderer <-> Main)
  GetScopedSession: 'guanjia:native:session:get',
  StartScopedSession: 'guanjia:native:session:start',
  ContinueScopedSession: 'guanjia:native:session:continue',
  StopScopedSession: 'guanjia:native:session:stop',
  ListScopedSessions: 'guanjia:native:session:list',

  // Real Business Pending Actions / Confirmations (Renderer <-> Main)
  GetPendingActions: 'guanjia:native:pending:get',
  ConfirmPendingAction: 'guanjia:native:pending:confirm',
  CancelPendingAction: 'guanjia:native:pending:cancel',

  // Push Events (Main -> Renderer)
  AssistantOpened: 'guanjia:native:assistant-opened',
  SessionEvent: 'guanjia:native:event:session',
  PendingChanged: 'guanjia:native:event:pending-changed',
} as const;

export type GuanjiaNativeIpcChannel =
  typeof GuanjiaNativeIpcChannel[keyof typeof GuanjiaNativeIpcChannel];

/**
 * Assistant entry points supported by native integration
 */
export type GuanjiaAssistantType = 'general' | 'financial';

/**
 * Shared message metadata keys for Guanjia native assistant sessions.
 */
export const GuanjiaMessageMetadataKey = {
  DisplayContent: 'guanjiaDisplayContent',
  BusinessRunId: 'guanjiaBusinessRunId',
} as const;

export type GuanjiaMessageMetadataKey =
  typeof GuanjiaMessageMetadataKey[keyof typeof GuanjiaMessageMetadataKey];

/**
 * Capabilities returned by Host Bridge v1 to the embedded web app
 */
export interface GuanjiaBridgeCapabilities {
  protocolVersion: 1;
  supported: boolean;
  bridgeVersion?: string;
  nativeAI: boolean;
  desktopAuth: boolean;
  assistantTypes: GuanjiaAssistantType[];
  reason?: string;
}

/**
 * Parameters passed when opening an assistant from the web app or UI
 */
export interface OpenAssistantParams {
  assistantType: GuanjiaAssistantType;
  storeId?: string;
  storeCode?: string;
  currentUrl?: string;
  initialMessage?: string;
  context?: Record<string, unknown>;
}

/**
 * Lifecycle events reported from embedded web console to host
 */
export type GuanjiaSessionEventType = 'logout' | 'expired' | 'store-changed';

export interface ReportSessionEventParams {
  type: GuanjiaSessionEventType;
  event?: GuanjiaSessionEventType;
  storeId?: string;
  storeCode?: string;
  timestamp?: number;
}

export type GuanjiaSessionStatus = 'unauthenticated' | 'restoring' | 'authenticated' | 'unavailable' | 'temporarily_unavailable' | 'expired';

export interface GuanjiaUserSnapshot {
  id: string | number;
  employeeNo: string;
  name?: string;
  role: string;
  tenantId?: string | number;
}

export interface GuanjiaStoreSnapshot {
  id: string | number;
  code?: string;
  name?: string;
}

/**
 * Credential-free business session snapshot.
 * Authoritative contract matching auth session service.
 * Strictly avoids holding tokens, passwords, or raw secrets.
 */
export interface GuanjiaSessionSnapshot {
  status: GuanjiaSessionStatus;
  generation: number;
  user: GuanjiaUserSnapshot | null;
  store: GuanjiaStoreSnapshot | null;
  error?: string;
  updatedAt?: number;
}

export type GuanjiaBusinessSessionSnapshot = GuanjiaSessionSnapshot;

/**
 * Bound to authenticated tenant, user, store, and generation to prevent cross-account leak.
 */
export interface GuanjiaScopedSession {
  sessionId: string;
  openclawSessionKey: string;
  agentId: string;
  assistantType: GuanjiaAssistantType;
  tenantId: string | number;
  userId: string | number;
  storeId: string | number;
  storeCode?: string;
  generation: number;
  title?: string;
  status?: 'running' | 'idle' | 'error' | 'done';
  createdAt: number;
  updatedAt: number;
}

export interface StartScopedSessionParams {
  initialMessage: string;
  assistantType?: GuanjiaAssistantType;
  storeId?: string;
  storeCode?: string;
  currentUrl?: string;
  context?: Record<string, unknown>;
}

export interface StartScopedSessionResult {
  success: boolean;
  sessionId?: string;
  openclawSessionKey?: string;
  userMessageId?: string;
  error?: string;
}

export interface ContinueScopedSessionParams {
  sessionId: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface ContinueScopedSessionResult {
  success: boolean;
  userMessageId?: string;
  error?: string;
}

export interface StopScopedSessionParams {
  sessionId: string;
  reason?: string;
}

export interface StopScopedSessionResult {
  success: boolean;
  error?: string;
}

export interface GetScopedSessionResult {
  success: boolean;
  sessionId?: string;
  session?: GuanjiaScopedSession;
  messages?: unknown[];
  pendingActions?: GuanjiaPendingAction[];
  error?: string;
}

export interface GetPendingActionsResult {
  success: boolean;
  runs?: GuanjiaPendingAction[];
  pendingActions?: GuanjiaPendingAction[];
  error?: string;
}

/**
 * Renderer Electron API surface exposed via window.electron.guanjia.native
 */
export interface ScopedNativeApi {
  start: (params: StartScopedSessionParams | { prompt: string; [key: string]: unknown }) => Promise<StartScopedSessionResult>;
  continue: (params: ContinueScopedSessionParams | { sessionId: string; prompt: string; [key: string]: unknown }) => Promise<ContinueScopedSessionResult>;
  get: (sessionId: string) => Promise<GetScopedSessionResult>;
  stop: (sessionId: string | StopScopedSessionParams) => Promise<StopScopedSessionResult>;
  getPendingRuns: (sessionId?: string) => Promise<GetPendingActionsResult>;
  confirmRun: (runId: string, note?: string) => Promise<ConfirmActionResult>;
  cancelRun: (runId: string, reason?: string) => Promise<CancelActionResult>;
  onOpenAssistant: (cb: (payload: OpenAssistantParams) => void) => () => void;
  onPendingChanged?: (cb: (actions: GuanjiaPendingAction[]) => void) => () => void;
}

/**
 * Verified financial assets returned from business backend
 * Strictly real numbers; no estimations or mocks.
 */
export interface GuanjiaVerifiedAssets {
  balance?: number | string;
  principal?: number | string;
  bonus?: number | string;
  remainingTimes?: number;
  discount?: number | string;
  originalAmount?: number | string;
}

/**
 * Real business pending action requiring human confirmation
 */
export interface GuanjiaPendingAction {
  runId: string;
  confirmationId?: string;
  skillId: string;
  title?: string;
  description?: string;
  amount?: number | string;
  verifiedAssets?: GuanjiaVerifiedAssets;
  orderId?: string;
  orderNo?: string;
  memberId?: string;
  memberName?: string;
  memberPhone?: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed' | 'expired' | 'in_progress' | 'unknown';
  requiresConfirmation: boolean;
  createdAt: number;
  expiresAt?: number;
  rawDetails?: Record<string, unknown>;
  resultPersisted?: boolean;
}

export interface ConfirmPendingActionParams {
  runId: string;
  confirmationId?: string;
  note?: string;
}

export interface CancelPendingActionParams {
  runId: string;
  confirmationId?: string;
  reason?: string;
}

export interface ConfirmActionResult {
  success: boolean;
  runId: string;
  status: 'completed' | 'failed' | 'pending' | 'unknown' | 'in_progress';
  message?: string;
  error?: string;
  data?: unknown;
  resultPersisted?: boolean;
}

export interface CancelActionResult {
  success: boolean;
  runId: string;
  status: 'unexecuted' | 'cancelled' | 'unknown';
  message?: string;
  error?: string;
}

/**
 * Prohibited tool names that must NEVER be exposed to the LLM agent.
 * User confirmations, system API calls, and skill deployment are UI-only
 * or administrative actions.
 */
export const PROHIBITED_MODEL_TOOL_NAMES = [
  'confirm_pending_action',
  'call_system_api',
  'create_skill',
  'deploy_skill',
  'manage_permissions',
  'system_shell',
  'browser_action',
  'file_write',
  'file_read',
  'network_fetch',
] as const;

/**
 * Prohibited parameter names that must NEVER be accepted from LLM tool calls.
 * Prevents model from attempting confirmation bypass via parameter injection.
 */
export const PROHIBITED_TOOL_ARGUMENTS = [
  'confirmation_id',
  'confirm_token',
  'auto_confirm',
  'bypass_approval',
  'force_execute',
] as const;

/**
 * Built-in and extension tool groups that MUST be denied for guanjia-assistant.
 */
export const GUANJIA_DENIED_TOOL_GROUPS = [
  'group:shell',
  'group:browser',
  'group:filesystem',
  'group:automation',
  'group:memory',
  'group:subagent',
] as const;

export * from './desktopAuth';
