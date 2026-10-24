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
  BALL_MENU_SIZE,
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

/** 渲染层入口（由前端工程师前端负责；本仓库宿主层**不创建/不修改** src/renderer/**）。 */
export const RENDERER_ENTRY = path.resolve(__dirname, "../renderer/index.html");

/**
 * 渲染层入口缺失时的兜底页。
 * 目的：让宿主层在前端交付前**独立可验证**（`npm start` 就能起窗口、能验证三态与 IPC），
 * 而不是白屏或直接崩掉。见 README「未完成项 / 偏离」。
 */
export const FALLBACK_ENTRY = path.resolve(__dirname, "../../scripts/probe/stub.html");

/** 把 `-webkit-app-region: drag` 拖动结束后的位置写回设置。 */
const POSITION_SAVE_DEBOUNCE_MS = 400;

/**
 * 吸边触发区（球心距屏幕边缘多少像素内才吸附）。
 *
 * 原来是 56px（约一个球径），用户实测"停在离边还有一段就自己吸过去，还跟着隐藏了"——
 * 那是把"靠近"当成了"贴住"。收到 10px：只有**真的拖到边上**才吸，
 * 停在别处就是停在别处，既不吸也不隐藏。
 */
const BALL_SNAP_THRESHOLD = 10;

/**
 * 球态「光标在不在球上」的巡检周期（毫秒）。
 *
 * 为什么不用 DOM 的 mouseenter/mouseleave 驱动显隐：实测两个坑都在它身上 ——
 *   ① 我们自己移动窗口时，浏览器可能**不发** leave（渲染层还以为鼠标在里面）⇒ 永不隐藏；
 *   ② 方框四角的透明区会来回触发 enter/leave ⇒ 显隐乒乓。
 * 改成主进程定时读 OS 游标 + 圆形滞回判定：**不依赖事件投递**，状态只会收敛不会抖。
 * 150ms 对"鼠标移开就收起"的手感足够，成本是一次 `getCursorScreenPoint()`。
 */
const BALL_HOVER_TICK_MS = 150;

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
    /** 球右键菜单是否展开中（临时窗口扩张，不算第四态） */
    this._menuOpen = false;
    /** @type {{x:number,y:number,width:number,height:number}|null} 展开前的球位置（还原用，不依赖设置文件） */
    this._menuAnchor = null;
    /** @type {{ball:{x:number,y:number},menu:{x:number,y:number},window:{width:number,height:number}}|null} */
    this._menuLayout = null;

    /* ---- 拖球 / 半隐藏（类 360 悬浮球） ---- */
    /** 拖球会话（beginBallDrag 建立，endBallDrag 清除） */
    this._drag = null;
    /** 球吸附在哪条边：'left' | 'right' | null（null = 没吸边，不做半隐藏） */
    this._ballEdge = null;
    /** 球是否处于半隐藏（一半在屏幕外） */
    this._ballHidden = false;
    /** 尺寸自愈日志的节流时间戳（避免异常时刷屏） */
    this._healLogAt = 0;
    /** 球态光标巡检定时器 */
    this._ballHoverTimer = null;
    /** 尺寸自愈日志的节流时间戳（避免异常时刷屏） */
    this._healLogAt = 0;
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

  /** 渲染层入口是否走了兜底页（前端未交付时为 true）。 */
  get usingFallbackRenderer() {
    return this._usingFallbackRenderer;
  }

  /** 悬浮球右键菜单是否展开中。 */
  get ballMenuOpen() {
    return this._menuOpen;
  }

  /**
   * 按 `settings.alwaysOnTop` 应用置顶（用户 2026-10-20：默认不置顶，开关控制）。
   * 开 = `screen-saver` 层级（高于普通置顶窗）；关 = 普通窗口。
   */
  applyAlwaysOnTop() {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    const on = this._settings.get().alwaysOnTop === true;
    try {
      win.setAlwaysOnTop(on, on ? "screen-saver" : "normal");
    } catch (err) {
      this._logger.warn?.(`[minipi:window] setAlwaysOnTop(${on}) 失败：${err?.message ?? err}`);
      return false;
    }
    return on;
  }

  /**
   * 最小化到任务栏（mini / full 都可）。
   * ⚠ 必须先 `setSkipTaskbar(false)`：ball/mini 默认不留任务栏条目，
   *   直接 minimize 会让窗口"消失"且无处可点回来。
   */
  minimize() {
    const win = this._win;
    if (!win || win.isDestroyed()) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "窗口不可用"));
    }
    try {
      win.setSkipTaskbar(false);
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 最小化前 setSkipTaskbar 失败：${err?.message ?? err}`);
    }
    try {
      win.minimize();
    } catch (err) {
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, `最小化失败：${err?.message ?? err}`));
    }
    return { ok: true };
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
      /* ★ 必须关掉 thickFrame（Windows）。
         只设 `resizable:false` **不够**：Windows 下无边框窗口默认带 WS_THICKFRAME，
         系统会把窗口边缘当成 resize 热区。球态窗口只有 48×48 —— **整个窗口都是边缘**，
         于是"按住球拖动"被 OS 当成"拖边框缩放"：窗口朝拖动方向一张张长大，
         直到铺满屏幕，还挡住桌面（2026-10-20 用户实测：四个方向都能长到全屏）。
         关掉 thickFrame 后就没有 resize 热区了；阴影本来也是 hasShadow:false。 */
      thickFrame: false,
      /* 用户 2026-10-20：置顶改成**开关**（默认不置顶）。初始值从 settings.alwaysOnTop 读，
         create() 里会按设置再 setAlwaysOnTop 一次（含层级）。 */
      alwaysOnTop: false,
      hasShadow: false,
      skipTaskbar: true,
      maximizable: false,
      /* 最小化到任务栏：mini/full 都要有（用户 2026-10-20）。
         注意 skipTaskbar 会随形态变（ball 隐藏、full 留任务栏）；最小化时先把
         skipTaskbar 关掉，否则任务栏里看不到、点不回来。 */
      minimizable: true,
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
    /* 球态任何 resize 都按回去（见 _healBallSize 的注释：48×48 窗口整个都是系统 resize 热区）。 */
    win.on("resize", () => { this._healBallSize(); });

    // 透明窗口 + 置顶层级用 screen-saver（spike 同款写法）；不置顶时关掉即可
    try {
      this.applyAlwaysOnTop();
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
          "这是宿主层自测用的临时页，前端交付后会自然切回真实渲染层。",
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

    // 球菜单展开中要切形态：先收起（还原 48×48），否则会带着扩张后的窗口去变形
    if (this._menuOpen) await this.closeBallMenu();

    const target = this.computeBounds(nextState);

    /* 变形期间巡检必须停：中间态的 bounds 既不是球也不是 mini，
       巡检会判成"不在边上"→ 恢复显示 → 下一 tick 又判回贴边 → 肉眼就是"球在抖"
       （2026-10-20 用户实测：点球时抖一下）。 */
    this._stopBallHoverWatch();

    // 变形期间不要被 move 事件把中间态记成「用户拖出来的位置」
    this._applying = true;
    try {
      const t0 = Date.now();
      win.setBounds(target, false);
      const setBoundsSyncMs = Date.now() - t0;
      const actual = await this._confirmBounds(target);

      // 层级与任务栏：ball / mini 不留任务栏条目；full 是真正的工作台，留一个
      try {
        this.applyAlwaysOnTop();
      } catch {
        /* ignore */
      }
      try {
        win.setSkipTaskbar(nextState !== WINDOW_STATE.FULL);
      } catch (err) {
        this._logger.warn?.(`[minipi:window] setSkipTaskbar 失败：${err?.message ?? err}`);
      }

      /* 半隐藏状态随形态切换重置：
         · 回到球态：按当前坐标重新判定贴哪条边，贴边就 3 秒后收起；
         · 离开球态（mini/full）：把球恢复成完整显示（否则下次回到球态会从半个开始）。 */
      if (nextState === WINDOW_STATE.BALL) {
        this._ballHidden = false;
        this._ballEdge = this._edgeOf(win.getBounds());
        this.sendToRenderer(EVENTS.BALL_PEEK, { hidden: false });
        /* 开巡检：之后显隐完全由"光标在不在球上"决定（不依赖事件，防漏发/防抖）。 */
        this._startBallHoverWatch();
        this._syncBallPeek();
      } else {
        this._stopBallHoverWatch();
        this._ballEdge = null;
        this._ballHidden = false;
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

  /* ==================================================================== 球右键菜单 */

  /**
   * 为悬浮球右键菜单**临时撑开窗口**（不改变形态 `_state`）。
   *
   * 为什么必须撑开：窗口只有 48×48，HTML 菜单画不到窗口外（会被原生裁剪）。
   * 撑开的是**窗口几何**，渲染层只画「球 + 菜单」—— 用户看到的是「右键出菜单」，
   * 而不再是以前那样「右键先把聊天窗撑出来」。
   *
   * 菜单优先放球的左侧/右侧（按工作区空间选边），垂直方向底对齐球底，
   * 再整体夹进工作区。返回的坐标都是**相对扩张后窗口**的 CSS px（DIP）。
   *
   * @returns {Promise<{ball:{x:number,y:number},menu:{x:number,y:number},window:{width:number,height:number}}|null>}
   */
  async openBallMenu() {
    const win = this._win;
    if (!win || win.isDestroyed()) return null;
    if (this._state !== WINDOW_STATE.BALL) return null;
    if (this._menuOpen && this._menuLayout) return this._menuLayout;

    const anchor = win.getBounds();
    const gap = 8;
    const pad = 6;
    const menuW = BALL_MENU_SIZE.width;
    const menuH = BALL_MENU_SIZE.height;
    const disp = this._displayForPoint(
      anchor.x + Math.round(anchor.width / 2),
      anchor.y + Math.round(anchor.height / 2),
    );
    const wa = disp.workArea;

    const roomRight = wa.x + wa.width - (anchor.x + anchor.width);
    const roomLeft = anchor.x - wa.x;
    let menuX;
    if (roomRight >= menuW + gap + pad) menuX = anchor.x + anchor.width + gap;
    else if (roomLeft >= menuW + gap + pad) menuX = anchor.x - menuW - gap;
    else menuX = roomRight >= roomLeft ? anchor.x + anchor.width + gap : anchor.x - menuW - gap;
    menuX = Math.max(wa.x + pad, Math.min(menuX, wa.x + wa.width - menuW - pad));

    // 底对齐球底：默认球在屏幕右下侧，菜单向上长，不会越过屏幕底
    let menuY = anchor.y + anchor.height - menuH;
    menuY = Math.max(wa.y + pad, Math.min(menuY, wa.y + wa.height - menuH - pad));

    const x = Math.min(anchor.x, menuX) - pad;
    const y = Math.min(anchor.y, menuY) - pad;
    const width = Math.max(anchor.x + anchor.width, menuX + menuW) + pad - x;
    const height = Math.max(anchor.y + anchor.height, menuY + menuH) + pad - y;

    this._menuOpen = true;
    this._menuAnchor = anchor;
    this._applying = true;

    try {
      win.setBounds({ x, y, width, height }, false);
      await this._confirmBounds({ x, y, width, height });
      // 菜单要靠「失焦」自动收起 —— 所以这一次必须主动拿焦点（只发生在用户右键的瞬间）
      try {
        win.focus();
      } catch {
        /* ignore */
      }
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 球菜单展开失败：${err?.message ?? err}`);
      this._menuOpen = false;
      this._menuAnchor = null;
      this._applying = false;
      return null;
    }

    const layout = {
      ball: { x: anchor.x - x, y: anchor.y - y },
      menu: { x: menuX - x, y: menuY - y },
      window: { width, height },
    };
    this._menuLayout = layout;
    this._logger.info?.(
      `[minipi:window] 球菜单展开 · 窗口 ${width}×${height} @(${x},${y}) · 菜单相对 (${layout.menu.x},${layout.menu.y})`,
    );
    return layout;
  }

  /**
   * 收起球菜单并还原 48×48（Esc / 点外部 / 失焦 / 选中动作都会走这里）。
   * @returns {Promise<boolean>} 本次是否真的收起（没开就返回 false）
   */
  async closeBallMenu() {
    if (!this._menuOpen) return false;
    this._menuOpen = false;
    this._menuLayout = null;
    const anchor = this._menuAnchor;
    this._menuAnchor = null;
    const win = this._win;

    if (win && !win.isDestroyed() && anchor) {
      try {
        const target = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height };
        win.setBounds(target, false);
        await this._confirmBounds(target);
      } catch (err) {
        this._logger.warn?.(`[minipi:window] 球菜单还原失败：${err?.message ?? err}`);
      }
    }
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this._confirmTimer = setTimeout(() => {
      this._applying = false;
      this._confirmTimer = null;
    }, 250);

    this.sendToRenderer(EVENTS.BALL_MENU_CLOSED, { reason: "closed" });
    this._logger.info?.("[minipi:window] 球菜单收起 · 窗口还原 48×48");
    return true;
  }

  /**
   * 球态手动拖拽：按屏幕位移移动窗口（整球可拖）。
   *
   * 为什么不用 CSS `-webkit-app-region: drag`：drag 区域会吞掉鼠标事件，
   * 球心（36px 核心）必须 no-drag 才能收到点击，于是**只有外面 6px 的环能拖** ——
   * 用户抓着球心拖不动（2026-10-20 反馈）。改成 pointer 事件 + 位移阈值：
   * 移动超过 4px 视为拖拽，否则视为点击。
   *
   * @param {number} dx 屏幕像素位移
   * @param {number} dy
   * @returns {boolean}
   */
  /**
   * 开始拖球。
   *
   * ## 为什么坐标全在主进程算
   *
   * 之前试过两条路，都被同一个坑打回：
   *   ① `e.screenX` 求差 —— Chromium 里 `screenX = clientX + 窗口原点`；
   *   ② `e.movementX` —— **规范上它就是 screenX 的变化量**，同样被污染。
   * 而拖拽过程中**我们自己在移动窗口**，原点一变，这两种量里就混进"窗口走过的距离"，
   * 再把它当鼠标增量移动窗口 ⇒ 正反馈：每帧自加速，方向甚至会反。
   *
   * 所以彻底不在渲染层算坐标：主进程用 OS 的 `screen.getCursorScreenPoint()` 读**真实游标**，
   * 配合按下时记下的"游标-窗口"偏移，直接把窗口摆到 `游标 - 偏移`。
   * 这条路径与窗口是否在移动完全无关，没有反馈环。
   */
  beginBallDrag() {
    this._healBallSize();
    const win = this._win;
    if (!win || win.isDestroyed()) return { ok: false };
    if (this._state !== WINDOW_STATE.BALL || this._menuOpen) return { ok: false };
    const pt = screen.getCursorScreenPoint();
    const b = win.getBounds();
    this._drag = {
      offsetX: pt.x - b.x,
      offsetY: pt.y - b.y,
      startPt: pt,
      moved: false,
    };
    return { ok: true };
  }

  /**
   * 拖拽过程中：把窗口跟到当前游标（已被移动过就贴住游标）。
   * @param {number} [threshold] 游标位移小于它时不算拖拽（保留"点击打开小窗"）
   */
  moveBallToCursor(threshold = 4) {
    this._healBallSize();
    const win = this._win;
    const d = this._drag;
    if (!win || win.isDestroyed() || !d) return { ok: false, moved: false };
    if (this._state !== WINDOW_STATE.BALL) return { ok: false, moved: false };
    const pt = screen.getCursorScreenPoint();
    if (!d.moved && Math.hypot(pt.x - d.startPt.x, pt.y - d.startPt.y) < threshold) {
      return { ok: true, moved: false };
    }
    d.moved = true;
    const b = win.getBounds();
    const disp = this._displayForPoint(pt.x, pt.y);
    const wa = disp.workArea;
    // dpr 差异在这里自然消除：两边的量都是**物理像素**（getBounds / 游标点，同一坐标系）
    const x = Math.max(wa.x, Math.min(pt.x - d.offsetX, wa.x + wa.width - b.width));
    const y = Math.max(wa.y, Math.min(pt.y - d.offsetY, wa.y + wa.height - b.height));
    /* ⚠ 1px 死区：游标读数在静止时会有 ±1 的抖动，如果每帧都 setPosition，
       窗口就在 1px 上反复挪 —— 用户看到的是"按住不松手一直抖"（2026-10-20 实测）。
       位移小于 2px 直接不动：肉眼看不出来，但抖动没了。 */
    if (Math.abs(Math.round(x) - b.x) < 2 && Math.abs(Math.round(y) - b.y) < 2) {
      return { ok: true, moved: true };
    }
    try {
      win.setPosition(Math.round(x), Math.round(y), false);
      return { ok: true, moved: true };
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 拖拽移动失败：${err?.message ?? err}`);
      return { ok: false, moved: true };
    }
  }

  /**
   * 结束拖球：真拖过就吸附到最近的左右边缘。
   * @returns {{ moved: boolean, snapped: boolean }}
   */
  endBallDrag() {
    const d = this._drag;
    this._drag = null;
    /* `moved` 由主进程按**游标真实位移**判定（≥4px 才算拖）。
       渲染层拿这个值决定"是拖拽还是点击" —— 比"有没有触发过 pointermove"可靠得多：
       鼠标按下时的 1–2px 抖动不应该把一次点击变成拖拽（那会导致点击被吞掉）。 */
    if (!d || !d.moved) return { moved: false, snapped: false };
    /* 拖完松手：只要没吸边就什么都不做；吸上了则保持完整显示，
       等鼠标真的移出（圆外 4px）再半隐藏（用户要求：不留延时）。 */
    const snapped = this.snapBall();
    return { moved: true, snapped };
  }

  /* ==================================================================== 球半隐藏（类 360） */

  /**
   * 球贴在哪条边（容差 4px：setPosition 只吃整数，且 DPI 取整会有 1–2px 误差）。
   *
   * ⚠ 可以传一个"目标几何"而不是去读 `win.getBounds()`：
   *   Windows 上 `setPosition` 之后**立刻** `getBounds()` 可能还是旧值，
   *   于是"刚吸到左边"被判成"没吸边"，半隐藏永远不触发（2026-10-20 用户实测就是这个）。
   */
  _edgeOf(b) {
    const cx = b.x + Math.round(b.width / 2);
    const cy = b.y + Math.round(b.height / 2);
    const wa = this._displayForPoint(cx, cy).workArea;
    const tol = 4;
    const half = Math.round(b.width / 2);
    const rightEdge = wa.x + wa.width;
    /* ⚠ 必须同时认「完整贴边」与「半隐藏贴边」两种 x。
       否则会出现死循环般的现象：隐藏后 x = wa.x - 24，再判"贴哪条边"就判不出来了
       ⇒ 状态机认为"不在边上" ⇒ 恢复完整显示 ⇒ 又判出贴边 ⇒ 再隐藏 ……
       用户看到的就是"左侧根本不隐藏"（右侧同理，只是表现不同）。2026-10-20 实测。 */
    if (Math.abs(b.x - wa.x) <= tol || Math.abs(b.x - (wa.x - half)) <= tol) return "left";
    if (Math.abs(b.x + b.width - rightEdge) <= tol || Math.abs(b.x - (rightEdge - half)) <= tol) {
      return "right";
    }
    return null;
  }

  /**
   * 鼠标是否真的**落在球体（圆）内**。
   *
   * ⚠ 不能用 DOM 的 mouseenter/mouseleave 直接决定显隐：
   *   窗口是 48×48 的**方框**，球是 `border-radius:50%` 的**圆**。
   *   方框四角那几块是透明的，但鼠标在上面依然算"在元素内"（光标还会变成 grab）。
   *   于是在角落移入 → 露出（窗口左移 24）→ 鼠标落到方框外 → 移出 → 藏回去 →
   *   鼠标又落回方框内 → 移入 …… 就是用户看到的"乒乓球一直跳"（2026-10-20 实测）。
   * 判定用**圆心 + 半径**，并且带滞回（进/出各留余量），从几何上消掉这个自激。
   * @param {number} margin 负数=更严格（进），正数=更宽松（出）
   */
  _isCursorOnBall(margin = 0) {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    const b = win.getBounds();
    const r = Math.min(b.width, b.height) / 2 + margin;
    const pt = screen.getCursorScreenPoint();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return Math.hypot(pt.x - cx, pt.y - cy) <= r;
  }

  /**
   * 把球移到「半隐藏 / 完整显示」的坐标。
   * @param {boolean} hidden
   * @returns {boolean} 是否真的移动了
   */
  _applyBallHalfHidden(hidden) {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    if (this._state !== WINDOW_STATE.BALL) return false;
    if (this._menuOpen) {
      this._logger.info?.("[minipi:peek] 跳过：球菜单展开中");
      return false;
    }
    /* ⚠ 这里**不能**用 `?? this._ballEdge` 兜底：那条边可能是上一次吸附留下的陈旧值，
       球已经被拖到屏幕中间（甚至顶部）时，会按旧边算出一个"半隐藏"坐标 ——
       用户看到的就是"拖到顶部，它自己跑到了右侧边缘"。算不出边就什么都不做。 */
    const b = win.getBounds();
    const edge = this._edgeOf(b);
    if (!edge) {
      this._ballEdge = null;
      if (this._ballHidden) {
        // 状态不一致（自认为隐藏但其实不在边上）：纠正回"完整显示"，否则会永远卡在隐藏
        this._ballHidden = false;
        this.sendToRenderer(EVENTS.BALL_PEEK, { hidden: false });
      }
      this._logger.info?.("[minipi:peek] 跳过：球不在边缘");
      return false;
    }
    this._ballEdge = edge;
    const wa = this._displayForPoint(b.x + Math.round(b.width / 2), b.y + Math.round(b.height / 2)).workArea;
    const half = Math.round(b.width / 2);
    const targetX = hidden
      ? this._ballEdge === "left"
        ? wa.x - half
        : wa.x + wa.width - half
      : this._ballEdge === "left"
        ? wa.x
        : wa.x + wa.width - b.width;
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
    /* 只有"位置已经是目标 + 状态也一致"才算无事可做。
       ⚠ 曾经写成"位置对上就把 _ballHidden 改掉然后 return"，
       结果窗口**没真的移动**但状态被标成隐藏 ⇒ 之后 `ballPeekOut()` 永远早退 ⇒ 再也不隐藏。 */
    if (b.x === targetX && this._ballHidden === hidden) return false;
    /* ⚠ 先改状态再 setPosition：`move` 事件里会保存位置，
       半隐藏的 x 在屏幕外 —— 绝不能写进设置，否则下次启动球会"缺一半"。 */
    this._ballHidden = hidden;
    try {
      win.setPosition(Math.round(targetX), Math.round(y), false);
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 半隐藏移动失败：${err?.message ?? err}`);
      return false;
    }
    // 渲染层据此把球改成 50% 透明（opacity 与颜色无关，深浅两套主题都适用）
    this.sendToRenderer(EVENTS.BALL_PEEK, { hidden });
    this._logger.info?.(
      `[minipi:peek] ${hidden ? "已半隐藏" : "已完整显示"} edge=${this._ballEdge} x=${Math.round(targetX)} (was ${b.x})`,
    );
    return true;
  }

  /** 开始巡检（进入球态时调用；重复调用安全）。 */
  _startBallHoverWatch() {
    this._stopBallHoverWatch();
    this._ballHoverTimer = setInterval(() => this._syncBallPeek(), BALL_HOVER_TICK_MS);
  }

  _stopBallHoverWatch() {
    if (this._ballHoverTimer) {
      clearInterval(this._ballHoverTimer);
      this._ballHoverTimer = null;
    }
  }

  /**
   * 把显隐状态**收敛到几何事实**（幂等）。
   *
   * 每次 tick 重新算"贴哪条边"和"光标在不在圆内"，然后：
   *   隐藏中 + 光标进来了 ⇒ 露出
   *   显示中 + 光标出去了 ⇒ 隐藏
   * 中间是 6px 死区（进 -2 / 出 +4），所以不会在边界上反复切。
   *
   * ⚠ 曾经把"边"缓存在 `_ballEdge` 里、隐藏时用 `?? this._ballEdge` 兜底 ——
   *   拖到顶部（不在任何边）时那条**陈旧的边**会启动一次半隐藏，把球**弹到右侧边缘**去。
   *   现在边每 tick 现算，算不出边就什么都不做。
   */
  _syncBallPeek() {
    const win = this._win;
    if (!win || win.isDestroyed()) return;
    if (this._state !== WINDOW_STATE.BALL || this._menuOpen || this._drag || this._applying) return;
    const b = win.getBounds();
    const edge = this._edgeOf(b);
    if (!edge) {
      this._ballEdge = null;
      if (this._ballHidden) this._applyBallHalfHidden(false); // 不在边上就恢复完整显示
      return;
    }
    this._ballEdge = edge;
    // 隐藏时按"进"的余量判定（-2），显示时按"出"的余量判定（+4）：天然滞回
    const inside = this._isCursorOnBall(this._ballHidden ? -2 : 4);
    if (this._ballHidden && inside) this._applyBallHalfHidden(false);
    else if (!this._ballHidden && !inside) this._applyBallHalfHidden(true);
  }

  /** 鼠标移入：半隐藏就整球滑出来（立即响应，不等下一次 tick）。 */
  ballPeekIn() {
    if (!this._ballHidden) return false;
    // 立即用几何判一次，别等 150ms 的 tick（拖拽/移动刚结束时手感更跟手）
    if (!this._isCursorOnBall(-2)) return false;
    return this._applyBallHalfHidden(false);
  }

  /** 鼠标移出：**立刻**收回半隐藏（用户要求"移出会立马进去"）。 */
  ballPeekOut() {
    /* 事件只是"催促一下"，真正的判定在 `_syncBallPeek()` 里（几何 + 滞回）。
       这样即使浏览器漏发 leave，巡检也会在 150ms 内把状态纠正过来。 */
    this._syncBallPeek();
    return this._ballHidden;
  }

  /** 点了球：还原为不隐藏，3 秒没有操作再收起。 */
  ballPin() {
    if (this._ballHidden) this._applyBallHalfHidden(false);
    return true;
  }

  /**
   * 把球吸附到最近的屏幕左右边缘（拖拽结束时调用）。
   *
   * 为什么要有它：拖拽只做 `setPosition`，松手时球可能停在离边几十像素的地方 ——
   * 用户会觉得"吸不住边"。这里在**松手那一刻**按球的中心判定靠哪边更近，
   * 贴到该边的 workArea 内沿（留 0 像素，球自己带描边）。
   *
   * @param {number} [threshold] 距边多少像素内才吸附（默认 56 ≈ 一个球径）
   * @returns {boolean} 是否真的移动了
   */
  snapBall(threshold = BALL_SNAP_THRESHOLD) {
    this._healBallSize();
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    if (this._state !== WINDOW_STATE.BALL || this._menuOpen) return false;
    const b = win.getBounds();
    const disp = this._displayForPoint(b.x + Math.round(b.width / 2), b.y + Math.round(b.height / 2));
    const wa = disp.workArea;
    const centerX = b.x + b.width / 2;
    const toLeft = centerX - wa.x;
    const toRight = wa.x + wa.width - centerX;
    let x = b.x;
    if (toLeft <= threshold || toRight <= threshold) {
      x = toLeft <= toRight ? wa.x : wa.x + wa.width - b.width;
    }
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
    if (x === b.x && y === b.y) return false;
    this._logger.info?.(`[minipi:window] 吸边 ${b.x} → ${Math.round(x)}`);
    const movedTo = { x: Math.round(x), y: Math.round(y), width: b.width, height: b.height };
    let moved = false;
    try {
      if (movedTo.x !== b.x || movedTo.y !== b.y) {
        win.setPosition(movedTo.x, movedTo.y, false);
        moved = true;
      }
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 吸边失败：${err?.message ?? err}`);
      return false;
    }
    /* 吸附之后才可能半隐藏。**用刚算出的目标坐标判定边**，不读 getBounds()：
       setPosition 之后 getBounds 可能是旧值 ⇒ 刚吸到左边却被判成"没吸边" ⇒ 永不触发。 */
    this._ballEdge = this._edgeOf(movedTo);
    this._ballHidden = false;
    /* 停在别处（没吸边）⇒ 永不隐藏；吸上了就保持完整显示，等鼠标移出再收。 */
    this.sendToRenderer(EVENTS.BALL_PEEK, { hidden: false });
    // 一条能直接看出结论的日志（排查半隐藏不再靠猜）
    this._logger.info?.(
      `[minipi:peek] 吸边结果 edge=${this._ballEdge ?? "none"} · 位置=(${movedTo.x},${movedTo.y}) · 窗口=${b.width}×${b.height} · moved=${moved}`,
    );
    return true;
  }

  /**
   * 关闭悬浮窗（隐藏窗口，不退出 App）。
   * 唤回：Alt+Space（toggle → show）；再次双击启动会命中单实例锁唤起。
   * @returns {boolean}
   */
  hideBall() {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    if (this._menuOpen) void this.closeBallMenu();
    try {
      win.hide();
      this._logger.info?.("[minipi:window] 悬浮窗已关闭（Alt+Space 可唤回）");
      return true;
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 关闭悬浮窗失败：${err?.message ?? err}`);
      return false;
    }
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

  /**
   * 球态尺寸自愈。
   *
   * 为什么要有它：即使关掉 thickFrame，也仍可能有别的路径把球态窗口改大
   * （系统边框、第三方工具、我们自己哪天真写错一处）。球态**必须是固定 48×48** ——
   * 一旦变大，用户会看到"球贴不住边 / 有透明窗口挡桌面"这种很难自解释的现象。
   * 所以这里在**每次 resize 事件**里把尺寸按回去（位置不动）。
   *
   * 跳过条件：
   *   · `_menuOpen`：右键菜单会**故意**把窗口撑大，那是合法扩张；
   *   · `_applying`：三态切换正在进行，`setBounds` 的中间态不该被当成异常。
   */
  _healBallSize() {
    const win = this._win;
    if (!win || win.isDestroyed()) return false;
    if (this._state !== WINDOW_STATE.BALL || this._menuOpen || this._applying) return false;
    const b = win.getBounds();
    const size = WINDOW_SIZE[WINDOW_STATE.BALL];
    /* ★ 必须留容差。
       在 125% / 150% 缩放的屏幕上，`setBounds({width:48})` 落下去会被 DPI 取整成 49 或 50，
       于是"精确相等"永远不成立 ⇒ 自愈变成**自己跟自己打架**：每次 resize 都改回去，
       改回去又触发 resize…… 实测日志里刷了几百行 `被改成 49×48，已还原为 48×48`。
       容差取 6px：真实的 resize（拖边框）一次就远超这个量级，而取整误差永远在 1–2px。 */
    const TOL = 6;
    const tooBig = b.width > size.width + TOL || b.height > size.height + TOL;
    const tooSmall = b.width < size.width - TOL || b.height < size.height - TOL;
    if (!tooBig && !tooSmall) return false;
    try {
      win.setBounds({ x: b.x, y: b.y, width: size.width, height: size.height }, false);
      /* 只在真的异常时记日志，并做节流：同一秒内不重复刷（否则异常时会把日志打满）。 */
      const now = Date.now();
      if (!this._healLogAt || now - this._healLogAt > 1000) {
        this._healLogAt = now;
        this._logger.warn?.(
          `[minipi:window] 球态窗口被改成 ${b.width}×${b.height}，已还原为 ${size.width}×${size.height}`,
        );
      }
      return true;
    } catch (err) {
      this._logger.warn?.(`[minipi:window] 尺寸自愈失败：${err?.message ?? err}`);
      return false;
    }
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

  /** 指定点的所在屏；失败退回光标屏。球菜单按**球**的位置选屏，而不是按光标。 */
  _displayForPoint(x, y) {
    try {
      return screen.getDisplayNearestPoint({ x, y });
    } catch {
      return this._displayForState();
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
      // 菜单展开期间窗口是扩张后的几何，绝不能记成「球的位置」；
      // 半隐藏时 x 在屏幕外，也不能记（否则下次启动球会缺一半）
      if (this._applying || this._menuOpen || this._ballHidden) return;
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

    // 球菜单：窗口失焦（点了别处）就收起。
    // 扩张后的窗口只覆盖菜单附近，真正的桌面点击不会派发到渲染层，
    // 所以「点外部关闭」只能靠主进程的 blur 事件。
    win.on("blur", () => {
      if (this._menuOpen) void this.closeBallMenu();
    });

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
