import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { isGuanjiaScopedSessionKey } from "./sessionKey";

type PluginConfig = {
  callbackUrl: string;
  secret: string;
  requestTimeoutMs: number;
};

type GuanjiaToolRequest = {
  toolName: string;
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
};

type GuanjiaToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === "object" && !Array.isArray(value);
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === "string" ? raw.callbackUrl.trim() : "",
    secret: typeof raw.secret === "string" ? raw.secret.trim() : "",
    requestTimeoutMs: typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs >= 1000
      ? raw.requestTimeoutMs
      : DEFAULT_TIMEOUT_MS,
  };
};

async function callGuanjiaBridge(
  config: PluginConfig,
  request: GuanjiaToolRequest,
  signal?: AbortSignal,
): Promise<GuanjiaToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(config.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-bridge-secret": config.secret,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      return parsed as GuanjiaToolResponse;
    }
    throw new Error(`Guanjia tool bridge HTTP ${response.status}: ${text.trim().slice(0, 200) || response.statusText}`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        content: [{
          type: "text",
          text: signal?.aborted ? "操作已取消。" : "请求超时，未能确认服务端执行结果。",
        }],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `智慧管家服务调用失败: ${message}` }],
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

const GetContextSchema = Type.Object({});

const ListSkillsSchema = Type.Object({
  category: Type.Optional(Type.String({ description: "可选的技能分类筛选" })),
});

const ExecuteSkillSchema = Type.Object({
  skillId: Type.String({ minLength: 1, description: "要执行的管家正式业务技能标识" }),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "技能参数。严禁传入 confirmation_id 或任何试图绕过店员确认的参数。",
  })),
});

const GetRunStatusSchema = Type.Object({
  runId: Type.String({ minLength: 1, description: "业务运行标识 run_id" }),
});

const PROHIBITED_ARGS = new Set([
  "confirmation_id",
  "confirm_token",
  "auto_confirm",
  "bypass_approval",
  "force_execute",
]);

const ALLOWED_TOOL_NAMES = new Set([
  "guanjia_get_context",
  "guanjia_list_skills",
  "guanjia_execute_skill",
  "guanjia_get_run_status",
]);

const plugin = {
  id: "guanjia-tools",
  name: "GuanjiaTools",
  description: "Scoped business tools for Smart Butler (智慧管家) store operations.",
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info("[guanjia-tools] skipped: callbackUrl or secret not configured.");
      return;
    }

    // 1. guanjia_get_context
    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? "";
      if (ctx.agentId !== "guanjia-assistant" || !isGuanjiaScopedSessionKey(sessionKey)) return null;
      return {
        name: "guanjia_get_context",
        label: "Guanjia Context",
        description: "获取当前智慧管家登录店员与当前操作门店的业务上下文信息（已核验的非敏感身份及门店信息）。",
        parameters: GetContextSchema,
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const args = isRecord(params) ? params : {};
          return callGuanjiaBridge(config, {
            toolName: "guanjia_get_context",
            args,
            context: { sessionKey, toolCallId: id },
          }, signal);
        },
      };
    }, { name: "guanjia_get_context", optional: true });

    // 2. guanjia_list_skills
    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? "";
      if (ctx.agentId !== "guanjia-assistant" || !isGuanjiaScopedSessionKey(sessionKey)) return null;
      return {
        name: "guanjia_list_skills",
        label: "Guanjia List Skills",
        description: "列出当前门店与店员权限下已开放执行的管家正式业务技能目录。",
        parameters: ListSkillsSchema,
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const args = isRecord(params) ? params : {};
          return callGuanjiaBridge(config, {
            toolName: "guanjia_list_skills",
            args,
            context: { sessionKey, toolCallId: id },
          }, signal);
        },
      };
    }, { name: "guanjia_list_skills", optional: true });

    // 3. guanjia_execute_skill
    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? "";
      if (ctx.agentId !== "guanjia-assistant" || !isGuanjiaScopedSessionKey(sessionKey)) return null;
      return {
        name: "guanjia_execute_skill",
        label: "Guanjia Execute Skill",
        description: "请求执行智慧管家正式业务技能。注意：凡涉及资金动账或写操作，服务端将生成待确认任务，必须由店员在界面手动确认后才能执行，模型禁止自行确认。",
        parameters: ExecuteSkillSchema,
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const args = isRecord(params) ? params : {};
          const pObj = isRecord(args.parameters) ? args.parameters : {};
          for (const key of Object.keys(pObj)) {
            if (PROHIBITED_ARGS.has(key.toLowerCase())) {
              return {
                content: [{
                  type: "text",
                  text: `禁止参数: 检测到试图绕过确认的参数 "${key}"，系统已硬性拒绝执行。动账与重要写操作必须由店员在界面上确认。`,
                }],
                isError: true,
              };
            }
          }
          return callGuanjiaBridge(config, {
            toolName: "guanjia_execute_skill",
            args,
            context: { sessionKey, toolCallId: id },
          }, signal);
        },
      };
    }, { name: "guanjia_execute_skill", optional: true });

    // 4. guanjia_get_run_status
    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? "";
      if (ctx.agentId !== "guanjia-assistant" || !isGuanjiaScopedSessionKey(sessionKey)) return null;
      return {
        name: "guanjia_get_run_status",
        label: "Guanjia Get Run Status",
        description: "查询当前会话发起的业务技能运行状态（待确认、已完成、失败等）。只能查询当前会话所有的 run_id。",
        parameters: GetRunStatusSchema,
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const args = isRecord(params) ? params : {};
          return callGuanjiaBridge(config, {
            toolName: "guanjia_get_run_status",
            args,
            context: { sessionKey, toolCallId: id },
          }, signal);
        },
      };
    }, { name: "guanjia_get_run_status", optional: true });

    // Host ringzero blocker via hook api.on('before_tool_call', (event, ctx) => ...)
    const apiWithHooks = api as unknown as {
      on?: (
        event: string,
        handler: (event: { toolName?: string; [key: string]: unknown }, ctx: { sessionKey?: string; agentId?: string; [key: string]: unknown }) => { block?: boolean; blockReason?: string } | void
      ) => void;
    };

    if (typeof apiWithHooks.on !== "function") {
      throw new Error("Guanjia requires before_tool_call enforcement; business tools remain unavailable.");
    }
    if (typeof apiWithHooks.on === "function") {
      apiWithHooks.on("before_tool_call", (event, ctx) => {
        const agentId = ctx?.agentId ?? "";
        const sessionKey = ctx?.sessionKey ?? "";
        const isGuanjia = agentId === "guanjia-assistant" || isGuanjiaScopedSessionKey(sessionKey);

        if (isGuanjia) {
          const tool = event?.toolName ?? "";
          if (agentId !== "guanjia-assistant" || !isGuanjiaScopedSessionKey(sessionKey) || !ALLOWED_TOOL_NAMES.has(tool)) {
            api.logger.warn(`[Ringzero Blocker] Blocked non-business tool "${tool}" for Guanjia Assistant`);
            return {
              block: true,
              blockReason: `[Ringzero Security Policy] Tool "${tool}" is prohibited for Guanjia Assistant. Only scoped business tools are permitted.`,
            };
          }
        }
      });
    }

    api.logger.info("[guanjia-tools] registered 4 scoped business tools with optional discovery and ringzero guard.");
  },
};

export default plugin;
