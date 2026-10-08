import crypto from 'crypto';

import { GuanjiaSession } from './guanjiaSession';
import { GuanjiaWorkspaceManager } from './guanjiaWorkspaceManager';

export type AllowedGuanjiaApiPath =
  | '/api/c/ai/skills/list'
  | '/api/c/ai/skills/installed'
  | '/api/c/ai/skills/execute'
  | '/api/c/ai/skills/runs/get'
  | '/api/c/ai/skills/runs/confirm';

export type GuanjiaBusinessApiPath = AllowedGuanjiaApiPath;

export const ALLOWED_GUANJIA_API_PATHS: ReadonlySet<string> = new Set([
  '/api/c/ai/skills/list',
  '/api/c/ai/skills/installed',
  '/api/c/ai/skills/execute',
  '/api/c/ai/skills/runs/get',
  '/api/c/ai/skills/runs/confirm',
]);

export const PROHIBITED_CATALOG_SKILL_IDS: ReadonlySet<string> = new Set([
  'confirm_pending_action',
  'confirm_action',
  'runs_confirm',
  'call_system_api',
  'system_api',
  'developer_api',
  'skill_drafts_save',
  'skill_drafts_submit',
  'skill_reviews_decide',
  'skill_versions_deploy',
  'skill_versions_withdraw',
  'execute_shell',
  'execute_node',
  'read_credentials',
]);

export interface AuthorizedSkillItem {
  skillId: string;
  name: string;
  description: string;
  category?: string;
  version?: string;
  installed: boolean;
  status: string;
  parameters?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
export const OPERATION_TIMEOUT_MS = 15000; // 15s hard timeout

export class GuanjiaBusinessApiError extends Error {
  public readonly code: string;
  public readonly unknownOutcome: boolean;
  public readonly requestId?: string;
  public readonly runId?: string;
  public readonly skillId?: string;
  public readonly httpStatus?: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      unknownOutcome?: boolean;
      requestId?: string;
      runId?: string;
      skillId?: string;
      httpStatus?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'GuanjiaBusinessApiError';
    this.code = options.code;
    this.unknownOutcome = options.unknownOutcome ?? false;
    this.requestId = options.requestId;
    this.runId = options.runId;
    this.skillId = options.skillId;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, GuanjiaBusinessApiError.prototype);
  }
}

const FORBIDDEN_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'confirmationid',
  'confirmedby',
  'confirmed',
  'autoconfirm',
  'bypassapproval',
  'skipconfirmation',
  'forceexecute',
  'isconfirmed',
  'confirmaction',
  'token',
  'password',
  'secret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'credential',
  'credentials',
  'privatekey',
  'xtoken',
]);

export function assertAllowedModelParameters(
  params: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (depth > 10) {
    throw new GuanjiaBusinessApiError('参数嵌套深度超过最大限制 (10层)', {
      code: 'PARAM_DEPTH_EXCEEDED',
    });
  }

  if (params === null || params === undefined || typeof params !== 'object') {
    return;
  }

  if (seen.has(params)) {
    throw new GuanjiaBusinessApiError('检测到参数结构包含循环引用', {
      code: 'PARAM_CIRCULAR_REFERENCE',
    });
  }
  seen.add(params);

  if (Array.isArray(params)) {
    for (const item of params) {
      assertAllowedModelParameters(item, depth + 1, seen);
    }
    return;
  }

  for (const key of Object.keys(params)) {
    const lowerKey = key.toLowerCase();
    const normalizedKey = lowerKey.replace(/[-_]/g, '');

    if (FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey)) {
      throw new GuanjiaBusinessApiError(
        `参数中包含被禁用的安全字段: "${key}"，动账确认与凭据相关参数禁止由模型提供`,
        { code: 'FORBIDDEN_PARAMETER' },
      );
    }

    if (
      lowerKey.includes('token') ||
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('credential')
    ) {
      throw new GuanjiaBusinessApiError(`参数中包含被禁用的敏感凭据字段: "${key}"`, {
        code: 'FORBIDDEN_PARAMETER',
      });
    }

    if (
      normalizedKey.includes('confirmationid') ||
      normalizedKey.includes('confirmedby') ||
      normalizedKey.includes('autoconfirm') ||
      normalizedKey.includes('bypassapproval')
    ) {
      throw new GuanjiaBusinessApiError(`参数中包含被禁用的确认规避字段: "${key}"`, {
        code: 'FORBIDDEN_PARAMETER',
      });
    }

    assertAllowedModelParameters((params as Record<string, unknown>)[key], depth + 1, seen);
  }
}

function sanitizeErrorMessage(msg: string, exactToken?: string): string {
  if (!msg || typeof msg !== 'string') return '业务请求失败';
  let sanitized = msg;
  if (exactToken && exactToken.trim()) {
    sanitized = sanitized.split(exactToken.trim()).join('***REDACTED_TOKEN***');
  }
  sanitized = sanitized
    .replace(
      /(?:token|bearer|password|secret|credential|key)[=:\s]+[A-Za-z0-9_\-.]{6,}/gi,
      '***REDACTED***',
    )
    .replace(/[a-f0-9]{32,}/gi, '***REDACTED_HASH***');
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200) + '...';
  }
  return sanitized;
}

function combineSignals(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, callerSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (callerSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  callerSignal.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

async function readBoundedStream(
  res: Response,
  maxBytes: number,
  requestId: string,
  isMutation: boolean,
  runId?: string,
  skillId?: string,
): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!Number.isNaN(len) && len > maxBytes) {
      throw new GuanjiaBusinessApiError(
        isMutation
          ? '动账或业务写操作响应内容超出 1MB 限制，服务端可能已执行。执行结果未知。'
          : '服务端响应内容超出 1MB 限制',
        {
          code: isMutation ? 'MUTATION_RESPONSE_TOO_LARGE_UNKNOWN_OUTCOME' : 'RESPONSE_TOO_LARGE',
          unknownOutcome: isMutation,
          requestId,
          runId,
          skillId,
          httpStatus: res.status,
        },
      );
    }
  }

  if (!res.body) {
    return '';
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore stream cancel failure
          }
          throw new GuanjiaBusinessApiError(
            isMutation
              ? '动账或业务写操作响应流超出 1MB 限制，服务端可能已执行。执行结果未知。'
              : '服务端响应流超出 1MB 限制',
            {
              code: isMutation
                ? 'MUTATION_RESPONSE_TOO_LARGE_UNKNOWN_OUTCOME'
                : 'RESPONSE_TOO_LARGE',
              unknownOutcome: isMutation,
              requestId,
              runId,
              skillId,
              httpStatus: res.status,
            },
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

export interface RequestGuanjiaBusinessApiOptions {
  path: AllowedGuanjiaApiPath;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  expectedGeneration: number;
  signal?: AbortSignal;
}

export async function requestGuanjiaBusinessApi(
  options: RequestGuanjiaBusinessApiOptions,
): Promise<Record<string, unknown>> {
  const callerRequestId =
    typeof options.body?.request_id === 'string' && options.body.request_id.trim()
      ? options.body.request_id.trim()
      : typeof options.body?.requestId === 'string' && options.body.requestId.trim()
        ? options.body.requestId.trim()
        : undefined;

  const requestId = callerRequestId || `req_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  let cleanPath: string;
  let queryParamsFromPath: URLSearchParams | null = null;
  try {
    const parsedPathUrl = new URL(options.path, 'https://guanjia.local');
    cleanPath = parsedPathUrl.pathname;
    if (parsedPathUrl.search) {
      queryParamsFromPath = parsedPathUrl.searchParams;
    }
  } catch {
    cleanPath = String(options.path || '').split('?')[0];
  }

  if (!ALLOWED_GUANJIA_API_PATHS.has(cleanPath)) {
    throw new GuanjiaBusinessApiError(`禁止访问非白名单业务接口路径: "${cleanPath}"`, {
      code: 'DISALLOWED_PATH',
      requestId,
    });
  }

  const actualRunId =
    typeof options.body?.run_id === 'string'
      ? options.body.run_id
      : typeof options.body?.runId === 'string'
        ? options.body.runId
        : queryParamsFromPath?.get('run_id') || queryParamsFromPath?.get('runId') || undefined;

  const actualSkillId =
    typeof options.body?.skill_id === 'string'
      ? options.body.skill_id
      : typeof options.body?.skillId === 'string'
        ? options.body.skillId
        : queryParamsFromPath?.get('skill_id') || queryParamsFromPath?.get('skillId') || undefined;

  let effectiveMethod: 'GET' | 'POST';
  if (cleanPath === '/api/c/ai/skills/list' || cleanPath === '/api/c/ai/skills/installed') {
    if (options.method && options.method !== 'GET') {
      throw new GuanjiaBusinessApiError(`接口路径 "${cleanPath}" 服务端仅支持 GET 请求`, {
        code: 'INVALID_METHOD',
        requestId,
      });
    }
    effectiveMethod = 'GET';
  } else {
    if (options.method && options.method !== 'POST') {
      throw new GuanjiaBusinessApiError(`接口路径 "${cleanPath}" 服务端仅支持 POST 请求`, {
        code: 'INVALID_METHOD',
        requestId,
      });
    }
    effectiveMethod = 'POST';
  }

  const isMutation =
    cleanPath === '/api/c/ai/skills/execute' || cleanPath === '/api/c/ai/skills/runs/confirm';

  const session = GuanjiaSession.getInstance();
  const snapshot = session.getSnapshot();
  const credentials = session.getCredentials();

  if (snapshot.status !== 'authenticated') {
    throw new GuanjiaBusinessApiError('智慧管家未登录或认证已失效，拒绝发起业务请求', {
      code: 'UNAUTHENTICATED',
      requestId,
    });
  }

  if (!snapshot.user || !snapshot.user.id || !String(snapshot.user.id).trim()) {
    throw new GuanjiaBusinessApiError('智慧管家身份缺失员工信息(user.id)', {
      code: 'MISSING_USER',
      requestId,
    });
  }

  if (!snapshot.store || !snapshot.store.id || !String(snapshot.store.id).trim()) {
    throw new GuanjiaBusinessApiError('智慧管家当前未选择有效门店(store.id)，拒绝发起业务请求', {
      code: 'MISSING_STORE',
      requestId,
    });
  }

  const tenantId = snapshot.user.tenantId;
  if (tenantId === undefined || tenantId === null || String(tenantId).trim() === '') {
    throw new GuanjiaBusinessApiError('智慧管家身份缺少租户ID (tenant_id)', {
      code: 'MISSING_TENANT_ID',
      requestId,
    });
  }

  if (!credentials?.token || typeof credentials.token !== 'string' || !credentials.token.trim()) {
    throw new GuanjiaBusinessApiError('智慧管家凭据缺失有效 Token', {
      code: 'MISSING_TOKEN',
      requestId,
    });
  }

  if (snapshot.generation !== options.expectedGeneration) {
    throw new GuanjiaBusinessApiError(
      `会话 generation 不匹配 (期望: ${options.expectedGeneration}, 当前: ${snapshot.generation})`,
      {
        code: 'GENERATION_MISMATCH',
        requestId,
      },
    );
  }

  const workspaceManager = GuanjiaWorkspaceManager.getInstance();
  const rawBaseUrl = workspaceManager.getDefaultUrl() || 'https://guanjia.qszy.me/';
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new GuanjiaBusinessApiError('智慧管家服务端基础地址格式无效', {
      code: 'INVALID_BASE_URL',
      requestId,
    });
  }

  if (parsedBaseUrl.protocol !== 'https:') {
    const isLoopback =
      parsedBaseUrl.hostname === 'localhost' || parsedBaseUrl.hostname === '127.0.0.1';
    if (!isLoopback) {
      throw new GuanjiaBusinessApiError('智慧管家服务端基础地址必须使用安全 HTTPS 协议', {
        code: 'INSECURE_PROTOCOL',
        requestId,
      });
    }
  }

  const targetUrl = new URL(cleanPath, parsedBaseUrl.origin);
  if (targetUrl.origin !== parsedBaseUrl.origin) {
    throw new GuanjiaBusinessApiError('拒绝跨源请求目标地址', {
      code: 'CROSS_ORIGIN_REJECTED',
      requestId,
    });
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Token': credentials.token,
    'X-Request-ID': requestId,
  };

  if (snapshot.store.id) {
    headers['X-Store-Id'] = String(snapshot.store.id);
  }
  if (snapshot.store.code) {
    headers['X-Store-Code'] = String(snapshot.store.code);
  }

  let serializedBody: string | undefined;

  if (effectiveMethod === 'POST') {
    headers['Content-Type'] = 'application/json';

    // For execute, strictly validate entire payload including top level and nested parameters
    if (cleanPath === '/api/c/ai/skills/execute') {
      if (options.body) {
        assertAllowedModelParameters(options.body);
      }
    }

    const postBody: Record<string, unknown> = { ...(options.body || {}) };
    if (
      (cleanPath === '/api/c/ai/skills/runs/get' ||
        cleanPath === '/api/c/ai/skills/runs/confirm') &&
      !postBody.run_id &&
      actualRunId
    ) {
      postBody.run_id = actualRunId;
    }
    // Synchronize request_id in body to match header exactly
    postBody.request_id = requestId;

    serializedBody = JSON.stringify(postBody);
    if (Buffer.byteLength(serializedBody, 'utf8') > MAX_PAYLOAD_SIZE) {
      throw new GuanjiaBusinessApiError('请求体大小超出 1MB 限制', {
        code: 'PAYLOAD_TOO_LARGE',
        requestId,
        runId: actualRunId,
        skillId: actualSkillId,
      });
    }
  } else {
    if (queryParamsFromPath) {
      for (const [k, v] of queryParamsFromPath.entries()) {
        targetUrl.searchParams.set(k, v);
      }
    }
    if (options.body) {
      assertAllowedModelParameters(options.body);
      for (const [k, v] of Object.entries(options.body)) {
        if (v !== undefined && v !== null) {
          targetUrl.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      }
    }
  }

  const token = credentials.token;
  let res: Response;
  let rawText: string;
  let parsed: Record<string, unknown> | null = null;

  // Wrap entire fetch + bounded stream read + JSON parse to preserve unknownOutcome for mutations
  try {
    res = await fetch(targetUrl.toString(), {
      method: effectiveMethod,
      headers,
      body: effectiveMethod === 'POST' ? serializedBody : undefined,
      redirect: 'error',
      signal: combineSignals(OPERATION_TIMEOUT_MS, options.signal),
    });

    rawText = await readBoundedStream(
      res,
      MAX_PAYLOAD_SIZE,
      requestId,
      isMutation,
      actualRunId,
      actualSkillId,
    );

    try {
      parsed = rawText.trim() ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    } catch (jsonErr) {
      throw new GuanjiaBusinessApiError(
        isMutation
          ? '动账或业务写操作服务端响应非有效 JSON 格式，执行结果未知。请勿自动重试。'
          : `服务端响应非有效 JSON 格式 (HTTP ${res.status})`,
        {
          code: isMutation ? 'MUTATION_INVALID_JSON_UNKNOWN_OUTCOME' : 'INVALID_JSON_RESPONSE',
          unknownOutcome: isMutation,
          requestId,
          runId: actualRunId,
          skillId: actualSkillId,
          httpStatus: res.status,
          cause: jsonErr,
        },
      );
    }
  } catch (err: unknown) {
    if (err instanceof GuanjiaBusinessApiError) {
      throw err;
    }

    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout/i.test(err.message));

    if (isTimeout) {
      if (isMutation) {
        throw new GuanjiaBusinessApiError(
          '动账或业务写操作请求超时(15s)，服务端执行结果未知。请勿自动重试，请检查待确认任务或运行状态。',
          {
            code: 'MUTATION_TIMEOUT_UNKNOWN_OUTCOME',
            unknownOutcome: true,
            requestId,
            runId: actualRunId,
            skillId: actualSkillId,
            cause: err,
          },
        );
      }
      throw new GuanjiaBusinessApiError('只读业务接口请求超时(15s)', {
        code: 'REQUEST_TIMEOUT',
        unknownOutcome: false,
        requestId,
        runId: actualRunId,
        skillId: actualSkillId,
        cause: err,
      });
    }

    if (isMutation) {
      throw new GuanjiaBusinessApiError(
        '动账或业务写操作执行或读取阶段发生异常，服务端处理结果未知。请勿自动重发重试。',
        {
          code: 'MUTATION_NETWORK_ERROR_UNKNOWN_OUTCOME',
          unknownOutcome: true,
          requestId,
          runId: actualRunId,
          skillId: actualSkillId,
          cause: err,
        },
      );
    }

    throw new GuanjiaBusinessApiError('业务接口网络请求失败', {
      code: 'NETWORK_ERROR',
      unknownOutcome: false,
      requestId,
      runId: actualRunId,
      skillId: actualSkillId,
      cause: err,
    });
  }

  if (!res.ok) {
    const isServerFault = res.status >= 500 || res.status === 408 || res.status === 504;
    const isUnknownOutcomeOnHttpError = isMutation && isServerFault;
    let serverMessage = `业务接口请求失败 (HTTP ${res.status})`;
    let serverErrorCode = 'HTTP_ERROR';
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string') {
        serverMessage = parsed.message;
      } else if (typeof parsed.error === 'string') {
        serverMessage = parsed.error;
      } else if (parsed.error && typeof parsed.error === 'object') {
        const errObj = parsed.error as Record<string, unknown>;
        if (typeof errObj.message === 'string') {
          serverMessage = errObj.message;
        }
        if (typeof errObj.code === 'string') {
          serverErrorCode = String(errObj.code);
        }
      }
    }
    serverMessage = sanitizeErrorMessage(serverMessage, token);

    throw new GuanjiaBusinessApiError(serverMessage, {
      code: serverErrorCode,
      unknownOutcome: isUnknownOutcomeOnHttpError,
      httpStatus: res.status,
      requestId,
      runId: actualRunId,
      skillId: actualSkillId,
    });
  }

  if (!parsed || typeof parsed !== 'object' || parsed.success !== true) {
    let failMsg = '业务接口返回失败状态';
    let failCode = 'API_EXECUTION_FAILED';
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string') {
        failMsg = sanitizeErrorMessage(parsed.message, token);
      } else if (typeof parsed.error === 'string') {
        failMsg = sanitizeErrorMessage(parsed.error, token);
      } else if (parsed.error && typeof parsed.error === 'object') {
        const errObj = parsed.error as Record<string, unknown>;
        if (typeof errObj.message === 'string')
          failMsg = sanitizeErrorMessage(errObj.message, token);
        if (typeof errObj.code === 'string') failCode = String(errObj.code);
      }
    }
    throw new GuanjiaBusinessApiError(failMsg, {
      code: failCode,
      requestId,
      runId: actualRunId,
      skillId: actualSkillId,
      httpStatus: res.status,
    });
  }

  const postSnapshot = GuanjiaSession.getInstance().getSnapshot();
  if (
    postSnapshot.status !== 'authenticated' ||
    postSnapshot.generation !== options.expectedGeneration ||
    !postSnapshot.user ||
    !postSnapshot.user.id ||
    !postSnapshot.store ||
    !postSnapshot.store.id
  ) {
    throw new GuanjiaBusinessApiError(
      `会话在请求执行期间已失效或发生变更 (期望 generation: ${options.expectedGeneration}, 当前: ${postSnapshot.generation})，丢弃本次响应`,
      {
        code: 'STALE_GENERATION_DISCARDED',
        requestId,
        runId: actualRunId,
        skillId: actualSkillId,
      },
    );
  }

  if (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data)) {
    if (Array.isArray(parsed.data)) {
      return { items: parsed.data };
    }
    throw new GuanjiaBusinessApiError('服务端返回的数据格式异常，缺少有效的 data 对象', {
      code: 'INVALID_DATA_FORMAT',
      requestId,
      runId: actualRunId,
      skillId: actualSkillId,
    });
  }

  return parsed.data as Record<string, unknown>;
}

export function isAllowedCatalogSkill(skill: Record<string, unknown>): boolean {
  const skillId = String(skill.skill_id ?? skill.id ?? skill.skillId ?? '')
    .trim()
    .toLowerCase();
  if (!skillId) return false;

  if (PROHIBITED_CATALOG_SKILL_IDS.has(skillId)) return false;

  if (
    skillId.includes('confirm') ||
    skillId.includes('system_api') ||
    skillId.includes('draft') ||
    skillId.includes('deploy') ||
    skillId.includes('review')
  ) {
    return false;
  }

  const status = String(skill.status ?? '').toLowerCase();
  if (status !== 'published' || skill.installed !== true || typeof skill.skill_id !== 'string' || !skill.input_schema || typeof skill.input_schema !== 'object') return false;
  const document = skill.document;
  if (document && typeof document === 'object') {
    const text = JSON.stringify(document).toLowerCase();
    if (/(confirm_pending_action|call_system_api|create_skill|deploy_skill|manage_permissions|system_shell|browser_action|network_fetch|runs\/confirm)/.test(text)) return false;
  }
  return true;
}

export async function fetchAuthorizedSkillsCatalog(options: {
  expectedGeneration: number;
  signal?: AbortSignal;
}): Promise<AuthorizedSkillItem[]> {
  const catalog = await requestGuanjiaBusinessApi({
    path: '/api/c/ai/skills/list', method: 'GET',
    body: { installed_filter: 'installed', page: 1, page_size: 100 },
    expectedGeneration: options.expectedGeneration, signal: options.signal,
  });
  if (!Array.isArray(catalog.skills)) throw new GuanjiaBusinessApiError('技能目录格式异常', { code: 'INVALID_CATALOG' });
  const publishedIds = new Set(catalog.skills.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .filter(item => item.status === 'published').map(item => item.skill_id));
  const res = await requestGuanjiaBusinessApi({
    path: '/api/c/ai/skills/installed',
    method: 'GET',
    expectedGeneration: options.expectedGeneration,
    signal: options.signal,
  });

  const rawSkills = Array.isArray(res.skills)
    ? (res.skills as Record<string, unknown>[])
    : Array.isArray(res.items)
      ? (res.items as Record<string, unknown>[])
      : [];

  const authorized: AuthorizedSkillItem[] = [];
  for (const raw of rawSkills) {
    if (!raw || typeof raw !== 'object' || !publishedIds.has(raw.skill_id) || !isAllowedCatalogSkill(raw)) {
      continue;
    }
    authorized.push({
      skillId: String(raw.skill_id ?? raw.id ?? raw.skillId ?? '').trim(),
      name: String(raw.name ?? raw.title ?? raw.skill_id ?? ''),
      description: String(raw.description ?? raw.summary ?? ''),
      category: typeof raw.category === 'string' ? raw.category : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      installed: raw.installed === true,
      status: String(raw.status),
      parameters:
        raw.input_schema && typeof raw.input_schema === 'object' && !Array.isArray(raw.input_schema)
          ? (raw.input_schema as Record<string, unknown>)
          : undefined,
      raw,
    });
  }
  return authorized;
}

Object.freeze(requestGuanjiaBusinessApi);
Object.freeze(assertAllowedModelParameters);
Object.freeze(fetchAuthorizedSkillsCatalog);
Object.freeze(isAllowedCatalogSkill);
Object.freeze(GuanjiaBusinessApiError);
