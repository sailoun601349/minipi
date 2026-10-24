/**
 * preload：把契约暴露成 `window.minipi`。
 *
 * 三条硬约束：
 *   1. **纯透传**——preload 不做任何业务判断、不持有状态、不改字段名；
 *      它只负责「invoke 转发」与「事件订阅 / 退订」。
 *   2. `contextIsolation: true` + `nodeIntegration: false`，渲染层拿不到 Node，
 *      也就拿不到 `~/.pi/agent/auth.json` 里的任何东西。
 *   3. 每个 `on*` 都**返回 unsubscribe 函数**（契约要求）。
 *
 * ⚠ 本文件是 **ESM**（根 package.json 是 `"type": "module"`）。
 *   Electron 只在 `sandbox: false` 时支持 ESM preload，所以
 *   `src/main/window.js` 的 webPreferences 里显式设了 `sandbox: false`
 *   （`contextIsolation` 仍然为 `true`，渲染层依旧没有 Node 能力）。
 */

import { contextBridge, ipcRenderer } from "electron";

import { EVENTS, INVOKE } from "../shared/protocol.js";

/**
 * 订阅一个推送通道。
 * @param {string} channel
 * @param {(payload: unknown) => void} handler
 * @returns {() => void} unsubscribe
 */
function subscribe(channel, handler) {
  if (typeof handler !== "function") {
    throw new TypeError("handler 必须是函数");
  }
  const listener = (_event, payload) => {
    try {
      handler(payload);
    } catch (err) {
      // 渲染层回调抛错不应该把 preload 的监听链带崩
      console.error(`[minipi:preload] ${channel} 的 handler 抛错：`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * 把调用方传进来的值转成**纯数据**再交给 `ipcRenderer`。
 *
 * 为什么必须做：`contextBridge` 暴露出去的函数，其对象入参在 preload 世界里是**代理对象**，
 * 直接丢给 `ipcRenderer.invoke()` 会抛 `An object could not be cloned.`
 * （本机实测：`setWindowState({ state: "ball" })` 必炸，`getSettings()` 无参不炸）。
 * 契约里的入参全是 JSON 安全的（`{sceneId}` / `{sessionId,text,behavior}` / `{state}` …），
 * 所以 JSON 往返一次即可；转不动的一律给 `null`，让主进程的入参校验去报可读错误。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function toPlainArg(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * 包一层的 invoke。
 *
 * 除了入参克隆，还有一坑：Electron 的 `ipcRenderer.invoke` 在被拒时抛出的是**内部错误对象**，
 * 它穿过 `contextBridge` 时同样会触发 `An object could not be cloned.`
 * ⇒ 在 preload 世界里换成一个普通 `Error`（消息仍是主进程给的 `"<CODE>: 说明"`）再往外抛。
 *
 * @param {string} channel
 * @param {unknown} [arg]
 */
async function call(channel, arg) {
  try {
    return await ipcRenderer.invoke(channel, toPlainArg(arg));
  } catch (err) {
    const message =
      err && typeof err.message === "string" && err.message.length > 0 ? err.message : String(err);
    const clean = new Error(message);
    clean.name = "MiniPiError";
    throw clean;
  }
}

/** 契约对象。字段名一字不改。 */
const minipi = Object.freeze({
  /* -------- invoke（渲染 → 主） -------- */

  /** @param {{ sceneId?: string }} [arg] → { sessionId, sceneId, model, lastSeq } */
  createSession: (arg) => call(INVOKE.CREATE_SESSION, arg),

  /** @param {{ sessionId: string }} arg → { sessionId, model, isStreaming, messageCount, lastSeq, costUsd, sceneId, status } */
  sessionState: (arg) => call(INVOKE.SESSION_STATE, arg),

  /** @param {{ sessionId: string, text: string, behavior?: "steer"|"followUp" }} arg → { accepted } */
  prompt: (arg) => call(INVOKE.PROMPT, arg),

  /** @param {{ sessionId: string }} arg → { ok } */
  abort: (arg) => call(INVOKE.ABORT, arg),

  /* -------- 会话自建存储（B1-3 / D-09） -------- */

  /** @param {{ query?: string, archived?: boolean }} [arg] → { items: SessionMeta[] } */
  listSessions: (arg) => call(INVOKE.LIST_SESSIONS, arg),
  /** @param {{ id: string, title: string }} arg → { ok: true, item }（标题截 24 字，空则回「新会话」） */
  renameSession: (arg) => call(INVOKE.RENAME_SESSION, arg),
  /** @param {{ id: string, pinned: boolean }} arg → { ok: true, item } */
  setSessionPinned: (arg) => call(INVOKE.SET_SESSION_PINNED, arg),
  /** @param {{ id: string, archived: boolean }} arg → { ok: true, item }（归档不动文件、不删数据） */
  setSessionArchived: (arg) => call(INVOKE.SET_SESSION_ARCHIVED, arg),
  /**
   * 删除一个会话：正文移入 `.trash/`，**不做物理删除**（D-09 §2.2：v1 不删真数据）。
   * @param {{ id: string }} arg
   * @returns {Promise<{ ok: true, trashedTo: string|null }>}
   *   `trashedTo` 是正文在回收站里的**真实绝对路径**；会话还没有正文文件（刚建、没说过话）
   *   时为 `null` —— 渲染层据此决定 toast 里要不要写路径，别把 null 漏给用户看。
   * @throws `SESSION_NOT_FOUND`（索引里没有）/ `SESSION_BUSY`（正在生成回答）
   */
  deleteSession: (arg) => call(INVOKE.DELETE_SESSION, arg),
  /**
   * 恢复一个已有会话（复用同一个 id 建 Pi 会话，历史进真实模型上下文）。
   * @param {{ id: string }} arg
   * @returns {Promise<{ sessionId: string, title: string, lastSeq: number, sceneId: string,
   *   history: Array<{ role: "user"|"assistant", content: string, timestamp: number }> }>}
   */
  resumeSession: (arg) => call(INVOKE.RESUME_SESSION, arg),

  /** @param {{ state: "ball"|"mini"|"full" }} arg → { ok, bounds } */
  setWindowState: (arg) => call(INVOKE.SET_WINDOW_STATE, arg),

  /** 置顶开关。@param {{ on: boolean }} arg → { ok, on } */
  setAlwaysOnTop: (arg) => call(INVOKE.SET_ALWAYS_ON_TOP, arg),

  /** 最小化到任务栏。→ { ok } */
  minimizeWindow: () => call(INVOKE.MINIMIZE_WINDOW),

  /**
   * 悬浮球右键菜单：请主进程把窗口临时撑开（球停在原位，菜单画在旁边）。
   * @returns {Promise<{ ok: boolean, layout: { ball: {x:number,y:number}, menu: {x:number,y:number}, window: {width:number,height:number} } }>}
   */
  showBallMenu: () => call(INVOKE.SHOW_BALL_MENU),

  /** 收起球菜单并还原 48×48。→ { ok } */
  hideBallMenu: () => call(INVOKE.HIDE_BALL_MENU),

  /** 关闭悬浮窗（隐藏窗口；Alt+Space 唤回）。→ { ok } */
  hideBall: () => call(INVOKE.HIDE_BALL),

  /** 球态手动拖拽：按屏幕像素位移移动窗口。@param {{dx:number,dy:number}} arg → { ok } */
  /** 拖球三步：开始 / 跟随游标 / 结束（结束会顺带吸边） */
  ballDragBegin: () => call(INVOKE.BALL_DRAG_BEGIN),
  ballDragMove: (arg) => call(INVOKE.BALL_DRAG_MOVE, arg),
  ballDragEnd: () => call(INVOKE.BALL_DRAG_END),
  /** 球态拖拽结束 → 吸附到最近的屏幕边缘。→ { ok:boolean } */
  snapBall: () => call(INVOKE.SNAP_BALL),

  /** → settings */
  getSettings: () => call(INVOKE.GET_SETTINGS),

  /** @param {object} partial → settings */
  setSettings: (partial) => call(INVOKE.SET_SETTINGS, partial),
  /** → { minipi:{version,electron,chrome,node,platform}, pi:{name,version,aiVersion}, consistent } */
  getAbout: () => call(INVOKE.GET_ABOUT),

  /** → void（App 退出；调用后不要指望还有返回值） */
  quit: () => call(INVOKE.QUIT),

  /* -------- 产出链路（M5） -------- */

  /** @param {{ sessionId: string, intent: string, format?: "auto"|"md"|"docx" }} arg → OutcomeCard */
  generateOutcome: (arg) => call(INVOKE.GENERATE_OUTCOME, arg),

  /** @param {{ outcomeId: string }} arg → { ok } */
  openOutcome: (arg) => call(INVOKE.OPEN_OUTCOME, arg),

  /** @param {{ outcomeId: string }} arg → { savedPath: string|null, canceled: boolean } */
  saveOutcomeAs: (arg) => call(INVOKE.SAVE_OUTCOME_AS, arg),

  /** @param {{ limit?: number }} [arg] → { items: OutcomeSummary[] } */
  listOutcomes: (arg) => call(INVOKE.LIST_OUTCOMES, arg),

  /* -------- 产出抽屉（D-14：跨重启的持久索引） -------- */
  /** @param {{ query?: string, limit?: number }} [arg] → { items: Array<{id,fileName,title,format,bytes,createdAt,pinned}> } */
  listAssets: (arg) => call(INVOKE.LIST_ASSETS, arg),
  /** @param {{ id: string }} arg → { ok: true }（用系统默认程序打开） */
  openAsset: (arg) => call(INVOKE.OPEN_ASSET, arg),
  /** @param {{ id: string }} arg → { ok: true, trashedTo: string } */
  removeAsset: (arg) => call(INVOKE.REMOVE_ASSET, arg),
  /** @param {{ id: string }} arg → { ok: true }（在系统文件夹中定位，不打开文件） */
  revealAsset: (arg) => call(INVOKE.REVEAL_ASSET, arg),

  /* -------- 模型配置 -------- */
  /** → { current, defaultModel, models: [{ provider, modelId, name, available, needsAuth }] } */
  listModels: () => call(INVOKE.LIST_MODELS),
  /** → { current, defaultModel, featured: string[], providers: [{ provider, name, baseUrl, api, configured, authSource, custom, edited, modelsEdited, models: [{ modelId, name, api, contextWindow, maxTokens, available }] }] } */
  listProviders: () => call(INVOKE.LIST_PROVIDERS),
  /**
   * 模型是否就绪（首启引导用）。
   * @returns {Promise<{ ready: boolean, reason: string }>}
   *   `ready:false` 时 `reason` 是给用户看的一句话；**永不 reject**（读不出来也是合法状态）。
   */
  modelStatus: () => call(INVOKE.MODEL_STATUS),
  /** @param {{ model: { provider: string, modelId: string } | null }} arg */
  setModel: (arg) => call(INVOKE.SET_MODEL, arg),
  /** @param {{ providerId: string, apiKey: string }} arg；key 只透传，不回显 */
  setApiKey: (arg) => call(INVOKE.SET_API_KEY, arg),
  /**
   * 写入提供方定义（自定义 or 覆盖内置）。
   * @param {{ provider: string, definition: { displayName?: string, baseUrl?: string, api?: string, models?: Array<{id: string, name?: string, contextWindow?: number, maxTokens?: number}> } }} arg
   * ⚠ `definition` 里**不接受 apiKey** —— 密钥走 setApiKey（只写不读）。
   */
  setProvider: (arg) => call(INVOKE.SET_PROVIDER, arg),
  /** @param {{ provider: string }} arg → { ok, provider, applied, removed, failed[] } */
  removeProvider: (arg) => call(INVOKE.REMOVE_PROVIDER, arg),
  /**
   * 拉取提供方的可用模型清单（只读 GET）。
   * @param {{ provider?: string, baseUrl: string, api?: string, apiKey?: string }} arg
   * @returns {Promise<{ models: Array<{ modelId: string, name: string }>, url: string, protocol: string }>}
   */
  discoverModels: (arg) => call(INVOKE.DISCOVER_MODELS, arg),

  /* -------- M4 审批闸门 -------- */

  /** @param {{ approvalId: string, action: "allowOnce"|"deny"|"terminate", remember?: boolean }} arg → { ok: true }
   *  `remember:true`（仅 allowOnce）⇒ 本会话总是允许该工具（内存级、退出即失、默认关）。 */
  approvalDecide: (arg) => call(INVOKE.APPROVAL_DECIDE, arg),

  /* -------- 事件订阅（主 → 渲染），都返回 unsubscribe -------- */

  /** @param {(payload: { seq: number, sessionId: string, ts: number, event: any }) => void} handler */
  onEvent: (handler) => subscribe(EVENTS.EVENT, handler),

  /** @param {(payload: { state: "ball"|"mini"|"full", bounds: {x:number,y:number,width:number,height:number} }) => void} handler */
  onWindowState: (handler) => subscribe(EVENTS.WINDOW_STATE, handler),

  /** @param {(payload: { reason: string }) => void} handler —— 球菜单被主进程收起（失焦/切形态） */
  onBallMenuClosed: (handler) => subscribe(EVENTS.BALL_MENU_CLOSED, handler),

  /** @param {(payload: { hidden: boolean }) => void} handler —— 球半隐藏状态（用于 50% 透明度） */
  onBallPeek: (handler) => subscribe(EVENTS.BALL_PEEK, handler),

  /** 鼠标移入球：半隐藏时整球滑出 */
  ballPeekIn: () => call(INVOKE.BALL_PEEK_IN),
  /** 鼠标移出球：立刻半隐藏回去 */
  ballPeekOut: () => call(INVOKE.BALL_PEEK_OUT),
  /** 点了球：还原为不隐藏，3 秒后再半隐藏 */
  ballPin: () => call(INVOKE.BALL_PIN),

  /** @param {(payload: { action: "toggle" } | { action: "grabSelection", selection: string|null, ok: boolean }) => void} handler */
  onHotkey: (handler) => subscribe(EVENTS.HOTKEY, handler),

  /** 主进程发起的「打开某个面板」请求（托盘菜单用）。
   *  @param {(payload: { action: "settings" | "about" }) => void} handler */
  onUiAction: (handler) => subscribe(EVENTS.UI_ACTION, handler),

  /** @param {(card: { outcomeId: string, sessionId: string, format: "md"|"docx", degraded: boolean, fileName: string, bytes: number, title: string, createdAt: number, actions: string[], inlineText?: string }) => void} handler */
  onOutcome: (handler) => subscribe(EVENTS.OUTCOME, handler),

  /** @param {(card: { approvalId: string, phase: "push"|"update"|"cancel", sessionId: string, createdAt: number, expiresAt: number, timeoutMs: number, actions: string[], kind?: "write"|"edit"|"command", toolName?: string, title?: string, alwaysAllowEligible?: boolean, batch: object[] }) => void} handler */
  onApproval: (handler) => subscribe(EVENTS.APPROVAL, handler),
});

contextBridge.exposeInMainWorld("minipi", minipi);
