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
  // 悬浮球右键菜单（v1.1）：为菜单临时撑开窗口 / 收起还原 / 隐藏悬浮窗。
  // 菜单本身画在渲染层；主进程只管窗口几何，不改三态状态机。
  SHOW_BALL_MENU: "minipi:showBallMenu",
  HIDE_BALL_MENU: "minipi:hideBallMenu",
  HIDE_BALL: "minipi:hideBall",
  // 球态手动拖拽（整球可拖）：渲染层按屏幕像素位移 → 主进程 setPosition
  /** 拖球三步（坐标全部在主进程用 OS 游标算，渲染层不传坐标） */
  BALL_DRAG_BEGIN: "minipi:ballDragBegin",
  BALL_DRAG_MOVE: "minipi:ballDragMove",
  BALL_DRAG_END: "minipi:ballDragEnd",
  /** 鼠标移入球（半隐藏时要把整个球滑出来） */
  BALL_PEEK_IN: "minipi:ballPeekIn",
  /** 鼠标移出球（立刻半隐藏回去） */
  BALL_PEEK_OUT: "minipi:ballPeekOut",
  /** 点了球（还原为不隐藏，3 秒后再半隐藏） */
  BALL_PIN: "minipi:ballPin",
  /** 球态拖拽结束：吸附到最近的左右屏幕边缘 */
  SNAP_BALL: "minipi:snapBall",
  GET_SETTINGS: "minipi:getSettings",
  SET_SETTINGS: "minipi:setSettings",
  QUIT: "minipi:quit",
  // v0.4 产出链路（M5，方案 §3.4）
  GENERATE_OUTCOME: "minipi:generateOutcome",
  OPEN_OUTCOME: "minipi:openOutcome",
  SAVE_OUTCOME_AS: "minipi:saveOutcomeAs",
  LIST_OUTCOMES: "minipi:listOutcomes",
  // 抽屉页（D-14）：持久索引的读 / 删（进回收站）/ 定位
  LIST_ASSETS: "minipi:listAssets",
  OPEN_ASSET: "minipi:openAsset",
  REMOVE_ASSET: "minipi:removeAsset",
  REVEAL_ASSET: "minipi:revealAsset",
  // 模型配置（偏好与凭证管理）
  LIST_MODELS: "minipi:listModels",
  LIST_PROVIDERS: "minipi:listProviders",
  SET_MODEL: "minipi:setModel",
  /** 「关于」：运行时探测的版本信息（minipi / Pi / Electron / Chromium / Node） */
  GET_ABOUT: "minipi:getAbout",
  /** 置顶开关（小窗/大窗通用）。@param {{ on: boolean }} → { ok, on } */
  SET_ALWAYS_ON_TOP: "minipi:setAlwaysOnTop",
  /** 最小化到任务栏（小窗/大窗通用）。→ { ok } */
  MINIMIZE_WINDOW: "minipi:minimizeWindow",
  SET_API_KEY: "minipi:setApiKey",
  // 模型配置第二批：提供方定义（自定义提供方 / API 地址与模型目录覆盖 / 拉取模型清单）
  SET_PROVIDER: "minipi:setProvider",
  REMOVE_PROVIDER: "minipi:removeProvider",
  DISCOVER_MODELS: "minipi:discoverModels",
  /**
   * 只读：**模型是否就绪**（首启引导用）。
   * → `{ ready: boolean, reason: string }`
   *   · `ready:true` = 有可用模型（至少一个提供方已配凭据且模型目录非空）；
   *   · `ready:false` 时 `reason` 是**给用户看的一句话**（中文），不是错误码。
   * ⚠ 这个通道**永不 reject**：「读不出来」也是合法状态，抛错会把首启兜底
   *   变成第二个故障点。也**绝不回传任何 key / 凭据**（D-03）。
   */
  MODEL_STATUS: "minipi:modelStatus",
  // M4 审批闸门（审批设计 §9.1）——渲染 → 主：用户点了「允许一次 / 拒绝 / 中断整轮」
  APPROVAL_DECIDE: "minipi:approvalDecide",
  // B1-3 会话自建存储（D-09）：列表 / 改名 / 置顶 / 归档 / 删除（进回收站）/ 恢复
  LIST_SESSIONS: "minipi:listSessions",
  RENAME_SESSION: "minipi:renameSession",
  SET_SESSION_PINNED: "minipi:setSessionPinned",
  SET_SESSION_ARCHIVED: "minipi:setSessionArchived",
  DELETE_SESSION: "minipi:deleteSession",
  RESUME_SESSION: "minipi:resumeSession",
});

/** 推送通道（`webContents.send` ↔ `ipcRenderer.on`）。 */
export const EVENTS = Object.freeze({
  EVENT: "minipi:event",
  WINDOW_STATE: "minipi:windowState",
  // 球菜单被主进程收起（失焦 / 形态变化）：渲染层据此清理菜单布局与 aria
  BALL_MENU_CLOSED: "minipi:ballMenuClosed",
  /** 球「半隐藏」状态变化 → 渲染层据此改透明度 */
  BALL_PEEK: "minipi:ballPeek",
  HOTKEY: "minipi:hotkey",
  // v0.4 产出卡片推送（承载 OutcomeCard，见下方 JSDoc）
  OUTCOME: "minipi:outcome",
  // M4 审批闸门（审批设计 §9.1）——主 → 渲染：推 / 就地更新 / 撤回审批卡
  APPROVAL: "minipi:approval",
  /**
   * 主进程发起的「打开某个面板」请求（v1.0，托盘菜单用）。
   * payload: `{ action: "settings" | "about" }`
   *
   * 为什么需要它：托盘菜单在**主进程侧**（`src/main/tray.js`），而面板是渲染层画的
   * （`openSettingsPanel()` / `openAbout()`）。主进程没有办法自己点按钮，所以要一条
   * 单向推送。刻意做成**通用 UI 动作**而不是 `OPEN_SETTINGS_PANEL` 这种一次性通道：
   * 以后再加"打开帮助/关于/抽屉"不用再动协议。
   */
  UI_ACTION: "minipi:uiAction",
});

/**
 * 主题三态（T1）。`system` 交给 OS 决定 —— Electron 的 `nativeTheme.themeSource`
 * 会直接改变渲染层的 `prefers-color-scheme`，所以 CSS 自动跟随，**无需 IPC、无首帧闪烁**。
 */
export const THEME_IDS = Object.freeze(["system", "light", "dark"]);
/** 主题默认值（结论 D-01：跟随系统）。 */
export const DEFAULT_THEME = "system";

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
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  // PROVIDER_NOT_FOUND：removeProvider 的 provider 既不在 minipi 的提供方定义里
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  // PROVIDER_INVALID：提供方定义不合法（id 形态 / baseUrl 非 http(s) / 协议不在枚举内 / 模型条目非法）
  PROVIDER_INVALID: "PROVIDER_INVALID",
  // DISCOVER_FAILED：拉取模型清单失败（网络 / 非 2xx / 响应不是 list / 协议不支持）
  DISCOVER_FAILED: "DISCOVER_FAILED",
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

/**
 * 悬浮球右键菜单的**视觉盒子**（DIP）。
 *
 * 菜单不是第四个形态：它是 ball 态的一次**临时窗口扩张** ——
 * 主进程把窗口扩成「球 + 菜单 + 留白」的并集，菜单收起后还原 48×48。
 * 这样右键不再需要先把聊天窗撑出来（那正是用户抱怨的行为）。
 *
 * 尺寸与渲染层 `.ballctx` 的 `width:200px` 必须一致；高度按 4 组菜单项 + 底部提示估算。
 */
export const BALL_MENU_SIZE = Object.freeze({ width: 200, height: 262 });

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
 * 4b. 会话自建存储（B1-3 / D-09）
 * ========================================================================== */

/**
 * 会话 id 形态：`s_<base36 秒时间戳>_<4 位随机字母数字>`。
 *
 * 为什么固定这么短：它会出现在**文件名**里（`<ts>_<id>.jsonl`）、在开发者信息里，
 * 也会穿过 IPC。字符集压到 `[a-z0-9]` 之后，路径拼接与 `SessionManager` 的
 * `assertValidSessionId()`（`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`）都天然通过。
 *
 * 主进程（`main/index.js` 入参校验）与存储层（`session-store.js`）共用这一份，
 * 避免两边各写一条正则然后慢慢漂移。
 */
export const SESSION_ID_PATTERN_SOURCE = "^s_[a-z0-9]+_[a-z0-9]{4}$";

/** 会话默认标题（新会话还没被命名时显示它，也是「可以自动取标题」的判定值）。 */
export const SESSION_DEFAULT_TITLE = "新会话";

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
  chat: Object.freeze({
    sceneId: "chat",
    label: "chat",
    cwdTemplate: "~/.minipi/outbox",
    // 只给联网工具：能查实时信息，但**仍然碰不到磁盘**（没有 read/write/edit）。
    toolAllowlist: Object.freeze(["web_search", "web_fetch"]),
    noTools: null,
    sessionManagerMode: "disk",
    description: "只做会话与导出：问答、整理、导出 md/docx；不读写本地文件。",
  }),
  work: Object.freeze({
    sceneId: "work",
    label: "work",
    // work 的**真实写入目标**是「当前打开的文档」，由运行时白名单表达（见 sandbox.js）；
    // cwd 仍落在 outbox，只用于导出与相对路径兜底。
    cwdTemplate: "~/.minipi/outbox",
    // ⚠ 无 bash / powershell（D-15）、无 grep / find：
    //   后两者依赖外部二进制 rg / fd（spike 实测），改单个文档用不上。
    toolAllowlist: Object.freeze(["read", "write", "edit", "ls", "web_search", "web_fetch"]),
    noTools: null,
    sessionManagerMode: "disk",
    description: "改本地文档：打开/新建 md、docx，写盘逐次审批；无 bash。",
  }),
});

/** 合法 sceneId 列表。 */
export const SCENE_IDS = Object.freeze(Object.keys(SCENE_DEFS));

/** 默认场景：chat。 */
export const DEFAULT_SCENE_ID = "chat";

/**
 * 场景 → 产出落点是否在 `outbox` 沙箱内。
 * `work` 不在其内（它要改用户文档，走审批闸门 + 文档白名单）。
 * 用于渲染层展示「会不会写我的文件」的提示，以及主进程侧的沙箱校验前置判断。
 */
export const OUTBOX_SCENES = Object.freeze(["chat"]);

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
 * 需要过审批闸门的工具名单（**只对 `work` 模式生效**，D-11 / D-15）。
 *
 * ⚠ 与 `src/main/pi/sandbox.js` 的 `WRITE_TOOLS`（`["write","edit"]`）**刻意不同，别合并**：
 *   · 沙箱（规则 1）只管**写路径落在哪**——所以只关心「会写盘」的 `write`/`edit`。
 *   · 审批（规则 2）管「**会改动系统的全部动作**」——除写盘外还包括**跑命令**
 *     （`bash`/`powershell` 能删文件、能推代码，危害不比写盘小）。
 *   两份名单各自成常量、各自有测试，语义不同不要复用同一个数组。
 *   `work` 白名单里的只读工具（`read`/`ls`）**不进审批**，直接放行。
 *
 * 注：D-15 之后产品内不再有 `bash`/`powershell` 工具，但这两个名字**保留在名单里**——
 *   审批器是纯函数、不认识场景白名单；万一将来某个场景重新开启命令工具，
 *   这里不能出现「因为删了名字所以静默放行」的漏洞。
 */
export const APPROVAL_TOOLS = Object.freeze(["write", "edit", "bash", "powershell"]);

/**
 * 审批卡的四档 outcome（D-11，用户 2026-10-21 拍板）。
 * `decide` 的 `action` 取值域就是这四个字符串。
 *
 * · `allowOnce`：允许这一次，**不记住**
 * · `allowSession`：本会话**对同一个文件**不再弹卡——**仅内存、退出即失**；
 *   ⚠ 判据是「**单文件绝对路径全等 + 单槽**」（`approval.js` 的 `_allowFile`：每个会话只存
 *   一个 `allowKey`，`===` 全等比对），**不是**按工具名、**不是**按路径前缀。
 *   换个文件即失效；命令类工具（bash/powershell）没有这个按钮。
 *   （2026-10-23 修正：本条原写「按工具名」，与实现不符，会误导审查者得出错误结论。）
 *   ⚠ 只免弹卡，**绝不免沙箱**（沙箱在审批之前判，顺序不可反）
 * · `denyWithInstruction`：拒绝，并把用户填的一句指导**回灌给模型**，让它换路径而不是原地重试
 * · `terminate`：拒绝并**中断整轮**——`{block:true, terminate:true}`
 *
 * ⚠ 旧值 `deny` 仍然接受（IPC 层做别名映射到 `denyWithInstruction`，无 instruction 时语义等同旧版），
 *   避免老渲染层/老测试一升级就崩。
 * ⚠ vendor 语义（`types.d.ts:822-826`）：`terminate` 是 **every 语义**——
 *   只有当**同一批的每一个** finalized tool result 都带 `terminate:true` 时才真正生效。
 *   `session.js` 规则 2 据此对整批统一带 `terminate`（§3.6 / §4.2）。
 */
export const APPROVAL_ACTIONS = Object.freeze([
  "allowOnce",
  "allowSession",
  "denyWithInstruction",
  "terminate",
]);

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
  /** 用户偏好的模型，仅影响新建会话；不包含任何密钥 */
  model: null,
  /** 主题：system / light / dark（D-01 默认跟随系统） */
  theme: "system",
  /** 联网总开关（用户 2026-10-20 拍板：**默认开**）。关掉时 web_search/web_fetch 完全不注册。 */
  webEnabled: true,
  /** 置顶（用户 2026-10-20：默认**不**置顶；开启后常驻顶部） */
  alwaysOnTop: false,
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

/**
 * **没配置时的默认模型**。
 *
 * 刻意不写进 `DEFAULT_SETTINGS.model`（那里保持 `null` = 「用默认」），
 * 而是在 `resolvePreferredModel()` 里兜底 —— 好处是：
 *   · `settings.json` 里 `"model": null` 的老用户**立刻**拿到新默认，不用迁移；
 *   · 「默认」与「用户显式选的」在文件里可区分。
 *
 * 选 `deepseek/deepseek-flash` 的理由：国内直连可用的厂商里它最便宜最快，
 * 而 minipi 的 quick 场景是「随手一问」，用不上 pro 的推理预算。
 */
export const DEFAULT_MODEL_PREFERENCE = Object.freeze({
  provider: "deepseek",
  modelId: "deepseek-flash",
});

/**
 * 模型设置页**默认列出**的厂商（顺序即展示顺序）。
 *
 * 只放国内能直连的：DeepSeek / 智谱 / Kimi(Moonshot) / MiniMax / 通义(Qwen) / 小米 MiMo / Ant Ling。
 * 其余 30 多个内置厂商（OpenAI、Anthropic、Bedrock…）不默认展示，但可以在
 * 「添加提供方」里找出来。任何**已配置密钥**的厂商不论在不在这个表里都会被展示。
 */
/**
 * 默认展示的厂商（模型设置页第一层）。
 *
 * 2026-10-20 用户拍板：**先只保留 DeepSeek** —— 模型与联网（搜索/抓取）共用同一个 Key，
 * 用户配一次就都通。其它厂商没有从代码里删掉，仍可通过「+ 添加提供方」手动展开，
 * 只是不再默认铺一屏。
 */
export const FEATURED_PROVIDER_IDS = Object.freeze(["deepseek"]);

/**
 * 自定义提供方支持的 **API 协议**（逐字取自 Pi 的 `docs/models.md`「Supported APIs」表）。
 *
 * ⚠ 这份是**枚举白名单**，不是建议列表：写进 `registerProvider()` 的 `api` 必须是这四个之一，
 *    否则 Pi 侧组不出 provider。渲染层的下拉框也吃这一份（不许自己再列一遍）。
 */
export const PROVIDER_API_IDS = Object.freeze([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

/**
 * 自定义提供方的 **Provider ID 形态**：小写字母开头，只含 `[a-z0-9-]`。
 *
 * 为什么这么严：这个 id 会进 `registerProvider()`、会派生凭据名、还会出现在模型标识
 * （`provider/modelId`）里；放开大写/下划线/空格只会让后面每一层都要额外转义。
 */
export const PROVIDER_ID_PATTERN_SOURCE = "^[a-z][a-z0-9-]*$";

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
  /** 模型 provider 标识长度上限 */
  MODEL_PROVIDER_MAX_CHARS: 64,
  /** 模型标识长度上限 */
  MODEL_ID_MAX_CHARS: 128,
  /** API key 长度上限 */
  MODEL_API_KEY_MAX_CHARS: 512,
  /** 模型目录最多展示条数 */
  MODEL_CATALOG_MAX: 200,
  /** 单个提供方最多回传的模型条数 */
  PROVIDER_MODELS_MAX: 80,
  /** 模型设置页最多回传的提供方条数 */
  PROVIDER_LIST_MAX: 80,
  /** 自定义提供方 id 长度上限（字符） */
  PROVIDER_ID_MAX_CHARS: 64,
  /** 提供方显示名长度上限（字符） */
  PROVIDER_DISPLAY_NAME_MAX_CHARS: 64,
  /** 提供方 API 地址长度上限（字符） */
  PROVIDER_BASE_URL_MAX_CHARS: 512,
  /** 单个模型 id 长度上限（字符） */
  PROVIDER_MODEL_ID_MAX_CHARS: 200,
  /** 单个模型显示名长度上限（字符） */
  PROVIDER_MODEL_NAME_MAX_CHARS: 200,
  /** 拉取可用模型的超时（毫秒）——网络调用必须有硬上限 */
  DISCOVER_MODELS_TIMEOUT_MS: 15000,
  /** 拉取可用模型时最多接收的条数（防一个畸形响应把界面撑爆） */
  DISCOVER_MODELS_MAX: 500,
  /** 拉取可用模型的响应体字节上限（防超大响应把内存吃满） */
  DISCOVER_MODELS_MAX_BYTES: 2 * 1024 * 1024,
  // ---- 思考段 / 正文里的「模型吐出工具调用标记」识别（显示层）----
  /** 单段文本里最多识别几个 `<invoke>` 块；超出的原样当正文显示 */
  TOOL_INVOKE_MAX_BLOCKS: 20,
  /** 单个 `<invoke>` 块的原文长度上限；超过就认定不是工具标记，原样当正文 */
  TOOL_INVOKE_MAX_CHARS: 20000,
  /** 单个 `<invoke>` 里最多解析几个 `<parameter>` */
  TOOL_PARAM_MAX_ITEMS: 8,
  /** 单个 parameter 值的长度上限（字符） */
  TOOL_PARAM_MAX_CHARS: 2000,
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
  // ---- B1-3 会话自建存储 ----
  /** 会话标题长度上限（字符）：首条用户消息自动取前 N 字，也是 rename 的截断长度 */
  SESSION_TITLE_MAX_CHARS: 24,
  /** 会话预览（最后一条用户消息）长度上限（字符） */
  SESSION_PREVIEW_MAX_CHARS: 60,
  /** 一次最多回传的会话条数（防一个坏索引把界面撑爆） */
  SESSION_LIST_MAX: 200,
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
 * 8b. 模型吐出的「工具调用标记」
 * ========================================================================== */

/**
 * 为什么需要它（2026-09-24 真实事件流取证）：
 *
 * `quick` 场景是 `noTools: "all"` —— **模型手里一个工具都没有**。但模型仍会「想用工具」，
 * 于是把 Anthropic 风格的工具调用语法**当正文写出来**：
 *
 *   <invoke name="cmd"><parameter name="cmd">dir /a</parameter>
 *   <parameter name="justification">看看目录</parameter></invoke>
 *
 * 已用真实会话 dump 过事件流：Pi 只发 `thinking_*` / `text_*`，**没有 `toolcall_*` 子事件**，
 * 最终 content blocks 也只有 `[thinking, text]` —— 也就是说这不是解析漏了，
 * 而是**模型行为**。既然它不是真的工具调用，就不该按工具卡渲染；
 * 但也不该让一屏尖括号糊在用户脸上。
 *
 * 所以：识别出来，折叠成一张「模型尝试调用工具 · 当前场景未启用」的提示卡。
 *
 * 边界（都往「宁可原样显示，不要误吞内容」一侧倒）：
 *   · 只认 `<invoke name="…">…</invoke>` 这个确切形状，`<img>` / `<div>` 之类一律不碰；
 *   · 块数超 `TOOL_INVOKE_MAX_BLOCKS`、单块超 `TOOL_INVOKE_MAX_CHARS` ⇒ 不再识别，
 *     剩下的原样当正文（防模型吐一坨垃圾时把整段吞掉）。
 *
 * @param {unknown} text
 * @returns {Array<{kind:"text", text:string} | {kind:"tool", name:string, raw:string, params:Array<{name:string, value:string}>}>}
 */
export function splitToolMarkup(text) {
  const src = typeof text === "string" ? text : "";
  if (src.length === 0) return [];
  if (!/<invoke\s+name\s*=/i.test(src)) return [{ kind: "text", text: src }];

  const parts = [];
  const re = /<invoke\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/invoke\s*>/gi;
  let cursor = 0;
  let blocks = 0;
  let match = re.exec(src);

  while (match !== null) {
    if (blocks >= LIMITS.TOOL_INVOKE_MAX_BLOCKS) break;
    const raw = match[0];
    if (raw.length > LIMITS.TOOL_INVOKE_MAX_CHARS) break;

    if (match.index > cursor) parts.push({ kind: "text", text: src.slice(cursor, match.index) });
    parts.push({
      kind: "tool",
      name: String(match[1] ?? "").slice(0, LIMITS.MODEL_PROVIDER_MAX_CHARS),
      raw,
      params: parseToolParams(match[2]),
    });
    cursor = match.index + raw.length;
    blocks += 1;
    match = re.exec(src);
  }

  if (cursor === 0) return [{ kind: "text", text: src }];
  if (cursor < src.length) parts.push({ kind: "text", text: src.slice(cursor) });
  return parts;
}

/**
 * 解析 `<invoke>` 体内的 `<parameter name="…">值</parameter>`。
 * @param {string} body
 * @returns {Array<{name:string, value:string}>}
 */
function parseToolParams(body) {
  const out = [];
  const src = typeof body === "string" ? body : "";
  const re = /<parameter\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/parameter\s*>/gi;
  let match = re.exec(src);
  while (match !== null) {
    if (out.length >= LIMITS.TOOL_PARAM_MAX_ITEMS) break;
    out.push({
      name: String(match[1] ?? "").slice(0, LIMITS.MODEL_PROVIDER_MAX_CHARS),
      value: String(match[2] ?? "").trim().slice(0, LIMITS.TOOL_PARAM_MAX_CHARS),
    });
    match = re.exec(src);
  }
  return out;
}

/** 这段文本里有没有**完整**的工具调用标记（流式期间用来决定要不要提前切成卡片）。 */
export function hasToolMarkup(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return /<\/invoke\s*>/i.test(text) && /<invoke\s+name\s*=/i.test(text);
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

/** `v` 是否是合法会话 id（`s_<base36 秒>_<4 位>`）。 */
export function isSessionId(v) {
  return typeof v === "string" && new RegExp(SESSION_ID_PATTERN_SOURCE).test(v);
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
