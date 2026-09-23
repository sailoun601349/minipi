/**
 * 窗口层：**一个 BrowserWindow 实例在三态之间变形**（方案 §4.1 / §4.3）。
 *
 * 为什么不三个窗口：只有一个窗口就没有「两个窗口状态同步」这类 bug，且用户感知
 * 是「同一个东西变大了」——正好对应「避免来回切换」。
 *
 * 实测约束（`spike/electron-window/`，Electron 44.4.3 / Win11 23H2 / dpr 1.5，勿踩）：
 *   ① 透明窗口 `setBounds` **不掉透明**（四角 alpha 全程 0）⇒ 单窗口三态成立；
 *   ② `setBounds` 同步耗时仅 3.2–7.6 ms，无白闪；
 *   ③ **`resize` 事件在 2 秒内不会触发** ⇒ 「变形完成」**绝不能**等 `resize`，
 *      本文件改用「`setBounds` 之后轮询 `getBounds()` 确认」；
 *   ④ 尺寸有 **1px 圆整偏差**（360→361、960→961）⇒ 比较时容差 ±2px；
 *   ⑤ `maximize()` 语义不完整（`isMaximized()` 恒 false、`unmaximize()` 回不去）
 *      ⇒ 构造期就 `maximizable: false`，Full 态不做原生最大化（要铺满则自绘 `setBounds`）。
 *
 * M0 硬指标：`backgroundThrottling: false` 必须在**构造期**设（运行期 setter
 * 结论不可判定，见 spike T4）——被遮挡时若为 true，rAF 计数是 **0**（完全停画）；
 * 为 false 时是 181/3s（≈60/s 全速）。
 */

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { BrowserWindow, screen } from "electron";

import {
  ERROR_CODES,
  EVENTS,
  WINDOW_SIZE,
  WINDOW_STATE,
  errorMessage,
  isWindowState,
} from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** preload 绝对路径。 */
export const PRELOAD_PATH = path.resolve(__dirname, "../preload/index.js");

/** 渲染层入口（由前端工程师方砚负责；本仓库宿主层**不创建/不修改** src/renderer/**）。 */
export const RENDERER_ENTRY = path.resolve(__dirname, "../renderer/index.html");

/**
 * 渲染层入口缺失时的兜底页。
 * 目的：让宿主层在方砚交付前**独立可验证**（`npm start` 就能起窗口、能验证三态与 IPC），
 * 而不是白屏或直接崩掉。见 README「未完成项 / 偏离」。
 */
export const FALLBACK_ENTRY = path.resolve(__dirname, "../../scripts/probe/stub.html");

/** 把 `-webkit-app-region: drag` 拖动结束后的位置写回设置。 */
const POSITION_SAVE_DEBOUNCE_MS = 400;

/** 变形后确认 bounds 的轮询上限（实测 setBounds 同步 3–8ms，600ms 足够宽松）。 */
const CONFIRM_BOUNDS_TIMEOUT_MS = 600;

/**
 * 取一个「至少要露出来」的最小可见边长。
 * @param {{width:number,height:number}} size
 */
function minVisible(size) {
  return Math.max(24, Math.min(48, size.width, size.height));
}

/** `setTimeout` 的 Promise 版。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WindowManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {import("./settings.js").SettingsStore} options.settings
   * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
   * @param {(ctx: { send: (channel: string, payload: unknown) => boolean, webContents: import("electron").WebContents }) => void} [options.onRendererReady]
   *        渲染层 `did-finish-load` 时的回调（用来重放事件增量和补推形态）
   */
  constructor(options = {}) {
    super();
    this._settings = options.settings;
    this._logger = options.logger ?? console;
    this._onRendererReady = options.onRendererReady ?? null;

    /** @type {BrowserWindow | null} */
    this._win = null;
    /** @type {"ball"|"mini"|"full"} */
    this._state = WINDOW_STATE.BALL;
    this._applying = false;
    this._positionTimer = null;
    this._confirmTimer = null;
    this._usingFallbackRenderer = false;
  }

  /** 当前形态。 */
  get state() {
    return this._state;
  }

  /** 当前窗口（可能是 null / destroyed）。 */
  get window() {
    return this._win;
  }

  /** 当前 webContents（可能是 null）。 */
  get webContents() {
    const win = this._win;
    if (!win || win.isDestroyed()) return null;
    const wc = win.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /** 渲染层入口是否走了兜底页（方砚未交付时为 true）。 */
  get usingFallbackRenderer() {
    return this._usingFallbackRenderer;
  }

  /* ==================================================================== 生命周期 */

  /** 创建窗口（按设置里记的上次形态显示）。 */
  async create() {
    const initial = this._settings.get().window.state;
    this._state = isWindowState(initial) ? initial : WINDOW_STATE.BALL;
    const bounds = this.computeBounds(this._state);

    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      hasShadow: false,
      skipTaskbar: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      show: false,
      title: "minipi",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // ESM preload 要求 sandbox:false（Electron 只在该组合下支持 .js/.mjs 形式的 ESM preload）。
        // contextIsolation 仍为 true、nodeIntegration 仍为 false ⇒ 渲染层没有 Node 能力。
        sandbox: false,
        preload: PRELOAD_PATH,
        // ★ M0 硬指标：必须在构造期关掉后台节流
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this._win = win;

    // 透明窗口 + always-on-top 的层级用 screen-saver（spike 同款写法）
    try {
      win.setAlwaysOnTop(true, "screen-saver");
    } catch (err) {
      this._logger.warn?.(`[minipi:window] setAlwaysOnTop 失败：${err?.message ?? err}`);
    }
    try {
      win.setMenuBarVisibility(false);
    } catch {
      /* 无边框窗口本来就没菜单栏 */
    }

    this._bindWindowEvents(win);

    // 加载渲染层（缺失则兜底页，并明确告警）
    const entry = fs.existsSync(RENDERER_ENTRY) ? RENDERER_ENTRY : FALLBACK_ENTRY;
    this._usingFallbackRenderer = entry === FALLBACK_ENTRY;
    if (this._usingFallbackRenderer) {
      this._logger.warn?.(
        `[minipi:window] 未找到 src/renderer/index.html，本次加载兜底探针页（${path.basename(FALLBACK_ENTRY)}）。` +
          "这是宿主层自测用的临时页，方砚交付后会自然切回真实渲染层。",
      );
    }
    try {
      await win.loadFile(entry);
    } catch (err) {
      this._logger.error?.(`[minipi:window] 渲染层加载失败：${err?.message ?? err}`);
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "渲染层页面加载失败"));
    }

    await this.setState(this._state, { emit: false });
    this._logger.info?.(
      `[minipi:window] 已就绪 · 形态 ${this._state} · bounds ${JSON.stringify(win.getBounds())}`,
    );
    return this;
  }

  /** 拆窗（退出时调用）。 */
  destroy() {
    if (this._positionTimer) clearTimeout(this._positionTimer);
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this._positionTimer = null;
    this._confirmTimer = null;
    const win = this._win;
    this._win = null;
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /* ==================================================================== 三态变形 */

  /**
   * 变形到目标形态。
   *
   * 返回的 `bounds` 是 **`getBounds()` 实测值**（可能和请求值差 1px，spike ④）。
   *
   * @param {"ball"|"mini"|"full"} nextState
   * @param {{ emit?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, bounds: {x:number,y:number,width:number,height:number} }>}
   */
  async setState(nextState, options = {}) {
    if (!isWindowState(nextState)) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "state 必须是 ball / mini / full"));
    }
    const win = this._win;
    if (!win || win.isDestroyed()) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "窗口不可用"));
    }

    const target = this.computeBounds(nextState);

    // 变形期间不要被 move 事件把中间态记成「用户拖出来的位置」
    this._applying = true;
    try {
      const t0 = Date.now();
      win.setBounds(target, false);
      const setBoundsSyncMs = Date.now() - t0;
      const actual = await this._confirmBounds(target);

      // 层级与任务栏：ball / mini 不留任务栏条目；full 是真正的工作台，留一个
      try {
        win.setAlwaysOnTop(true, "screen-saver");
      } catch {
        /* ignore */
      }
      try {
        win.setSkipTaskbar(nextState !== WINDOW_STATE.FULL);
      } catch (err) {
        this._logger.warn?.(`[minipi:window] setSkipTaskbar 失败：${err?.message ?? err}`);
      }

      if (nextState === WINDOW_STATE.BALL) {
        // 尽力把焦点还给「唤起前的窗口」（D-02：只做窗口级，caret 恢复是 best-effort）。
        // Electron 没有 GetForegroundWindow/SetForegroundWindow 的 API，
        // 靠 Windows 自身的激活历史 + blur() 兜住常见场景。
        try {
          if (win.isFocused()) win.blur();
        } catch {
          /* ignore */
        }
      }

      this._applyShowPolicy(nextState);

      this._state = nextState;
      this._settings.recordState(nextState);
      const posChanged = this._settings.recordPosition(nextState, actual);

      const payload = { state: nextState, bounds: actual };
      this.emit("state-changed", { ...payload, setBoundsSyncMs });
      if (options.emit !== false) this.sendToRenderer(EVENTS.WINDOW_STATE, payload);

      this._logger.info?.(
        `[minipi:window] 变形 → ${nextState} · 请求 ${target.width}×${target.height} @(${target.x},${target.y})` +
          ` · 实测 ${actual.width}×${actual.height} @(${actual.x},${actual.y})` +
          ` · setBounds ${setBoundsSyncMs}ms${posChanged ? " · 位置已记忆" : ""}`,
      );
      return { ok: true, bounds: actual };
    } finally {
      // 变形后的 move 事件风暴晚一点再放行
      if (this._confirmTimer) clearTimeout(this._confirmTimer);
      this._confirmTimer = setTimeout(() => {
        this._applying = false;
        this._confirmTimer = null;
      }, 250);
    }
  }

  /** ball ↔ mini 开合；full → mini（`Alt+Space` 的语义，§4.2）。 */
  async toggle() {
    const cur = this._state;
    const next = cur === WINDOW_STATE.MINI ? WINDOW_STATE.BALL : WINDOW_STATE.MINI;
    return this.setState(next);
  }

  /** 把窗口带到前台（抓选区热键用；必须在抓取**之后**调，否则 Ctrl+C 会打到自己身上）。 */
  async raise() {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    const noFocus = this._settings.get().noFocusSteal === true;
    try {
      if (!win.isVisible()) {
        if (noFocus) win.showInactive();
        else win.show();
      } else if (!noFocus && !win.isFocused()) {
        win.focus();
      }
      return true;
    } catch (err) {
      this._logger.warn?.(`[minipi:window] raise 失败：${err?.message ?? err}`);
      return false;
    }
  }

  /* ==================================================================== 位置与尺寸 */

  /**
   * 算目标 bounds：记忆位置 → 光标所在屏修正 → 夹进 workArea。
   * @param {"ball"|"mini"|"full"} state
   */
  computeBounds(state) {
    const size = WINDOW_SIZE[state];
    const disp = this._displayForState();
    const wa = disp.workArea;
    const remembered = this._settings.get().window.positions?.[state] ?? null;
    const clamped = remembered ? this._clampPosition(remembered, size, wa) : null;
    const pos = clamped ?? this._defaultPosition(state, wa);
    return { x: pos.x, y: pos.y, width: size.width, height: size.height };
  }

  /** 默认位：球/小窗贴右下侧，大窗居中（多屏一律先按光标所在屏算）。 */
  _defaultPosition(state, wa) {
    const size = WINDOW_SIZE[state];
    const gap = 16;
    if (state === WINDOW_STATE.BALL) {
      return {
        x: wa.x + Math.max(0, wa.width - size.width - gap),
        y: wa.y + Math.round(Math.max(0, wa.height - size.height) * 0.34),
      };
    }
    if (state === WINDOW_STATE.MINI) {
      return {
        x: wa.x + Math.max(0, wa.width - size.width - gap),
        y: wa.y + Math.round(Math.max(0, wa.height - size.height) * 0.16),
      };
    }
    return {
      x: wa.x + Math.round(Math.max(0, (wa.width - size.width) / 2)),
      y: wa.y + Math.round(Math.max(0, (wa.height - size.height) / 2)),
    };
  }

  /**
   * 位置兜底：完全在屏幕外 → 返回 null（调用方改用默认位）；
   * 部分在外 → 夹回工作区左上角以内。单屏够用，多屏是最基本的保守修正。
   * @param {{x:number,y:number}} pos
   * @param {{width:number,height:number}} size
   * @param {{x:number,y:number,width:number,height:number}} wa
   * @returns {{x:number,y:number}|null}
   */
  _clampPosition(pos, size, wa) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
    const need = minVisible(size);
    const visibleX = pos.x + need > wa.x && pos.x < wa.x + wa.width;
    const visibleY = pos.y + need > wa.y && pos.y < wa.y + wa.height;
    if (!visibleX || !visibleY) return null;
    return {
      x: Math.max(Math.round(pos.x), Math.round(wa.x)),
      y: Math.max(Math.round(pos.y), Math.round(wa.y)),
    };
  }

  /** 光标所在屏；失败退回主屏。 */
  _displayForState() {
    try {
      const point = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point);
    } catch {
      try {
        return screen.getPrimaryDisplay();
      } catch {
        return { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
      }
    }
  }

  /**
   * 等窗口真的变成目标尺寸（**不依赖 `resize` 事件**，spike 实测它 2s 内不来）。
   * @param {{x:number,y:number,width:number,height:number}} target
   * @returns {Promise<{x:number,y:number,width:number,height:number}>} 实测 bounds
   */
  async _confirmBounds(target) {
    const win = this._win;
    if (!win || win.isDestroyed()) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "窗口不可用"));
    }
    const deadline = Date.now() + CONFIRM_BOUNDS_TIMEOUT_MS;
    let actual = win.getBounds();
    // 容差 ±2px 吸收 spike ④ 的 1px 圆整偏差
    while (Date.now() < deadline) {
      actual = win.getBounds();
      const okX = Math.abs(actual.x - target.x) <= 2;
      const okY = Math.abs(actual.y - target.y) <= 2;
      const okW = Math.abs(actual.width - target.width) <= 2;
      const okH = Math.abs(actual.height - target.height) <= 2;
      if (okX && okY && okW && okH) break;
      await delay(16);
    }
    return actual;
  }

  /** 显示策略：ball 与「不抢焦点」模式走 `showInactive()`。 */
  _applyShowPolicy(state) {
    const win = this._win;
    if (!win || win.isDestroyed()) return;
    const noFocus = this._settings.get().noFocusSteal === true;
    const wantInactive = state === WINDOW_STATE.BALL || noFocus;
    try {
      if (!win.isVisible()) {
        if (wantInactive) win.showInactive();
        else win.show();
        return;
      }
      if (state === WINDOW_STATE.BALL) {
        // 球态永远不主动抢焦点
        return;
      }
      if (!noFocus && !win.isFocused()) win.focus();
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 显示策略失败：${err?.message ?? err}`);
    }
  }

  /* ==================================================================== 事件绑定 */

  /** @param {BrowserWindow} win */
  _bindWindowEvents(win) {
    // 用户用 -webkit-app-region: drag 拖动窗口 → 记位置（防抖）
    const save = (why) => {
      if (this._applying) return;
      if (this._positionTimer) clearTimeout(this._positionTimer);
      this._positionTimer = setTimeout(() => {
        this._positionTimer = null;
        const w = this._win;
        if (!w || w.isDestroyed()) return;
        const b = w.getBounds();
        if (this._settings.recordPosition(this._state, b)) {
          this._logger.info?.(`[minipi:window] 位置已记忆（${why}）· ${this._state} @(${b.x},${b.y})`);
        }
      }, POSITION_SAVE_DEBOUNCE_MS);
    };
    win.on("move", () => save("move"));
    win.on("moved", () => save("moved"));

    win.on("unresponsive", () => {
      this._logger.warn?.("[minipi:window] 渲染进程无响应");
    });
    win.on("closed", () => {
      this._logger.info?.("[minipi:window] 窗口已关闭");
      this.emit("closed");
    });

    const wc = win.webContents;

    // 渲染层就绪：补推形态 + 重放事件增量（重载/重连不丢历史）
    wc.on("did-finish-load", () => {
      const w = this._win;
      if (!w || w.isDestroyed()) return;
      const payload = { state: this._state, bounds: w.getBounds() };
      this.sendToRenderer(EVENTS.WINDOW_STATE, payload);
      try {
        this._onRendererReady?.({ send: (c, p) => this.sendToRenderer(c, p), webContents: wc });
      } catch (err) {
        this._logger.warn?.(`[minipi:window] onRendererReady 回调抛错：${err?.message ?? err}`);
      }
    });
    wc.on("render-process-gone", (_e, details) => {
      this._logger.error?.(
        `[minipi:window] 渲染进程退出（reason=${details?.reason ?? "?"}，exitCode=${details?.exitCode ?? "?"}）`,
      );
    });
    wc.on("preload-error", (_e, preloadPath, err) => {
      this._logger.error?.(`[minipi:window] preload 加载失败 ${path.basename(String(preloadPath))}：${err?.message ?? err}`);
    });

    // 悬浮球不接受外部导航 / 新窗口（渲染层只能是本地文件）
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => {
      event.preventDefault();
    });
  }

  /* ==================================================================== 发送 */

  /**
   * 往渲染层发一条推送。窗口/渲染层不可用时静默返回 false（不抛）。
   * @param {string} channel
   * @param {unknown} payload
   * @returns {boolean}
   */
  sendToRenderer(channel, payload) {
    const wc = this.webContents;
    if (!wc) return false;
    try {
      // 结构化克隆会拒掉 Electron 的原生对象（如 NativeImage）；
      // 这里统一先过一遍 JSON，保证「不把原生对象丢进 IPC」。
      wc.send(channel, JSON.parse(JSON.stringify(payload ?? null)));
      return true;
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 推送 ${channel} 失败：${err?.message ?? err}`);
      return false;
    }
  }
}
