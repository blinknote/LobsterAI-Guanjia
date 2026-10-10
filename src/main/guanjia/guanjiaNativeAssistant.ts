import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { AgentId } from '../../shared/agent/constants';
import {
  type ConfirmActionResult,
  type ContinueScopedSessionParams,
  type ContinueScopedSessionResult,
  type GuanjiaBridgeCapabilities,
  GuanjiaMessageMetadataKey,
  GuanjiaNativeIpcChannel as Channel,
  type GuanjiaPendingAction,
  type GuanjiaScopedSession,
  type OpenAssistantParams,
  type ReportSessionEventParams,
  type StartScopedSessionParams,
  type StartScopedSessionResult,
} from '../../shared/guanjia/native';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { IMStore } from '../im/imStore';
import type { CoworkRuntime, CoworkStartOptions } from '../libs/agentEngine/types';
import { buildManagedSessionKey } from '../libs/openclawChannelSessionSync';
import { PRESET_AGENTS } from '../presetAgents';
import { assertAllowedModelParameters, fetchAuthorizedSkillsCatalog, GuanjiaBusinessApiError, requestGuanjiaBusinessApi } from './guanjiaBusinessApi';
import { GuanjiaSession } from './guanjiaSession';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';

export interface GuanjiaToolBridgeRequest { toolName: string; args: Record<string, unknown>; context: { sessionKey: string; toolCallId: string } }
export interface GuanjiaToolBridgeResponse { content: Array<{ type: string; text: string }>; isError?: boolean; details?: Record<string, unknown> }
export interface NativeAssistantRuntimeOptions {
  getMainWindow: () => BrowserWindow | null;
  getCoworkStore: () => CoworkStore;
  getEngineRouter: () => CoworkRuntime;
  ensureEngineRunning: () => Promise<{ phase: string }>;
  ensureModelReady: () => Promise<{ allowed: boolean; error?: string }>;
  getWorkspaceRoot: () => string;
  isBusinessBridgeReady: () => boolean;
  getIMStore?: () => IMStore | null;
}
let runtime: NativeAssistantRuntimeOptions | undefined;
function getHostWindow(): BrowserWindow | null {
  try {
    const win = runtime?.getMainWindow() ?? null;
    return win && !win.isDestroyed() ? win : null;
  } catch {
    return null;
  }
}
const sessions = new Map<string, GuanjiaScopedSession>();
type RunBinding = {
  sessionId: string;
  action?: GuanjiaPendingAction;
  confirmationId?: string;
  resultMessageId?: string;
  submitted?: boolean;
  submitting?: boolean;
  querying?: boolean;
  lastReconciledStatus?: string;
  lastReconciledContent?: string;
};
const runs = new Map<string, RunBinding>();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const extractString = (val: unknown): string => (typeof val === 'string' ? val.trim() : '');
function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:confirmation.?id|conf.?id|token|password|secret|credential|authorization)/i.test(key)).map(([key, item]) => [key, publicData(item)]));
}
function currentScope(scoped: GuanjiaScopedSession | undefined): boolean {
  const snapshot = GuanjiaSession.getInstance().getSnapshot();
  return !!scoped && snapshot.status === 'authenticated' && !!snapshot.user && !!snapshot.store
    && snapshot.generation === scoped.generation && String(snapshot.user.tenantId) === String(scoped.tenantId)
    && String(snapshot.user.id) === String(scoped.userId) && String(snapshot.store.id) === String(scoped.storeId) && snapshot.store.code === scoped.storeCode;
}
function nativeCaller(event: IpcMainInvokeEvent): boolean {
  const win = getHostWindow();
  if (!win) return false;
  const contents = win.webContents;
  return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
}
function hostCaller(event: IpcMainInvokeEvent): boolean {
  if (nativeCaller(event)) return true;
  const manager = GuanjiaWorkspaceManager.getInstance();
  const view = manager.getOrCreateView();
  try { return event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame && new URL(event.senderFrame.url).origin === new URL(manager.getDefaultUrl()).origin; }
  catch { return false; }
}
function requireNative(event: IpcMainInvokeEvent): void { if (!nativeCaller(event)) throw new Error('Unauthorized caller'); }
function requireScoped(id: string): GuanjiaScopedSession { const scoped = sessions.get(id); if (!currentScope(scoped)) throw new Error(t('guanjiaSessionExpired')); return scoped!; }
function pendingActions(id?: string): GuanjiaPendingAction[] {
  return Array.from(runs.values())
    .filter((run) => (!id || run.sessionId === id) && currentScope(sessions.get(run.sessionId)) && !!run.action && (run.action.status !== 'confirmed' || run.action.resultPersisted === true))
    .map((run) => publicData(run.action) as GuanjiaPendingAction);
}
function pushPending(): void {
  const win = getHostWindow();
  if (!win) return;
  const contents = win.webContents;
  if (contents && !contents.isDestroyed()) contents.send(Channel.PendingChanged, pendingActions());
}
function decodeRun(data: Record<string, unknown>): Record<string, unknown> {
  if (!record(data.run) || typeof data.run.status !== 'string') throw new Error('业务接口未返回有效运行状态，结果尚未确认');
  return data.run;
}
function bindRun(scoped: GuanjiaScopedSession, run: Record<string, unknown>, skillId: string): void {
  requireScoped(scoped.sessionId);
  const id = typeof run.run_id === 'string' ? run.run_id : '';
  if (!id) { if (run.status === 'confirmation_required') throw new Error('待确认响应缺少运行编号'); return; }
  const existing = runs.get(id);
  if (existing && existing.sessionId !== scoped.sessionId) throw new Error('业务运行归属不符');
  const binding: RunBinding = existing ?? { sessionId: scoped.sessionId }; runs.set(id, binding);
  if (run.status === 'confirmation_required') {
    if (existing?.action && existing.action.status !== 'pending') return;
    if (typeof run.confirmation_id !== 'string') throw new Error('待确认响应缺少确认凭证');
    binding.confirmationId = run.confirmation_id;
    binding.action = { runId: id, skillId, status: 'pending', requiresConfirmation: true, createdAt: Date.now(), ...(typeof run.title === 'string' ? { title: run.title } : {}), ...(typeof run.reply === 'string' ? { description: run.reply } : {}), rawDetails: publicData(run) as Record<string, unknown> };
    pushPending();
  }
}
function persistAndBroadcastResult(
  binding: RunBinding,
  scoped: GuanjiaScopedSession,
  runId: string,
  content: string,
  targetActionStatus: GuanjiaPendingAction['status'],
  runDetails?: Record<string, unknown>,
): boolean {
  const currentSession = sessions.get(binding.sessionId);
  if (!currentSession || !currentScope(currentSession) || currentSession.generation !== scoped.generation) {
    return false;
  }
  const isTerminal = targetActionStatus === 'confirmed' || targetActionStatus === 'failed';
  const syncAction = (persistedReceipt?: boolean) => {
    if (binding.action) {
      const prevStatus = binding.action.status;
      const hadReceipt = binding.action.resultPersisted === true;
      if (persistedReceipt !== false) binding.action.status = targetActionStatus;
      if (runDetails && persistedReceipt !== false) {
        binding.action.rawDetails = publicData(runDetails) as Record<string, unknown>;
      }
      if (isTerminal && persistedReceipt) {
        binding.action.resultPersisted = true;
      } else {
        delete binding.action.resultPersisted;
      }
      if (prevStatus !== binding.action.status || hadReceipt !== (binding.action.resultPersisted === true)) {
        pushPending();
      }
    }
  };

  const store = runtime?.getCoworkStore();
  if (!store) return false;

  if (
    binding.resultMessageId &&
    binding.lastReconciledStatus === targetActionStatus &&
    binding.lastReconciledContent === content
  ) {
    const rowTimestamp = store.getMessageTimestamp(scoped.sessionId, binding.resultMessageId);
    if (rowTimestamp == null) {
      syncAction(false);
      return false;
    }
    if (isTerminal && binding.action?.resultPersisted !== true) {
      syncAction(false);
      return false;
    }
    const isTerminalDedup = isTerminal && binding.action?.resultPersisted === true;
    syncAction(isTerminalDedup);
    return true;
  }

  const metadata: Record<string, unknown> = {
    [GuanjiaMessageMetadataKey.BusinessRunId]: runId,
  };

  const win = getHostWindow();
  let storeSucceeded = false;
  let newMsg: { id: string } | undefined;
  const contents = win && !win.isDestroyed() ? win.webContents : null;

  try {
    if (!binding.resultMessageId) {
      const msg = store.addMessage(scoped.sessionId, {
        type: 'assistant',
        content,
        metadata,
      });
      newMsg = msg;
      binding.resultMessageId = msg.id;
      binding.lastReconciledContent = content;
    } else {
      store.updateMessage(scoped.sessionId, binding.resultMessageId, {
        content,
        metadata,
      });
      const rowTimestamp = store.getMessageTimestamp(scoped.sessionId, binding.resultMessageId);
      if (rowTimestamp == null) {
        syncAction(false);
        return false;
      }
      binding.lastReconciledContent = content;
    }
    binding.lastReconciledStatus = targetActionStatus;
    storeSucceeded = true;
  } catch {
    syncAction(false);
    return false;
  }

  syncAction(storeSucceeded);
  try {
    if (contents && !contents.isDestroyed()) {
      if (newMsg) {
        contents.send('cowork:stream:message', { sessionId: scoped.sessionId, message: newMsg });
      } else if (binding.resultMessageId) {
        contents.send('cowork:stream:messageUpdate', { sessionId: scoped.sessionId, messageId: binding.resultMessageId, content, metadata });
      }
    }
  } catch { /* non-fatal: storage and status already committed */ }
  return storeSucceeded;
}
interface ReconcileOutcome {
  status: 'completed' | 'failed' | 'in_progress' | 'unknown';
  persisted: boolean;
  resultPersisted?: boolean;
  content: string;
  error?: string;
  message?: string;
}
function reconcileRunResult(
  binding: RunBinding,
  run: Record<string, unknown>,
  scoped: GuanjiaScopedSession,
  isConfirmFlight = false,
): ReconcileOutcome {
  if (!binding.action) {
    return { status: 'unknown', persisted: false, content: '' };
  }

  if (typeof run.run_id === 'string' && binding.action.runId && run.run_id !== binding.action.runId) {
    return { status: 'unknown', persisted: false, content: '', error: '运行编号不符' };
  }
  if (!binding.submitted) {
    return { status: 'unknown', persisted: false, content: '' };
  }
  if (binding.submitting && !isConfirmFlight) {
    return { status: 'in_progress', persisted: false, content: '' };
  }

  const rawStatus = typeof run.status === 'string' ? run.status : 'unknown';
  if (binding.action.status === 'confirmed') {
    return {
      status: 'completed',
      persisted: Boolean(binding.action.resultPersisted),
      ...(binding.action.resultPersisted ? { resultPersisted: true } : {}),
      content: binding.lastReconciledContent ?? '',
    };
  }
  if (binding.action.status === 'cancelled') {
    return { status: 'failed', persisted: false, content: binding.lastReconciledContent ?? '' };
  }
  if ((binding.action.status === 'failed' || binding.action.status === 'expired') && (rawStatus === 'confirmation_required' || rawStatus === 'in_progress' || rawStatus === 'unknown')) {
    return {
      status: 'failed',
      persisted: Boolean(binding.action.resultPersisted),
      ...(binding.action.resultPersisted ? { resultPersisted: true } : {}),
      content: binding.lastReconciledContent ?? '',
    };
  }

  let targetActionStatus: GuanjiaPendingAction['status'] = 'unknown';
  let confirmResultStatus: 'completed' | 'failed' | 'in_progress' | 'unknown' = 'unknown';
  let content = '';
  let errorDetail: string | undefined;

  if (rawStatus === 'succeeded') {
    const replyStr = extractString(run.reply);
    content = replyStr || t('guanjiaRunSucceededNoDetails');
    targetActionStatus = 'confirmed';
    confirmResultStatus = 'completed';
  } else if (rawStatus === 'failed') {
    const errObj = record(run.error) ? run.error : null;
    const errObjMsg = errObj ? extractString(errObj.message) : '';
    const errStr = typeof run.error === 'string' ? run.error.trim() : errObjMsg;
    errorDetail = errStr || extractString(run.message) || extractString(run.reply);
    content = errorDetail ? t('guanjiaRunFailed', { error: errorDetail }) : t('guanjiaRunFailedGeneric');
    targetActionStatus = 'failed';
    confirmResultStatus = 'failed';
  } else if (rawStatus === 'need_more_info') {
    const info = extractString(run.message) || extractString(run.reply) || extractString(run.error);
    content = info ? t('guanjiaRunNeedMoreInfo', { info }) : t('guanjiaRunNeedMoreInfoGeneric');
    errorDetail = content;
    targetActionStatus = 'failed';
    confirmResultStatus = 'failed';
  } else if (rawStatus === 'in_progress') {
    content = t('guanjiaRunInProgress');
    targetActionStatus = 'in_progress';
    confirmResultStatus = 'in_progress';
  } else {
    content = t('guanjiaRunUnknown');
    targetActionStatus = 'unknown';
    confirmResultStatus = 'unknown';
  }
  const persisted = persistAndBroadcastResult(binding, scoped, binding.action.runId, content, targetActionStatus, run);
  const finalStatus = persisted && confirmResultStatus === 'completed' ? 'completed' : confirmResultStatus === 'completed' ? 'unknown' : confirmResultStatus;
  const terminalResultPersisted = (finalStatus === 'completed' || finalStatus === 'failed') && persisted ? true : undefined;
  return {
    status: finalStatus,
    persisted,
    ...(terminalResultPersisted ? { resultPersisted: true } : {}),
    content,
    error: errorDetail,
    message: typeof run.message === 'string' ? run.message : undefined,
  };
}
async function reconcilePendingActionsForSessions(scopedSessions: GuanjiaScopedSession[]): Promise<void> {
  const allowedSessionIds = new Set(scopedSessions.map((s) => s.sessionId));
  const candidates = Array.from(runs.values()).filter((b) => allowedSessionIds.has(b.sessionId) && b.action && b.submitted && (b.action.status === 'in_progress' || b.action.status === 'unknown') && !b.submitting && !b.querying);
  if (candidates.length === 0) return;
  const budgetAc = new AbortController();
  const budgetTimer = setTimeout(() => budgetAc.abort(), 20000);
  try {
    for (const binding of candidates) {
      if (budgetAc.signal.aborted) break;
      if (!binding.action || binding.submitting || binding.querying) continue;
      binding.querying = true;
      const runAc = new AbortController();
      const runTimer = setTimeout(() => runAc.abort(), 5000);
      const onBudgetAbort = () => runAc.abort();
      budgetAc.signal.addEventListener('abort', onBudgetAbort, { once: true });
      try {
        const scoped = sessions.get(binding.sessionId);
        if (!scoped || !currentScope(scoped)) continue;
        const data = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/runs/get', method: 'POST', body: { run_id: binding.action.runId }, expectedGeneration: scoped.generation, signal: runAc.signal }));
        const currentSession = sessions.get(binding.sessionId);
        if (!currentSession || !currentScope(currentSession) || currentSession.generation !== scoped.generation) continue;
        if (data.run_id !== binding.action.runId) continue;
        if (binding.submitting || (binding.action.status !== 'in_progress' && binding.action.status !== 'unknown')) continue;
        if (data.status === 'confirmation_required') continue;
        reconcileRunResult(binding, data, currentSession);
      } catch {
        // Bounded timeout or network error: do not crash or corrupt
      } finally {
        clearTimeout(runTimer);
        budgetAc.signal.removeEventListener('abort', onBudgetAbort);
        binding.querying = false;
      }
    }
  } finally {
    clearTimeout(budgetTimer);
    budgetAc.abort();
  }
}
export async function handleGuanjiaNativeToolCall(request: GuanjiaToolBridgeRequest, signal?: AbortSignal): Promise<GuanjiaToolBridgeResponse> {
  const reply = (value: unknown, isError = false): GuanjiaToolBridgeResponse => ({ content: [{ type: 'text', text: JSON.stringify(publicData(value)) }], ...(isError ? { isError } : {}) });
  try {
    const sessionKey = request.context.sessionKey || '';
    let scoped = Array.from(sessions.values()).find((s) => s.openclawSessionKey === sessionKey);
    const isChannelKey = sessionKey.startsWith('agent:guanjia-assistant:') || sessionKey.startsWith(`agent:${AgentId.GuanjiaAssistant}:`);

    if (isChannelKey) {
      const snapshot = GuanjiaSession.getInstance().getSnapshot();
      if (snapshot.status !== 'authenticated' || !snapshot.user?.tenantId || !snapshot.store) {
        throw new Error('智慧管家当前未在桌面端登录，无法访问门店业务数据，请先在电脑端登录智慧管家账号。');
      }

      if (scoped) {
        if (scoped.generation !== snapshot.generation || String(scoped.storeId) !== String(snapshot.store.id)) {
          scoped.generation = snapshot.generation;
          scoped.tenantId = snapshot.user.tenantId;
          scoped.userId = snapshot.user.id;
          scoped.storeId = snapshot.store.id;
          scoped.storeCode = snapshot.store.code;
          scoped.updatedAt = Date.now();
        }
      } else {
        const imStore = runtime?.getIMStore?.();
        const mapping = imStore?.getSessionMappingByOpenClawSessionKey(sessionKey);
        let sessionId = mapping?.coworkSessionId;
        if (!sessionId) {
          const root = runtime?.getWorkspaceRoot() ?? '/tmp';
          fs.mkdirSync(root, { recursive: true });
          const cwd = fs.mkdtempSync(path.join(root, 'im-session-'));
          const created = runtime?.getCoworkStore().createSession(
            '智慧管家IM渠道会话',
            cwd,
            systemPrompt(),
            'local',
            [],
            AgentId.GuanjiaAssistant,
          );
          sessionId = created?.id ?? crypto.randomUUID();
        }
        scoped = {
          sessionId,
          openclawSessionKey: sessionKey,
          agentId: AgentId.GuanjiaAssistant,
          assistantType: 'general',
          tenantId: snapshot.user.tenantId,
          userId: snapshot.user.id,
          storeId: snapshot.store.id,
          storeCode: snapshot.store.code,
          generation: snapshot.generation,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          title: '智慧管家IM渠道会话',
        };
        sessions.set(sessionId, scoped);
      }
    }

    if (!scoped || !currentScope(scoped) || !runtime?.isBusinessBridgeReady() || signal?.aborted) throw new Error('业务工具会话不可用或已失效');
    assertAllowedModelParameters(request.args);
    if (request.toolName === 'guanjia_get_context') { const snapshot = GuanjiaSession.getInstance().getSnapshot(); return reply({ user: snapshot.user, store: snapshot.store, assistantType: scoped.assistantType }); }
    if (request.toolName === 'guanjia_list_skills' || request.toolName === 'guanjia_execute_skill') {
      const catalog = await fetchAuthorizedSkillsCatalog({ expectedGeneration: scoped.generation, signal }); requireScoped(scoped.sessionId);
      if (request.toolName === 'guanjia_list_skills') return reply(catalog.map((skill) => ({ skillId: skill.skillId, name: skill.name, description: skill.description, parameters: skill.parameters })));
      const skillId = typeof request.args.skillId === 'string' ? request.args.skillId : '';
      if (!catalog.some((s) => s.skillId === skillId)) throw new Error('该技能未安装、未发布或不属于允许的业务能力');
      const parameters = request.args.parameters ?? {}; if (!record(parameters)) throw new Error('技能参数必须是对象'); assertAllowedModelParameters(parameters);
      const requestId = crypto.randomUUID();
      try {
        const run = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/execute', method: 'POST', body: { skill_id: skillId, params: parameters, session_id: scoped.sessionId, request_id: requestId }, expectedGeneration: scoped.generation, signal }));
        bindRun(scoped, run, skillId);
        if (run.status === 'confirmation_required' && isChannelKey) {
          const channelNotice = '（提示：该操作涉及资金或写操作，已生成待确认凭单并推送到门店管家桌面端，请通知前台或店长在电脑端核对并点击确认。）';
          if (typeof run.reply === 'string' && !run.reply.includes('电脑端')) {
            run.reply = `${run.reply}\n\n${channelNotice}`;
          }
        }
        return reply(run);
      } catch (error) {
        if (error instanceof GuanjiaBusinessApiError && error.unknownOutcome) return reply({ status: 'unknown', request_id: error.requestId ?? requestId, run_id: error.runId, message: error.message }, true);
        throw error;
      }
    }
    if (request.toolName === 'guanjia_get_run_status') {
      const id = typeof request.args.runId === 'string' ? request.args.runId : '';
      const binding = runs.get(id);
      if (!binding || binding.sessionId !== scoped.sessionId) throw new Error('禁止查询未绑定到当前会话的运行');
      if (binding.action?.status === 'cancelled') throw new Error(t('guanjiaCannotQueryCancelledRun'));
      if (binding.submitting) return reply(binding.action ? publicData(binding.action) : { run_id: id, status: 'in_progress' });
      if (binding.querying) return reply(binding.action ? publicData(binding.action) : { run_id: id, status: binding.action?.status ?? 'unknown' });
      binding.querying = true;
      try {
        const run = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/runs/get', method: 'POST', body: { run_id: id }, expectedGeneration: scoped.generation, signal }));
        const currentSession = requireScoped(scoped.sessionId);
        if (run.run_id !== id) throw new Error('查询响应运行编号不符');
        if (binding.submitting) return reply(binding.action ? publicData(binding.action) : run);
        if (run.status === 'confirmation_required' || !binding.submitted) { bindRun(scoped, run, typeof run.skill_id === 'string' ? run.skill_id : ''); return reply(run); }
        reconcileRunResult(binding, run, currentSession);
        return reply(run);
      } finally {
        binding.querying = false;
      }
    }
    throw new Error('不允许调用该业务工具');
  } catch (error) { return reply({ error: error instanceof Error ? error.message : '业务工具调用失败' }, true); }
}
async function ready(): Promise<void> {
  if (!runtime) throw new Error('原生运行时未注册');
  const gate = await runtime.ensureModelReady(); if (!gate.allowed) throw new Error(gate.error || '请先配置可用模型');
  if ((await runtime.ensureEngineRunning()).phase !== 'running') throw new Error('OpenClaw 引擎未就绪');
  if (!runtime.isBusinessBridgeReady()) throw new Error('受限业务工具扩展未就绪');
}
function notifySessionError(scoped: GuanjiaScopedSession, errorMessage: string): void {
  if (!currentScope(scoped)) return;
  const win = getHostWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('cowork:stream:sessionStatus', { sessionId: scoped.sessionId, status: 'error' });
    win.webContents.send('cowork:stream:error', { sessionId: scoped.sessionId, error: errorMessage });
  } catch {
    /* ignore notification failures */
  }
}
const systemPrompt = (): string => PRESET_AGENTS.find((agent) => agent.id === AgentId.GuanjiaAssistant)?.systemPrompt ?? '';
function launch(scoped: GuanjiaScopedSession, modelPrompt: string, first: boolean, displayText: string): string {
  requireScoped(scoped.sessionId);
  const store = runtime!.getCoworkStore();
  const userMessage = store.addMessage(scoped.sessionId, {
    type: 'user',
    content: modelPrompt,
    metadata: {
      [GuanjiaMessageMetadataKey.DisplayContent]: displayText,
    },
  });
  store.updateSession(scoped.sessionId, { status: 'running' });
  const router = runtime!.getEngineRouter();
  const options: CoworkStartOptions = { systemPrompt: systemPrompt(), skillIds: [], skipInitialUserMessage: true };
  try {
    const turn = first ? router.startSession(scoped.sessionId, modelPrompt, { ...options, agentId: AgentId.GuanjiaAssistant, workspaceRoot: store.getSession(scoped.sessionId)?.cwd }) : router.continueSession(scoped.sessionId, modelPrompt, options);
    void turn.catch((err: unknown) => {
      runtime?.getCoworkStore().updateSession(scoped.sessionId, { status: 'error' });
      const msg = err instanceof Error ? err.message : '助手执行失败';
      notifySessionError(scoped, msg);
    });
  } catch (error) {
    store.updateSession(scoped.sessionId, { status: 'error' });
    const msg = error instanceof Error ? error.message : '助手执行失败';
    notifySessionError(scoped, msg);
    throw error;
  }
  return userMessage.id;
}
export function registerGuanjiaNativeAssistantHandlers(options: NativeAssistantRuntimeOptions): void {
  runtime = options;
  GuanjiaSession.getInstance().subscribe(() => {
    for (const scoped of sessions.values()) if (!currentScope(scoped)) {
      options.getEngineRouter().stopSession(scoped.sessionId);
      for (const binding of runs.values()) if (binding.sessionId === scoped.sessionId && binding.action?.status === 'pending') binding.action.status = 'expired';
    }
    pushPending();
  });
  ipcMain.handle(Channel.GetCapabilities, async (event): Promise<GuanjiaBridgeCapabilities> => {
    if (!hostCaller(event)) throw new Error('Unauthorized caller');
    let nativeAI = false;
    let reason: string | undefined;
    try {
      if (GuanjiaSession.getInstance().getSnapshot().status === 'authenticated') {
        await ready();
        nativeAI = true;
      } else {
        reason = '智慧管家账号未登录';
      }
    } catch (error) {
      nativeAI = false;
      reason = error instanceof Error ? error.message : '原生助手未就绪';
    }
    return { protocolVersion: 1, supported: true, nativeAI, desktopAuth: true, assistantTypes: ['general', 'financial'], reason };
  });
  ipcMain.handle(Channel.OpenAssistant, async (event, params: OpenAssistantParams) => {
    try {
      if (!hostCaller(event) || !record(params) || !['general', 'financial'].includes(params.assistantType)) throw new Error('助手请求无效'); assertAllowedModelParameters(params);
      if (JSON.stringify(params).length > 32000) throw new Error('助手上下文过大');
      if (params.storeId) await GuanjiaSession.getInstance().setStore({ id: params.storeId, code: params.storeCode });
      const snapshot = GuanjiaSession.getInstance().getSnapshot();
      if (snapshot.status !== 'authenticated' || !snapshot.store || (params.storeId && String(snapshot.store.id) !== String(params.storeId))) throw new Error('请先选择并核验当前门店');
      await ready(); if (GuanjiaSession.getInstance().getSnapshot().generation !== snapshot.generation) throw new Error('业务会话已变化');
      const win = getHostWindow();
      if (!win) throw new Error('主窗口不可用');
      const contents = win.webContents;
      if (!contents || contents.isDestroyed()) throw new Error('主窗口不可用');
      contents.send(Channel.AssistantOpened, params); return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : '打开助手失败' }; }
  });
  ipcMain.handle(Channel.ReportSessionEvent, async (event, params: ReportSessionEventParams) => {
    if (!hostCaller(event) || !record(params)) return { success: false, error: 'Unauthorized caller' };
    const service = GuanjiaSession.getInstance();
    if (params.type === 'logout' || params.type === 'expired') service.invalidate('网页业务会话已失效');
    else if (params.type === 'store-changed') {
      const isWorkspace = GuanjiaWorkspaceManager.getInstance().isGuanjiaWebContents(event.sender);
      await service.setStore(
        params.storeId ? { id: params.storeId, code: params.storeCode } : null,
        { syncWorkspace: !isWorkspace },
      );
    }
    else return { success: false, error: 'Unsupported lifecycle event' }; return { success: true };
  });
  ipcMain.handle(Channel.StartScopedSession, async (event, params: StartScopedSessionParams & { prompt?: string }): Promise<StartScopedSessionResult> => {
    try {
      requireNative(event); if (!record(params)) throw new Error('会话请求无效'); assertAllowedModelParameters(params);
      const displayText = params.initialMessage || params.prompt || ''; if (!displayText.trim() || displayText.length > 32000) throw new Error('请输入有效的对话内容');
      let modelPrompt = displayText;
      if (params.context) {
        assertAllowedModelParameters(params.context);
        modelPrompt += `\n[页面筛选与业务对象，仅作为查询条件，不代表身份或权限]\n${JSON.stringify(publicData(params.context))}`;
      }
      const snapshot = GuanjiaSession.getInstance().getSnapshot();
      if (snapshot.status !== 'authenticated' || !snapshot.user?.tenantId || !snapshot.store || (params.storeId && String(params.storeId) !== String(snapshot.store.id))) throw new Error('请先登录并核验当前门店');
      await ready(); if (GuanjiaSession.getInstance().getSnapshot().generation !== snapshot.generation) throw new Error('业务会话已变化');
      const root = options.getWorkspaceRoot(); fs.mkdirSync(root, { recursive: true }); const cwd = fs.mkdtempSync(path.join(root, 'session-'));
      const session = options.getCoworkStore().createSession(params.assistantType === 'financial' ? '智慧管家财务助手' : '智慧管家助理', cwd, systemPrompt(), 'local', [], AgentId.GuanjiaAssistant);
      const scoped: GuanjiaScopedSession = { sessionId: session.id, openclawSessionKey: buildManagedSessionKey(session.id, AgentId.GuanjiaAssistant), agentId: AgentId.GuanjiaAssistant, assistantType: params.assistantType ?? 'general', tenantId: snapshot.user.tenantId, userId: snapshot.user.id, storeId: snapshot.store.id, storeCode: snapshot.store.code, generation: snapshot.generation, createdAt: session.createdAt, updatedAt: session.updatedAt, title: session.title };
      sessions.set(session.id, scoped); const userMessageId = launch(scoped, modelPrompt, true, displayText); return { success: true, sessionId: session.id, openclawSessionKey: scoped.openclawSessionKey, userMessageId };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : '创建会话失败' }; }
  });
  ipcMain.handle(Channel.ContinueScopedSession, async (event, params: ContinueScopedSessionParams & { prompt?: string }): Promise<ContinueScopedSessionResult> => {
    try {
      requireNative(event); if (!record(params)) throw new Error('会话请求无效'); assertAllowedModelParameters(params);
      const scoped = requireScoped(params.sessionId); const displayText = params.message || params.prompt || '';
      if (!displayText.trim() || displayText.length > 32000) throw new Error('请输入有效的对话内容'); if (options.getCoworkStore().getSession(scoped.sessionId)?.status === 'running') throw new Error('当前会话正在运行');
      let modelPrompt = displayText;
      if (params.context) {
        assertAllowedModelParameters(params.context);
        modelPrompt += `\n[页面筛选与业务对象，仅作为查询条件，不代表身份或权限]\n${JSON.stringify(publicData(params.context))}`;
      }
      await ready(); requireScoped(scoped.sessionId); if (options.getCoworkStore().getSession(scoped.sessionId)?.status === 'running') throw new Error('当前会话正在运行'); const userMessageId = launch(scoped, modelPrompt, false, displayText); return { success: true, userMessageId };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : '继续会话失败' }; }
  });
  ipcMain.handle(Channel.StopScopedSession, (event, params: string | { sessionId: string }) => {
    try { requireNative(event); const id = typeof params === 'string' ? params : params.sessionId; requireScoped(id); options.getEngineRouter().stopSession(id); return { success: true }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '停止失败' }; }
  });
  ipcMain.handle(Channel.GetScopedSession, (event, id: string) => {
    try { requireNative(event); const scoped = requireScoped(id); const session = options.getCoworkStore().getSession(id); return { success: true, sessionId: id, session: { ...scoped, status: session?.status === 'completed' ? 'done' : session?.status }, messages: session?.messages ?? [], pendingActions: pendingActions(id) }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '会话不可用' }; }
  });
  ipcMain.handle(Channel.GetPendingActions, async (event, filter?: { sessionId?: string } | string) => {
    try {
      requireNative(event);
      const targetSessionId = typeof filter === 'string' ? filter : filter?.sessionId;
      if (targetSessionId) {
        const targetScoped = requireScoped(targetSessionId);
        await reconcilePendingActionsForSessions([targetScoped]);
        requireScoped(targetSessionId);
      } else {
        const validSessions = Array.from(sessions.values()).filter((s) => currentScope(s));
        await reconcilePendingActionsForSessions(validSessions);
        if (GuanjiaSession.getInstance().getSnapshot().status !== 'authenticated') throw new Error(t('guanjiaSessionExpired'));
      }
      const actions = pendingActions(targetSessionId);
      return { success: true, runs: actions, pendingActions: actions };
    }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '待确认操作不可用' }; }
  });
  ipcMain.handle(Channel.ConfirmPendingAction, async (event, params: { runId: string; note?: string }): Promise<ConfirmActionResult> => {
    let binding: RunBinding | undefined;
    let scoped: GuanjiaScopedSession | undefined;
    let ownsFlight = false;
    try {
      requireNative(event); binding = runs.get(params.runId); if (!binding?.action || binding.action.status !== 'pending' || !binding.confirmationId) throw new Error('待确认操作不存在或已处理');
      if (binding.submitting) throw new Error('待确认操作不存在或已处理');
      scoped = requireScoped(binding.sessionId); binding.submitting = true; binding.submitted = true; ownsFlight = true; binding.action.status = 'in_progress'; pushPending();
      persistAndBroadcastResult(binding, scoped, params.runId, t('guanjiaRunInProgress'), 'in_progress');
      const run = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/runs/confirm', method: 'POST', body: { run_id: params.runId }, expectedGeneration: scoped.generation })); requireScoped(scoped.sessionId);
      if (run.run_id !== params.runId) throw new Error('确认响应运行编号不符');
      const currentSession = requireScoped(scoped.sessionId);
      const outcome = reconcileRunResult(binding, run, currentSession, true);
      return {
        success: outcome.status === 'completed',
        runId: params.runId,
        status: outcome.status,
        data: publicData(run),
        ...(outcome.resultPersisted ? { resultPersisted: true } : {}),
        ...(outcome.message ? { message: outcome.message } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    } catch (error) {
      if (ownsFlight && scoped && currentScope(sessions.get(scoped.sessionId))) {
        const isUnknown = error instanceof GuanjiaBusinessApiError ? error.unknownOutcome : true;
        const errStatus = isUnknown ? 'unknown' : 'failed';
        const errMsg = error instanceof Error ? error.message : '确认结果尚未核验';
        const errText = isUnknown ? t('guanjiaRunUnknownError', { error: errMsg }) : t('guanjiaRunFailed', { error: errMsg });
        let writeSaved = false;
        if (binding) writeSaved = persistAndBroadcastResult(binding, scoped, params?.runId ?? '', errText, errStatus);
        const hasPersisted = !isUnknown && writeSaved ? true : undefined;
        return {
          success: false,
          runId: params?.runId ?? '',
          status: errStatus,
          error: errMsg,
          ...(hasPersisted ? { resultPersisted: true } : {}),
        };
      }
      return { success: false, runId: params?.runId ?? '', status: 'unknown', error: error instanceof Error ? error.message : '确认结果尚未核验' };
    } finally {
      if (ownsFlight && binding) binding.submitting = false;
    }
  });
  ipcMain.handle(Channel.CancelPendingAction, (event, params: { runId: string }) => {
    try { requireNative(event); const binding = runs.get(params.runId); if (!binding?.action || binding.action.status !== 'pending') throw new Error('仅可取消尚未提交确认的操作'); requireScoped(binding.sessionId); binding.action.status = 'cancelled'; binding.confirmationId = undefined; pushPending(); return { success: true, runId: params.runId, status: 'unexecuted' }; }
    catch (error) { return { success: false, runId: params?.runId ?? '', status: 'unknown', error: error instanceof Error ? error.message : '取消失败' }; }
  });
}
function checkOrRestoreGuanjiaScope(id: string): boolean {
  let scoped = sessions.get(id);
  const snapshot = GuanjiaSession.getInstance().getSnapshot();
  if (snapshot.status !== 'authenticated' || !snapshot.user || !snapshot.store) {
    return false;
  }
  if (!scoped) {
    const session = runtime?.getCoworkStore().getSession(id);
    if (session?.agentId === AgentId.GuanjiaAssistant) {
      const mapping = runtime?.getIMStore?.()?.getSessionMappingByCoworkSessionId(id);
      const openclawSessionKey = mapping?.openClawSessionKey || buildManagedSessionKey(id, AgentId.GuanjiaAssistant);
      scoped = {
        sessionId: id,
        openclawSessionKey,
        agentId: AgentId.GuanjiaAssistant,
        assistantType: 'general',
        tenantId: snapshot.user.tenantId,
        userId: snapshot.user.id,
        storeId: snapshot.store.id,
        storeCode: snapshot.store.code,
        generation: snapshot.generation,
        createdAt: session.createdAt || Date.now(),
        updatedAt: session.updatedAt || Date.now(),
        title: session.title || '智慧管家会话',
      };
      sessions.set(id, scoped);
    }
  } else if (!scoped.openclawSessionKey.includes(':lobsterai:')) {
    if (scoped.generation !== snapshot.generation || String(scoped.storeId) !== String(snapshot.store.id)) {
      scoped.generation = snapshot.generation;
      scoped.tenantId = snapshot.user.tenantId;
      scoped.userId = snapshot.user.id;
      scoped.storeId = snapshot.store.id;
      scoped.storeCode = snapshot.store.code;
      scoped.updatedAt = Date.now();
    }
  }
  return currentScope(scoped);
}
export function isSessionGuanjiaProtected(id: string): boolean { return sessions.has(id) || (runtime?.getCoworkStore().getSession(id)?.agentId === AgentId.GuanjiaAssistant); }
export function canAccessGuanjiaSession(id: string): boolean { return !isSessionGuanjiaProtected(id) || checkOrRestoreGuanjiaScope(id); }
export function filterAccessibleSessions<T extends { id: string; agentId?: string | null; agent_id?: string | null }>(items: T[]): T[] { return items.filter((s) => (s.agentId ?? s.agent_id) !== AgentId.GuanjiaAssistant || checkOrRestoreGuanjiaScope(s.id)); }
