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

  /** @param {{ state: "ball"|"mini"|"full" }} arg → { ok, bounds } */
  setWindowState: (arg) => call(INVOKE.SET_WINDOW_STATE, arg),

  /** → settings */
  getSettings: () => call(INVOKE.GET_SETTINGS),

  /** @param {object} partial → settings */
  setSettings: (partial) => call(INVOKE.SET_SETTINGS, partial),

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

  /* -------- M4 审批闸门 -------- */

  /** @param {{ approvalId: string, action: "allowOnce"|"deny"|"terminate", remember?: boolean }} arg → { ok: true }
   *  `remember:true`（仅 allowOnce）⇒ 本会话总是允许该工具（内存级、退出即失、默认关）。 */
  approvalDecide: (arg) => call(INVOKE.APPROVAL_DECIDE, arg),

  /* -------- 事件订阅（主 → 渲染），都返回 unsubscribe -------- */

  /** @param {(payload: { seq: number, sessionId: string, ts: number, event: any }) => void} handler */
  onEvent: (handler) => subscribe(EVENTS.EVENT, handler),

  /** @param {(payload: { state: "ball"|"mini"|"full", bounds: {x:number,y:number,width:number,height:number} }) => void} handler */
  onWindowState: (handler) => subscribe(EVENTS.WINDOW_STATE, handler),

  /** @param {(payload: { action: "toggle" } | { action: "grabSelection", selection: string|null, ok: boolean }) => void} handler */
  onHotkey: (handler) => subscribe(EVENTS.HOTKEY, handler),

  /** @param {(card: { outcomeId: string, sessionId: string, format: "md"|"docx", degraded: boolean, fileName: string, bytes: number, title: string, createdAt: number, actions: string[], inlineText?: string }) => void} handler */
  onOutcome: (handler) => subscribe(EVENTS.OUTCOME, handler),

  /** @param {(card: { approvalId: string, phase: "push"|"update"|"cancel", sessionId: string, createdAt: number, expiresAt: number, timeoutMs: number, actions: string[], kind?: "write"|"edit"|"command", toolName?: string, title?: string, alwaysAllowEligible?: boolean, batch: object[] }) => void} handler */
  onApproval: (handler) => subscribe(EVENTS.APPROVAL, handler),
});

contextBridge.exposeInMainWorld("minipi", minipi);
