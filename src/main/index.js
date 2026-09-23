/**
 * minipi 主进程入口。
 *
 * 启动顺序（每一步都有理由，不要重排）：
 *   0. 清 `ELECTRON_RUN_AS_NODE`（见下，**入口第一件事**）
 *   1. 单实例锁 —— 第二次启动唤起已有窗口，不起第二个 App
 *   2. `app.whenReady()` → 建目录 → 读设置 → 建窗口 → 起 Pi 宿主 → 注册 IPC → 注册热键
 *   3. 退出时统一收尾（热键反注册、Pi 会话 dispose、拆窗口）
 *
 * ⚠ `ELECTRON_RUN_AS_NODE` 的真实说明（本机实测踩到的坑）：
 *   本机环境变量里存在 `ELECTRON_RUN_AS_NODE=1`。它会让 `electron .` **退化成纯 Node**，
 *   于是 `import { BrowserWindow } from "electron"` 报
 *   `does not provide an export named 'BrowserWindow'`。
 *   这个变量必须在 **Electron 进程启动之前**清掉，所以真正的修复在启动器
 *   `scripts/start.mjs`（它 spawn electron 时过滤掉这个变量）。
 *   本文件里的这行 `delete` 是**第二道防线**：ESM 的 import 会被提升到模块体之前执行，
 *   所以它救不了本进程的 import，但能保证后续 `spawn` 出去的子进程（pip、powershell 等）
 *   不会被这个变量污染。**不要删掉这行。**
 */

import process from "node:process";
import fs from "node:fs";
import path from "node:path";

// ── 入口第一件事：清掉 ELECTRON_RUN_AS_NODE（理由见文件头） ─────────────────
try {
  delete process.env.ELECTRON_RUN_AS_NODE;
} catch {
  /* 极少数只读 env 的场景，忽略 */
}

import { Menu, app, dialog, ipcMain, shell } from "electron";

import {
  DEFAULT_SCENE_ID,
  ERROR_CODES,
  EVENTS,
  INVOKE,
  PROTOCOL_VERSION,
  SCENE_IDS,
  errorMessage,
  isPlainObject,
  isSceneId,
  isWindowState,
  parseErrorMessage,
} from "../shared/protocol.js";

import { SettingsStore, ensureAppDirs, MINIPI_HOME } from "./settings.js";
import { WindowManager } from "./window.js";
import { grabSelection, registerHotkeys } from "./hotkeys.js";
import { PiSessionHost, sanitizeDetail } from "./pi/session.js";
import { OutcomeService } from "./pi/outcome/index.js";
import { ApprovalGate } from "./pi/approval.js";

const log = console;
const APP_USER_MODEL_ID = "com.minipi.app";
/** 重放给渲染层的缓冲事件条数上限（重载时不要一次灌太多）。 */
const REPLAY_MAX_EVENTS = 800;

/**
 * 场景非法的错误提示。
 *
 * **从 `SCENE_IDS` 动态生成**，不硬编码场景名——
 * 这样以后加/删场景时不会有「错误提示还说着老场景名」的漂移。
 * @returns {string}
 */
function sceneIdHint() {
  return `sceneId 必须是 ${SCENE_IDS.join(" / ")} 之一`;
}

/**
 * `scripts/selftest/main.mjs` 会 `import { registerIpc }` 来**跑真实路由**。
 * 那时不能顺手把真 App 也启动起来，所以要有一个显式的「只要路由、不要启动」开关。
 * 该变量只由 `scripts/start.mjs --selftest` 设置，正常 `npm start` 绝不会带上。
 */
const NO_BOOTSTRAP = process.env.MINIPI_NO_BOOTSTRAP === "1";

if (NO_BOOTSTRAP) {
  log.info?.("[minipi] MINIPI_NO_BOOTSTRAP=1：只导出模块，不启动 App（自测模式）");
} else {
  /** 单实例锁：拿不到就退出（第二次启动由 `second-instance` 唤起已有窗口）。 */
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    log.info?.("[minipi] 已有实例在跑，本次启动退出");
    app.quit();
  } else {
    bootstrap();
  }
}

/* ========================================================================== *
 * 启动
 * ========================================================================== */

function bootstrap() {
  /** @type {SettingsStore} */
  const settings = new SettingsStore();
  /** @type {WindowManager | null} */
  let wm = null;

  /**
   * M4 审批闸门（`repo` 场景护栏）。
   *
   * ⚠ 与 `outcomeService` 同款：**注入 bridge**，而不是让 `approval.js` import electron。
   *    · `pushCard` → `wm.sendToRenderer(EVENTS.APPROVAL, card)`（推 / 更新 / 撤回卡）
   *    · `audit`    → 同步追加 `~/.minipi/approvals-audit.log`（NDJSON，已脱敏）
   * 注入发生在 `pi` 之前 —— `PiSessionHost` 构造时就要拿到它（规则 2 用）。
   * `wm` 用 `let` 闭包捕获，建卡时窗口必已就绪（闸门只在会话跑起来后才被调到）。
   */
  const approvalGate = new ApprovalGate({
    logger: log,
    appDir: MINIPI_HOME,
    bridge: {
      pushCard: (card) => wm?.sendToRenderer(EVENTS.APPROVAL, card),
      audit: (entry) => appendAudit(entry),
    },
  });

  /** @type {PiSessionHost} */
  const pi = new PiSessionHost({ emit: (wrapped) => sendEvent(wrapped), logger: log, approval: approvalGate });
  /**
   * 产出链路服务（M5）。
   *
   * ⚠ `shell` / `dialog` **注入**而不是在 `outcome/index.js` 里 import electron ——
   * 这样编排层能在纯 Node 下被 `verify-outcome.mjs` 完整测试（本机 Electron GPU 会崩）。
   * 只有本文件（`main/index.js`）允许 import electron。
   */
  const outcomeService = new OutcomeService({
    piHost: pi,
    logger: log,
    emitOutcome: (card) => wm?.sendToRenderer(EVENTS.OUTCOME, card),
    shellOpener: (absPath) => shell.openPath(absPath),
    // showSaveDialog 的包装：返回契约要求的 `{ canceled, filePath }`
    dialogOpener: async (defaultName) => {
      const picked = await dialog.showSaveDialog(wm?.window ?? undefined, {
        defaultPath: defaultName,
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return { canceled: picked.canceled, filePath: picked.filePath };
    },
  });
  /** @type {{ unregisterAll: () => void } | null} */
  let globalShortcutRef = null;

  /** 把事件推给渲染层（窗口不可用时静默丢弃——事件同时已落内存日志）。 */
  function sendEvent(wrapped) {
    wm?.sendToRenderer(EVENTS.EVENT, wrapped);
  }

  /** 推 hotkey 事件（payload 严格按契约：只有 action / selection / ok）。 */
  function pushHotkey(payload) {
    wm?.sendToRenderer(EVENTS.HOTKEY, payload);
  }

  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.on("second-instance", () => {
    // 第二次启动：把已有窗口抬起来（球态则展开成小窗）
    if (!wm) return;
    if (wm.state === "ball") {
      wm.setState("mini").catch((err) => log.warn?.(`[minipi] second-instance 展开失败：${err?.message ?? err}`));
    } else {
      wm.raise();
    }
  });

  app.on("window-all-closed", () => {
    // 我们是单窗口常驻 App：窗口真被关掉就退出（正常路径是 quit()）
    app.quit();
  });

  app.on("will-quit", () => {
    try {
      globalShortcutRef?.unregisterAll?.();
    } catch {
      /* ignore */
    }
    try {
      pi.disposeAll();
    } catch {
      /* ignore */
    }
    try {
      wm?.destroy();
    } catch {
      /* ignore */
    }
  });

  process.on("unhandledRejection", (reason) => {
    log.error?.(`[minipi] 未处理的 Promise 拒绝：${sanitizeDetail(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    log.error?.(`[minipi] 未捕获异常：${sanitizeDetail(err)}`);
  });

  app.whenReady().then(async () => {
    log.info?.(`[minipi] 启动中 · protocol ${PROTOCOL_VERSION} · Electron ${process.versions.electron} · Node ${process.versions.node}`);

    if (!app.isPackaged) {
      // 开发期：去掉 Electron 自带的默认菜单（无边框窗口也不需要）
      try {
        Menu.setApplicationMenu(null);
      } catch {
        /* ignore */
      }
    }

    ensureAppDirs();
    const loaded = settings.load();
    for (const w of settings.warnings) log.warn?.(`[minipi] ${w}`);
    log.info?.(
      `[minipi] 设置已载入 · 场景 ${loaded.sceneId} · 形态 ${loaded.window.state} · 不抢焦点 ${loaded.noFocusSteal}`,
    );

    // ① 窗口层
    wm = new WindowManager({
      settings,
      logger: log,
      onRendererReady: ({ send }) => replayForRenderer(pi, send),
    });

    // ② IPC 路由 —— **必须在 create() 之前注册**：
    //    渲染层脚本在页面加载时就会调 getSettings()/onEvent()，
    //    注册晚一步就会吃到 "No handler registered for 'minipi:getSettings'"。
    registerIpc({ settings, wm, pi, log, outcome: outcomeService, approval: approvalGate });

    try {
      await wm.create();
    } catch (err) {
      log.error?.(`[minipi] 窗口创建失败，App 退出：${sanitizeDetail(err)}`);
      app.exit(1);
      return;
    }

    // ③ 预热 Pi（复用 ~/.pi/agent/auth.json）——不阻塞窗口显示
    pi.init().catch((err) => {
      log.warn?.(`[minipi] Pi 预热失败（首次 createSession 会再试一次）：${sanitizeDetail(err)}`);
    });

    // ④ 全局热键
    globalShortcutRef = registerHotkeys({
      logger: log,
      onToggle: () => handleToggle(wm),
      onGrabSelection: () => handleGrabSelection(wm, pushHotkey),
    });

    log.info?.("[minipi] 就绪。Alt+Space 开合，Alt+Shift+Space 抓选区。");
  });
}

/* ========================================================================== *
 * 热键行为
 * ========================================================================== */

/**
 * `Alt+Space`：ball ↔ mini 开合；若当前是 full 则收到 mini（§4.2）。
 * @param {WindowManager} wm
 */
async function handleToggle(wm) {
  await wm.toggle();
  wm.sendToRenderer(EVENTS.HOTKEY, { action: "toggle" });
}

/**
 * `Alt+Shift+Space`：抓选区 → **然后**才把窗口抬到前台 → 通知渲染层。
 *
 * 顺序很关键：合成 `Ctrl+C` 必须打给「抓取时还在前台的那个 App」，
 * 所以**先抓、后抬窗**。抬窗顺序颠倒了就永远抓不到东西。
 *
 * @param {WindowManager} wm
 * @param {(payload: unknown) => void} pushHotkey
 */
async function handleGrabSelection(wm, pushHotkey) {
  const result = await grabSelection({ logger: console });
  // 直通 Mini（§4.1 形态机：Alt+Shift+Space → Mini）
  if (wm.state !== "mini") {
    try {
      await wm.setState("mini");
    } catch (err) {
      console.warn(`[minipi] 抓选区后切换到 mini 失败：${err?.message ?? err}`);
    }
  } else {
    await wm.raise();
  }
  pushHotkey({ action: "grabSelection", selection: result.selection, ok: result.ok });
}

/* ========================================================================== *
 * IPC 路由
 * ========================================================================== */

/**
 * 主 → 渲染的错误文本：**必须**是可读说明，且不含堆栈 / 路径 / 密钥。
 * @param {unknown} err
 * @returns {string}
 */
function toRendererError(err) {
  const { code, detail } = parseErrorMessage(err);
  const safe = sanitizeDetail(detail);
  if (code === ERROR_CODES.INTERNAL) {
    console.warn(`[minipi:ipc] 内部错误：${safe}`);
    return errorMessage(ERROR_CODES.INTERNAL, safe);
  }
  return errorMessage(code, safe);
}

/**
 * 追加一条审计到 `~/.minipi/approvals-audit.log`（NDJSON，一行一条，同步 append）。
 *
 * 设计 §7.4：审批是低频人驱动动作，不值得异步队列；但**写失败不能阻断审批**
 * ——`try/catch` 吞掉 + warn。审计内容已由 `approval.js` 脱敏（`buildAuditSummary`）。
 *
 * @param {object} entry 已脱敏的审计条目
 */
function appendAudit(entry) {
  try {
    fs.mkdirSync(MINIPI_HOME, { recursive: true });
    fs.appendFileSync(path.join(MINIPI_HOME, "approvals-audit.log"), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    log.warn?.(`[minipi:approval] 审计落盘失败（不阻断审批）：${err?.message ?? err}`);
  }
}

/**
 * 注册全部 invoke 路由。
 *
 * 独立导出（不是内联在 bootstrap 里）的目的：自测套件能用**同一份实现**验证
 * 契约字段与入参校验，避免「测试里另写一套规则，测了个寂寞」。
 *
 * @param {object} ctx
 * @param {SettingsStore} ctx.settings
 * @param {WindowManager} ctx.wm
 * @param {PiSessionHost} ctx.pi
 * @param {OutcomeService} ctx.outcome
 * @param {ApprovalGate} [ctx.approval]
 * @param {Console} [ctx.log]
 */
export function registerIpc({ settings, wm, pi, outcome, approval, log = console }) {
  /**
   * 越权校验：只接受**本 App 主窗口**发来的调用。
   * 单机单用户不假，但「任何 webContents 都能调管理动作」是明确不该留的口子。
   * @param {import("electron").IpcMainInvokeEvent} event
   */
  const assertTrustedSender = (event) => {
    const wc = wm.webContents;
    if (!wc || event.sender !== wc) {
      log.warn?.("[minipi:ipc] 拒绝来自非主窗口的调用");
      throw new Error(errorMessage(ERROR_CODES.INTERNAL, "拒绝来自非主窗口的调用"));
    }
  };

  /**
   * @param {string} channel
   * @param {(arg: unknown, event: import("electron").IpcMainInvokeEvent) => unknown} fn
   */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, arg) => {
      try {
        assertTrustedSender(event);
        // 入参必须是「空」或「普通对象」：挡住数组 / 字符串 / 数字等畸形调用
        if (arg !== undefined && arg !== null && !isPlainObject(arg)) {
          throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "入参必须是对象"));
        }
        return await fn(arg ?? {}, event);
      } catch (err) {
        throw new Error(toRendererError(err));
      }
    });
  };

  /* ---------------- 会话 ---------------- */

  handle(INVOKE.CREATE_SESSION, async (arg) => {
    const rawSceneId = arg.sceneId;
    if (rawSceneId !== undefined && !isSceneId(rawSceneId)) {
      throw new Error(errorMessage(ERROR_CODES.SCENE_NOT_FOUND, sceneIdHint()));
    }
    const sceneId = rawSceneId ?? settings.get().sceneId ?? DEFAULT_SCENE_ID;
    const result = await pi.createSession({ sceneId });
    // 记住用户用过的场景
    try {
      settings.set({ sceneId: result.sceneId });
    } catch (err) {
      log.warn?.(`[minipi:ipc] 记录场景失败：${sanitizeDetail(err)}`);
    }
    return result;
  });

  handle(INVOKE.SESSION_STATE, (arg) => pi.sessionState(arg));

  handle(INVOKE.PROMPT, (arg) => pi.prompt(arg));

  handle(INVOKE.ABORT, (arg) => pi.abort(arg));

  /* ---------------- 产出链路（M5） ---------------- */

  // 入参校验由 OutcomeService.generate 内部完成（sessionId / intent / format），
  // 这里只做「必须有 outcome 服务」的防御。
  handle(INVOKE.GENERATE_OUTCOME, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.generate(arg);
  });

  handle(INVOKE.OPEN_OUTCOME, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.open(arg);
  });

  handle(INVOKE.SAVE_OUTCOME_AS, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.saveAs(arg);
  });

  handle(INVOKE.LIST_OUTCOMES, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.list(arg);
  });

  /* ---------------- M4 审批闸门 ---------------- */

  // 用户点了「允许一次 / 拒绝 / 中断整轮」。
  // 校验全部在 approval.decide 内部（action 取值域 ⇒ INVALID_ARGUMENT；
  // id 不存在或已决 ⇒ APPROVAL_NOT_FOUND）。
  // `remember:true`（仅 allowOnce 有意义）⇒ 本会话总是允许该工具（R5，内存级、默认关）。
  handle(INVOKE.APPROVAL_DECIDE, (arg) => {
    if (!approval) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "审批服务未初始化"));
    return approval.decide({ approvalId: arg.approvalId, action: arg.action, remember: arg.remember });
  });

  /* ---------------- 窗口 ---------------- */

  handle(INVOKE.SET_WINDOW_STATE, async (arg) => {
    if (!isWindowState(arg.state)) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "state 必须是 ball / mini / full"));
    }
    return wm.setState(arg.state);
  });

  /* ---------------- 设置 ---------------- */

  handle(INVOKE.GET_SETTINGS, () => settings.get());

  handle(INVOKE.SET_SETTINGS, (arg) => {
    if (Object.keys(arg).length === 0) return settings.get();
    if (arg.sceneId !== undefined && !isSceneId(arg.sceneId)) {
      throw new Error(errorMessage(ERROR_CODES.SCENE_NOT_FOUND, sceneIdHint()));
    }
    try {
      const next = settings.set(arg);
      log.info?.(`[minipi:ipc] 设置已更新：${Object.keys(arg).join(", ")}`);
      return next;
    } catch (err) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, sanitizeDetail(err)));
    }
  });

  /* ---------------- 退出 ---------------- */

  handle(INVOKE.QUIT, () => {
    log.info?.("[minipi:ipc] 收到 quit()");
    // 让渲染层先把 invoke 的 Promise 收掉，再真正退出
    setTimeout(() => app.quit(), 0);
    return undefined;
  });
}

/* ========================================================================== *
 * 渲染层重载 → 事件补增量
 * ========================================================================== */

/**
 * 渲染层 `did-finish-load` 时，把**最近一个会话**的内存环形缓冲重放一遍。
 *
 * 为什么这样够用：渲染层的 store 约定「按 `seq` 幂等入队」（方案 §4.1 实现要求 1），
 * 所以重放是幂等的；而重载后 store 是空的，重放正好把历史补回来。
 *
 * ⚠ 已知边界（v0.1）：契约里没有「恢复会话」的接口，所以渲染层重载后拿到的事件
 *   仍然属于**旧 sessionId**。渲染层若不认识的 sessionId，请直接忽略（或用它重建只读历史）。
 *
 * @param {PiSessionHost} pi
 * @param {(channel: string, payload: unknown) => boolean} send
 */
function replayForRenderer(pi, send) {
  const lastId = pi.lastSessionId;
  if (!lastId) return;
  const all = pi.eventsSince(lastId, 0);
  if (all.length === 0) return;
  const tail = all.length > REPLAY_MAX_EVENTS ? all.slice(all.length - REPLAY_MAX_EVENTS) : all;
  for (const wrapped of tail) send(EVENTS.EVENT, wrapped);
  log.info?.(
    `[minipi] 渲染层已就绪：重放 ${lastId} 的 ${tail.length}/${all.length} 条缓冲事件（seq ≤ ${tail[tail.length - 1]?.seq ?? 0}）`,
  );
}
