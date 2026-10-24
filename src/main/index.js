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

import { Menu, app, dialog, ipcMain, nativeTheme, shell } from "electron";

/*
 * ── 关掉 GPU 进程自己的 sandbox（否则本机 App 起不来） ─────────────────────
 *
 * 现象（本机实测，2026-09-24）：Electron 主进程能跑到 `app.whenReady()`、窗口也建了，
 * 但 GPU 子进程反复以 `exit_code=-1073741819`（0xC0000005，ACCESS_VIOLATION）退出，
 * 重试若干次后 Chromium 直接 `FATAL ... GPU process isn't usable. Goodbye.` 把整个
 * App 带走——从双击到进程消失约 1 秒，看起来就是「闪退」。
 *
 * 实测过的旗标组合（`scripts/_probe-electron.mjs`）：
 *   --disable-gpu            仍然崩（说明不是「GPU 不可用」，而是 GPU 进程起不来）
 *   --in-process-gpu         换成 0xC0000005 崩在浏览器进程，更糟
 *   --use-gl=swiftshader     仍然崩
 *   --no-sandbox             能起，但把渲染进程的 sandbox 也一起关了，代价过大
 *   --disable-gpu-sandbox    ✅ 能起，且**保留硬件加速**
 *
 * 所以只关 GPU 进程的 sandbox 这一颗，别去动 `--disable-gpu`：本 App 是透明悬浮窗，
 * Windows 上透明依赖 DWM 合成，关掉 GPU 会把透明一起弄坏。
 *
 * 想恢复 Electron 默认行为（保留 GPU sandbox）就设 `MINIPI_KEEP_GPU_SANDBOX=1`。
 */
if (process.platform === "win32" && process.env.MINIPI_KEEP_GPU_SANDBOX !== "1") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}

import {
  DEFAULT_MODEL_PREFERENCE,
  DEFAULT_SCENE_ID,
  ERROR_CODES,
  EVENTS,
  FEATURED_PROVIDER_IDS,
  INVOKE,
  LIMITS,
  PROTOCOL_VERSION,
  SCENE_IDS,
  errorMessage,
  isPlainObject,
  isSceneId,
  isSessionId,
  isWindowState,
  parseErrorMessage,
} from "../shared/protocol.js";

import { SettingsStore, ensureAppDirs, MINIPI_HOME } from "./settings.js";
// `MAIN_LOG_FILE` 只用于崩溃对话框里告诉用户「日志在哪」——路径必须来自 logger.js，
// 不在这里自己拼（拼出来的路径一旦和 logger 实际写的文件不一致，客户就白找了）。
import { MAIN_LOG_FILE, createLogger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { WindowManager } from "./window.js";
import { createTray, disposeTray } from "./tray.js";
import { grabSelection, registerHotkeys } from "./hotkeys.js";
import { PiSessionHost, sanitizeDetail } from "./pi/session.js";
import { ProviderStore } from "./pi/providers-store.js";
import { getAboutInfo } from "./versions.js";
import { discoverModels } from "./pi/discover-models.js";
import { OutcomeService } from "./pi/outcome/index.js";
import { ApprovalGate } from "./pi/approval.js";

/*
 * ── 日志：**必须自己落盘**，不能靠 console ──────────────────────────────────
 *
 * 开发期是 `scripts/launch.mjs` 把子进程 stdout/stderr 接进
 * `~/.minipi/logs/launcher.log`，所以 `const log = console` 够用。
 *
 * 打包后这条链路断了：没有启动器，Windows GUI 子系统程序没有控制台，
 * `console.log` 的输出被系统直接丢弃 ⇒ **客户版永远没有日志**，
 * 报障时零信息。所以改成自带文件日志（`~/.minipi/logs/main.log`）。
 * 详见 `src/main/logger.js` 文件头。
 *
 * 与启动器日志刻意**分开两个文件**：`launcher.log` 是外壳（node 写），
 * `main.log` 是应用本体（Electron 写）。客户反馈时两个都要。
 */
const log = createLogger();
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
 * 崩溃兜底：日志 + 一次系统对话框
 * ========================================================================== */

/**
 * 是否已经弹过崩溃提示（**只弹一次**，见 `reportFatalCrash` 的第 ② 条）。
 * 模块级而不是 bootstrap 内：崩溃可能来自任何地方，守卫也只有一个真源。
 */
let crashed = false;

/**
 * 致命崩溃的统一出口：**先落盘，再一次弹窗**。任何一步都不许再抛。
 *
 * 为什么要这个函数（发布阻断级缺陷）：
 *   打包后的 Windows GUI 程序**没有控制台**，`console` 输出被系统丢弃，
 *   客户版唯一的信息出口是 `~/.minipi/logs/main.log`。但客户根本不知道有这个文件。
 *   于是主进程一崩，用户看到的就是「悬浮球突然消失了」，既不知道发生了什么、
 *   也不知道该把什么发给开发者。所以崩溃路径上必须**主动弹一个系统对话框**。
 *
 * 三个刻意的取舍（别改回去）：
 *   ① 用 `dialog.showErrorBox`：**同步**、不需要 BrowserWindow、不依赖 app ready
 *      （Electron 文档明确写了它「可在 ready 之前安全调用」）。
 *      崩溃时窗口往往已经没了 / 正在销毁，任何依赖窗口的 API 都不可靠。
 *   ② **只弹一次**：`uncaughtException` 经常连续触发（同一批 task 里多个回调各自崩），
 *      弹一屏模态对话框会把桌面锁死，用户连任务管理器都难开。
 *   ③ **不主动 `app.exit()`**：未捕获异常时 Electron 自己的默认行为就是退出进程。
 *      我们再调一次只会抢在用户读完文案之前把进程带走，还会跳过收尾/落盘。
 *      本函数只负责「让用户看到信息 + 知道去哪找日志」，退出交给运行时。
 *
 * @param {unknown} err
 */
function reportFatalCrash(err) {
  const detail = sanitizeDetail(err); // 默认截 300 字；且已脱敏（家目录 / 绝对路径 / 密钥）
  log.error?.(`[minipi] 未捕获异常：${detail}`);
  if (crashed) return;
  crashed = true;
  try {
    dialog.showErrorBox(
      "minipi 遇到问题需要关闭",
      "程序遇到一个未预料到的错误，即将退出。\n\n" +
        `日志已保存到：${MAIN_LOG_FILE}\n` +
        "请把该文件发给开发者，能帮助我们定位问题。\n\n" +
        `（错误摘要：${detail}）`,
    );
  } catch (dialogErr) {
    /* 弹窗本身也在崩溃路径上：`showErrorBox` 自己抛错时**绝不能**再炸一次
       —— 那会变成「崩溃处理里的崩溃」，用户连一行日志都拿不到。
       所以整段兜住，最多再记一条日志（连日志都写不进去就彻底放弃）。 */
    try {
      log.error?.(`[minipi] 崩溃提示框没能弹出：${sanitizeDetail(dialogErr)}`);
    } catch {
      /* ignore */
    }
  }
}

/* ========================================================================== *
 * 启动
 * ========================================================================== */

function bootstrap() {
  /** @type {SettingsStore} */
  const settings = new SettingsStore();
  /**
   * minipi 自己的提供方定义（`~/.minipi/providers.json`）。
   * 在 `PiSessionHost` 之前构造：host 初始化 Pi 运行时时会立刻读它并注入。
   */
  const providerStore = new ProviderStore({ logger: log });
  /**
   * 会话元数据索引（`~/.minipi/sessions/index.json`，D-09 / B1-3）。
   * 在 `PiSessionHost` 之前构造：建会话时就要往里登记（`PiSessionHost` 只用这一份实例，
   * 不再自己造第二个 —— 两个 store 各自缓存条目会互相覆盖）。
   */
  const sessionStore = new SessionStore({ logger: log });
  /** @type {WindowManager | null} */
  let wm = null;
  /**
   * 系统托盘（`src/main/tray.js`）。
   * 放在 bootstrap 闭包里而不是局部变量：`will-quit` 要向它收尾，
   * 另外 Tray 实例本身那个强引用在 tray.js 的模块级变量上（防 GC 掉图标）。
   * @type {{ tray: import("electron").Tray | null, destroy: () => void } | null}
   */
  let trayRef = null;

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
  const pi = new PiSessionHost({
    emit: (wrapped) => sendEvent(wrapped),
    logger: log,
    approval: approvalGate,
    modelPreference: () => settings.get().model,
    /** 联网总开关（默认开）。关掉时连工具都不注册 —— 模型看不到，就不会"假装搜过"。 */
    webEnabled: () => settings.get().webEnabled !== false,
    // minipi 自己的提供方定义（自定义 / 覆盖内置）。**不写 Pi 的 models.json**，
    // 通过 ModelRuntime.registerProvider() 注入运行时 —— 理由见 providers-store.js 文件头。
    providerStore,
    // 会话元数据索引（D-09）：与下面 IPC 侧用的是同一份实例
    sessionStore,
  });
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
      // 托盘先拆：它只是窗口/菜单的入口，窗口没了再留图标只会点出错误。
      // 用 `disposeTray()` 而不是 `trayRef.destroy()`：真正的强引用在 tray.js 的
      // 模块级变量上（防 GC 掉图标），走模块自己的出口才不会漏掉那种情况。
      disposeTray(log);
      trayRef = null;
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
    /* 只记日志、**不弹窗**（刻意的取舍）：
       Promise 拒绝绝大多数是可恢复的（一次请求失败、一次 aborted fetch、一次超时），
       用户完全可能接着正常用。为它弹系统对话框 = 把偶发抖动升级成骚扰，
       客户很快会学会「见到 minipi 的弹窗就关掉」—— 那样真崩溃时的提示也会被无视。
       需要人知道的致命错误走下面的 uncaughtException（它会弹框）。 */
    log.error?.(`[minipi] 未处理的 Promise 拒绝：${sanitizeDetail(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    // 日志 + 一次性系统对话框（为什么不退出、为什么只弹一次，见 reportFatalCrash 的注释）
    reportFatalCrash(err);
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
    /* 主题必须在**创建窗口之前**落到 nativeTheme：
       themeSource 会直接改变渲染层的 prefers-color-scheme，于是 CSS 首帧就是对的，
       不需要等异步 IPC、也不会「先白后黑」。这是 T1 无闪烁的全部秘密。 */
    nativeTheme.themeSource = loaded.theme;
    log.info?.(`[minipi] 主题 = ${loaded.theme}（system 时跟随 OS）`);
    for (const w of settings.warnings) log.warn?.(`[minipi] ${w}`);
    // 提供方定义必须在 pi.init() 之前加载完 —— init 里会立刻把它注入 ModelRuntime
    providerStore.load();
    for (const w of providerStore.warnings) log.warn?.(`[minipi] ${w}`);
    if (providerStore.ids().length > 0) {
      log.info?.(`[minipi] 已载入 ${providerStore.ids().length} 个提供方定义：${providerStore.ids().join(", ")}`);
    }
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

    /* ③' 系统托盘 —— **必须在窗口建好之后**：托盘菜单项要调 `wm.setState() / raise()`，
       窗口不存在时点下去只会报错；而它又是"窗口被盖住时唯一的入口"，
       所以放在 create() 成功之后、其余初始化之前，让用户最早就有一个可靠入口。
       创建失败只记为「无托盘」并继续启动（没有托盘的 App 仍然能用，
       为了让托盘出现而拒绝启动是本末倒置）。 */
    try {
      trayRef = createTray({
        logger: log,
        actions: {
          // 与 Alt+Space 完全同一条路径（复用 handleToggle，别在这里另写一套 toggle 逻辑）
          toggle: () => handleToggle(wm),
          mini: () => wm.setState("mini"),
          settings: () => openPanelFromTray(wm, "settings"),
          about: () => openPanelFromTray(wm, "about"),
          quit: () => {
            log.info?.("[minipi:tray] 托盘菜单：退出");
            app.quit();
          },
        },
      });
    } catch (err) {
      log.warn?.(`[minipi] 托盘创建失败（不阻断启动）：${sanitizeDetail(err)}`);
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

/**
 * 托盘的「模型设置 / 关于」：先把窗口叫到前台，**再**请渲染层打开面板。
 *
 * 顺序与两个细节（都是必须的）：
 *   ① 球态窗口只有 48×48，面板画不出来（渲染层 `renderMode()` 在 ball 态会主动把
 *      `#settingsPanel` / `#aboutPanel` 收起来）⇒ 先 `setState("mini")`。
 *      这条与渲染层球右键菜单里"模型设置"走的是**同一条路**（也是先展开小窗）。
 *   ② 窗口可能被用户 `hideBall()` 藏起来了：`setState` / `raise` 都会顺手显示它，
 *      所以不需要额外 show。
 *   ③ 面板由渲染层画（`openSettingsPanel()` / `openAbout()`），主进程没有按钮可点，
 *      只能推 `EVENTS.UI_ACTION`。**不要**为了这个再新增一条专用 IPC 通道。
 *
 * @param {WindowManager} wm
 * @param {"settings" | "about"} action
 */
async function openPanelFromTray(wm, action) {
  try {
    if (wm.state === "ball") {
      await wm.setState("mini");
    } else {
      await wm.raise();
    }
  } catch (err) {
    // 抬窗失败也继续推事件：窗口也许只是被遮挡，面板开出来用户还能看到
    log.warn?.(`[minipi:tray] 打开「${action}」前抬窗失败：${sanitizeDetail(err)}`);
  }
  const sent = wm.sendToRenderer(EVENTS.UI_ACTION, { action });
  if (!sent) log.warn?.(`[minipi:tray] 推送 UI_ACTION(${action}) 失败（渲染层不可用？）`);
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

  /* ---------------- 会话自建存储（B1-3 / D-09） ----------------
   *
   * 六个通道：列表 / 改名 / 置顶 / 归档 / 删除（进回收站）/ 恢复。
   * 共同口径：
   *   · `id` 一律过 `isSessionId()`（形如 `s_<base36 秒>_<4 位>`）。
   *     非法 → `INVALID_ARGUMENT`（**不要**落到「找不到」：两者对排查的意义完全不同）；
   *   · 索引 / 文件里没有 → 存储层返回 null 或抛 `SESSION_NOT_FOUND`，这里统一转成错误码；
   *   · 参数类型挡在边界（渲染层不可信），长度由存储层归一（标题截 24 字）。
   */

  /** 取会话索引（`PiSessionHost` 持有的那一份实例，见 bootstrap）。 */
  const sessionStore = () => pi.sessionStore;

  /** @param {unknown} raw */
  const requireSessionId = (raw) => {
    if (!isSessionId(raw)) {
      throw new Error(
        errorMessage(ERROR_CODES.INVALID_ARGUMENT, "id 必须是会话 id（形如 s_<时间戳>_<4 位>）"),
      );
    }
    return raw;
  };

  /** @param {string} id */
  const sessionNotFound = (id) =>
    new Error(errorMessage(ERROR_CODES.SESSION_NOT_FOUND, `会话不存在或已删除：${id}`));

  handle(INVOKE.LIST_SESSIONS, (arg) => {
    if (arg.query !== undefined && arg.query !== null && typeof arg.query !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "query 必须是字符串"));
    }
    if (arg.archived !== undefined && arg.archived !== null && typeof arg.archived !== "boolean") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "archived 必须是 boolean"));
    }
    return sessionStore().list({ query: arg.query ?? "", archived: arg.archived === true });
  });

  handle(INVOKE.RENAME_SESSION, (arg) => {
    const id = requireSessionId(arg.id);
    if (typeof arg.title !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "title 必须是字符串"));
    }
    const item = sessionStore().rename(id, arg.title);
    if (!item) throw sessionNotFound(id);
    return { ok: true, item };
  });

  handle(INVOKE.SET_SESSION_PINNED, (arg) => {
    const id = requireSessionId(arg.id);
    if (typeof arg.pinned !== "boolean") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "pinned 必须是 boolean"));
    }
    const item = sessionStore().setPinned(id, arg.pinned);
    if (!item) throw sessionNotFound(id);
    return { ok: true, item };
  });

  handle(INVOKE.SET_SESSION_ARCHIVED, (arg) => {
    const id = requireSessionId(arg.id);
    if (typeof arg.archived !== "boolean") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "archived 必须是 boolean"));
    }
    const item = sessionStore().setArchived(id, arg.archived);
    if (!item) throw sessionNotFound(id);
    return { ok: true, item };
  });

  handle(INVOKE.DELETE_SESSION, async (arg) => {
    const id = requireSessionId(arg.id);
    /* ---- BLK-1：删活会话会把正文写坏 ----
     *
     * 现象：`SessionManager._persist` 在首次落盘后走 `appendFileSync(this.sessionFile)`
     * （`session-manager.js:812`）——**文件不在就用 append 模式重建一个**。
     * 所以「会话还活着 → 删 → 再发一句话」会让原路径冒出一份**没有 session header** 的
     * 同名 jsonl。**这个现象依然存在**（SDK 行为，我们改不了）；
     * 但**后果已被存储层拦住**：重启后 `_idOfFile` 会校验首行 header，**不认领**这种
     * 无 header 残片 ⇒ 已删会话**不会**复活（`session-store.js` 的 `_idOfFile`）。
     * （2026-10-23 修正：本段原写「按文件名认领（不看 header）⇒ 已删会话原地复活」，
     *   那是修复前的行为，已过时。残片文件本身仍留在磁盘，属 P2 物理清理，v1 不做。）
     *
     * ⚠ 顺序是有讲究的，别调：
     *   ① **先判流式**（用我们自己的 rec.status，不依赖 SDK）：`AgentSession.dispose()`
     *      只触发 abort，**abort 之后仍可能有一次收尾 append**（`agent-session.js:996-1003`，
     *      整段 try/catch 还会吞掉错误）。若先 dispose 再 remove，那一次 append 照样能把
     *      文件重建出来 ⇒ 拒绝删除形同虚设。所以流式中**直接拒绝，不 dispose、不 remove**。
     *   ② 活着但**空闲** → 先 dispose 摘掉写入者（注意语义：不是"活着一律不许删"，
     *      刚建的空会话本来就活着且没有文件，用户删它是正常操作）；
     *   ③ 最后才移文件。
     */
    const isStreaming = () => pi.isStreaming(id);
    if (isStreaming()) {
      throw new Error(errorMessage(ERROR_CODES.SESSION_BUSY, "正在生成回答，先中断再删除"));
    }
    if (pi.hasSession(id)) {
      // 摘掉写入者；返回值 false 说明已经不在记录里（幂等）
      pi.disposeSession(id);
    }
    let removed;
    try {
      // 正文移进 `.trash/`（可恢复），**不做物理删除**（plan §2.2：v1 不删真数据）。
      // `isStreaming` 钩子是存储层的最后一道保险（dispose 万一没成功，宁可拒绝删除）。
      removed = await sessionStore().remove(id, { isStreaming });
    } catch (err) {
      if (err && err.code === "SESSION_NOT_FOUND") throw sessionNotFound(id);
      if (err && err.code === "SESSION_BUSY") {
        throw new Error(errorMessage(ERROR_CODES.SESSION_BUSY, "正在生成回答，先中断再删除"));
      }
      throw err;
    }
    log.info?.(`[minipi:ipc] 会话已移入回收站 ${id}`);
    /* 把存储层的 `trashedTo` 原样带回渲染层（preload 的 JSDoc 早就这么写了）。
       `null` 是合法值 —— 会话**还没有正文文件**（刚建、没说过话）时没有东西可搬，
       渲染层据此不说路径（详见 `src/renderer/index.html` 里那段删除 toast 的注释）。 */
    return { ok: true, trashedTo: removed?.trashedTo ?? null };
  });

  handle(INVOKE.RESUME_SESSION, (arg) => pi.resumeSession({ id: requireSessionId(arg.id) }));

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

  /* ---------------- 产出抽屉（D-14：持久索引） ---------------- */
  handle(INVOKE.LIST_ASSETS, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.indexList(arg);
  });

  handle(INVOKE.OPEN_ASSET, async (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    const { absPath } = outcome.indexAbsPath(arg);
    const errMsg = await shell.openPath(absPath);
    if (errMsg) throw new Error(errorMessage(ERROR_CODES.OUTCOME_NOT_FOUND, `打开失败：${errMsg}`));
    return { ok: true };
  });

  handle(INVOKE.REMOVE_ASSET, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    return outcome.indexRemove(arg);
  });

  handle(INVOKE.REVEAL_ASSET, (arg) => {
    if (!outcome) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "产出服务未初始化"));
    const { absPath } = outcome.indexAbsPath(arg);
    shell.showItemInFolder(absPath);
    return { ok: true };
  });

  /* ---------------- 模型就绪状态（首启引导，P1） ----------------
   *
   * 客户装完第一次打开，大概率一个 Key 都没配过。改动前产品在这种情况下
   * 只是「问了一句没反应」或者抛一条 `PI_UNAVAILABLE` —— 客户不知道要先去设置里配。
   * 渲染层靠这个**只读**接口决定要不要在聊天区放一张「去配置」引导卡。
   *
   * ⚠ 两条硬约束：
   *   · **永不 reject**：它报告的状态本身就包含「读不出来」。抛错会让引导卡变成
   *     一块「读取失败」，等于把兜底做成了第二个故障点 —— 所以整段 try/catch，
   *     连 `pi` 没初始化好也当「未就绪」返回。
   *   · **绝不带 key**（D-03）：只回 `{ ready, reason }`，reason 是给用户看的中文短句。
   *
   * 判定口径（以 `pi/session.js` 的 `listProviders()` 真实字段为准，别凭空假设）：
   *   每项有 `configured`（该提供方凭据是否已配置，来自 `getProviderAuthStatus`）
   *   与 `models[]`（该提供方的模型目录，来自 `getModels`）。
   *   「有可用模型且已选中」 ⇔ 至少一个 **configured 且 models 非空** 的提供方：
   *   满足时 Pi 建会话必然解析得出模型 —— `createSession` 会先 `resolvePreferredModel()`
   *   （失败还会兜 `DEFAULT_MODEL_PREFERENCE`），`createAgentSession` 内部再
   *   `findInitialModel()` 兜一层（`sdk.js`）。
   *   刻意**不**再比对 `settings.model` 是否存在：默认偏好指向的模型可能被厂商下架，
   *   而用户另一个提供方明明配好了 —— 那会把「能用」误报成「不能用」，
   *   把客户推回设置页去改一个本来没问题的选择。
   */
  handle(INVOKE.MODEL_STATUS, async () => {
    try {
      await pi.init();
      const providers = await pi.listProviders();
      const list = Array.isArray(providers) ? providers : [];
      const configured = list.filter((p) => p && p.configured === true);
      const usable = configured.filter((p) => Array.isArray(p.models) && p.models.length > 0);
      if (usable.length > 0) return { ready: true, reason: "" };
      const reason =
        configured.length === 0
          ? "还没有配置模型，所以暂时不能对话。点「去配置」填一个 API Key 就能开始用。"
          : "密钥已保存，但没读到可用的模型。点「去配置」检查一下 API 地址或模型目录。";
      log.info?.(`[minipi:ipc] 模型未就绪 · 已配置提供方 ${configured.length} 个 · 可用 ${usable.length} 个`);
      return { ready: false, reason };
    } catch (err) {
      /* 初始化失败（依赖没装好 / 凭据文件损坏 / 磁盘问题）也按「未就绪」返回：
         给用户一句可执行的下一步，细节进日志。**不要**把 sanitizeDetail 后的技术细节
         塞进 reason —— 客户看不懂，还可能带出内部路径。 */
      log.warn?.(`[minipi:ipc] 读取模型状态失败（按未就绪处理）：${sanitizeDetail(err)}`);
      return { ready: false, reason: "暂时读不到模型配置。点「去配置」检查一下，详情见日志。" };
    }
  });

  /* ---------------- 模型配置 ---------------- */
  handle(INVOKE.LIST_MODELS, async () => ({
    current: settings.get().model,
    defaultModel: DEFAULT_MODEL_PREFERENCE,
    models: (await pi.listModels()).slice(0, LIMITS.MODEL_CATALOG_MAX),
  }));
  // 模型设置页的提供方目录。`featured` 是「默认展示哪些厂商」——渲染层不自己算，
  // 免得两边各维护一份国内厂商清单（清单本体在 protocol.js 的 FEATURED_PROVIDER_IDS）。
  handle(INVOKE.LIST_PROVIDERS, async () => ({
    current: settings.get().model,
    defaultModel: DEFAULT_MODEL_PREFERENCE,
    featured: FEATURED_PROVIDER_IDS,
    providers: await pi.listProviders(),
  }));
  handle(INVOKE.SET_MODEL, (arg) => {
    if (arg.model === null) return settings.set({ model: null });
    const model = arg.model;
    if (!isPlainObject(model) || typeof model.provider !== "string" || typeof model.modelId !== "string" ||
        model.provider.length === 0 || model.provider.length > LIMITS.MODEL_PROVIDER_MAX_CHARS ||
        model.modelId.length === 0 || model.modelId.length > LIMITS.MODEL_ID_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "model 必须包含合法的 provider 和 modelId"));
    }
    settings.set({ model: { provider: model.provider.trim(), modelId: model.modelId.trim() } });
    return { ok: true, model: settings.get().model, note: "新会话生效" };
  });
  handle(INVOKE.SET_API_KEY, async (arg) => {
    if (typeof arg.providerId !== "string" || !arg.providerId.trim() || typeof arg.apiKey !== "string" ||
        !arg.apiKey || arg.apiKey.length > LIMITS.MODEL_API_KEY_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "providerId 和 apiKey 必须有效"));
    }
    return pi.setModelApiKey({ providerId: arg.providerId.trim(), apiKey: arg.apiKey });
  });

  // 写入提供方定义（自定义 or 覆盖内置）：id 形态 / baseUrl 是否 http(s) / 协议枚举 /
  // 模型条目合法性**全部**在 ProviderStore 的归一化里判，非法一律 PROVIDER_INVALID。
  handle(INVOKE.SET_PROVIDER, (arg) => {
    if (typeof arg.provider !== "string" || arg.provider.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "provider 不能为空"));
    }
    return pi.setProvider({ provider: arg.provider, definition: arg.definition });
  });

  // 只删 minipi 自己的定义；Pi 的 models.json / auth.json 一个字节都不动。
  handle(INVOKE.REMOVE_PROVIDER, (arg) => {
    if (typeof arg.provider !== "string" || arg.provider.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "provider 不能为空"));
    }
    return pi.removeProvider({ provider: arg.provider });
  });

  // 「获取可用模型」：一次 GET，只读远端。key 可来自尚未保存的输入框。
  handle(INVOKE.DISCOVER_MODELS, async (arg) => {
    if (typeof arg.baseUrl !== "string" || arg.baseUrl.trim().length === 0) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "baseUrl 不能为空"));
    }
    if (arg.baseUrl.length > LIMITS.PROVIDER_BASE_URL_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "baseUrl 过长"));
    }
    if (arg.api !== undefined && arg.api !== null && typeof arg.api !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "api 必须是字符串"));
    }
    const apiKey = typeof arg.apiKey === "string" ? arg.apiKey : "";
    if (apiKey.length > LIMITS.MODEL_API_KEY_MAX_CHARS) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "apiKey 过长"));
    }
    // ⚠ 日志里**绝不打印 apiKey**；这里只打协议与主机名
    log.info?.(`[minipi:ipc] 获取可用模型 · provider=${arg.provider ?? "(未指定)"} · api=${arg.api ?? "openai-completions"}`);
    return discoverModels({ baseUrl: arg.baseUrl, api: arg.api, apiKey });
  });

  /* ---------------- M4 审批闸门 ---------------- */

  // 用户点了「允许一次 / 拒绝 / 中断整轮」。
  // 校验全部在 approval.decide 内部（action 取值域 ⇒ INVALID_ARGUMENT；
  // id 不存在或已决 ⇒ APPROVAL_NOT_FOUND）。
  // `remember:true`（仅 allowOnce 有意义）⇒ 本会话总是允许该工具（R5，内存级、默认关）。
  handle(INVOKE.APPROVAL_DECIDE, (arg) => {
    if (!approval) throw new Error(errorMessage(ERROR_CODES.INTERNAL, "审批服务未初始化"));
    // instruction：四档里「拒绝并说明」的用户输入。类型在边界就挡掉，
    // 长度由 approval.normalizeDenyInstruction() 统一截断（渲染层不可信）。
    if (arg?.instruction !== undefined && typeof arg.instruction !== "string") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "instruction 必须是字符串"));
    }
    return approval.decide({
      approvalId: arg.approvalId,
      action: arg.action,
      remember: arg.remember,
      instruction: arg.instruction,
    });
  });

  /* ---------------- 窗口 ---------------- */

  handle(INVOKE.SET_WINDOW_STATE, async (arg) => {
    if (!isWindowState(arg.state)) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "state 必须是 ball / mini / full"));
    }
    return wm.setState(arg.state);
  });

  // 置顶开关（用户 2026-10-20：默认不置顶，开启后常驻顶部）
  handle(INVOKE.SET_ALWAYS_ON_TOP, (arg) => {
    if (!arg || typeof arg.on !== "boolean") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "on 必须是 boolean"));
    }
    const next = settings.set({ alwaysOnTop: arg.on });
    const applied = wm.applyAlwaysOnTop();
    log.info?.(`[minipi:ipc] 置顶 = ${applied}`);
    return { ok: true, on: applied, alwaysOnTop: next.alwaysOnTop };
  });

  // 最小化到任务栏（mini / full）
  handle(INVOKE.MINIMIZE_WINDOW, () => {
    log.info?.("[minipi:ipc] 最小化窗口");
    return wm.minimize();
  });

  /* ---- 悬浮球右键菜单（v1.1）：菜单画在渲染层，主进程只负责临时窗口几何 ---- */

  handle(INVOKE.SHOW_BALL_MENU, async () => {
    const layout = await wm.openBallMenu();
    if (!layout) {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "当前不是悬浮球形态，无法打开球菜单"));
    }
    return { ok: true, layout };
  });

  handle(INVOKE.HIDE_BALL_MENU, async () => ({ ok: await wm.closeBallMenu() }));

  // 关闭悬浮窗 = 隐藏窗口（不退出 App）。唤回：Alt+Space / 再次启动。
  handle(INVOKE.HIDE_BALL, async () => ({ ok: wm.hideBall() }));

  // 球态手动拖拽：渲染层传屏幕位移，主进程夹进工作区后 setPosition
  /* 拖球三步。渲染层**不传坐标** —— 它传过来的 screenX/movementX 都会被窗口移动污染
     （见 `window.js` 里 beginBallDrag 的注释），坐标统一由主进程读 OS 游标。 */
  handle(INVOKE.BALL_DRAG_BEGIN, () => wm.beginBallDrag());
  handle(INVOKE.BALL_DRAG_MOVE, (arg) => wm.moveBallToCursor(Number(arg?.threshold ?? 4)));
  handle(INVOKE.BALL_DRAG_END, () => wm.endBallDrag());

  /* 半隐藏（类 360 悬浮球）：吸边后 3 秒无操作 → 一半滑出屏幕；移入滑出、移出立刻收回。 */
  handle(INVOKE.BALL_PEEK_IN, () => ({ ok: wm.ballPeekIn() }));
  handle(INVOKE.BALL_PEEK_OUT, () => ({ ok: wm.ballPeekOut() }));
  handle(INVOKE.BALL_PIN, () => ({ ok: wm.ballPin() }));

  // 拖拽结束吸边：只改窗口位置，不写设置（球位置本来就是内存里的临时状态）
  handle(INVOKE.SNAP_BALL, () => ({ ok: wm.snapBall() }));

  /* ---------------- 设置 ---------------- */

  handle(INVOKE.GET_SETTINGS, () => settings.get());

  /* 「关于」：版本一律**运行时探测**（读已安装包的 package.json），不写死文案 ——
     否则升级依赖后界面就开始说谎。 */
  handle(INVOKE.GET_ABOUT, () =>
    getAboutInfo({
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node ?? null,
    }),
  );

  handle(INVOKE.SET_SETTINGS, (arg) => {
    if (Object.keys(arg).length === 0) return settings.get();
    if (arg.sceneId !== undefined && !isSceneId(arg.sceneId)) {
      throw new Error(errorMessage(ERROR_CODES.SCENE_NOT_FOUND, sceneIdHint()));
    }
    try {
      const next = settings.set(arg);
      // 主题是**即时生效**的：改完立刻落到 nativeTheme（渲染层靠媒体查询自动跟随）
      if (arg.theme !== undefined && arg.theme !== nativeTheme.themeSource) {
        nativeTheme.themeSource = next.theme;
      }
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
