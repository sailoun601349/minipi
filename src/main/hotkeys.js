/**
 * 全局热键（方案 §4.2）。
 *
 * 两个热键语义独立、不冲突：
 *   · `Alt+Space`        → 唤起 / 收起（ball ↔ mini；full → mini）
 *   · `Alt+Shift+Space`  → **抓当前选中文字**并直接提问
 *
 * 抓选取区走 §4.2 的三级降级链里的 ①②：
 *   ① 保存剪贴板快照 → 模拟 `Ctrl+C` → 读剪贴板 → **恢复原剪贴板**；
 *   ② 拿到空/旧内容 → 返回 `{ ok: false, selection: null }`，由 UI 提示用户手动 `Ctrl+C`。
 *   ③ UI Automation 取 `TextPattern`：本期不做（锦上添花，见任务书「明确不做」）。
 *
 * ⚠ 剪贴板的「快照 → 恢复」必须做对：**绝不破坏用户剪贴板**。
 *   快照覆盖 text / html / rtf / image / bookmark 五类，恢复时按同一份写回；
 *   原本就是空剪贴板的话，恢复成空（而不是留下我们抓到的那段文字）。
 *
 * ⚠ 模拟按键的已知代价（要如实告知，不要假装是零成本）：
 *   Windows 上没有原生注入 API 可用，这里靠拉起一次 `powershell.exe` +
 *   `WScript.Shell.SendKeys('^c')`。首次调用有 **百毫秒级** 的进程启动开销
 *   （实测值见 README「实测记录」）。对目标 App 是**提权进程**的场景，
 *   UIPI 会挡住合成按键 → 走到降级链 ②。
 */

import { spawn } from "node:child_process";

import { clipboard, globalShortcut } from "electron";

/** 热键定义（唯一口径）。 */
export const HOTKEY = Object.freeze({
  TOGGLE: "Alt+Space",
  GRAB_SELECTION: "Alt+Shift+Space",
});

/** 抓选区时读剪贴板的轮询上限。 */
const GRAB_TIMEOUT_MS = 900;
/** 轮询间隔。 */
const GRAB_POLL_MS = 60;
/** 注入按键的子进程硬超时。 */
const INJECT_TIMEOUT_MS = 3000;
/** 选区长度硬上限（挡 IPC 被一段几十 MB 的文本撑爆）。 */
export const SELECTION_MAX_CHARS = 100_000;

/** `setTimeout` 的 Promise 版。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== *
 * 剪贴板快照 / 恢复
 * ========================================================================== */

/**
 * 读一份剪贴板快照（尽可能多的格式）。
 * @returns {{ text: string, html: string, rtf: string, image: import("electron").NativeImage | null, bookmark: {title:string,url:string} | null, hadAny: boolean }}
 */
export function readClipboardSnapshot() {
  const snap = { text: "", html: "", rtf: "", image: null, bookmark: null, hadAny: false };
  try {
    snap.text = clipboard.readText() ?? "";
  } catch {
    /* 某个格式读失败不该让整条链断掉 */
  }
  try {
    snap.html = clipboard.readHTML() ?? "";
  } catch {
    /* ignore */
  }
  try {
    snap.rtf = clipboard.readRTF() ?? "";
  } catch {
    /* ignore */
  }
  try {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) snap.image = img;
  } catch {
    /* ignore */
  }
  try {
    const bm = clipboard.readBookmark();
    if (bm && (bm.title || bm.url)) snap.bookmark = { title: bm.title ?? "", url: bm.url ?? "" };
  } catch {
    /* ignore */
  }
  snap.hadAny = Boolean(snap.text || snap.html || snap.rtf || snap.image || snap.bookmark);
  return snap;
}

/**
 * 把快照写回剪贴板。
 * 原本就是空剪贴板 → 恢复成空（`clipboard.clear()`），而不是留下抓到的那段文字。
 * @param {ReturnType<typeof readClipboardSnapshot>} snap
 * @returns {boolean} 是否成功恢复
 */
export function writeClipboardSnapshot(snap) {
  try {
    if (!snap || !snap.hadAny) {
      clipboard.clear();
      return true;
    }
    /** @type {Record<string, unknown>} */
    const data = {};
    if (snap.text) data.text = snap.text;
    if (snap.html) data.html = snap.html;
    if (snap.rtf) data.rtf = snap.rtf;
    if (snap.image) data.image = snap.image;
    if (snap.bookmark && (snap.bookmark.title || snap.bookmark.url)) data.bookmark = snap.bookmark;
    if (Object.keys(data).length === 0) {
      clipboard.clear();
      return true;
    }
    clipboard.write(data);
    return true;
  } catch {
    return false;
  }
}

/* ========================================================================== *
 * 模拟 Ctrl+C（PowerShell + WScript.Shell.SendKeys）
 * ========================================================================== */

/** 被注入的 PowerShell 脚本（UTF-16LE base64 传参，避免引号/中文转义问题）。 */
const SEND_COPY_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  "$ws = New-Object -ComObject WScript.Shell;" +
  "$ws.SendKeys('^c');";

/**
 * 向**当前前台窗口**发一次 `Ctrl+C`。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, ms: number, error: string | null }>}
 */
export function sendCopyKeystroke(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : INJECT_TIMEOUT_MS;
  const encoded = Buffer.from(SEND_COPY_SCRIPT, "utf16le").toString("base64");
  const t0 = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, ms: Date.now() - t0, error: error ?? null });
    };

    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      done(false, "注入按键超时");
    }, timeoutMs);

    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: "ignore" },
      );
    } catch (err) {
      done(false, err?.message ?? String(err));
      return;
    }

    child.on("error", (err) => done(false, err?.message ?? String(err)));
    child.on("exit", (code) => done(code === 0, code === 0 ? null : `powershell 退出码 ${code}`));
  });
}

/* ========================================================================== *
 * 抓选区主流程
 * ========================================================================== */

/**
 * 读剪贴板直到它变化，或超时。
 * @param {string} before 抓取前的剪贴板文本
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<{ text: string, changed: boolean }>}
 */
async function waitForClipboardChange(before, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : GRAB_TIMEOUT_MS;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : GRAB_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let last = before;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    try {
      last = clipboard.readText() ?? "";
    } catch {
      last = "";
    }
    if (last && last !== before) return { text: last, changed: true };
  }
  return { text: last, changed: false };
}

/**
 * 抓当前选中文字。
 *
 * 返回**不含**原因字段（契约里 `grabSelection` 的 payload 只有 `action/selection/ok`），
 * 失败原因走 `console.warn`，方便对照 §4.2 的例外表。
 *
 * @param {{ logger?: Console, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, selection: string | null }>}
 */
export async function grabSelection(options = {}) {
  const logger = options.logger ?? console;
  const snapshot = readClipboardSnapshot();
  const before = snapshot.text ?? "";

  // ①（a）模拟 Ctrl+C —— 必须在把我们的窗口抬到前台**之前**做完
  const injected = await sendCopyKeystroke();
  if (!injected.ok) {
    logger.warn?.(`[minipi:hotkeys] 模拟 Ctrl+C 失败（${injected.error}），走降级链 ②：请手动 Ctrl+C 后再按热键`);
    writeClipboardSnapshot(snapshot);
    return { ok: false, selection: null };
  }

  // ①（b）读剪贴板
  const { text, changed } = await waitForClipboardChange(before);

  // ①（c）**无论成败都恢复原剪贴板**
  const restored = writeClipboardSnapshot(snapshot);
  if (!restored) {
    logger.warn?.("[minipi:hotkeys] 剪贴板恢复失败（已尽力），用户剪贴板可能被改动");
  }

  if (!changed) {
    logger.warn?.(
      "[minipi:hotkeys] 没拿到新选区（目标 App 可能不响应合成按键，或选中的文字与剪贴板内容相同）：走降级链 ②",
    );
    return { ok: false, selection: null };
  }

  if (text.trim().length === 0) return { ok: false, selection: null };

  let selection = text;
  if (selection.length > SELECTION_MAX_CHARS) {
    logger.warn?.(
      `[minipi:hotkeys] 选区过长（${selection.length} 字符），已截断到 ${SELECTION_MAX_CHARS} 字符`,
    );
    selection = selection.slice(0, SELECTION_MAX_CHARS);
  }
  // 不做 trim：选区要逐字保留（§6.3 规则 3），只有「是否为空」用 trim 判断
  return { ok: true, selection };
}

/* ========================================================================== *
 * 注册
 * ========================================================================== */

/**
 * 注册两个全局热键。**注册失败只告警，不让 App 崩**（热键可能被别的软件占用，
 * 例如 `Alt+Space` 被某些输入法 / 窗口管理工具占用）。
 *
 * @param {object} handlers
 * @param {() => unknown} handlers.onToggle
 * @param {() => unknown} handlers.onGrabSelection
 * @param {Console} [handlers.logger]
 * @returns {{ results: Array<{accelerator:string,label:string,ok:boolean,reason?:string}>, unregisterAll: () => void }}
 */
export function registerHotkeys(handlers) {
  const logger = handlers.logger ?? console;
  /** @type {Array<{accelerator:string,label:string,ok:boolean,reason?:string}>} */
  const results = [];

  const register = (accelerator, label, handler) => {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        // 热键回调里抛错会直接冒到 Electron 事件循环 → 统一包一层
        Promise.resolve()
          .then(() => handler())
          .catch((err) => {
            logger.error?.(`[minipi:hotkeys] ${label} 处理抛错：${err?.message ?? err}`);
          });
      });
      if (ok) {
        results.push({ accelerator, label, ok: true });
        logger.info?.(`[minipi:hotkeys] 已注册 ${accelerator}（${label}）`);
      } else {
        results.push({ accelerator, label, ok: false, reason: "unavailable" });
        logger.warn?.(`[minipi:hotkeys] 注册失败（多半被其它程序占用）：${accelerator}（${label}），App 继续运行`);
      }
    } catch (err) {
      results.push({ accelerator, label, ok: false, reason: err?.message ?? String(err) });
      logger.warn?.(
        `[minipi:hotkeys] 注册异常：${accelerator}（${label}）：${err?.message ?? err}，App 继续运行`,
      );
    }
  };

  register(HOTKEY.TOGGLE, "Alt+Space 开合", handlers.onToggle);
  register(HOTKEY.GRAB_SELECTION, "Alt+Shift+Space 抓选区", handlers.onGrabSelection);

  return {
    results,
    unregisterAll: () => {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* ignore */
      }
    },
  };
}
