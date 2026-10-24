/**
 * Pi SDK 接线（方案 §3）。
 *
 * **本文件是整个仓库里唯一 import Pi SDK 业务 API 的地方。**
 * 将来 SDK 签名 / 事件名漂移，只改这里（外加 `protocol.js` 里的纯函数判断）。
 *
 * 已实测事实（勿按直觉改）——出处：`spike/pi-sdk/`（offline + live 各一轮）：
 *   1. `session.prompt()` 在工作期间**必须**指定 `streamingBehavior`，否则抛
 *      `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."`
 *   2. `prompt()` 的 Promise **直到整轮跑完才 resolve** ⇒ 不能拿它做「已接受」反馈；
 *      「已接受」改用 `preflightResult` 回调（实测只给一个 boolean）。
 *   3. `queue_update` 的 `steering` / `followUp` 是「**尚未投递**的消息文本数组」，
 *      投递后会被移出 ⇒ 这个和会「先升后降」，是「排队 N 条」而非「第 N 位」。
 *   4. `tool_execution_start` 的参数字段名是 **`args`**，扩展侧 `tool_call` 是 **`input`**。
 *   5. `navigateTree()` 忙时是 **rejected Promise**（不是同步 throw）。本期不调用它。
 *
 * 另有两条安全边界（写进注释，别在实现里想当然）：
 *   · 闸门只覆盖**本会话**的工具调用；第三方扩展（官方 subagent 示例用 spawn 起独立进程）
 *     可以绕过 ⇒ `noExtensions: true`（§3.3 取「干脆禁止此类扩展」这一支）。
 *   · `repo` 场景的审批闸门为 **M4 已实现**（规则 2，见 `registerGate`）：
 *     `bash` / `edit` / `write` / `powershell` 调用会弹审批卡等用户决策；
 *     审批实例由 `main/index.js` 构造后经构造函数注入（`options.approval`）。
 *
 * ⚠ v0.4 M5 的 `generateStructured()` **已改为 `ModelRuntime.completeSimple()` 旁路**
 *   （详见该方法的 JSDoc）。它不再是「退而求其次」分支：一次独立模型调用，
 *   零事件、零会话历史、零队列占用 —— 用户点导出时不会再看到一条莫名其妙的问答。
 *   代价是**没有会话隐式上下文**，所以素材改由 `recentTranscript()` 显式提供。
 *
 *   历史（供追溯，勿据此改回）：M5 首版用的是 `session.prompt(instruction, {streamingBehavior})` +
 *   临时订阅收 `text_delta`。那版**必然**把指令与回答追加进 Pi 历史，且主订阅
 *   `_subscribe()` 一直在跑 ⇒ 抽取指令与模型吐的 JSON 都会被当成对话推给渲染层。
 *   这条路径已整体废弃，别把两套混在一起。
 */

import os from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";

import { MinipiCredentialStore } from "./credentials-store.js";

import {
  DEFAULT_MODEL_PREFERENCE,
  DEFAULT_SCENE_ID,
  ERROR_CODES,
  LIMITS,
  APPROVAL_TOOLS,
  OUTBOX_SCENES,
  PROVIDER_API_IDS,
  SESSION_DEFAULT_TITLE,
  SESSION_STATUS,
  STREAMING_BEHAVIOR,
  errorMessage,
  isSceneId,
  isSessionId,
  isStreamingBehavior,
  wrapEvent,
} from "../../shared/protocol.js";

import { OUTBOX_DIR } from "../settings.js";

import { SessionStore, sliceByCodePoint } from "../session-store.js";

import { ensureSceneCwd, resolveScene, sessionToolOptions } from "./scenes.js";

import { checkWriteTarget } from "./sandbox.js";
import { DEEPSEEK_PROVIDER_ID } from "./web/deepseek-web.js";
import { buildWebTools, createWebBudget } from "./web/tools.js";

import { redactSecrets } from "./approval.js";

/** 等 `preflightResult` 的窗口（对齐方案 §5 第 0 级的 0–300ms 预算）。 */
const PREFLIGHT_WAIT_MS = 250;

/**
 * 会话索引的最小写盘间隔（毫秒）。
 *
 * 为什么必须节流：事件流在流式期间是**逐 token** 的（`message_update` 一秒几十条）。
 * 每条都去 `fs.writeFileSync` 一份 index.json，等于拿磁盘换 seq —— 而且索引内容几乎不变。
 * 所以：普通活动 ≥1s 才写一次；**每条用户消息**与**每轮结束**强制写（这两个时点才是
 * 「列表看起来对不对」的关键：预览、标题、最后活动时间都在那里定格）。
 */
const INDEX_WRITE_MIN_INTERVAL_MS = 1000;

/** 恢复会话时回放给渲染层的历史消息上限（条）与单条文本上限（字符）。 */
const RESUME_HISTORY_MAX_MESSAGES = 40;
const RESUME_HISTORY_MAX_CHARS = 4000;

/**
 * 把可能含敏感信息 / 绝对路径的错误文本洗成可外发的说明。
 *
 * 规则（设计 §7.2）：家目录 → `~`；Windows / POSIX 绝对路径 → `<path:文件名>`；
 * **密钥值 → `<redacted>`**；压成单行并截断。
 * **绝不允许**把原样堆栈、密钥、数据库语句发给渲染层。
 *
 * ⚠ 第 3 步「密钥脱敏」**复用 `approval.js` 的 `redactSecrets()`**（全仓唯一实现），
 *   不在此处另抄正则 —— 避免两份脱敏实现漂移（P2-1 教训）。
 * ⚠ 顺序固定：**密钥脱敏在「路径替换之后、截断之前」**：
 *   · 若放截断之后 ⇒ 超长文本的密钥可能被截一半而漏脱；
 *   · 若放路径替换之前 ⇒ 可能与路径残留互相干扰。
 *
 * @param {unknown} input
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeDetail(input, maxLen = 300) {
  let s = input instanceof Error ? input.message : String(input ?? "");
  s = s.replace(/\r?\n/g, " ").trim();
  if (s.length === 0) s = "未知错误";

  const home = os.homedir();
  if (home) s = s.split(home).join("~");
  if (home) s = s.split(home.replace(/\\/g, "/")).join("~");

  // Windows 绝对路径 C:\a\b\c → <path:c>
  s = s.replace(/[A-Za-z]:[\\/][^\s'"，。；]*/g, (m) => `<path:${path.basename(m)}>`);
  // POSIX 绝对路径 /a/b/c → <path:c>（不碰 ~/ 开头的，便于保留可读的 ~/.minipi/...）
  s = s.replace(/(?<![\w~])\/(?:[\w.@-]+\/)+[\w.@-]+/g, (m) => `<path:${path.basename(m)}>`);

  // 密钥脱敏（第 3 步，复用唯一实现；必须在截断之前，见上方顺序说明）
  s = redactSecrets(s);

  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

/**
 * 从一条 Pi 消息的 `content` 里取纯文本。**纯函数**。
 *
 * `content` 有两种形态（`UserMessage`：`string | (Text|Image)[]`；
 * `AssistantMessage`：`(Text|Thinking|ToolCall)[]`），所以要分两路：
 *   · 字符串 ⇒ 直接用；
 *   · 数组 ⇒ 只拼 `type === "text"` 的 `text`，**不要 thinking / toolCall / image**。
 *
 * 取错类型后果很隐蔽：`thinking` 里全是「让我先想想…」，`toolCall` 里是工具参数，
 * 混进「对话素材」只会把模型带偏，也让用户看不懂导出为什么跑题。
 *
 * @param {unknown} content
 * @returns {string} 已 trim；取不到文本时为空串
 */
function messageTextOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
}

/** 环形事件缓冲（per-session）。 */
class RingLog {
  /** @param {number} max */
  constructor(max) {
    this.max = Math.max(1, max);
    /** @type {Array<{seq:number,sessionId:string,ts:number,event:unknown}>} */
    this.items = [];
  }

  /** @param {{seq:number}} wrapped */
  push(wrapped) {
    this.items.push(wrapped);
    const overflow = this.items.length - this.max;
    if (overflow > 0) this.items.splice(0, overflow);
  }

  /** @param {number} sinceSeq 只取 seq > sinceSeq 的 */
  since(sinceSeq) {
    const n = Number.isFinite(sinceSeq) ? sinceSeq : 0;
    return this.items.filter((w) => w.seq > n);
  }

  /** @param {number} [limit] */
  tail(limit = this.max) {
    const n = Math.max(0, Math.min(limit, this.items.length));
    return this.items.slice(this.items.length - n);
  }

  clear() {
    this.items.length = 0;
  }
}

/** 一个会话在主进程侧的全部状态。 */
class SessionRecord {
  /**
   * @param {object} o
   * @param {string} o.sessionId
   * @param {ReturnType<typeof resolveScene>} o.scene
   * @param {import("@earendil-works/pi-coding-agent").AgentSession} o.session
   * @param {() => void} o.unsubscribe
   * @param {boolean} [o.persisted] 正文是否落在我们的会话目录里（memory 场景为 false）
   */
  constructor({ sessionId, scene, session, unsubscribe, persisted = false }) {
    this.sessionId = sessionId;
    this.scene = scene;
    this.sceneId = scene.sceneId;
    this.cwd = scene.cwd;
    this.session = session;
    this.unsubscribe = unsubscribe;
    this.seq = 0;
    this.log = new RingLog(LIMITS.EVENT_LOG_MAX);
    this.status = SESSION_STATUS.IDLE;
    /** @type {string | null} */
    this.model = null;
    /** @type {string | null} */
    this.lastError = null;
    this.createdAt = Date.now();
    this.disposed = false;
    /** 是否需要在 `~/.minipi/sessions/index.json` 里维护这条会话 */
    this.persisted = persisted;
    /** 上次写索引的时间（节流用，见 INDEX_WRITE_MIN_INTERVAL_MS） */
    this.indexWriteAt = 0;
  }
}

/**
 * Pi 会话宿主：会话注册表 + 事件 → `seq` 包装 + 对外三个动作（create / prompt / abort）。
 *
 * 与 Electron 完全解耦（只通过注入的 `emit` 往外发），因此可以在纯 Node 下被测试
 * ——— `scripts/verify-stream.mjs` 就是这么跑的。
 */
/**
 * 把一份「模型偏好」解析成 Pi 的 `Model` 对象。
 * 接受三种形状（历史兼容，不要砍）：
 *   · `"provider/modelId"` 字符串
 *   · `{ provider, modelId }`
 *   · `{ provider, id }`
 * @param {unknown} pref
 * @param {(provider: string, modelId: string) => unknown} getModel
 * @returns {unknown} Model 对象；解析不出来返回 undefined
 */
function resolveModelPref(pref, getModel) {
  if (!pref) return undefined;
  if (typeof pref === "string") {
    const [provider, ...rest] = pref.split("/");
    return rest.length ? getModel(provider, rest.join("/")) : undefined;
  }
  const modelId = pref.modelId ?? pref.id;
  if (typeof pref.provider === "string" && typeof modelId === "string") return getModel(pref.provider, modelId);
  return undefined;
}

/**
 * 解析用户偏好；**偏好缺失/失效时回退到 `DEFAULT_MODEL_PREFERENCE`**。
 *
 * 为什么要兜底：本机 `~/.pi/agent/settings.json` 里的 `defaultProvider` 指向一个
 * **根本没注册**的 provider（`cc-switch-zhipu-glm`），于是 Pi 会自己回退到「碰巧排前面的」
 * `deepseek/deepseek-v4-pro` —— 用户看到的默认模型是随机的结果，不是我们的选择。
 * 显式兜底之后，「默认」这件事由 minipi 说了算。
 *
 * ⚠ 兜底只对「没选 / 选的东西不存在」生效；用户显式选中的模型永远优先。
 */
export function resolvePreferredModel(pref, getModel, fallback = DEFAULT_MODEL_PREFERENCE) {
  if (typeof getModel !== "function") return undefined;
  const chosen = resolveModelPref(pref, getModel);
  if (chosen) return chosen;
  return resolveModelPref(fallback, getModel);
}

/**
 * 把 minipi 的提供方定义翻成 Pi 的 `ProviderConfigInput`。**纯函数**。
 *
 * 关键映射（字段名两边不一样，别混）：
 *   minipi `displayName` → Pi `name`
 *   minipi `models[].id`  → Pi `models[].id`（`name` 缺省用 id 补）
 * 模型级也补 `api`：内置提供方被覆盖整个目录时，Provider 级 api 不一定能继承下来。
 *
 * @param {object} def 已归一化的定义（见 providers-store.js）
 * @returns {object} ProviderConfigInput
 */
export function toProviderConfigInput(def) {
  const out = {};
  if (typeof def?.displayName === "string" && def.displayName.length > 0) out.name = def.displayName;
  if (typeof def?.baseUrl === "string" && def.baseUrl.length > 0) out.baseUrl = def.baseUrl;
  if (typeof def?.api === "string" && def.api.length > 0) out.api = def.api;
  if (Array.isArray(def?.models)) {
    out.models = def.models.map((m) => {
      /** @type {Record<string, unknown>} */
      const model = { id: m.id, name: m.name || m.id };
      if (typeof def.api === "string" && def.api.length > 0) model.api = def.api;
      if (Number.isSafeInteger(m.contextWindow)) model.contextWindow = m.contextWindow;
      if (Number.isSafeInteger(m.maxTokens)) model.maxTokens = m.maxTokens;
      return model;
    });
  }
  return out;
}

/**
 * 把一份「提供方定义表」同步进运行时。**让运行时严格等于存储**：
 *   1. 先 `unregisterProvider` 掉「当前已注册、但目标里没有」的 id
 *      —— 实测这只摘掉我们注册的覆盖层，内置提供方会**回落到原始定义**（模型不丢）；
 *   2. 再按目标逐个 `registerProvider`。
 *
 * ⚠ 假设：本进程里只有 minipi 自己在调 `registerProvider`（我们没用扩展注册提供方）。
 *    若将来引入扩展提供方，这里要改成「只卸自己记录过的 id」。
 *
 * @param {import("@earendil-works/pi-coding-agent").ModelRuntime | undefined} runtime
 * @param {Record<string, object>} definitions
 * @returns {{ applied: string[], removed: string[], failed: Array<{id:string, reason:string}> }}
 */
export function applyProviderDefinitions(runtime, definitions) {
  const report = { applied: [], removed: [], failed: [] };
  if (!runtime || typeof runtime.registerProvider !== "function") return report;
  const want = definitions && typeof definitions === "object" ? definitions : {};

  const registered = typeof runtime.getRegisteredProviderIds === "function" ? runtime.getRegisteredProviderIds() : [];
  for (const id of registered) {
    if (want[id]) continue;
    try {
      runtime.unregisterProvider(id);
      report.removed.push(id);
    } catch (err) {
      report.failed.push({ id, reason: sanitizeDetail(err) });
    }
  }

  for (const [id, def] of Object.entries(want)) {
    try {
      runtime.registerProvider(id, toProviderConfigInput(def));
      report.applied.push(id);
    } catch (err) {
      report.failed.push({ id, reason: sanitizeDetail(err) });
    }
  }
  return report;
}

/**
 * 一次性取齐设置页要用的模型目录（脱敏：**绝不回传密钥**）。
 *
 * 返回形状对齐「提供方卡片」的信息架构：
 *   `{ provider, name, baseUrl, api, configured, authSource, custom, edited, modelsEdited, models[] }`
 *
 * `custom` 的判定需要**基线**：只有「minipi 定义里有、而基线（Pi 内置 + models.json）里没有」
 * 才算我们新建的提供方。基线由 `PiSessionHost.init()` 在注入定义**之前**抓下来传进来 ——
 * 不抓基线就分不清「我新建的」和「我覆盖的内置」。
 *
 * @param {import("@earendil-works/pi-coding-agent").ModelRuntime | undefined} runtime
 * @param {Record<string, object>} [definitions] minipi 自己的提供方定义
 * @param {Iterable<string>} [baselineIds] 注入定义**之前**就存在的提供方 id
 */
export function buildProviderCatalog(runtime, definitions = {}, baselineIds = []) {
  const providers = runtime?.getProviders?.() ?? [];
  const available = new Set((runtime?.getAvailableSnapshot?.() ?? []).map((m) => `${m.provider}/${m.id}`));
  const defs = definitions && typeof definitions === "object" ? definitions : {};
  const baseline = new Set(baselineIds);
  return providers.slice(0, LIMITS.PROVIDER_LIST_MAX).map((provider) => {
    const auth = runtime?.getProviderAuthStatus?.(provider.id) ?? { configured: false };
    const def = defs[provider.id];
    const models = (runtime?.getModels?.(provider.id) ?? [])
      .slice(0, LIMITS.PROVIDER_MODELS_MAX)
      .map((model) => ({
        modelId: model.id,
        name: model.name || model.id,
        api: typeof model.api === "string" ? model.api : null,
        contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
        maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
        available: available.has(`${provider.id}/${model.id}`),
      }));
    return {
      provider: provider.id,
      name: provider.name || provider.id,
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : null,
      // 该提供方当前的协议（取第一个带 api 的模型）——UI 编辑模型目录时用它预填
      api: models.find((m) => m.api)?.api ?? null,
      configured: auth.configured === true,
      authSource: typeof auth.source === "string" ? auth.source : null,
      /** minipi **新建**的提供方（基线里没有这个 id） */
      custom: Boolean(def) && !baseline.has(provider.id),
      /** minipi 里有这个 id 的定义（自定义 **或** 对内置的覆盖） */
      edited: Boolean(def),
      /** 定义里带了模型目录（= 替换整个目录，而不是只改端点） */
      modelsEdited: Array.isArray(def?.models) && def.models.length > 0,
      /** 定义里显式覆盖了 API 地址（UI 做「恢复默认模型目录」时要保住这个覆盖） */
      hasBaseUrlOverride: typeof def?.baseUrl === "string" && def.baseUrl.length > 0,
      models,
    };
  });
}

/**
 * P1-1：按模型**上下文窗口**算出这一轮实际允许的提示词上限（字符数）。
 *
 * ## 为什么需要一个"按模型算"的上限
 *
 * `LIMITS.PROMPT_MAX_CHARS = 32000` 是个**全局拍脑袋硬顶**，它只防"一次塞爆进程"，
 * 防不了"一次塞爆模型"：deepseek-flash 的 contextWindow 是 1,000,000 字符级别，
 * 而某些本地/小模型只有 4096 —— 同一个 32000 的上限，对小模型意味着**必然超窗**
 * （请求被厂商拒、或被静默截断到用户看不到中间那段）。
 * 于是「按窗口的 50% 给提示词留额度」是下限里的下限：剩下 50% 要留给
 * 系统提示、历史、工具定义与模型输出。
 *
 * ## 为什么是 `min(32000, floor(ctx * 0.5))`
 *
 *   · 乘 0.5 是**预算分配**，不是精度问题：提示词最多占一半窗口。
 *   · 再取 `min(32000, …)`：大窗口模型（1M / 10M）不该因此放宽 —— 32000 仍是
 *     单条用户输入的产品上限（长文请用文档入口，别拿聊天框当上传通道）。
 *     换句话说：`LIMITS.PROMPT_MAX_CHARS` 从"唯一上限"降级成"**上限的天花板**"，
 *     它的数值不变、语义收窄，`prompt.js` 完全不用动（D1c 常量漂移检查仍然成立）。
 *   · `Math.floor` 而不是四舍五入：宁可少 1 个字符，也别算出 4095.5 这种
 *     让边界断言摇摆的数。
 *
 * ## 为什么拿不到 contextWindow 时回落到 32000
 *
 * 三个来源都取不到时（老 provider 定义没写 `contextWindow`、SDK 版本换字段、
 * 恢复到一个已下架的模型）**不能**当成"窗口为 0"—— 那会把上限压成 0，
 * 用户一个字都发不出去，是比超窗严重得多的故障。缺信息时用最宽松的已知值
 * （= 天花板 32000）保守放行，让厂商侧去拒，而不是我们在本地先把人锁死。
 *
 * @param {unknown} contextWindow 模型的上下文窗口（token 数）；可能缺失 / null / 字符串
 * @returns {number} 本轮提示词允许的最大字符数（整数，≥ 0）
 */
export function promptCapFor(contextWindow) {
  /* 只接受"能当数字用"的值：`Number(null)` 是 0、`Number("")` 是 0，都会把上限压成 0，
     所以先用 `typeof` 挡掉 null / undefined / 空串，再判有限正数。
     字符串数字（"64000"）是允许的 —— 老的 providers.json 里可能存成字符串。 */
  const raw =
    typeof contextWindow === "number"
      ? contextWindow
      : typeof contextWindow === "string" && contextWindow.trim().length > 0
        ? Number(contextWindow)
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return LIMITS.PROMPT_MAX_CHARS;
  return Math.min(LIMITS.PROMPT_MAX_CHARS, Math.floor(raw * 0.5));
}

export function buildModelCatalog(runtime) {
  const available = new Set((runtime?.getAvailableSnapshot?.() ?? []).map((model) => `${model.provider}/${model.id}`));
  return (runtime?.getModels?.() ?? []).map((model) => {
    const auth = runtime?.getProviderAuthStatus?.(model.provider) ?? { configured: false };
    /**
     * D-08：把模型的**输入能力**透出到渲染层。
     *
     * 为什么必须在这里做、不能等渲染层自己判：
     *   · SDK 的模型定义里 `input?: ("text"|"image")[]`（`virtual-models.d.ts:85`），
     *     **缺省是有语义的** —— 虚拟模型注释写明「Defaults to text and images」，
     *     即"没写 input" ≠ "不支持图片"。但这是 SDK 对**虚拟模型**的默认；
     *     对真实模型的目录条目，没写就是不知道。渲染层无从区分「没写」和「不支持」，
     *     所以这里统一归一成数组：缺省给 `[]`（= 不知道/不支持），**绝不给 undefined**
     *     （`undefined` 过 IPC 的 structuredClone 会变成缺失键，渲染层 `x.input.includes`
     *     直接 TypeError，而这类崩溃发生在最不起眼的模型面板打开时）。
     *   · `canImage` 是给渲染层的**单一判据**：一个布尔值，不让每个调用点各自写一遍
     *     `Array.isArray(...) && includes("image")` —— 那种重复迟早有一处写反。
     *   · 复制一份而不是直接把 `model.input` 引用透出去：`getModels()` 返回的是 SDK
     *     内部 registry 的对象，渲染层改一下就会污染 registry（虽然跨 IPC 会克隆，
     *     但 `buildModelCatalog` 也会被主进程内直接调用）。
     */
    const input = Array.isArray(model.input) ? [...model.input] : [];
    return {
      provider: model.provider,
      modelId: model.id,
      name: model.name || model.id,
      available: available.has(`${model.provider}/${model.id}`),
      needsAuth: auth.configured !== true,
      /** 该模型接受的输入类型（`[]` = 未声明/不接受任何类型的显式声明，永不为 undefined） */
      input,
      /** 能不能接收图片（渲染层据此决定要不要给图片入口，别再各处重复推导） */
      canImage: input.includes("image"),
    };
  });
}

export class PiSessionHost {
  /**
   * @param {object} [options]
   * @param {(wrapped: {seq:number,sessionId:string,ts:number,event:unknown}) => void} [options.emit]
   * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
   * @param {number} [options.eventLogMax]
   * @param {() => (string|object|undefined)} [options.modelPreference]
   * @param {{request:Function,cancelBySession:Function}} [options.approval]
   *        M4 审批闸门（`ApprovalGate`，由 `main/index.js` 构造注入）。
   *        ⚠ 注入而非 import —— `session.js` 只 import SDK，**不替 approval 做 electron 的事**
   *        （设计 §1 第 7 条）。未注入时规则 2 退化为「放行」（等同 M4 之前行为）。
   */
  constructor(options = {}) {
    this._emit = typeof options.emit === "function" ? options.emit : () => {};
    this._logger = options.logger ?? console;
    this._eventLogMax = Number.isFinite(options.eventLogMax) ? options.eventLogMax : LIMITS.EVENT_LOG_MAX;
    /** @type {{request:Function,cancelBySession:Function}|null} */
    this._approval = options.approval ?? null;
    this._modelPreference = typeof options.modelPreference === "function" ? options.modelPreference : () => undefined;
    /**
     * minipi 自己的提供方定义存储（`~/.minipi/providers.json`）。
     * 注入而非 import —— 这样 `session.js` 依旧只有 SDK 一个外部依赖，
     * 而存储层（含原子写、白名单）能在纯 Node 下单独测。
     * @type {{get:Function,set:Function,remove:Function}|null}
     */
    this._providerStore = options.providerStore ?? null;
    /**
     * 会话元数据索引（`~/.minipi/sessions/index.json`，D-09 / B1-3）。
     * **注入优先**：`main/index.js` 传一份共享实例；纯 Node 测试可以传临时目录。
     * 没注入时**延迟**自建（构造期不碰磁盘）—— 这样 `verify-stream.mjs` 这类
     * 只测事件流的老脚本不需要改。`sessionStore` getter 是唯一取用入口。
     * @type {SessionStore | null}
     */
    this._sessionStore = options.sessionStore ?? null;
    /**
     * 「正在恢复中」的 id → Promise（BLK-2）。
     *
     * 为什么需要：`resumeSession` 里 `_records.set(id, rec)` 在**三个 await 之后**
     * （init / resourceLoader / createAgentSession）。双击会话行、或渲染层重放导致的两条
     * 并发 IPC，会在 set 之前双双通过 `live` 检查 ⇒ 两个 AgentSession 挂同一份 JSONL，
     * 各自按内存里的 leaf 往后 `appendFileSync` ⇒ 历史被写成两条分支（内容还在，但树是裂的）。
     * 用一张 in-flight 表把同一个 id 的并发请求**收成一个 Promise**，`finally` 清理。
     * @type {Map<string, Promise<object>>}
     */
    this._resuming = new Map();
    /**
     * 联网工具的单轮预算（搜索 / 抓取次数上限）。每次 `prompt()` 重置。
     * 放在 host 上而不是会话上：minipi 同一时刻只有一个活跃会话，
     * 而切换场景时旧会话会被释放 —— 挂在会话上反而要处理"预算跟着会话走"的复杂度。
     */
    this._webBudget = createWebBudget(options.webBudget);
    /**
     * 联网总开关。**默认开**（用户 2026-10-20 拍板）。
     * 关掉时 `_buildWebTools()` 返回空数组 ⇒ 会话不传 `customTools` ⇒ 模型连工具名都看不到。
     * ⚠ 工具集在**建会话时**确定，所以开关改变对**新会话**生效（与模型选择同一语义）。
     * @type {() => boolean}
     */
    this._webEnabled = typeof options.webEnabled === "function" ? options.webEnabled : () => true;
    /**
     * 注入定义**之前**的提供方 id 集合（Pi 内置 + models.json）。
     * 用来区分「minipi 新建的自定义提供方」与「被 minipi 覆盖的内置提供方」。
     * @type {Set<string> | null}
     */
    this._baselineProviderIds = null;

    /** @type {Map<string, SessionRecord>} */
    this._records = new Map();
    /** @type {import("@earendil-works/pi-coding-agent").ModelRuntime | null} */
    this._modelRuntime = null;
    /** @type {MinipiCredentialStore | null} */
    this._credentialStore = null;
    /** @type {Promise<unknown> | null} */
    this._initPromise = null;
    this._sessionCounter = 0;
    /** @type {string | null} */
    this._lastSessionId = null;
  }

  /** 模型运行时是否已就绪。 */
  get isReady() {
    return this._modelRuntime !== null;
  }

  /** 最近一个会话的 id（渲染层重载时用来重放事件）。 */
  get lastSessionId() {
    return this._lastSessionId;
  }

  /**
   * 会话元数据索引（惰性自建）。
   *
   * ⚠ 只在**第一次真正用到**时才实例化：构造 `PiSessionHost` 不应该产生任何磁盘副作用
   * （老脚本 / 单测里构造它只是为了测事件流）。
   */
  get sessionStore() {
    if (!this._sessionStore) this._sessionStore = new SessionStore({ logger: this._logger });
    return this._sessionStore;
  }

  /**
   * 建 `ModelRuntime`（**复用** `~/.pi/agent/auth.json`，不自建 API key）。
   * 可重复调用；并发调用共用同一个 Promise。
   */
  async init() {
    if (this._modelRuntime) return this._modelRuntime;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const fallbackRead = typeof readStoredCredential === "function" ? (providerId) => readStoredCredential(providerId) : undefined;
        const credentials = new MinipiCredentialStore({ fallbackRead });
        this._credentialStore = credentials;
        const rt = await ModelRuntime.create({ credentials });
        this._modelRuntime = rt;
        // 基线：**注入我们自己的定义之前**就已存在的提供方（Pi 内置 + models.json）。
        // 有了它才能区分「minipi 新建的自定义提供方」和「被 minipi 覆盖的内置提供方」。
        this._baselineProviderIds = new Set((rt.getProviders?.() ?? []).map((p) => p.id));
        // 把 minipi 自己的提供方定义（自定义 / 覆盖）注入运行时。
        // 放在 create() 之后、任何人拿 runtime 之前 —— 这样第一个会话建出来就带着覆盖。
        this._applyProviders();
        return rt;
      })();
    }
    try {
      return await this._initPromise;
    } catch (err) {
      this._initPromise = null; // 允许下次重试
      throw new Error(
        errorMessage(
          ERROR_CODES.PI_UNAVAILABLE,
          `模型服务不可用：请点「模型设置」填入 API Key 并选择一个模型；若是自定义服务商，检查「自定义提供方」里的 API 地址是否正确。（详情：${sanitizeDetail(err)}）`,
        ),
      );
    }
  }

  /**
   * 读 DeepSeek 的 API Key（**只读不写**）。
   * 优先 minipi 自己的 `~/.minipi/credentials.json`，读不到回退 Pi 的 `auth.json`
   * —— 这与模型侧完全同一条链路，所以"用户配一次，模型与联网都通"。
   * @returns {Promise<string|null>}
   */
  async _readWebKey() {
    try {
      const cred = await this._credentialStore?.read(DEEPSEEK_PROVIDER_ID);
      if (cred && cred.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0) {
        return cred.key;
      }
    } catch (err) {
      this._logger.warn?.(`[minipi:pi] 读取联网密钥失败：${sanitizeDetail(err)}`);
    }
    return null;
  }

  /**
   * 造联网工具集。无 Key 时返回空数组（调用方据此不传 `customTools`）。
   * 注意：这里只做"能不能造"的判断，**具体调用时还会再读一次 Key**（见 tools.js）。
   */
  async _buildWebTools() {
    /* ⚠ 这里**不再**按总开关裁剪工具集。
       原因：工具集是建会话时确定的，若按开关裁剪，用户在输入框下面勾上「联网」
       必须新建会话才生效 —— 用户会觉得"勾了没用"。
       所以改成：**只要有 Key 就把工具注册上**，开关在 `execute` 里逐次判断（tools.js）。
       关掉时的表现是"工具返回一句明确的说明"，而不是"模型看不到工具"。
       （无 Key 仍然不注册 —— 那种情况下工具根本无路可走，注册才是假按钮。） */
    const key = await this._readWebKey();
    if (!key) return [];
    return buildWebTools({
      getApiKey: () => this._readWebKey(),
      isEnabled: () => this._webEnabled() !== false,
      budget: this._webBudget,
      logger: (kind, info) => this._logger.info?.(`[minipi:web] ${kind} ${JSON.stringify(info)}`),
    });
  }

  /** 已登记的会话 id 列表。 */
  listSessionIds() {
    return [...this._records.keys()];
  }

  async listModels() {
    await this.init();
    return buildModelCatalog(this._modelRuntime);
  }

  /**
   * 模型设置页用的**提供方目录**（每个提供方带自己的模型清单 + 密钥状态 + 覆盖状态）。
   * 只回传脱敏信息：没有 key、没有 token、没有 headers。
   */
  async listProviders() {
    await this.init();
    return buildProviderCatalog(
      this._modelRuntime,
      this._providerStore?.get() ?? {},
      this._baselineProviderIds ?? [],
    );
  }

  /** 把存储里的提供方定义同步进运行时。返回一份可直接回给 UI 的报告。 */
  _applyProviders() {
    if (!this._modelRuntime) return { applied: [], removed: [], failed: [] };
    const report = applyProviderDefinitions(this._modelRuntime, this._providerStore?.get() ?? {});
    for (const f of report.failed) {
      this._logger.warn?.(`[minipi:pi] 提供方 ${f.id} 注入失败（已跳过，不影响其它提供方）：${f.reason}`);
    }
    return report;
  }

  /**
   * 写入一个提供方定义（自定义 or 对内置的覆盖），**立即生效于新会话**。
   * @param {{ provider: string, definition: unknown }} input
   */
  async setProvider(input) {
    await this.init();
    if (!this._providerStore) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "提供方存储未初始化"));
    }
    const providerId = input?.provider;
    if (typeof providerId !== "string" || providerId.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "provider 不能为空"));
    }
    let saved;
    try {
      saved = this._providerStore.set(providerId.trim(), input?.definition);
    } catch {
      throw new Error(
        errorMessage(
          ERROR_CODES.PROVIDER_INVALID,
          "提供方定义非法：id 需为小写字母开头的 [a-z0-9-]，API 地址需为 http(s)，协议需在支持列表内，模型 id 不能重复或超长",
        ),
      );
    }
    // 定义了模型目录就必须有协议：否则 Pi 组不出 provider（内置的协议不会被继承）
    if (Array.isArray(saved.models) && saved.models.length > 0 && !saved.api) {
      const derived = this._inferApi(saved.provider);
      if (derived) {
        saved = this._providerStore.set(saved.provider, { ...saved, api: derived });
      } else {
        this._providerStore.remove(saved.provider);
        throw new Error(
          errorMessage(ERROR_CODES.PROVIDER_INVALID, "自定义模型目录时必须指定 API 协议（无法从该提供方推断）"),
        );
      }
    }
    const report = this._applyProviders();
    return { ok: true, provider: saved, ...report, note: "新会话生效" };
  }

  /**
   * 删除一个提供方定义。**只删 minipi 自己的那份定义**：
   *   · 内置提供方会回落到 Pi 的原始定义（实测：unregister 只摘覆盖层，模型不丢）；
   *   · 纯自定义提供方随之消失；
   *   · `~/.pi/agent/models.json` 与 Pi 的 `auth.json` **一个字节都不动**。
   * 同时清掉 minipi 自己存的那份凭据（只动 `~/.minipi/credentials.json`）。
   * @param {{ provider: string }} input
   */
  async removeProvider(input) {
    await this.init();
    if (!this._providerStore) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "提供方存储未初始化"));
    }
    const providerId = input?.provider;
    if (typeof providerId !== "string" || providerId.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "provider 不能为空"));
    }
    const id = providerId.trim();
    if (!this._providerStore.remove(id)) {
      throw new Error(errorMessage(ERROR_CODES.PROVIDER_NOT_FOUND, `minipi 里没有 ${id} 的提供方定义`));
    }
    try {
      await this._credentialStore?.delete?.(id);
    } catch (err) {
      this._logger.warn?.(`[minipi:pi] 删除 ${id} 的 minipi 凭据失败（不影响定义删除）：${sanitizeDetail(err)}`);
    }
    const report = this._applyProviders();
    return { ok: true, provider: id, ...report, note: "新会话生效" };
  }

  /** 从运行时的既有模型推断协议（用于「覆盖模型目录但没写协议」时兜底）。 */
  _inferApi(providerId) {
    const models = this._modelRuntime?.getModels?.(providerId) ?? [];
    const api = models.find((m) => typeof m?.api === "string")?.api;
    return PROVIDER_API_IDS.includes(api) ? api : "";
  }

  async setModelApiKey(input) {
    await this.init();
    const providerId = input?.providerId;
    const apiKey = input?.apiKey;
    if (typeof providerId !== "string" || typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "providerId 和 apiKey 必须有效"));
    }
    await this._credentialStore.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
    try {
      await this._modelRuntime.setRuntimeApiKey(providerId, apiKey);
    } catch (err) {
      // 凭证已持久化；模型运行时同步失败时仍报告可重试的警示。
      this._logger.warn?.(`[minipi:pi] provider ${providerId} key 已保存，但运行时同步失败：${sanitizeDetail(err)}`);
      return { ok: true, persisted: true, warning: "运行时同步失败，下次会话将重试" };
    }
    return { ok: true, persisted: true };
  }

  /** 某个会话是否存在。 */
  hasSession(sessionId) {
    return typeof sessionId === "string" && this._records.has(sessionId);
  }

  /**
   * 某个会话是否**正在跑**（流式中）。
   *
   * 为什么单独暴露：删除 / 恢复都必须先问这一句 ——
   * `AgentSession.dispose()` 只触发 abort，**abort 之后仍可能有一次收尾 append**
   * （`agent-session.js:996` 起那段还整段包在 `try/catch` 里，抛错也不外传）。
   * 也就是说「先 dispose 再删文件」在流式中仍有一个窗口：文件已被 rename 走，
   * 收尾 append 又把原路径**原样重建**成一个没有 session header 的 jsonl
   * （`session-manager.js:812` 的 `appendFileSync`），重启后按文件名被认领 ⇒ 会话复活。
   * 所以状态判断必须用**我们自己的** `rec.status`，且必须在 `disposeSession()` 之前。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  isStreaming(sessionId) {
    const rec = this._records.get(sessionId);
    return !!rec && !rec.disposed && rec.status === SESSION_STATUS.STREAMING;
  }

  /**
   * 取某个会话的事件增量（`seq > sinceSeq`）。用于渲染层重载/重连补增量。
   * @param {string} sessionId
   * @param {number} sinceSeq
   */
  eventsSince(sessionId, sinceSeq) {
    const rec = this._records.get(sessionId);
    if (!rec) return [];
    return rec.log.since(sinceSeq);
  }

  /**
   * 建会话。
   *
   * **D-09（会话自建）**：`disk` 场景的正文落 `~/.minipi/sessions/`，
   * 并把 id 与元数据登记进我们的索引（`index.json`）。
   * 之前这里是 `SessionManager.create(cwd)`（不传 sessionDir）⇒ 与 Pi CLI 共用默认目录，
   * 等于把用户的会话塞进别人的储物柜，违反 D-09。
   *
   * @param {{ sceneId?: string }} [input]
   * @returns {Promise<{ sessionId: string, sceneId: string, model: string | null, lastSeq: number, title: string }>}
   */
  async createSession(input = {}) {
    const rawSceneId = input?.sceneId;
    const sceneId = rawSceneId === undefined || rawSceneId === null ? DEFAULT_SCENE_ID : rawSceneId;
    if (typeof sceneId !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "sceneId 必须是字符串"));
    }
    if (sceneId.length > LIMITS.SCENE_ID_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "sceneId 过长"));
    }

    const scene = resolveScene(sceneId); // 非法 sceneId → SCENE_NOT_FOUND
    const cwd = ensureSceneCwd(scene);

    await this.init();

    const memoryMode = scene.sessionManagerMode === "memory";
    /** @type {string} */
    let sessionId;
    /** @type {unknown} */
    let sessionManager;
    let title = SESSION_DEFAULT_TITLE;

    if (memoryMode) {
      // 内存会话（测试 / 演示）：不落盘、不进索引，id 也就不需要满足文件命名规则
      this._sessionCounter += 1;
      sessionId = `s_${this._sessionCounter}`;
      sessionManager = SessionManager.inMemory(cwd);
    } else {
      /* 关键：把「我们的目录」和「我们的 id」一起交给 SDK。
         · sessionDir=~/.minipi/sessions ⇒ 正文落在自己的目录（D-09）；
         · { id } ⇒ 文件名 / header 里的 id 都是我们生成的（`s_<ts>_<4位>`），
           于是 `pathOf()` / `findById()` / 重启后恢复都能对上。 */
      const made = this.sessionStore.create(cwd, scene.sceneId, {
        createManager: (cwdArg, dir, opts) => SessionManager.create(cwdArg, dir, opts),
      });
      sessionId = made.item.id;
      sessionManager = made.sessionManager;
      title = made.item.title;
    }

    const resourceLoader = await this._buildResourceLoader(scene, sessionId, cwd);
    /* 联网工具：**先看有没有 Key，没有就一个都不注入**。
       这样模型连工具名都看不到，绝不会出现"我搜一下"然后编结果的情况。
       Key 在每次工具调用时重新读（用户可能中途才填）。 */
    const webTools = await this._buildWebTools();
    const preferredModel = resolvePreferredModel(this._modelPreference(), (provider, id) => this._modelRuntime.getModel(provider, id));

    let created;
    try {
      created = await createAgentSession({
        modelRuntime: this._modelRuntime,
        ...(preferredModel ? { model: preferredModel } : {}),
        cwd,
        sessionManager,
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(webTools.length > 0 ? { customTools: webTools } : {}),
        ...sessionToolOptions(scene),
      });
    } catch (err) {
      throw new Error(
        errorMessage(ERROR_CODES.PI_UNAVAILABLE, `创建 Pi 会话失败：${sanitizeDetail(err)}`),
      );
    }

    const session = created.session;
    const rec = new SessionRecord({
      sessionId,
      scene,
      session,
      unsubscribe: () => {},
      persisted: !memoryMode,
    });
    rec.model = session?.model ? `${session.model.provider}/${session.model.id}` : null;

    rec.unsubscribe = this._subscribe(rec);

    this._records.set(sessionId, rec);
    this._lastSessionId = sessionId;

    this._logger.info?.(
      `[minipi:pi] 会话已建 ${sessionId} · 场景 ${scene.sceneId} · cwd ~/${path.basename(cwd)} · 模型 ${rec.model ?? "(未解析)"}` +
        (created.modelFallbackMessage ? ` · 注意：${sanitizeDetail(created.modelFallbackMessage, 120)}` : ""),
    );

    return { sessionId, sceneId: rec.sceneId, model: rec.model, lastSeq: rec.seq, title };
  }

  /**
   * 恢复一个**已有**会话（B1-3 / plan §2.3）。
   *
   * 语义（每步都有理由）：
   *   1. `SessionManager.open(path, dir, cwd)` —— 打开我们目录里的那份 JSONL；
   *   2. `createAgentSession({ sessionManager, ... })` —— AgentSession 构造时会调
   *      `sessionManager.buildSessionProjection()` 把历史灌进 `agent.state.messages`
   *      （`dist/core/agent-session.js:577`）⇒ **真实模型上下文**，不是「装作记得」；
   *   3. 对外 `sessionId` **就是原来的 id** —— 渲染层续接事件流时不需要换 key；
   *   4. 事件流 seq **从 1 重新开始**（新 SessionRecord）。渲染层恢复时会把 seq 计数清空，
   *      所以不存在跳号；把 `lastSeq` 返回成 0 就是让渲染层「从 1 收」的明确信号。
   *
   * ⚠ 已经在本进程里恢复过的同 id 直接复用记录：同一份 JSONL 上挂两个 AgentSession
   *   会互相 append，历史会被写乱（Pi 的 append 是「按自己内存里的 leaf 往后写」）。
   *
   * @param {{ id: string }} input
   * @returns {Promise<{ sessionId: string, title: string, lastSeq: number, sceneId: string,
   *   history: Array<{role: "user"|"assistant", content: string, timestamp: number}> }>}
   */
  async resumeSession(input = {}) {
    const id = input?.id;
    if (!isSessionId(id)) {
      throw new Error(
        errorMessage(ERROR_CODES.INVALID_ARGUMENT, "id 必须是会话 id（形如 s_<时间戳>_<4 位>）"),
      );
    }

    /* 正在跑的那条不许恢复：恢复会新建一个 AgentSession 挂到同一份 JSONL 上，
       而旧的那个还在往里 append（abort 之后的收尾写盘尤其危险，见 isStreaming 注释）。
       渲染层也挡了这条，这里是**主进程的真相**：IPC 可以被重放/脚本直接调。 */
    if (this.isStreaming(id)) {
      throw new Error(
        errorMessage(ERROR_CODES.SESSION_BUSY, "正在生成回答，先中断再恢复该会话"),
      );
    }

    /* BLK-2：同一个 id 的并发请求共享同一次恢复。
       注意 `_records` 的登记在 `_resumeOnce()` 的三个 await 之后，所以**不能**只靠
       `live` 检查去重 —— 那个窗口足够两次双击都进来。 */
    const inflight = this._resuming.get(id);
    if (inflight) {
      this._logger.info?.(`[minipi:pi] ${id} 正在恢复中，复用这次请求`);
      return inflight;
    }
    const task = this._resumeOnce(id).finally(() => {
      this._resuming.delete(id);
    });
    this._resuming.set(id, task);
    return task;
  }

  /**
   * `resumeSession` 的实际过程（去重包装见上）。
   * @param {string} id
   * @returns {Promise<{ sessionId: string, title: string, lastSeq: number, sceneId: string,
   *   history: Array<{role: "user"|"assistant", content: string, timestamp: number}> }>}
   */
  async _resumeOnce(id) {
    const store = this.sessionStore;
    const item = store.get(id);
    if (!item) {
      throw new Error(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "会话不存在（索引里没有这个 id）"));
    }

    // 已在本进程里活着：直接复用，别在同一个 jsonl 上再开一个写入者
    const live = this._records.get(id);
    if (live && !live.disposed) {
      /* 正在跑的这一轮不能被"复用"：Resume 会把渲染层切到这条会话上，
         而它此刻还在流式输出 —— 用户看到的会是"点了一下，答案从中间开始长"。
         直接 SESSION_BUSY，与删除、切换同一句式（都是"先中断再动"）。 */
      if (live.status === SESSION_STATUS.STREAMING) {
        throw new Error(
          errorMessage(ERROR_CODES.SESSION_BUSY, "这个会话正在生成回答，先中断再切换"),
        );
      }
      return {
        sessionId: id,
        title: item.title,
        lastSeq: live.seq,
        sceneId: live.sceneId,
        history: this._historyOf(live.session),
      };
    }

    const absPath = store.pathOf(id);
    if (!absPath) {
      throw new Error(
        errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "会话正文文件不存在（可能已被移走或删除）"),
      );
    }

    const scene = resolveScene(isSceneId(item.sceneId) ? item.sceneId : DEFAULT_SCENE_ID);
    const cwd = ensureSceneCwd(scene);

    await this.init();

    /** @type {unknown} */
    let sessionManager;
    try {
      sessionManager = SessionManager.open(absPath, store.dir, cwd);
    } catch (err) {
      /* ⚠ 这一支**不是**「SDK 起不来」，是「文件在、但内容不是合法会话」：
         `open()` 对无 header 的非空文件会抛 `Session file is not a valid pi session`
         （实测；空文件/不存在文件反而**不抛**，静默造一个 UUID —— 那支由下面
         `openedId !== id` 接住）。两者是同一类语义：**这份正文用不了了** ⇒
         会话不可用（`SESSION_NOT_FOUND`），让渲染层按"会话没了"处理（提示 + 刷新列表），
         而不是按"引擎坏了"处理（那会引导用户去查模型/凭据，方向全错）。
         `PI_UNAVAILABLE` 只留给 `this.init()` 失败、`createAgentSession` 失败这种真的引擎不可用。 */
      throw new Error(
        errorMessage(
          ERROR_CODES.SESSION_NOT_FOUND,
          `会话正文已损坏或不是有效会话（可能已被删除）：${sanitizeDetail(err)}`,
        ),
      );
    }

    /* MAJ-2：`pathOf()` 是按文件名后缀匹配的，理论上可能命中一份"文件名像、但 header 里
       是别的 id"的旧文件（手工拷贝 / 上一个版本改名）。打开后必须核对，
       否则会**静默把别的会话正文接到这个条目上**（越用越乱，且不可逆）。 */
    const openedId = typeof sessionManager.getSessionId === "function" ? sessionManager.getSessionId() : null;
    if (openedId !== id) {
      throw new Error(
        errorMessage(
          ERROR_CODES.SESSION_NOT_FOUND,
          `会话正文与索引不一致（索引 ${id} / 文件 ${openedId ?? "无 id"}）`,
        ),
      );
    }

    const resourceLoader = await this._buildResourceLoader(scene, id, cwd);
    const webTools = await this._buildWebTools();
    const preferredModel = resolvePreferredModel(this._modelPreference(), (provider, mid) => this._modelRuntime.getModel(provider, mid));

    let created;
    try {
      created = await createAgentSession({
        modelRuntime: this._modelRuntime,
        // 恢复到别的模型上也必须有模型：沿用当前偏好（历史在 context 里，不依赖它）
        ...(preferredModel ? { model: preferredModel } : {}),
        cwd,
        sessionManager,
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(webTools.length > 0 ? { customTools: webTools } : {}),
        ...sessionToolOptions(scene),
      });
    } catch (err) {
      throw new Error(
        errorMessage(ERROR_CODES.PI_UNAVAILABLE, `恢复会话失败：${sanitizeDetail(err)}`),
      );
    }

    const rec = new SessionRecord({
      sessionId: id,
      scene,
      session: created.session,
      unsubscribe: () => {},
      persisted: true,
    });
    rec.model = created.session?.model ? `${created.session.model.provider}/${created.session.model.id}` : null;
    rec.unsubscribe = this._subscribe(rec);

    this._records.set(id, rec);
    /* ---- 残余竞态：恢复途中被删掉（Ray 的第 3 条）----
     * 顺序问题：`_resumeOnce` 上面有三个 await（`init` / `SessionManager.open` /
     * `createAgentSession`）。用户在这个窗口里从渲染层删掉这条会话是能成的 ——
     * `DELETE_SESSION` 那会儿 `_records` 里**还没有** `id`（`hasSession` 为 false），
     * 于是它跳过 dispose 直接 `remove`，索引条目没了、正文进了回收站。
     * 等我们这边 await 回来，手里就握着一个"正文已被搬走"的 AgentSession，
     * 却把它挂进 `_records` —— 结果是：列表里没有它，但渲染层能 resume 成功，
     * 再发一句话 `appendFileSync` 会把**回收站里的那份文件**之外的同名路径重新建出来
     * （和 BLK-1 同一个机制，只是入口不同）⇒ 删除静默失败。
     *
     * 所以落表的**同一拍**必须复查索引：索引里没有 ⇒ 立刻摘掉刚挂上的记录再抛
     * `SESSION_NOT_FOUND`（渲染层按"会话已经没了"处理：提示 + 刷新列表）。
     * 两行的代价换掉一个"删了又活过来"的洞。 */
    if (!this.sessionStore.get(id)) {
      this.disposeSession(id);
      throw new Error(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "恢复期间该会话已被删除"));
    }
    this._lastSessionId = id;
    // 恢复回来就算一次活动：列表里「最后活动时间」应该跳到现在，且能从 pending 里摘掉
    this._touchIndex(rec, {}, true);

    const history = this._historyOf(created.session);
    this._logger.info?.(
      `[minipi:pi] 会话已恢复 ${id} · 场景 ${scene.sceneId} · 历史 ${history.length} 条消息 · 模型 ${rec.model ?? "(未解析)"}`,
    );

    return { sessionId: id, title: item.title, lastSeq: 0, sceneId: rec.sceneId, history };
  }

  /**
   * 会话状态快照（契约字段一个不少）。
   * @param {{ sessionId: string }} input
   */
  sessionState(input) {
    const rec = this._requireSession(input?.sessionId);
    return this._stateOf(rec);
  }

  /**
   * 发一条消息。
   *
   * ⚠ 语义（照契约与实测写）：
   *   · **不 await 整轮**；`accepted` 来自 `preflightResult`（+ 「调用没有同步抛错」）；
   *   · 流式期间**必须**带 `streamingBehavior`，缺省 `steer`（否则 SDK 抛错）；
   *   · 整轮真正的结束由 `agent_end` / `agent_settled` 事件表达。
   *
   * @param {{ sessionId: string, text: string, behavior?: "steer"|"followUp" }} input
   * @returns {Promise<{ accepted: boolean }>}
   */
  async prompt(input) {
    const rec = this._requireSession(input?.sessionId);
    // 每轮重置联网预算（"单轮上限"按用户一次提问算）
    this._webBudget.reset();

    const text = input?.text;
    if (typeof text !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "text 必须是字符串"));
    }
    if (text.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "text 不能为空"));
    }
    /* P1-1：上限**按当前模型的上下文窗口**算，不是全局 32000 一把尺。
       窗口取 `rec.session?.model.contextWindow`（与 `generateStructured` 同源）。
       错误文案里必须给出**实际生效的那个数** —— 只说 32000 会让用户以为
       自己撞了全局限制，实际上是这个模型的窗口小（4k 模型的上限是 2047）。
       另外要说清"字符"与"token"不是一回事，否则用户会拿 token 估算对不上。 */
    const promptCap = promptCapFor(rec.session?.model?.contextWindow);
    if (text.length > promptCap) {
      const ctx = rec.session?.model?.contextWindow;
      throw new Error(
        errorMessage(
          ERROR_CODES.INVALID_ARGUMENT,
          `text 超长（上限 ${promptCap} 字符，实际 ${text.length}）` +
            (Number.isFinite(ctx) && ctx > 0
              ? `；该上限按当前模型上下文窗口 ${ctx} 的一半计算（字符数，非 token）`
              : "；当前模型未上报上下文窗口，已按默认上限处理"),
        ),
      );
    }

    const rawBehavior = input?.behavior;
    if (rawBehavior !== undefined && rawBehavior !== null && !isStreamingBehavior(rawBehavior)) {
      throw new Error(
        errorMessage(ERROR_CODES.INVALID_ARGUMENT, "behavior 必须是 'steer' 或 'followUp'"),
      );
    }
    if (rawBehavior === undefined || rawBehavior === null) {
      this._logger.warn?.(
        "[minipi:pi] prompt 未带 behavior，已按契约缺省值 steer 处理（流式期间 SDK 强制要求该参数）",
      );
    }
    const behavior = isStreamingBehavior(rawBehavior) ? rawBehavior : STREAMING_BEHAVIOR.STEER;

    /* 每条用户消息都强制刷一次索引：预览（最后一条用户消息）与「首条消息自动取标题」
       都在这里定格；不靠事件流里的 message 形状（不同版本字段不一样），
       我们手里就有原文，直接写最可靠。 */
    this._touchIndex(rec, { preview: text }, true);

    /** @type {Promise<void> | null} */
    let runPromise = null;
    let syncThrew = false;

    const accepted = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // 250ms 内既没同步抛错、preflight 也没回调 ⇒ 按「已受理」处理：
          // 这是 prompt（不是写操作），fail-open 的代价只是 UI 先给反馈，
          // 真正的失败会在事件流里以 error / auto_retry_* 出现。
          resolve(true);
        }
      }, PREFLIGHT_WAIT_MS);
      timer.unref?.();

      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val === true);
      };

      try {
        runPromise = rec.session.prompt(text, {
          streamingBehavior: behavior,
          preflightResult: (success) => finish(success === true),
        });
      } catch (err) {
        // 理论上不会走到（prompt 是 async），但契约要求「依据调用没有同步抛错给 accepted」，
        // 所以这条分支必须留着。
        syncThrew = true;
        finish(false);
        this._publishSyntheticError(rec, err);
        return;
      }

      // 整轮跑完（resolve 或 reject）由这里收口，绝不 await
      Promise.resolve(runPromise).then(
        () => {
          if (rec.status === SESSION_STATUS.STREAMING) rec.status = SESSION_STATUS.IDLE;
        },
        (err) => {
          rec.status = SESSION_STATUS.ERROR;
          rec.lastError = sanitizeDetail(err);
          this._logger.warn?.(`[minipi:pi] ${rec.sessionId} 本轮失败：${rec.lastError}`);
          this._publishSyntheticError(rec, err);
        },
      );
    });

    if (!accepted) {
      this._logger.warn?.(`[minipi:pi] ${rec.sessionId} prompt 未被受理（syncThrew=${syncThrew}）`);
    }
    return { accepted };
  }

  /**
   * 中断当前轮。
   * @param {{ sessionId: string }} input
   * @returns {Promise<{ ok: boolean }>}
   */
  async abort(input) {
    const rec = this._requireSession(input?.sessionId);
    try {
      await rec.session.abort();
    } catch (err) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, `中断失败：${sanitizeDetail(err)}`));
    }
    if (rec.status === SESSION_STATUS.STREAMING) rec.status = SESSION_STATUS.IDLE;
    return { ok: true };
  }

  /**
   * 一次性结构化输出：**独立**调一次模型，要求它只回一段 JSON，返回原始文本。
   *
   * ⚠ 命名刻意避开 prompt/ask 等词 —— 它是「一次性结构化输出」，不是 prompt 变体：
   *    · **不写 `rec.seq`、不进 RingLog** —— 它不是对话轮次，不该污染事件流。
   *    · **不影响 `rec.status`、不推 message_* 事件** —— UI 不该看见它；产出卡片才是用户可见面。
   *    · 入参出参**不暴露任何 Pi SDK 类型**（纯 string 进出）。
   *
   * ## 为什么走 `completeSimple` 而不是 `session.prompt`
   *
   * `session.prompt()` 会把这次指令追加进会话历史，而会话的主订阅（`_subscribe()`）
   * 一直在跑 ⇒ 抽取指令与模型吐的 JSON 都会被包装成事件推给渲染层，用户看到的现象是
   * 「点了导出，却又发起一个问答」。`ModelRuntime.completeSimple(model, context, options)`
   * 则是**一次性请求**：零事件、零会话历史、零队列占用，与用户轮次完全并行不抢。
   *
   * 代价是**没有会话隐式上下文**（模型看不到前面的对话）⇒ 素材必须显式给：
   * 由 `recentTranscript()` 摘出近期对话，outcome 层拼进提示词。这是本方案的
   * 核心取舍，别为了「省事」改回 `session.prompt`。
   *
   * ## 硬超时必须收
   *
   * `AbortController` + `setTimeout(timeoutMs)`：到点**先 reject、再 `abort()`**（顺序见实现处注释），
   * **绝不**留一个永远 pending 的 Promise（否则产出卡片永不返回）。定时器**不 `unref`**：
   * 它必须能独立把超时推到台前，而成功 / 抛错 / 超时**每条分支**都会 `clearTimeout`，不留残留。
   *
   * @param {{ sessionId: string, instruction: string, timeoutMs?: number }} input
   * @returns {Promise<{ text: string, model: string|null }>}
   * @throws 超时 / 被中断 → `INTERNAL`；会话不存在 → `SESSION_NOT_FOUND`；
   *         无可用模型 / 凭据缺失 / 网络失败 / 模型报错 → `PI_UNAVAILABLE`
   *         （`completeSimple` 有**三种**失败形态 —— 同步抛、reject、以及正常 resolve 出带
   *          `errorMessage` 的消息 —— 三者都归一成 `PI_UNAVAILABLE`，见实现内注释）
   */
  async generateStructured(input) {
    const rec = this._requireSession(input?.sessionId);

    const instruction = input?.instruction;
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "instruction 不能为空"));
    }
    /* P1-1：与 `prompt()` **同一个闸门**，同样的来源（`rec.session?.model`）。
       不能只拦 `prompt()`：`generateStructured()` 走 `completeSimple` 旁路，
       但不代表它不受窗口约束 —— 超窗一样被厂商拒，只是从"用户看到超长提示"
       退化成"导出卡片莫名失败"，更难查。 */
    const instructionCap = promptCapFor(rec.session?.model?.contextWindow);
    if (instruction.length > instructionCap) {
      const ctx = rec.session?.model?.contextWindow;
      throw new Error(
        errorMessage(
          ERROR_CODES.INVALID_ARGUMENT,
          `instruction 超长（上限 ${instructionCap} 字符，实际 ${instruction.length}）` +
            (Number.isFinite(ctx) && ctx > 0
              ? `；该上限按当前模型上下文窗口 ${ctx} 的一半计算（字符数，非 token）`
              : "；当前模型未上报上下文窗口，已按默认上限处理"),
        ),
      );
    }

    const timeoutMs =
      Number.isFinite(input?.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : LIMITS.OUTCOME_TIMEOUT_MS;

    // `init()` 在 `_modelRuntime` 已存在时直接返回它（测试可注入桩），不会重复建运行时。
    const runtime = await this.init();

    // 要的是 `session.model`（**Model 对象**），不是 `rec.model`（那只是 "provider/id" 字符串）。
    const model = rec.session?.model;
    if (!model) {
      throw new Error(errorMessage(ERROR_CODES.PI_UNAVAILABLE, "当前会话没有可用模型"));
    }

    const controller = new AbortController();
    /** 超时用同一个 Error 实例：`catch` 里据此区分「我们自己的超时」与真实失败。 */
    const timeoutError = new Error(errorMessage(ERROR_CODES.INTERNAL, "结构化输出超时"));

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // **顺序有意为之：先 reject，再 abort。**
        // 反过来的话，在 abort 里同步收口的 provider 会先让竞速以它自己的
        // `Request was aborted` 落败，用户看到的是英文框架原文、错误码还会从 INTERNAL 漂走。
        // 先 reject 就把胜负定死在我们的中文文案上，abort 仍会照常打到 HTTP 层。
        reject(timeoutError);
        controller.abort();
      }, timeoutMs);
      // ⚠ **不要 unref**：HTTP socket 本身就在 ref 事件循环，unref 拿不到任何收益；
      //   反过来「定时器不 ref」会让超时契约在最需要它的场景（进程里没有别的 handle）失效 ——
      //   进程直接静默退出，Promise 永不 settle，等于超时没写。定时器在 finally 里必清。
    });

    /**
     * 只用到 `content` / `stopReason` / `errorMessage` 三个字段，
     * 所以不把 SDK 类型引到本文件的方法签名上。
     * @type {{ content?: unknown[], stopReason?: string, errorMessage?: string } | undefined}
     */
    let msg;
    try {
      msg = await Promise.race([
        runtime.completeSimple(
          model,
          // 不传 systemPrompt：一次性抽取的角色约束全写在 instruction 里，见 outcome/prompt.js
          {
            messages: [
              { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
            ],
          },
          { signal: controller.signal },
        ),
        timeout,
      ]);
    } catch (err) {
      // AbortError 是我们自己 abort 出来的，与超时对用户是同一件事：请求没拿到结果。
      if (err === timeoutError || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(errorMessage(ERROR_CODES.INTERNAL, "结构化输出超时"));
      }
      // 走到这里只有两种形态：①**同步抛**（凭据缺失等 setup 前置校验，`completeSimple`
      // 是普通 async 函数，同步抛会直接从这里冒出来）；②**reject**（网络 / HTTP / 解析层）。
      // ⚠ 第三种形态（SDK setup 失败）**不在这里**：它是 resolve 出一条
      // `stopReason:"error"` + `errorMessage` 的消息 —— 既不抛也不 reject，见下面的检查。
      throw new Error(errorMessage(ERROR_CODES.PI_UNAVAILABLE, `结构化输出失败：${sanitizeDetail(err)}`));
    } finally {
      clearTimeout(timer); // 成功 / 抛错都要清，否则定时器会拖住事件循环
    }

    // ⚠ 顺序：先判 `aborted`，再判 `errorMessage`。
    //   被中断的消息往往**同时**带一句英文 errorMessage（`Request was aborted`）——
    //   先判 errorMessage 会让「已中断」永远走不到，用户看到的是框架原文 + 错误码漂成 PI_UNAVAILABLE。
    if (msg?.stopReason === "aborted") {
      // 两种来源要分开报：我们自己的超时会先 reject（走不到这里），能到这里说明是
      // 「abort 已经切开但消息仍正常返回」，即超时；否则就是会话侧/上游真的中断了。
      throw new Error(
        errorMessage(
          ERROR_CODES.INTERNAL,
          controller.signal.aborted ? "结构化输出超时" : "结构化输出已中断",
        ),
      );
    }
    // SDK 的 setup 失败形态：**正常 resolve** 一条 `stopReason:"error"` + `errorMessage`
    // 的消息（不抛也不 reject），所以这个检查不能省 —— 少了它会把失败当成「空文本成功」。
    // ⚠ 只带 `stopReason:"error"` 却没有 errorMessage 的形态这里**不特殊处理**：
    //   它会走下面的「空文本」分支，由 outcome 层降级①兜底，语义与改动前一致。
    if (typeof msg?.errorMessage === "string" && msg.errorMessage.length > 0) {
      throw new Error(
        errorMessage(ERROR_CODES.PI_UNAVAILABLE, `结构化输出失败：${sanitizeDetail(msg.errorMessage)}`),
      );
    }

    // 只取 text 块：thinking / toolCall 都不是要的 JSON（content 也可能是空数组）。
    const text = (Array.isArray(msg?.content) ? msg.content : [])
      .filter((c) => c && typeof c === "object" && c.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("");

    // 空文本照旧返回空串 —— 「没拿到 JSON」由 outcome 层的降级①兜底，这里不改语义。
    return { text, model: rec.model };
  }

  /**
   * 摘出某会话**最近的**对话文本（产出链路用它当素材）。
   *
   * ## 为什么需要这个方法
   *
   * `generateStructured()` 改走 `completeSimple` 旁路之后**没有会话隐式上下文** ——
   * 模型看不到前面聊过什么。要让「导出质量不下降」，素材必须由调用方显式传进提示词，
   * 这条通道就是它。
   *
   * ## 取法（每条都是有意为之）
   *
   *   · 只取 `user` / `assistant` 的**说话内容**：`system` 是内部提示、`toolResult` 是
   *     工具回包，都不是用户眼里的「对话」，塞给模型只会稀释重点；
   *   · `content` 是数组时只取 `type === "text"`（见 `messageTextOf()`）；
   *   · **从末尾截取**：导出关心的是「最近在聊什么」，砍头比砍尾合理；
   *   · 真被截断时在最前面加一行「（更早的对话已省略）」，让模型知道上文不全。
   *
   * ## 两种「失败」的待遇不同（别混为一谈）
   *
   *   · **入参 / 会话不存在 ⇒ 抛**：`sessionId` 非法 → `INVALID_ARGUMENT`，
   *     会话已释放 → `SESSION_NOT_FOUND`。这是调用方的 bug，且与全仓口径一致，
   *     静默返回空串会让「导出为什么没素材」变得不可诊断。
   *   · **读历史失败 ⇒ 不抛**：拿不到 `rec.session.messages` 时只 `warn` 一条并返回 `""`。
   *     没素材也能出稿，只是质量差一点；让导出因为「读历史失败」整次失败是更差的选择。
   *
   * @param {string} sessionId
   * @param {number} [maxChars] 总长预算（`String.length`，与仓库其它 LIMITS 口径一致）
   * @returns {string} 纯文本；无对话 / 读不到历史时为空串
   * @throws sessionId 非法 → `INVALID_ARGUMENT`；会话不存在 → `SESSION_NOT_FOUND`
   *         （⚠ **读历史失败不抛**，见上）
   */
  recentTranscript(sessionId, maxChars = 8000) {
    const rec = this._requireSession(sessionId);

    /** 预算非法（`0` / 负数 / `NaN`）时退回缺省：宁可多给点素材，也不要静默给空串。 */
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000;

    /** @type {unknown} */
    let messages;
    try {
      // ⚠ 如实记录：SDK 当前实现就是 `return this.agent.state.messages`，**不会抛**。
      //   这里的 try/catch 是**防御**（未来版本改成惰性组装 / 半初始化会话时可能抛），
      //   不是因为它现在会抛 —— 别拿这段当「读历史会失败」的证据。
      messages = rec.session?.messages;
    } catch (err) {
      this._logger.warn?.(
        `[minipi:pi] ${rec.sessionId} 读取会话历史失败，导出将不带素材：${sanitizeDetail(err)}`,
      );
      return "";
    }

    /** @type {string[]} */
    const blocks = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const role = message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageTextOf(message.content);
      if (text.length === 0) continue;
      blocks.push(`[${role === "user" ? "用户" : "助手"}] ${text}`);
    }
    if (blocks.length === 0) return "";

    const joined = blocks.join("\n\n");
    if (joined.length <= budget) return joined;

    // 截断：省略说明自己也占预算，先把它扣掉，正文才不会被顶出上限。
    const note = "（更早的对话已省略）";
    const contentBudget = Math.max(0, budget - note.length - 2 /* 与正文之间的空行 */);
    /** @type {string[]} */
    const kept = [];
    let used = 0;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      const cost = block.length + (kept.length > 0 ? 2 /* 块间空行 */ : 0);
      if (used + cost <= contentBudget) {
        kept.unshift(block);
        used += cost;
        continue;
      }
      // 最近的一条自己就超预算 ⇒ 取它的**尾部**（最新那几句才是用户刚要导出的内容）
      if (kept.length === 0 && contentBudget > 0) kept.push(block.slice(block.length - contentBudget));
      break;
    }
    return [note, ...kept].join("\n\n");
  }

  /**
   * `tool_call` 闸门 —— **沙箱硬拦 + M4 审批**两条规则（同一个钩子，不是两套机制）。
   * 设计：`docs/minipi-v0.4-impl-plan.md` §2.5 + `docs/minipi-approval-gate-design.md` v1.1。
   *
   * ```
   * tool_call(event):
   *   # 规则 1：沙箱（只对 outbox 场景）
   *   if sceneId in OUTBOX_SCENES:
   *      if tool 是 write/edit 且目标不合法:
   *          return { block: true, reason: SANDBOX_DENY_REASON }   # 硬拦，不弹卡
   *   # 规则 2：审批（只对 repo）
   *   if sceneId in OUTBOX_SCENES: return undefined               # 放行
   *   if toolName not in APPROVAL_TOOLS: return undefined         # 只读放行
   *   decision = await approval.request(...)                      # 路径 A：async 钩子
   *   → allowOnce: undefined ｜ deny: {block} ｜ terminate: {block, terminate}
   * ```
   *
   * ⚠ **顺序不能反：先沙箱后审批**（安全性关键）。沙箱违例**不给用户「允许」的选项**——
   * 否则用户手滑点「允许一次」，沙箱就形同虚设。反过来（先审批后沙箱）会出现
   * 「用户批准了却被沙箱拒」的困惑 UI。
   * 且 vendor 层面 `block` 是**短路返回**（`runner.js:754-758`）——沙箱 block 后审批**根本不会被调用**，
   * 是**双重保障**，不只是「我们约定先判沙箱」。
   *
   * ⚠ 钩子是 **async**（路径 A）：vendor 确证 `ExtensionHandler` 可返回 Promise 且 runner `await` 它
   *   （`types.d.ts:902` + `runner.js:753`）。⇒「等用户决策」直接 `await approval.request(...)`。
   *
   * ⚠ **`terminate` 是 every 语义**（`types.d.ts:822-826`）：同一批里全部为 true 才提前终止。
   *   审批侧对整批统一带 terminate（`approval.js` 的批语义）。
   *
   * ⚠ 被 `block` 的调用**仍会**发 `tool_execution_start/end`（`isError:true`）⇒
   *   审批卡必须在 `tool_call` 钩子里推，**不能等** `tool_execution_start`（会晚一拍）。
   *
   * 另：闸门只覆盖**本会话**；第三方扩展可 spawn 独立进程绕过（官方 subagent 示例），
   * 因此 `_buildResourceLoader()` 里设了 `noExtensions: true`。
   *
   * @param {unknown} pi 扩展 API（`ExtensionAPI`）
   * @param {{ sessionId: string, sceneId: string, cwd: string }} ctx
   * @returns {null} 沙箱规则通过钩子生效，无需返回值
   */
  registerGate(pi, ctx) {
    const { sessionId, sceneId, cwd } = ctx;
    // 场景分流：只有 outbox 场景受沙箱约束（`repo` 要动真仓库，走审批闸门）。
    const sandboxed = OUTBOX_SCENES.includes(sceneId);

    try {
      pi.on("tool_call", async (event) => {
        // ---- 规则 1：outbox 沙箱硬拦（写之前校验，一次操作非法 → block，不弹卡）----
        if (sandboxed) {
          const verdict = checkWriteTarget({
            toolName: event?.toolName,
            input: event?.input,
            cwd,
            outboxDir: OUTBOX_DIR,
            sceneId,
          });
          if (verdict.blocked) {
            // reason 会**逐字回灌**给模型（spike 实测：模型看到后改正路径，不重试）
            return { block: true, reason: verdict.reason };
          }
        }

        // ---- 规则 2：M4 审批闸门（设计 `docs/minipi-approval-gate-design.md` §8.3）----
        // 决策树（顺序按 §8.3，不能反）：
        //   ① outbox 场景（quick/note/desk）：不进审批，直接放行。
        //      · quick 无工具（防御性提前 return，§8.1）
        //      · note/desk 的 write 由规则 1 保证落在 outbox，是产品承诺的「无感落点」，
        //        打断它违背 5 秒通道定位（§8.2）
        //   ② 只剩 repo：非 APPROVAL_TOOLS（read/grep/find/ls）放行。
        //   ③ APPROVAL_TOOLS（write/edit/bash/powershell）⇒ 弹卡等用户决策。
        if (OUTBOX_SCENES.includes(sceneId)) return undefined;

        const toolName = event?.toolName;
        if (!APPROVAL_TOOLS.includes(toolName)) return undefined;
        if (!this._approval) return undefined; // 未注入审批闸门（M4 之前行为）

        // 路径 A（vendor 确证钩子可 async：types.d.ts:902 + runner.js:753）：
        // 直接 await 用户决策——整轮在该工具处挂起，审批卡已在 request() 内先推。
        //
        // ⚠ **审批禁止改 `event.input`**（不是「没做」，是「不许做」）：`event.input` 可变
        //   但改后 SDK **不重新校验**（types.d.ts:721-722）⇒ 改参会绕过沙箱。审批只能
        //   「放行 / 拒绝 / 中断」，无权改模型给的内容。下面只读 `event.input`，绝不写。
        let decision;
        try {
          decision = await this._approval.request({
            sessionId,
            sceneId,
            toolName,
            input: event?.input,
            cwd,
          });
        } catch (err) {
          // 审批自身抛错 = fail-closed：拒绝（而不是放行）
          this._logger.warn?.(`[minipi:pi] ${sessionId} 审批请求失败，按拒绝处理：${sanitizeDetail(err)}`);
          return { block: true, reason: "Approval failed unexpectedly. Do not retry this action automatically." };
        }

        if (!decision || decision.action === "allowOnce") return undefined;
        // deny / terminate：block + reason
        const reason =
          typeof decision.reason === "string" && decision.reason.length > 0
            ? decision.reason
            : "The user denied this action.";
        // terminate 是 every 语义（types.d.ts:822-826）：由 approval 侧对**整批**统一带
        // terminate=True；这里按本调用对应卡的决策原样返回。
        return decision.action === "terminate"
          ? { block: true, reason, terminate: true }
          : { block: true, reason };
      });
    } catch (err) {
      // 钩子挂不上不致命（会话照常跑），但必须留痕——否则沙箱静默失效。
      this._logger.warn?.(
        `[minipi:pi] ${sessionId} 沙箱钩子挂载失败：${sanitizeDetail(err)}`,
      );
    }
    return null;
  }

  /** 释放单个会话。 */
  disposeSession(sessionId) {
    const rec = this._records.get(sessionId);
    if (!rec || rec.disposed) return false;
    rec.disposed = true;
    // M4：清掉该会话全部未决审批（默认拒绝，撤卡）——防止悬空 pending 持有定时器（§5.4/§6.3）
    try {
      this._approval?.cancelBySession?.(sessionId);
    } catch (err) {
      this._logger.warn?.(`[minipi:pi] ${sessionId} 清理未决审批失败：${sanitizeDetail(err)}`);
    }
    try {
      rec.unsubscribe?.();
    } catch {
      /* ignore */
    }
    try {
      rec.session?.dispose?.();
    } catch (err) {
      this._logger.warn?.(`[minipi:pi] ${sessionId} dispose 抛错：${sanitizeDetail(err)}`);
    }
    rec.log.clear();
    this._records.delete(sessionId);
    if (this._lastSessionId === sessionId) {
      this._lastSessionId = this._records.size > 0 ? [...this._records.keys()][this._records.size - 1] : null;
    }
    return true;
  }

  /** 释放全部会话（退出时调用）。 */
  disposeAll() {
    for (const id of [...this._records.keys()]) this.disposeSession(id);
  }

  /* ------------------------------------------------------------------ 内部 */

  /** @param {SessionRecord} rec */
  _stateOf(rec) {
    let costUsd = null;
    try {
      const stats = rec.session?.getSessionStats?.();
      if (stats && typeof stats.cost === "number" && Number.isFinite(stats.cost)) costUsd = stats.cost;
    } catch {
      /* 统计拿不到不影响状态上报 */
    }
    let messageCount = 0;
    try {
      messageCount = Array.isArray(rec.session?.messages) ? rec.session.messages.length : 0;
    } catch {
      /* ignore */
    }
    let isStreaming = false;
    try {
      isStreaming = rec.session?.isStreaming === true;
    } catch {
      /* ignore */
    }
    return {
      sessionId: rec.sessionId,
      model: rec.model,
      isStreaming,
      messageCount,
      lastSeq: rec.seq,
      costUsd,
      sceneId: rec.sceneId,
      status: rec.status,
    };
  }

  /**
   * @param {string} sessionId
   * @returns {SessionRecord}
   */
  _requireSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "sessionId 必须是字符串"));
    }
    if (sessionId.length > LIMITS.SESSION_ID_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "sessionId 过长"));
    }
    const rec = this._records.get(sessionId);
    if (!rec) {
      // 单机单用户：会话注册表就是「归属校验」——不在表里的 id 一律 404，
      // 不会因为「只凭 id」就返回别人的会话。
      throw new Error(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, "会话不存在或已释放"));
    }
    return rec;
  }

  /**
   * 事件订阅（换会话后必须重新订阅 —— §3 表最后一行）。
   * @param {SessionRecord} rec
   * @returns {() => void} unsubscribe
   */
  _subscribe(rec) {
    try {
      const unsub = rec.session.subscribe((event) => {
        try {
          this._onPiEvent(rec, event);
        } catch (err) {
          this._logger.error?.(`[minipi:pi] 事件处理抛错：${sanitizeDetail(err)}`);
        }
      });
      return typeof unsub === "function" ? unsub : () => {};
    } catch (err) {
      this._logger.error?.(`[minipi:pi] 订阅失败：${sanitizeDetail(err)}`);
      return () => {};
    }
  }

  /**
   * 单条 Pi 事件：先落内存日志（带 seq），再往外发。
   * @param {SessionRecord} rec
   * @param {unknown} event
   */
  _onPiEvent(rec, event) {
    const type = event && typeof event === "object" ? event.type : undefined;
    if (type === "agent_start" || type === "turn_start" || type === "message_start") {
      rec.status = SESSION_STATUS.STREAMING;
    } else if (type === "agent_end") {
      rec.status = event?.willRetry === true ? SESSION_STATUS.STREAMING : SESSION_STATUS.IDLE;
    } else if (type === "agent_settled") {
      rec.status = SESSION_STATUS.IDLE;
    } else if (type === "error") {
      rec.status = SESSION_STATUS.ERROR;
      if (typeof event?.errorMessage === "string") rec.lastError = sanitizeDetail(event.errorMessage);
    }
    this._appendAndEmit(rec, event);
  }

  /**
   * 落日志 + 发事件。
   * @param {SessionRecord} rec
   * @param {unknown} event
   */
  _appendAndEmit(rec, event) {
    rec.seq += 1;
    const wrapped = wrapEvent(rec.seq, rec.sessionId, event);
    rec.log.push(wrapped); // ① 先落内存日志（带 seq）
    /* ② 顺手把「最后活动 / lastSeq」写回索引（已节流；轮末强制落地）。
       ⚠ 放在 emit 之前：渲染层收到事件时列表已经是新的，避免「答案出来了但时间还是旧的」。 */
    const type = event && typeof event === "object" ? event.type : undefined;
    this._touchIndex(rec, {}, type === "agent_settled" || type === "agent_end");
    try {
      this._emit(wrapped); // ③ 再发（webContents.send）
    } catch (err) {
      this._logger.error?.(`[minipi:pi] 事件外发失败：${sanitizeDetail(err)}`);
    }
  }

  /**
   * 本地合成一条 `error` 事件（**不新造 type**，复用 Pi 自己的 `error`）。
   * 只用于「prompt 在 preflight 之外直接 reject」这类 Pi 不会自己发事件的情形，
   * 让渲染层的第 6 级（失败 / 中断）不至于静默。
   * @param {SessionRecord} rec
   * @param {unknown} err
   */
  _publishSyntheticError(rec, err) {
    rec.status = SESSION_STATUS.ERROR;
    const errorMessage_ = sanitizeDetail(err);
    rec.lastError = errorMessage_;
    this._appendAndEmit(rec, {
      type: "error",
      errorMessage: errorMessage_,
      minipiSynthetic: true,
    });
  }

  /**
   * 取会话历史里「用户 / 助手说的话」，供恢复时回放给渲染层。
   *
   * 每条形状 `{ role, content, timestamp }` —— `content` 与 Pi 的 `AgentMessage` 同形
   * （字符串或 `[{type:"text",text}]` 数组），渲染层的 `extractMessageText()` 两种都认。
   * 只取文本：thinking / toolCall / image 都不是用户眼里的「对话」，
   * 回放它们只会让恢复后的界面出现一堆看不懂、且没有真实执行结果的假卡片。
   * 只取**最近 N 条**并限制单条长度 —— 恢复是为了「接着聊」，不是把整部历史塞进 DOM。
   *
   * @param {unknown} session
   * @returns {Array<{role: "user"|"assistant", content: string, timestamp: number}>}
   */
  _historyOf(session) {
    /** @type {unknown} */
    let messages;
    try {
      messages = session?.messages;
    } catch {
      return [];
    }
    if (!Array.isArray(messages)) return [];

    /** @type {Array<{role:"user"|"assistant", content:string, timestamp:number}>} */
    const out = [];
    for (const message of messages) {
      const role = message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageTextOf(message.content);
      if (text.length === 0) continue;
      const ts = Number.isFinite(message?.timestamp) ? Number(message.timestamp) : Date.now();
      out.push({
        role,
        // 按码点截断：`slice` 会劈开 emoji 的代理对（与 normalizeSessionTitle 同一口径）
        content: sliceByCodePoint(text, RESUME_HISTORY_MAX_CHARS),
        timestamp: ts,
      });
    }
    return out.slice(Math.max(0, out.length - RESUME_HISTORY_MAX_MESSAGES));
  }

  /**
   * 把会话的「活动」写回索引（`updatedAt` / `preview` / `lastSeq`）。
   *
   * ⚠ **节流在这里**：`force=false` 时同一会话 ≥1s 才写一次盘。
   *   流式期间 `message_update` 是逐 token 的，不节流等于拿磁盘当内存用。
   *   真正需要立刻准的时点由调用方传 `force=true`（每条用户消息 / 每轮结束）。
   *
   * 写失败**不抛**：索引写不进去不该让一轮对话崩掉（与 outcome store 同一口径）。
   *
   * @param {SessionRecord} rec
   * @param {{preview?: string}} patch
   * @param {boolean} [force]
   */
  _touchIndex(rec, patch = {}, force = false) {
    if (!rec || rec.persisted !== true) return;
    const now = Date.now();
    if (!force && now - rec.indexWriteAt < INDEX_WRITE_MIN_INTERVAL_MS) return;
    rec.indexWriteAt = now;
    try {
      this.sessionStore.touch(rec.sessionId, { ...patch, lastSeq: rec.seq });
    } catch (err) {
      this._logger.warn?.(`[minipi:pi] ${rec.sessionId} 索引更新失败（不影响会话）：${sanitizeDetail(err)}`);
    }
  }

  /**
   * 建带「M4 闸门接入点」的资源加载器。
   *
   * 关键取舍：`noExtensions: true` —— 闸门只覆盖本会话，第三方扩展（官方 subagent
   * 示例是 `spawn` 独立进程）能绕过 ⇒ 本期干脆禁止第三方扩展（§3.3 要点 7）。
   *
   * 失败不致命：退回 `null`（会话照常建，只是 M4 的钩子暂时挂不上）。
   * @param {ReturnType<typeof resolveScene>} scene
   * @param {string} sessionId
   * @param {string} cwd
   */
  async _buildResourceLoader(scene, sessionId, cwd) {
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        extensionFactories: [
          {
            name: `minipi-${scene.sceneId}`,
            factory: (pi) => {
              // M4 闸门挂点：registerGate() 内部注册 pi.on("tool_call")，
              // 对 repo 场景的 write/edit/bash/powershell 先过沙箱、再 await 审批。
              // 详见 registerGate() 上方注释与 src/main/pi/approval.js。
              this.registerGate(pi, { sessionId, sceneId: scene.sceneId, cwd });
            },
          },
        ],
        noExtensions: true,
      });
      await loader.reload();
      return loader;
    } catch (err) {
      this._logger.warn?.(
        `[minipi:pi] 资源加载器不可用，本会话不带内联扩展（M4 闸门接入点暂不可用）：${sanitizeDetail(err)}`,
      );
      return null;
    }
  }
}
