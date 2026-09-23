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
 * ⚠ v0.4 M5 新增 `generateStructured()` 的**如实记录**（详见该方法的 JSDoc）：
 *   产出链路要「旁路取一次结构化文本、不进对话轮次」。本仓库能做到的不污染是
 *   **主进程侧**的（不写 `rec.seq` / 不进 RingLog / 不推事件），但 Pi SDK 的
 *   `session.prompt()` **必然**把这次指令追加进会话历史——没有官方旁路途径。
 *   即走的是方案 §3.1.1 的「退而求其次」分支：渲染层看不到这次调用，
 *   但 Pi 自己的 sessionManager 历史里会多一条。这是明确取舍，不是遗漏。
 */

import os from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_SCENE_ID,
  ERROR_CODES,
  LIMITS,
  APPROVAL_TOOLS,
  OUTBOX_SCENES,
  SESSION_STATUS,
  STREAMING_BEHAVIOR,
  errorMessage,
  isStreamingBehavior,
  isTextDelta,
  isTurnSettled,
  wrapEvent,
} from "../../shared/protocol.js";

import { OUTBOX_DIR } from "../settings.js";

import { ensureSceneCwd, resolveScene, sessionToolOptions } from "./scenes.js";

import { checkWriteTarget } from "./sandbox.js";

import { redactSecrets } from "./approval.js";

/** 等 `preflightResult` 的窗口（对齐方案 §5 第 0 级的 0–300ms 预算）。 */
const PREFLIGHT_WAIT_MS = 250;

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
   */
  constructor({ sessionId, scene, session, unsubscribe }) {
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
  }
}

/**
 * Pi 会话宿主：会话注册表 + 事件 → `seq` 包装 + 对外三个动作（create / prompt / abort）。
 *
 * 与 Electron 完全解耦（只通过注入的 `emit` 往外发），因此可以在纯 Node 下被测试
 * ——— `scripts/verify-stream.mjs` 就是这么跑的。
 */
export class PiSessionHost {
  /**
   * @param {object} [options]
   * @param {(wrapped: {seq:number,sessionId:string,ts:number,event:unknown}) => void} [options.emit]
   * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
   * @param {number} [options.eventLogMax]
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

    /** @type {Map<string, SessionRecord>} */
    this._records = new Map();
    /** @type {import("@earendil-works/pi-coding-agent").ModelRuntime | null} */
    this._modelRuntime = null;
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
   * 建 `ModelRuntime`（**复用** `~/.pi/agent/auth.json`，不自建 API key）。
   * 可重复调用；并发调用共用同一个 Promise。
   */
  async init() {
    if (this._modelRuntime) return this._modelRuntime;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const rt = await ModelRuntime.create();
        this._modelRuntime = rt;
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
          `Pi 凭据 / 模型目录不可用（需 ~/.pi/agent/auth.json 里至少一个可用 provider）：${sanitizeDetail(err)}`,
        ),
      );
    }
  }

  /** 已登记的会话 id 列表。 */
  listSessionIds() {
    return [...this._records.keys()];
  }

  /** 某个会话是否存在。 */
  hasSession(sessionId) {
    return typeof sessionId === "string" && this._records.has(sessionId);
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
   * @param {{ sceneId?: string }} [input]
   * @returns {Promise<{ sessionId: string, sceneId: string, model: string | null, lastSeq: number }>}
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

    this._sessionCounter += 1;
    const sessionId = `s_${this._sessionCounter}`;

    const sessionManager =
      scene.sessionManagerMode === "memory"
        ? SessionManager.inMemory(cwd)
        : // disk：不传 sessionDir，走 Pi 默认会话目录 ⇒ 与 Pi CLI 共用（§3.2 repo 行）
          SessionManager.create(cwd);

    const resourceLoader = await this._buildResourceLoader(scene, sessionId, cwd);

    let created;
    try {
      created = await createAgentSession({
        modelRuntime: this._modelRuntime,
        cwd,
        sessionManager,
        ...(resourceLoader ? { resourceLoader } : {}),
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
    });
    rec.model = session?.model ? `${session.model.provider}/${session.model.id}` : null;

    rec.unsubscribe = this._subscribe(rec);

    this._records.set(sessionId, rec);
    this._lastSessionId = sessionId;

    this._logger.info?.(
      `[minipi:pi] 会话已建 ${sessionId} · 场景 ${scene.sceneId} · cwd ~/${path.basename(cwd)} · 模型 ${rec.model ?? "(未解析)"}` +
        (created.modelFallbackMessage ? ` · 注意：${sanitizeDetail(created.modelFallbackMessage, 120)}` : ""),
    );

    return { sessionId, sceneId: rec.sceneId, model: rec.model, lastSeq: rec.seq };
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

    const text = input?.text;
    if (typeof text !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "text 必须是字符串"));
    }
    if (text.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "text 不能为空"));
    }
    if (text.length > LIMITS.PROMPT_MAX_CHARS) {
      throw new Error(
        errorMessage(
          ERROR_CODES.INVALID_ARGUMENT,
          `text 超长（上限 ${LIMITS.PROMPT_MAX_CHARS} 字符，实际 ${text.length}）`,
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
   * 一次性结构化输出：复用既有 Pi 会话，要求模型只回一段 JSON，返回原始文本。
   *
   * ⚠ 命名刻意避开 prompt/ask 等词 —— 它是「一次性结构化输出」，不是 prompt 变体：
   *    · **不写 `rec.seq`、不进 RingLog** —— 它不是对话轮次，不该污染事件流。
   *    · **不影响 `rec.status`、不推 message_* 事件** —— UI 不该看见它；产出卡片才是用户可见面。
   *    · 入参出参**不暴露任何 Pi SDK 类型**（纯 string 进出）。
   *
   * ## 实现事实（⚠ 如实记录，不要美化成「干净的旁路」）
   *
   * 本方法走的是方案 §3.1.1 的**「退而求其次」分支**：Pi SDK 的
   * `session.prompt(text)` **必然**把这条指令追加进会话历史（它是 SDK 的公开 API，
   * 没有「旁路取一次文本、不入历史」的官方途径 —— 这一点已由本仓库既有接线证实）。
   * 我们能做到的、也确实做到的「不污染」是**主进程侧**的：
   *   · 不调用 `_appendAndEmit()`、不递增 `rec.seq`、不推 `EVENTS.EVENT`。
   * ⇒ **事件流 / RingLog / 渲染层** 完全看不到这次调用（符合「旁路」目标）；
   *    但 **Pi 自己的 `sessionManager` 历史里会多一条指令与一条回答**。
   *    对用户体验影响很小（用户看到的是产出卡片，不是原始 JSON），这是明确取舍。
   *
   * ## 取文本的方式
   *
   * 复用**已有**的判定口径（不另造判断）：
   *   · 用 `isTextDelta()` 从 `message_update` 里收 `text_delta`；
   *   · 用 `isTurnSettled()`（`agent_end` / `agent_settled`）作为收口信号。
   * 收口时**同时**给 `prompt()` 的 Promise 挂一个兜底（它 resolve 也视为结束），
   * 因为不同 SDK 版本收口事件可能只发其中之一。
   *
   * ## 超时必须硬收
   *
   * 超时后调 `rec.session.abort()` 并 reject。**绝不**留一个永远 pending 的 Promise
   * （否则产出卡片永不返回）。`timer.unref()` 保证超时定时器不会拖住进程退出。
   *
   * @param {{ sessionId: string, instruction: string, timeoutMs?: number }} input
   * @returns {Promise<{ text: string, model: string|null }>}
   * @throws 超时 → `INTERNAL`「结构化输出超时」；会话不存在 → `SESSION_NOT_FOUND`；
   *         Pi 不可用 / 同步抛错 → `PI_UNAVAILABLE`
   */
  async generateStructured(input) {
    const rec = this._requireSession(input?.sessionId);

    const instruction = input?.instruction;
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "instruction 不能为空"));
    }
    if (instruction.length > LIMITS.PROMPT_MAX_CHARS) {
      throw new Error(
        errorMessage(ERROR_CODES.INVALID_ARGUMENT, `instruction 超长（上限 ${LIMITS.PROMPT_MAX_CHARS} 字符）`),
      );
    }

    const timeoutMs =
      Number.isFinite(input?.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : LIMITS.OUTCOME_TIMEOUT_MS;

    return await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";

      // 只针对**本次调用**的临时订阅（`session.subscribe` 每次调用返回独立 unsubscribe）。
      // 注意：它与 `_subscribe()` 的那条订阅是并行的 —— 那条负责正常事件流（带 seq），
      // 这条只负责把 text_delta 收进本地 buffer，**不发事件、不写日志**。
      let unsub = () => {};

      const cleanup = () => {
        try {
          unsub?.();
        } catch {
          /* ignore */
        }
      };

      const finish = (ok, payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (ok) resolve(payload);
        else reject(payload);
      };

      const timer = setTimeout(() => {
        // 超时：先 abort 收口，再 reject。abort 本身抛错也不能影响 reject。
        Promise.resolve()
          .then(() => rec.session.abort())
          .catch((err) => {
            this._logger.warn?.(`[minipi:pi] ${rec.sessionId} 结构化输出超时后 abort 失败：${sanitizeDetail(err)}`);
          })
          .finally(() => {
            finish(false, new Error(errorMessage(ERROR_CODES.INTERNAL, "结构化输出超时")));
          });
      }, timeoutMs);
      timer.unref?.();

      try {
        unsub = rec.session.subscribe((event) => {
          // 收文本：复用 protocol.js 的 isTextDelta（唯一判定口径）
          if (isTextDelta(event)) {
            buffer += String(event.assistantMessageEvent?.delta ?? "");
            return;
          }
          // 收口：复用 isTurnSettled（agent_end / agent_settled）
          if (isTurnSettled(event)) {
            finish(true, { text: buffer, model: rec.model });
          }
        });
      } catch (err) {
        finish(false, new Error(errorMessage(ERROR_CODES.PI_UNAVAILABLE, `订阅失败：${sanitizeDetail(err)}`)));
        return;
      }

      // 触发这一轮。**不 await 整轮** —— 由订阅 + 超时收口。
      let runPromise;
      try {
        runPromise = rec.session.prompt(instruction, { streamingBehavior: STREAMING_BEHAVIOR.FOLLOW_UP });
      } catch (err) {
        finish(false, new Error(errorMessage(ERROR_CODES.PI_UNAVAILABLE, `结构化输出失败：${sanitizeDetail(err)}`)));
        return;
      }

      // 兜底收口：万一 SDK 这一版没发 agent_end / agent_settled，靠 prompt 的 resolve 也能收。
      Promise.resolve(runPromise).then(
        () => finish(true, { text: buffer, model: rec.model }),
        (err) => {
          // 已 settle（比如超时已经 reject 过）就走不到这里；否则按失败处理。
          if (!settled) {
            finish(false, new Error(errorMessage(ERROR_CODES.PI_UNAVAILABLE, `结构化输出失败：${sanitizeDetail(err)}`)));
          }
        },
      );
    });
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
    try {
      this._emit(wrapped); // ② 再发（webContents.send）
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
