/**
 * 系统托盘图标（发布阻断级可用性缺陷的修复）。
 *
 * ## 为什么必须有托盘
 *
 * 悬浮球态是 `skipTaskbar: true`（刻意：48×48 的球不该占任务栏格子）。用户把窗口
 * 取消置顶之后，只要被别的窗口盖住，就**没有任何入口能把 minipi 叫回来** ——
 * 唯一的办法是 `Alt+Space`，而客户显然不知道也没习惯记这个。用户原话：
 *   『我现在将他非置顶后，点击别的软件他就被隐藏后面了，我只能从界面上一个个最小化找到它。』
 * 托盘就是那个"永远在的入口"。
 *
 * ## 三条实现约束（都踩过，别改）
 *
 * ① **实例必须长生命周期**：`Tray` 在 Electron 里一旦被垃圾回收，图标会**无声消失**
 *    （托盘没了，程序还在跑），这是最常见的托盘 bug。所以本模块用模块级变量 `alive`
 *    持有，`createTray()` 返回的 `{ tray }` 只是给调用方检查状态用的。
 * ② **只绑 `click`，不要绑 `double-click`**：Windows 上双击会**先触发一次 `click`**
 *    再触发 `double-click`。两个都绑的话，一次双击 = 切换两次（显示完立刻收起），
 *    用户看到的就是"点托盘没反应"。双击因此天然落在同一条路径上，另外再加一个
 *    250ms 去抖，挡住双击连带出来的第二次 click。
 * ③ **图标读不出来要降级，不许崩**：`nativeImage` 读不到（缺资源 / asar 异常 /
 *    平台不支持 ICO）时只 warn 并返回空托盘对象。没有托盘图标的 App 仍然可用，
 *    为它抛异常把主进程带崩是拿全部功能换一个图标。
 * ④ **Windows 上不要直接 `createFromPath("tray.ico")`**：实测它会把 32 帧放大成
 *    256×256 的单一表示，托盘再缩回 16 就糊了。按 ICO 目录自己切帧做成多表示
 *    （`loadIcoImage`），16/24/32 各拿原生那一档。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Menu, Tray, app, nativeImage } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** PNG 文件魔数（判 ICO 里的帧是不是 PNG 载荷用）。 */
const PNG_SIG = "89504e470d0a1a0a";

/**
 * 图标资源目录。
 * 放 `src/assets/` 而不是 `build/`：`build/` 是 electron-builder 的 buildResources
 * （构建产物目录，`.gitignore` 里），不进 asar；而打包的 `files` 白名单已含 `src/**`，
 * 所以 `src/assets/` 下的文件在**打包后的 asar 内**依然可读。
 */
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

/** 托盘提示文案：顺带把唯一的热键告诉用户（他们不知道有这个键）。 */
const TRAY_TOOLTIP = "minipi · Alt+Space 唤出";

/** 同一次"双击"里的第二次 click 在这个窗口内被忽略（见文件头 ②）。 */
const CLICK_DEBOUNCE_MS = 250;

/**
 * 当前活着的 Tray 实例。
 * ⚠ 模块级持有（见文件头 ①）——**不要**改成 `createTray()` 里的局部变量。
 * @type {Tray | null}
 */
let alive = null;

/**
 * 按平台挑图标文件。
 * · Windows：`tray.ico`（16/24/32 三档，任务栏按 DPI 自己挑一档）
 * · macOS：`trayTemplate.png`（纯黑 + alpha，`setTemplateImage` 后系统会自动
 *   按菜单栏深浅色反色，这是 macOS 的规范做法）
 * · Linux：暂时复用 template png（没有桌面环境的统一规范，先保证能用）
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function iconFileFor(platform) {
  return platform === "win32" ? "tray.ico" : "trayTemplate.png";
}

/**
 * 把 `tray.ico` 的每一帧拆出来，组装成**多表示**（multi-representation）的 NativeImage。
 *
 * ## 为什么不能只用 `nativeImage.createFromPath("tray.ico")`
 *
 * 本机实测（Electron 44.4.3 / Win11）：`createFromPath()` 读我们的 ICO（16/24/32 三帧）
 * 回来的是**一个 256×256 的表示**、`getScaleFactors()` = `[1]` —— 文件里根本没有 256 帧，
 * 那是 Windows 的图标加载器把 32 帧**放大**成 256 再交过来的。托盘实际按
 * 16 / 24 / 32 用图 ⇒ 等于"放大再缩小"，边缘必糊，而 16px 托盘图标糊了就认不出。
 *
 * 按 ICO 目录自己切帧就没有这一步：16px → scaleFactor 1、24 → 1.5、32 → 2，
 * 托盘在 100% / 150% / 200% 缩放下都能拿到**原生渲染**的那一档。
 * 实测这样组出来的 image：`getSize()` = 16×16，`getScaleFactors()` = `[1, 1.5, 2]`。
 *
 * 解析失败（文件被换、格式不对）返回 `null`，调用方退回 `createFromPath`。
 *
 * @param {string} abs
 * @param {{warn?:Function}} logger
 * @returns {import("electron").NativeImage | null}
 */
function loadIcoImage(abs, logger) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null; // 不是 icon
    const count = buf.readUInt16LE(4);
    const image = nativeImage.createEmpty();
    let added = 0;
    for (let k = 0; k < count; k += 1) {
      const base = 6 + k * 16;
      if (base + 16 > buf.length) break;
      // ICO 目录项里 0 表示 256（一字节装不下 256，见 build-icon.mjs 的 packIco）
      const width = buf.readUInt8(base) || 256;
      const height = buf.readUInt8(base + 1) || 256;
      const bytes = buf.readUInt32LE(base + 8);
      const offset = buf.readUInt32LE(base + 12);
      if (width !== height || bytes <= 0 || offset + bytes > buf.length) continue;
      const frame = buf.subarray(offset, offset + bytes);
      // 只认 PNG 帧：`scripts/build-icon.mjs` 产出的每一帧都是 PNG
      if (frame.subarray(0, 8).toString("hex") !== PNG_SIG) continue;
      image.addRepresentation({ scaleFactor: width / 16, width, height, buffer: frame });
      added += 1;
    }
    return added > 0 && !image.isEmpty() ? image : null;
  } catch (err) {
    logger.warn?.(`[minipi:tray] 解析 tray.ico 失败（退回整文件加载）：${err?.message ?? err}`);
    return null;
  }
}

/**
 * 读托盘图标；读不出来返回 `null`（调用方降级，不抛）。
 * @param {{info?:Function,warn?:Function,error?:Function}} logger
 * @returns {import("electron").NativeImage | null}
 */
function loadTrayImage(logger) {
  const file = iconFileFor(process.platform);
  const abs = path.join(ASSETS_DIR, file);
  /**
   * asar 内的路径可以直接读：Electron 给 fs 打了 asar 补丁。
   * Windows 先按帧组装（见 loadIcoImage 的"256 放大"实测），其它平台/失败再整文件读。
   * @type {import("electron").NativeImage | null}
   */
  let image = process.platform === "win32" ? loadIcoImage(abs, logger) : null;
  if (!image) {
    try {
      image = nativeImage.createFromPath(abs);
    } catch (err) {
      logger.warn?.(`[minipi:tray] 读取托盘图标抛错（${file}）：${err?.message ?? err}`);
      return null;
    }
  }
  if (!image || image.isEmpty()) {
    logger.warn?.(
      `[minipi:tray] 托盘图标读出来是空的（${abs}）—— 本次不显示托盘图标，其余功能不受影响`,
    );
    return null;
  }
  // macOS 的 template image：只认黑色 + alpha，系统按深浅色自动反色
  if (process.platform === "darwin") {
    try {
      image.setTemplateImage(true);
    } catch (err) {
      logger.warn?.(`[minipi:tray] setTemplateImage 失败：${err?.message ?? err}`);
    }
  }
  logger.info?.(
    `[minipi:tray] 图标已载入 ${file} · ${JSON.stringify(image.getSize())} · scaleFactors=${JSON.stringify(image.getScaleFactors())}`,
  );
  return image;
}

/**
 * 包一层"菜单项点击"：动作抛错只落日志，绝不让托盘菜单把主进程带崩。
 *
 * @param {string} name
 * @param {Record<string, Function>} actions
 * @param {{warn?:Function}} logger
 * @returns {() => void}
 */
function menuClick(name, actions, logger) {
  return () => {
    const fn = actions[name];
    if (typeof fn !== "function") {
      logger.warn?.(`[minipi:tray] 菜单项「${name}」没有处理函数（托盘降级为只显示图标）`);
      return;
    }
    try {
      const result = fn();
      // 动作大多是 async（wm.setState 等）：异步失败同样只记日志
      if (result && typeof result.then === "function") {
        result.catch((err) => logger.warn?.(`[minipi:tray] 菜单项「${name}」执行失败：${err?.message ?? err}`));
      }
    } catch (err) {
      logger.warn?.(`[minipi:tray] 菜单项「${name}」执行失败：${err?.message ?? err}`);
    }
  };
}

/**
 * 销毁当前托盘（幂等）。
 * @param {{info?:Function,warn?:Function}} [logger]
 * @returns {boolean} 是否真的销毁了一个实例
 */
function destroyTray(logger = console) {
  const tray = alive;
  alive = null;
  if (!tray) return false;
  try {
    tray.destroy();
    logger.info?.("[minipi:tray] 托盘已销毁");
  } catch (err) {
    logger.warn?.(`[minipi:tray] 托盘销毁失败：${err?.message ?? err}`);
  }
  return true;
}

/**
 * 创建系统托盘。
 *
 * @param {object} options
 * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
 * @param {object} options.actions 托盘菜单要调的动作（全部由 main/index.js 注入，
 *        本模块**不 import WindowManager**，保持托盘与窗口层解耦）
 * @param {() => unknown} [options.actions.toggle]   显示 / 收起（左键单击也走它）
 * @param {() => unknown} [options.actions.mini]     打开小窗
 * @param {() => unknown} [options.actions.settings] 模型设置
 * @param {() => unknown} [options.actions.about]    关于
 * @param {() => unknown} [options.actions.quit]     退出
 * @returns {{ tray: Tray | null, destroy: () => void }}
 *          `tray: null` = 图标不可用，已降级（不抛）
 */
export function createTray({ logger = console, actions = {} } = {}) {
  // 重复创建（理论上只会在热重载时）先拆旧的，避免托盘里堆两个图标
  destroyTray(logger);

  const image = loadTrayImage(logger);
  if (!image) return { tray: null, destroy: () => {} };

  /** @type {Tray | null} */
  let tray = null;
  try {
    tray = new Tray(image);
  } catch (err) {
    logger.warn?.(`[minipi:tray] Tray 创建失败（不阻断启动）：${err?.message ?? err}`);
    return { tray: null, destroy: () => {} };
  }
  alive = tray;

  try {
    tray.setToolTip(TRAY_TOOLTIP);
  } catch (err) {
    logger.warn?.(`[minipi:tray] setToolTip 失败：${err?.message ?? err}`);
  }

  const template = [
    { label: "显示 / 收起", click: menuClick("toggle", actions, logger) },
    { label: "打开小窗", click: menuClick("mini", actions, logger) },
    { type: "separator" },
    { label: "模型设置", click: menuClick("settings", actions, logger) },
    { label: "关于", click: menuClick("about", actions, logger) },
    { type: "separator" },
    { label: "退出 minipi", click: menuClick("quit", actions, logger) },
  ];
  try {
    tray.setContextMenu(Menu.buildFromTemplate(template));
  } catch (err) {
    logger.warn?.(`[minipi:tray] 托盘菜单构建失败（图标仍可用）：${err?.message ?? err}`);
  }

  /* 左键单击 = 显示 / 收起（Windows 习惯）；双击也归到这条路径。
     ⚠ 只绑 `click`：Windows 上双击会连触发两次 `click`，所以用时间去抖，
        而不是再绑一个 `double-click`（那会让一次双击切两次，见文件头 ②）。 */
  let lastClickAt = 0;
  tray.on("click", () => {
    const now = Date.now();
    if (now - lastClickAt < CLICK_DEBOUNCE_MS) return;
    lastClickAt = now;
    menuClick("toggle", actions, logger)();
  });

  logger.info?.(`[minipi:tray] 托盘就绪 · 提示「${TRAY_TOOLTIP}」`);
  return { tray, destroy: () => destroyTray(logger) };
}

/** App 退出前由 `main/index.js` 的 `will-quit` 兜底调用（幂等）。 */
export function disposeTray(logger = console) {
  return destroyTray(logger);
}
