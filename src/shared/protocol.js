/**
 * minipi · 主进程 ↔ 渲染进程的**唯一契约文件**。
 *
 * 定位：现在放在 `src/shared/`，将来原样搬成 `packages/protocol`。
 * 约束：本文件必须是**纯函数 + 纯常量**，不 import `electron`、不碰 fs、
 *       两边（主进程 / 渲染进程）都要能直接 `import`。
 *
 * 字段名冻结（v0.1，与前端并行开发，一字不改）：
 *
 *   window.minipi = {
 *     // invoke（渲染 → 主，返回 Promise）
 *     createSession({ sceneId })              → { sessionId, sceneId, model, lastSeq }
 *     sessionState({ sessionId })             → { sessionId, model, isStreaming, messageCount,
 *                                                 lastSeq, costUsd, sceneId, status }
 *     prompt({ sessionId, text, behavior })   → { accepted }
 *     abort({ sessionId })                    → { ok }
 *     setWindowState({ state })               → { ok, bounds }
 *     getSettings()                           → settings
 *     setSettings(partial)                    → settings
 *     quit()                                  → void
 *     // 事件订阅（主 → 渲染），都返回 unsubscribe 函数
 *     onEvent(handler)          handler({ seq, sessionId, ts, event })
 *     onWindowState(handler)    handler({ state, bounds })
 *     onHotkey(handler)         handler({ action: 'toggle' } | { action: 'grabSelection', selection, ok })
 *   }
 *
 * 事件里 `event.type` **就是 Pi 的原始事件名**（`message_update` / `tool_execution_start` /
 * `queue_update` / `agent_end` / `turn_end` …），主进程**不做改名**。
 * `seq` 是 **per-session 从 1 连续递增**的整数（方案 §3.1）。
 *
 * 本文件额外补充（不改变上面任何字段名）：
 *   · `ERROR_CODES` / `errorMessage()` / `parseErrorMessage()`：invoke 失败的约定。
 *     Electron 只能把字符串传给渲染层，所以错误一律做成 `"<CODE>: <可读中文/英文说明>"`。
 *   · 若干纯函数工具（`isTextDelta` / `textDeltaOf` / `queuedCount` / `toolArgsOf` …），
 *     给渲染层省掉重复的事件名判断，**不含任何改名**。
 */

/** 协议版本；渲染层可在启动时打印，用来和主进程对表。 */
export const PROTOCOL_VERSION = "0.1.0";

/* ========================================================================== *
 * 1. 通道名常量
 * ========================================================================== */

/** invoke 通道（`ipcRenderer.invoke` ↔ `ipcMain.handle`）。 */
export const INVOKE = Object.freeze({
  CREATE_SESSION: "minipi:createSession",
  SESSION_STATE: "minipi:sessionState",
  PROMPT: "minipi:prompt",
  ABORT: "minipi:abort",
  SET_WINDOW_STATE: "minipi:setWindowState",
  GET_SETTINGS: "minipi:getSettings",
  SET_SETTINGS: "minipi:setSettings",
  QUIT: "minipi:quit",
  // v0.4 产出链路（M5，方案 §3.4）
  GENERATE_OUTCOME: "minipi:generateOutcome",
  OPEN_OUTCOME: "minipi:openOutcome",
  SAVE_OUTCOME_AS: "minipi:saveOutcomeAs",
  LIST_OUTCOMES: "minipi:listOutcomes",
  // M4 审批闸门（审批设计 §9.1）——渲染 → 主：用户点了「允许一次 / 拒绝 / 中断整轮」
  APPROVAL_DECIDE: "minipi:approvalDecide",
});

/** 推送通道（`webContents.send` ↔ `ipcRenderer.on`）。 */
export const EVENTS = Object.freeze({
  EVENT: "minipi:event",
  WINDOW_STATE: "minipi:windowState",
  HOTKEY: "minipi:hotkey",
  // v0.4 产出卡片推送（承载 OutcomeCard，见下方 JSDoc）
  OUTCOME: "minipi:outcome",
  // M4 审批闸门（审批设计 §9.1）——主 → 渲染：推 / 就地更新 / 撤回审批卡
  APPROVAL: "minipi:approval",
});

/** 合并视图，便于调试打印。 */
export const CHANNELS = Object.freeze({ ...INVOKE, ...EVENTS });

/* ========================================================================== *
 * 2. 错误约定
 * ========================================================================== */

/**
 * invoke 失败的错误码。
 * 渲染层拿到的是一句字符串，格式固定为 `"<CODE>: <说明>"`，
 * 用 `parseErrorMessage()` 拆开即可分支处理。
 */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SCENE_NOT_FOUND: "SCENE_NOT_FOUND",
  SESSION_BUSY: "SESSION_BUSY",
  PROMPT_REQUIRES_BEHAVIOR: "PROMPT_REQUIRES_BEHAVIOR",
  PI_UNAVAILABLE: "PI_UNAVAILABLE",
  INTERNAL: "INTERNAL",
  // v0.4 产出链路（M5，方案 §3.4）
  OUTCOME_JSON_INVALID: "OUTCOME_JSON_INVALID",
  OUTCOME_RENDER_FAILED: "OUTCOME_RENDER_FAILED",
  OUTCOME_WRITE_FAILED: "OUTCOME_WRITE_FAILED",
  OUTCOME_NOT_FOUND: "OUTCOME_NOT_FOUND",
  SANDBOX_DENIED: "SANDBOX_DENIED",
  // M4 审批闸门（审批设计 §9.1 / §5）
  // APPROVAL_TIMEOUT：5 分钟未响应 ⇒ 默认拒绝（fail-closed，绝不放行）
  APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
  // APPROVAL_DENIED：用户点了「拒绝」或「中断整轮」
  APPROVAL_DENIED: "APPROVAL_DENIED",
  // APPROVAL_NOT_FOUND：decide 的 approvalId 不存在，或该卡已决（已允许/已拒/已超时）
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
});

/**
 * 造一条可读错误文本。
 * @param {string} code `ERROR_CODES` 里的值
 * @param {string} detail 给人看的说明（**不得**含路径、SQL、密钥、完整手机号）
 * @returns {string}
 */
export function errorMessage(code, detail) {
  const c = String(code || ERROR_CODES.INTERNAL);
  const d = String(detail || "").trim() || "未提供说明";
  return `${c}: ${d}`;
}

/**
 * 拆开 `"<CODE>: <说明>"`。
 * @param {unknown} input
 * @returns {{ code: string, detail: string }}
 */
export function parseErrorMessage(input) {
  const raw = input instanceof Error ? input.message : String(input ?? "");
  // Electron 会在前面加 "Error invoking remote method 'x': Error: "，先剥掉
  const tail = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
  const idx = tail.indexOf(": ");
  if (idx > 0) {
    const code = tail.slice(0, idx);
    if (Object.values(ERROR_CODES).includes(code)) {
      return { code, detail: tail.slice(idx + 2) };
    }
  }
  return { code: ERROR_CODES.INTERNAL, detail: tail };
}

/* ========================================================================== *
 * 3. 窗口形态（§4.1 / §4.3：一个窗口实例三态变形）
 * ========================================================================== */

export const WINDOW_STATE = Object.freeze({
  BALL: "ball",
  MINI: "mini",
  FULL: "full",
});

/** 合法形态顺序（ball → mini → full）。 */
export const WINDOW_STATE_IDS = Object.freeze(["ball", "mini", "full"]);

/**
 * 三态的**窗口**尺寸（DIP；Electron 的 setBounds 单位是 DIP，不是物理像素）。
 *
 * ⚠ ball 的**窗口就是 48×48**，与方案 §4.1 一致：
 *   本机 dpr = 1.5，48 DIP ≈ 48 CSS px ≈ 72 物理像素，已满足 44px 最小命中区建议，
 *   因此**没有**采用「窗口比视觉球大一圈（96×96）」的做法——
 *   那会强迫渲染层在内缩的容器里画球，等于在并行开发期偷偷改视觉契约。
 *   详见 README「与方案的偏离」。
 */
export const WINDOW_SIZE = Object.freeze({
  ball: Object.freeze({ width: 48, height: 48 }),
  mini: Object.freeze({ width: 360, height: 480 }),
  full: Object.freeze({ width: 960, height: 680 }),
});

/* ========================================================================== *
 * 4. 会话状态
 * ========================================================================== */

/** `sessionState.status` 的取值域（主进程维护，渲染层只读）。 */
export const SESSION_STATUS = Object.freeze({
  IDLE: "idle",
  STREAMING: "streaming",
  ERROR: "error",
});

/** `prompt.behavior` 的取值域；缺省为 `steer`（§3.1）。 */
export const STREAMING_BEHAVIOR = Object.freeze({
  STEER: "steer",
  FOLLOW_UP: "followUp",
});

/* ========================================================================== *
 * 5. 场景定义（§3.2）
 * ========================================================================== */

/**
 * 四场景的**声明式**定义（主进程与渲染层共享，渲染层用来画场景切换器）。
 * 主进程侧的「怎么落地成 createAgentSession 参数」在 `src/main/pi/scenes.js`。
 *
 * v0.4 重构（见 `docs/minipi-capability-boundary.md` / plan §3.2）：
 *   第一分类维度从「像不像在编程」改为「**产出的落点**」——
 *   因为这产品的核心动作是「随手产出」。
 *   旧名 → 新名：`speed` → `quick` · `study` → `note` · 新增 `desk` · `work` → `repo`。
 */
export const SCENE_DEFS = Object.freeze({
  quick: Object.freeze({
    sceneId: "quick",
    label: "quick",
    cwdTemplate: "~/.minipi/outbox",
    toolAllowlist: Object.freeze([]),
    noTools: "all",
    sessionManagerMode: "memory",
    description: "随手一问：概念、报错、翻译、改写。无工具可用、不落盘。",
  }),
  note: Object.freeze({
    sceneId: "note",
    label: "note",
    cwdTemplate: "~/.minipi/outbox",
    toolAllowlist: Object.freeze(["read", "write", "grep", "find", "ls"]),
    noTools: null,
    sessionManagerMode: "disk",
    description: "读长文/PDF、写笔记。可写，但只写得进 outbox；无 bash / edit。",
  }),
  desk: Object.freeze({
    sceneId: "desk",
    label: "desk",
    cwdTemplate: "~/.minipi/outbox",
    toolAllowlist: Object.freeze(["read", "write", "grep", "find", "ls"]),
    noTools: null,
    sessionManagerMode: "disk",
    description: "日常办公产出：纪要、周报、提纲。落盘到 outbox；无 bash / edit。",
  }),
  repo: Object.freeze({
    sceneId: "repo",
    label: "repo",
    // repo 是**唯一**允许用户显式选目录的场景（要改真仓库）；
    // v0.1 契约的 createSession 尚无 cwd 参数 ⇒ 先落到 ~/.minipi/repo 占位，
    // 待契约扩展后替换（见 README「未完成项」）。
    cwdTemplate: "~/.minipi/repo",
    toolAllowlist: Object.freeze([
      "read", "write", "edit", "grep", "find", "ls", "bash", "powershell",
    ]),
    noTools: null,
    sessionManagerMode: "disk",
    description: "「这个报错去帮我改代码」。唯一全量工具 + 唯一可改仓库，走审批闸门。",
  }),
});

/** 合法 sceneId 列表。 */
export const SCENE_IDS = Object.freeze(Object.keys(SCENE_DEFS));

/** 默认场景：quick。 */
export const DEFAULT_SCENE_ID = "quick";

/**
 * 场景 → 产出落点是否在 `outbox` 沙箱内。
 * `repo` 是唯一例外（它要动真仓库）。
 * 用于渲染层展示「会不会写我的文件」的提示，以及主进程侧的沙箱校验前置判断。
 */
export const OUTBOX_SCENES = Object.freeze(["quick", "note", "desk"]);

/** @returns {boolean} `v` 是否是合法 sceneId */
export function isSceneId(v) {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SCENE_DEFS, v);
}

/* ========================================================================== *
 * 5.1 产出链路（v0.4 / M5，方案 §3.4）
 * ========================================================================== */

/** 产出格式取值域（D-22：本期只做 Markdown + docx，pptx/xlsx 不做）。 */
export const OUTCOME_FORMAT = Object.freeze({ MD: "md", DOCX: "docx" });

/** 产出格式的合法取值（用于入参校验，与 OUTCOME_FORMAT 同源）。 */
export const OUTCOME_FORMAT_IDS = Object.freeze(Object.values(OUTCOME_FORMAT));

/** 产出卡片的三个动作（本期固定，不开放扩展）。 */
export const OUTCOME_ACTIONS = Object.freeze(["open", "saveAs", "revise"]);

/**
 * 产出卡片（主 → 渲染，随 `EVENTS.OUTCOME` 推送）。
 *
 * 字段名冻结（v0.4）。`buildFileName(title, format, date)` 是文件名规则的**唯一来源**
 * （在 `src/main/pi/outcome/schema.js`，前后端共用同一份规则）。
 *
 * @typedef {object} OutcomeCard
 * @property {string} outcomeId 产出物 id（`o_<n>`，查 open/saveAs 用）
 * @property {string} sessionId 产出所属会话
 * @property {"md"|"docx"} format 最终格式（降级后为 `"md"`）
 * @property {boolean} degraded `true` = 已降级（docx→md / JSON 失败 / 落盘失败）；UI 必须显式标注
 * @property {string} fileName 文件名（落盘失败时仍是「本应生成」的名字）
 * @property {number} bytes 文件字节数
 * @property {string} title 产出标题（单行省略展示）
 * @property {number} createdAt Unix 毫秒时间戳
 * @property {string[]} actions 卡片三按钮，恒为 OUTCOME_ACTIONS
 * @property {string} [inlineText] **仅降级③（落盘失败）时出现**：Markdown 全文，
 *   供渲染层给「复制」按钮，保证「绝不空手而归」
 * @property {string|null} [absPath] 实际落盘绝对路径（仅主进程内部使用；**不回传渲染层**）
 */
// 参考形状：
// {
//   outcomeId: "o_1",
//   sessionId: "s_1",
//   format: "docx",            // "md" | "docx"
//   degraded: false,           // true = 已从 docx 降级为 md
//   fileName: "周报-2026-09-23.docx",
//   bytes: 12345,
//   title: "周报",
//   createdAt: 1730000000000,
//   actions: ["open", "saveAs", "revise"],  // 卡片三按钮，本期固定这三项
// }

/**
 * 产出物清单条目（`LIST_OUTCOMES` 返回的 `items[]` 元素）。
 * 比 `OutcomeCard` 轻——列表不需要 inlineText 与 actions 细节。
 *
 * @typedef {object} OutcomeSummary
 * @property {string} outcomeId
 * @property {"md"|"docx"} format
 * @property {boolean} degraded
 * @property {string} fileName
 * @property {number} bytes
 * @property {string} title
 * @property {number} createdAt
 */

/* ========================================================================== *
 * 5.2 审批闸门（M4，审批设计 `docs/minipi-approval-gate-design.md` §9）
 * ========================================================================== */

/**
 * 需要过审批闸门的工具名单（**只对 `repo` 场景生效**，§8.3）。
 *
 * ⚠ 与 `src/main/pi/sandbox.js` 的 `WRITE_TOOLS`（`["write","edit"]`）**刻意不同，别合并**：
 *   · 沙箱（规则 1）只管**写路径落在哪**——所以只关心「会写盘」的 `write`/`edit`。
 *   · 审批（规则 2）管「**会改动系统的全部动作**」——除写盘外还包括**跑命令**
 *     （`bash`/`powershell` 能删文件、能推代码，危害不比写盘小）。
 *   两份名单各自成常量、各自有测试，语义不同不要复用同一个数组。
 *   `repo` 白名单里的只读工具（`read`/`grep`/`find`/`ls`）**不进审批**，直接放行。
 */
export const APPROVAL_TOOLS = Object.freeze(["write", "edit", "bash", "powershell"]);

/**
 * 审批卡的三个 outcome（**任务 #3 已拍板**的三按钮语义，v1.1）。
 * `decide` 的 `action` 取值域就是这三个字符串。
 *
 * · `allowOnce`：允许这一次（**本次会话不记住**；「本会话总是允许」是另一开关，默认关）
 * · `deny`：拒绝这一次——`{block:true}` 回灌模型，模型**不重试**
 * · `terminate`：拒绝并**中断整轮**——`{block:true, terminate:true}`
 *
 * ⚠ vendor 语义（`types.d.ts:822-826`）：`terminate` 是 **every 语义**——
 *   只有当**同一批的每一个** finalized tool result 都带 `terminate:true` 时才真正生效。
 *   `session.js` 规则 2 据此对整批统一带 `terminate`（§3.6 / §4.2）。
 */
export const APPROVAL_ACTIONS = Object.freeze(["allowOnce", "deny", "terminate"]);

/** `approvalDecide` 的入参取值域（就是 `APPROVAL_ACTIONS`）。 */
export const APPROVAL_ACTION_IDS = APPROVAL_ACTIONS;

/**
 * 审批卡（主 → 渲染，随 `EVENTS.APPROVAL` 推送；承载「推 / 更新 / 撤回」三态）。
 *
 * 字段名冻结（v1.1，审批设计 §9.3；R4 补 `sessionId`/`kind`/`toolName`/`title`/`actions`/
 * `alwaysAllowEligible` 六个卡级字段，team-lead 裁定）。渲染层只据此画卡。
 *
 * `phase === "cancel"` 时不带 `kind`/`toolName`/`title`/`alwaysAllowEligible`（`batch` 为空数组），
 * 渲染层据 `phase` 做移除即可。
 *
 * @typedef {object} ApprovalCard
 * @property {string} approvalId        // "a_<n>"，decide 时回传
 * @property {"push"|"update"|"cancel"} phase   // 推 / 就地更新（同 id 重推）/ 撤回
 * @property {string} sessionId         // 所属会话（R4）
 * @property {number} createdAt         // Unix ms
 * @property {number} expiresAt         // createdAt + APPROVAL_TIMEOUT_MS，前端倒计时用
 * @property {number} timeoutMs         // 恒为 APPROVAL_TIMEOUT_MS，前端倒计时用
 * @property {string[]} actions         // 恒为 APPROVAL_ACTION_IDS（三值）；渲染层据此画按钮（R4）
 * @property {"write"|"edit"|"command"} [kind]      // 卡级类别：单条取该条；混合批取第一条（R4）
 * @property {string} [toolName]        // 卡级工具名：同上（R4）
 * @property {string} [title]           // 卡级标题：单条用 KIND_TITLE；混合批「多项改动（N 项）」（R4）
 * @property {boolean} [alwaysAllowEligible] // 是否可勾「本会话总是允许」（单工具批才为 true）（R4/R5）
 * @property {ApprovalBatchItem[]} batch  // 本次合并的调用列表（§4）；单条时长度 1
 */
// 参考形状：
// {
//   approvalId: "a_7",
//   phase: "push",              // "push" | "update" | "cancel"
//   sessionId: "s_1",
//   createdAt: 1730000000000,
//   expiresAt: 1730000300000,
//   timeoutMs: 300000,
//   actions: ["allowOnce", "deny", "terminate"],
//   kind: "command",
//   toolName: "bash",
//   title: "执行命令",
//   alwaysAllowEligible: true,
//   batch: [ /* ApprovalBatchItem[] */ ],
// }

/**
 * 审批卡里的一条待批调用（`ApprovalCard.batch[]` 元素）。
 *
 * 逐字段来源：`write`/`edit`/`command` 三类共有 `kind`/`toolName`/`title`；
 * 其余为**类别专属**（写了才出现）。字段名冻结（v1.1，审批设计 §9.3）。
 *
 * @typedef {object} ApprovalBatchItem
 * @property {"write"|"edit"|"command"} kind  // 卡片类别，渲染层据此选模板
 * @property {string} toolName                 // 原始工具名 write/edit/bash/powershell
 * @property {string} title                    // 人类可读标题（如「写入文件」「执行命令」）
 * @property {string} [path]                   // write/edit：目标文件（~ 化；越出 cwd 时 `<path:文件名>`）
 * @property {number} [bytes]                  // write：content 的 UTF-8 字节数
 * @property {string} [preview]                // write：前 APPROVAL_WRITE_PREVIEW_CHARS 字符
 * @property {boolean} [overwrite]             // write：目标是否已存在（存在 ⇒ UI 重警示）
 * @property {string} [diff]                   // edit：真实 diff 文本（由 edits[] 生成，不读盘）
 * @property {{added:number,removed:number}} [diffStat]  // edit：摘要行 `+8 -3`
 * @property {boolean} [tooLargeToDiff]        // edit：改动超 APPROVAL_DIFF_MAX_BYTES ⇒ 只给统计
 * @property {"bash"|"powershell"} [shell]     // command
 * @property {string} [command]                // command：完整命令文本（**原样，不脱敏**）
 * @property {number|null} [timeoutSec]        // command：模型给的超时（秒），无则 null
 * @property {"normal"|"high"} [risk]          // command：命中高危模式时 high
 */
// 参考形状（三类各一例）：
// { kind: "write",   toolName: "write", title: "写入文件", path: "周报.md",
//   bytes: 2048, preview: "# 周报\n…", overwrite: false }
// { kind: "edit",    toolName: "edit",  title: "修改文件", path: "src/session.js",
//   diff: "@@ edit 1/1\n- const a = 1;\n+ const a = 2;", diffStat: { added: 1, removed: 1 },
//   tooLargeToDiff: false }
// { kind: "command", toolName: "bash",  title: "执行命令", shell: "bash",
//   command: "npm test", timeoutSec: null, risk: "normal" }

/* ========================================================================== *
 * 6. 设置默认值（`~/.minipi/settings.json`）
 * ========================================================================== */

/**
 * 设置的结构与默认值。**任何未知键在落盘前会被丢掉**（白名单），
 * 见 `src/main/settings.js` 的 `normalizeSettings()`。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  /** 上次用的场景 */
  sceneId: DEFAULT_SCENE_ID,
  /** D-01：默认**抢焦点**（能直接打字）；设 true 走 showInactive() 式唤起 */
  noFocusSteal: false,
  window: Object.freeze({
    /** 上次退出时的形态 */
    state: WINDOW_STATE.BALL,
    /** 三态各自记住的位置；null = 还没记过，由主进程按光标所在屏算默认位 */
    positions: Object.freeze({ ball: null, mini: null, full: null }),
  }),
});

/** 深拷贝一份默认设置（避免调用方改到冻结对象）。 */
export function createDefaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

/* ========================================================================== *
 * 7. 入参上下界（宿主层强制，渲染层可提前用同一份常量做前端校验）
 * ========================================================================== */

export const LIMITS = Object.freeze({
  /** prompt 文本长度上限（字符） */
  PROMPT_MAX_CHARS: 32000,
  /** sessionId 长度上限 */
  SESSION_ID_MAX_CHARS: 64,
  /** sceneId 长度上限 */
  SCENE_ID_MAX_CHARS: 32,
  /** 每个会话的内存事件环形缓冲条数上限 */
  EVENT_LOG_MAX: 2000,
  /** setSettings 的 JSON 体积上限（字节） */
  SETTINGS_JSON_MAX_BYTES: 64 * 1024,
  /** 位置记忆的坐标下界（挡住 NaN / 负数爆炸） */
  POSITION_MIN: -100_000,
  /** 位置记忆的坐标上界 */
  POSITION_MAX: 100_000,
  /** 窗口尺寸下界 / 上界（挡住 size=99999 这类） */
  WINDOW_SIZE_MIN: 24,
  WINDOW_SIZE_MAX: 4096,
  // ---- v0.4 产出链路上限（M5，方案 §3.4）----
  /** 产出标题长度上限（字符） */
  OUTCOME_TITLE_MAX_CHARS: 120,
  /** 产出节数上限 */
  OUTCOME_SECTIONS_MAX: 50,
  /** 单条 bullet 长度上限（字符） */
  OUTCOME_BULLET_MAX_CHARS: 2000,
  /** 单个产出文件体积上限（字节）；超限不静默产出 */
  OUTCOME_FILE_MAX_BYTES: 10 * 1024 * 1024,
  /** generateStructured 的硬超时（毫秒，§3.1.1） */
  OUTCOME_TIMEOUT_MS: 60000,
  /** 用户那句「整理成周报」的长度上限（字符） */
  OUTCOME_INTENT_MAX_CHARS: 2000,
  // ---- M4 审批闸门（审批设计 §9.1）----
  /** 审批等待上限；到点默认拒绝（300000ms = 5 分钟） */
  APPROVAL_TIMEOUT_MS: 300000,
  /** 单张审批卡最多合并的调用条数；超出则新建一张卡（防爆卡，§4.2） */
  APPROVAL_BATCH_MAX_ITEMS: 20,
  /** 单条 edit 的 oldText/newText 超此字节数则不生成逐行 diff，只给 +N -M（§3.3） */
  APPROVAL_DIFF_MAX_BYTES: 65536,
  /** write 卡内容预览的字符上限（只给前 N 字符，不塞全文，§3.2） */
  APPROVAL_WRITE_PREVIEW_CHARS: 2000,
  /** 审计日志里 command 的截断长度（§7.3） */
  APPROVAL_COMMAND_MAX_CHARS: 500,
});

/* ========================================================================== *
 * 8. 纯函数工具
 * ========================================================================== */

/**
 * 事件包装（§3.1 的数据帧）。
 * @param {number} seq per-session 从 1 连续递增
 * @param {string} sessionId
 * @param {unknown} event Pi 的**原始**事件对象（不改名、不裁剪字段）
 * @returns {{ seq: number, sessionId: string, ts: number, event: unknown }}
 */
export function wrapEvent(seq, sessionId, event) {
  return { seq, sessionId, ts: Date.now(), event };
}

/** 是不是 `message_update` 里的 `text_delta`（逐字流式的唯一判定口径）。 */
export function isTextDelta(event) {
  return (
    !!event &&
    event.type === "message_update" &&
    !!event.assistantMessageEvent &&
    event.assistantMessageEvent.type === "text_delta"
  );
}

/** 取 `text_delta` 的增量文本；不是则返回 `""`。 */
export function textDeltaOf(event) {
  return isTextDelta(event) ? String(event.assistantMessageEvent.delta ?? "") : "";
}

/** 是不是 `thinking_delta`（思考块增量）。 */
export function isThinkingDelta(event) {
  return (
    !!event &&
    event.type === "message_update" &&
    !!event.assistantMessageEvent &&
    event.assistantMessageEvent.type === "thinking_delta"
  );
}

/**
 * 排队条数（**不是**席位，§3.1 live 实测）。
 * `queue_update` 的 `steering` / `followUp` 是「尚未投递的消息文本数组」，
 * 投递后会被移出 ⇒ 这个和会「先升后降」。UI 请显示「排队 N 条」。
 */
export function queuedCount(event) {
  if (!event || event.type !== "queue_update") return 0;
  const s = Array.isArray(event.steering) ? event.steering.length : 0;
  const f = Array.isArray(event.followUp) ? event.followUp.length : 0;
  return s + f;
}

/**
 * ⚠ 字段名映射提醒（§3.1 / spike F7）：
 *   · `tool_execution_start` 里参数字段名是 **`args`**
 *   · 扩展侧 `tool_call` 钩子里是 **`input`**
 * 事件流侧统一用 `toolArgsOf()`，不要自己猜字段名。
 */
export function toolArgsOf(event) {
  if (!event || typeof event !== "object") return null;
  return event.args ?? null;
}

/** 本轮是否结束（`agent_end` / `agent_settled` 都算）。 */
export function isTurnSettled(event) {
  return !!event && (event.type === "agent_end" || event.type === "agent_settled");
}

/** 是否是工具执行事件。 */
export function isToolExecution(event) {
  return (
    !!event &&
    (event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end")
  );
}

/* ========================================================================== *
 * 9. 校验小工具（主进程与渲染层共用同一套判断，避免两边规则漂移）
 * ========================================================================== */

/** 是否是「普通对象」（不是 null / 数组 / 函数 / Date…）。 */
export function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `v` 是否是合法形态。 */
export function isWindowState(v) {
  return typeof v === "string" && WINDOW_STATE_IDS.includes(v);
}

/** `v` 是否是合法 streamingBehavior。 */
export function isStreamingBehavior(v) {
  return v === STREAMING_BEHAVIOR.STEER || v === STREAMING_BEHAVIOR.FOLLOW_UP;
}

/** 是否是安全整数（挡 NaN / Infinity / 浮点）。 */
export function isSafeInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/**
 * 把坐标夹到合法区间；非法返回 null（表示「不要用这个位置」）。
 * @param {unknown} pos
 * @returns {{ x: number, y: number } | null}
 */
export function sanitizePosition(pos) {
  if (!isPlainObject(pos)) return null;
  const { x, y } = pos;
  if (!isSafeInt(x) || !isSafeInt(y)) return null;
  if (x < LIMITS.POSITION_MIN || x > LIMITS.POSITION_MAX) return null;
  if (y < LIMITS.POSITION_MIN || y > LIMITS.POSITION_MAX) return null;
  return { x, y };
}
