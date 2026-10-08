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
type RunBinding = { sessionId: string; action?: GuanjiaPendingAction; confirmationId?: string };
const runs = new Map<string, RunBinding>();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
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
function requireScoped(id: string): GuanjiaScopedSession { const scoped = sessions.get(id); if (!currentScope(scoped)) throw new Error('业务会话已失效，请开启新会话'); return scoped!; }
function pendingActions(id?: string): GuanjiaPendingAction[] {
  return Array.from(runs.values()).filter((run) => (!id || run.sessionId === id) && currentScope(sessions.get(run.sessionId)) && !!run.action).map((run) => publicData(run.action) as GuanjiaPendingAction);
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
export async function handleGuanjiaNativeToolCall(request: GuanjiaToolBridgeRequest, signal?: AbortSignal): Promise<GuanjiaToolBridgeResponse> {
  const reply = (value: unknown, isError = false): GuanjiaToolBridgeResponse => ({ content: [{ type: 'text', text: JSON.stringify(publicData(value)) }], ...(isError ? { isError } : {}) });
  try {
    const scoped = Array.from(sessions.values()).find((s) => s.openclawSessionKey === request.context.sessionKey);
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
        bindRun(scoped, run, skillId); return reply(run);
      } catch (error) {
        if (error instanceof GuanjiaBusinessApiError && error.unknownOutcome) return reply({ status: 'unknown', request_id: error.requestId ?? requestId, run_id: error.runId, message: error.message }, true);
        throw error;
      }
    }
    if (request.toolName === 'guanjia_get_run_status') {
      const id = typeof request.args.runId === 'string' ? request.args.runId : ''; const binding = runs.get(id);
      if (!binding || binding.sessionId !== scoped.sessionId) throw new Error('禁止查询未绑定到当前会话的运行');
      const run = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/runs/get', method: 'POST', body: { run_id: id }, expectedGeneration: scoped.generation, signal }));
      requireScoped(scoped.sessionId); bindRun(scoped, run, typeof run.skill_id === 'string' ? run.skill_id : '');
      if (binding.action && run.status !== 'confirmation_required') { binding.action.status = run.status === 'succeeded' ? 'confirmed' : run.status === 'failed' ? 'failed' : run.status === 'in_progress' ? 'in_progress' : 'unknown'; pushPending(); }
      return reply(run);
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
  ipcMain.handle(Channel.GetPendingActions, (event, filter?: { sessionId?: string } | string) => {
    try { requireNative(event); const targetSessionId = typeof filter === 'string' ? filter : filter?.sessionId; if (targetSessionId) requireScoped(targetSessionId); const actions = pendingActions(targetSessionId); return { success: true, runs: actions, pendingActions: actions }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '待确认操作不可用' }; }
  });
  ipcMain.handle(Channel.ConfirmPendingAction, async (event, params: { runId: string; note?: string }): Promise<ConfirmActionResult> => {
    let binding: RunBinding | undefined;
    try {
      requireNative(event); binding = runs.get(params.runId); if (!binding?.action || binding.action.status !== 'pending' || !binding.confirmationId) throw new Error('待确认操作不存在或已处理');
      const scoped = requireScoped(binding.sessionId); binding.action.status = 'in_progress'; pushPending();
      const run = decodeRun(await requestGuanjiaBusinessApi({ path: '/api/c/ai/skills/runs/confirm', method: 'POST', body: { run_id: params.runId }, expectedGeneration: scoped.generation })); requireScoped(scoped.sessionId);
      if (run.run_id !== params.runId) throw new Error('确认响应运行编号不符');
      const status = run.status === 'succeeded' ? 'completed' : run.status === 'failed' ? 'failed' : run.status === 'in_progress' ? 'in_progress' : 'unknown';
      binding.action.status = status === 'completed' ? 'confirmed' : status; binding.action.rawDetails = publicData(run) as Record<string, unknown>; pushPending();
      const success = status === 'completed';
      let errorDetail: string | undefined;
      if (!success) {
        if (typeof run.error === 'string' && run.error.trim()) {
          errorDetail = run.error.trim();
        } else if (record(run.error) && typeof run.error.message === 'string' && run.error.message.trim()) {
          errorDetail = run.error.message.trim();
        } else if (typeof run.reply === 'string' && run.reply.trim()) {
          errorDetail = run.reply.trim();
        } else if (typeof run.message === 'string' && run.message.trim()) {
          errorDetail = run.message.trim();
        }
      }
      return { success, runId: params.runId, status, data: publicData(run), ...(errorDetail ? { error: errorDetail } : {}) };
    } catch (error) {
      const unknown = binding?.action?.status === 'in_progress' || (error instanceof GuanjiaBusinessApiError && error.unknownOutcome); if (binding?.action && unknown) binding.action.status = 'unknown'; pushPending();
      return { success: false, runId: params?.runId ?? '', status: unknown ? 'unknown' : 'failed', error: error instanceof Error ? error.message : '确认结果尚未核验' };
    }
  });
  ipcMain.handle(Channel.CancelPendingAction, (event, params: { runId: string }) => {
    try { requireNative(event); const binding = runs.get(params.runId); if (!binding?.action || binding.action.status !== 'pending') throw new Error('仅可取消尚未提交确认的操作'); requireScoped(binding.sessionId); binding.action.status = 'cancelled'; binding.confirmationId = undefined; pushPending(); return { success: true, runId: params.runId, status: 'unexecuted' }; }
    catch (error) { return { success: false, runId: params?.runId ?? '', status: 'unknown', error: error instanceof Error ? error.message : '取消失败' }; }
  });
}
export function isSessionGuanjiaProtected(id: string): boolean { return sessions.has(id) || (runtime?.getCoworkStore().getSession(id)?.agentId === AgentId.GuanjiaAssistant); }
export function canAccessGuanjiaSession(id: string): boolean { return !isSessionGuanjiaProtected(id) || currentScope(sessions.get(id)); }
export function filterAccessibleSessions<T extends { id: string; agentId?: string | null; agent_id?: string | null }>(items: T[]): T[] { return items.filter((s) => (s.agentId ?? s.agent_id) !== AgentId.GuanjiaAssistant || currentScope(sessions.get(s.id))); }
