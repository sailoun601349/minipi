/**
 * 主进程日志 —— **落盘**，不只是 `console`。
 *
 * ## 为什么需要这个文件（真实发布缺陷）
 *
 * 在开发期，`src/main/index.js` 的日志靠 `scripts/launch.mjs` 把
 * 子进程的 stdout/stderr 重定向到 `~/.minipi/logs/launcher.log`。
 * 那条链路有个隐含前提：**得有人启动器去接 fd**。
 *
 * 打包之后这个前提消失了：
 *   · 没有 `launch.mjs` 了，客户双击的是 `minipi.exe`；
 *   · Windows 的 GUI 子系统程序**没有控制台**，`console.log` 写进的是
 *     一个不存在的 stdout ⇒ 输出被系统直接丢弃；
 *   · macOS 从 Finder 启动同理，stderr 无处可去。
 *
 * 后果：**打包版永远不产生任何日志**。客户报「双击没反应」「球不见了」
 * 时，我们手上零信息，只能靠猜。这是发布阻断级问题，不是体验问题。
 *
 * 所以主进程必须自己开文件写日志，不能依赖 stdout。
 *
 * ## 为什么是**同步**写
 *
 * 异步（`createWriteStream` / `fs.appendFile`）在进程崩溃时会丢掉缓冲区里
 * 最后几行 —— 而「崩溃前最后几行」恰恰是我们唯一想要的东西。
 * 日志量很小（启动十几行 + 用户操作几十行），同步写换来「崩了也留证据」值得。
 *
 * ## 失败降级
 *
 * 日志写不进去（磁盘满 / 目录只读 / 权限不足）**绝不能拦住产品启动**。
 * 所有写入都包在 try 里，失败就静默退回 console。
 *
 * 本文件**不 import electron**，所以能在纯 Node 下被单测。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `~/.minipi/logs`（与 settings.js 的 LOG_DIR 同一个位置，这里不 import 是为了避免循环依赖）。 */
const LOG_DIR = path.join(os.homedir(), ".minipi", "logs");

/** 主进程日志文件名。与启动器的 `launcher.log` **分开**：一个是外壳、一个是应用本体。 */
export const MAIN_LOG_FILE = path.join(LOG_DIR, "main.log");

/** 超过这个大小就轮转成 `.old`（只留一代，够定位问题、不占空间）。 */
const MAX_BYTES = 1024 * 1024;

/**
 * 已经做过轮转检查的**文件**（每进程每文件只查一次，不必每次写都 stat）。
 *
 * ⚠ 这里必须是 Set 而不是一个 `boolean`（2026-10-23 被测试抓到的真 bug）：
 *   第一版用模块级 `let rotated = false`，但轮转对象是**调用方传入的 `file`**。
 *   于是「传了自定义 file」的调用会去轮转**默认的** `main.log` ——
 *   测试里以为写的是临时文件，实际把真实用户日志挤成了 `.old`。
 *   生产上当时只有一个默认调用点所以没炸，但这是**会伤到用户的隐式耦合**，必须修。
 *   key 用绝对路径（`path.resolve`）做归一，避免 `./a.log` 与 `/abs/a.log` 被当成两个文件。
 * @type {Set<string>}
 */
const rotatedFiles = new Set();

/**
 * 时间戳。刻意用本地时间而不是 ISO/UTC：
 * 客户反馈「我下午三点多点的」，本地时间才对得上；UTC 只会增加对表成本。
 * @returns {string} `2026-10-24 15:04:05.123`
 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 轮转：`<file>` → `<file>.old`（覆盖旧 `.old`）。失败不影响写日志。
 * @param {string} file 实际要写的日志文件（**不是**默认路径）
 */
function rotateIfNeeded(file) {
  const key = path.resolve(file);
  if (rotatedFiles.has(key)) return;
  rotatedFiles.add(key);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.rmSync(`${file}.old`, { force: true });
      fs.renameSync(file, `${file}.old`);
    }
  } catch {
    /* 轮转失败就继续往原文件追加 */
  }
}

/**
 * 把 `Error` / `Object` / 任意值变成一行可读文本。
 *
 * ⚠ **不做脱敏** —— 脱敏是调用方的事（`sanitizeDetail`）。
 * 这里只负责「别把日志写成 `[object Object]`」。
 * @param {unknown} v
 * @returns {string}
 */
function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * 造一个 logger。`console` 的四个方法名保持一致，这样
 * `logger.info?.(...)` / `log.warn?.(...)` 这种可选调用写法不用改。
 *
 * @param {{ tag?: string, file?: string, mirrorToConsole?: boolean }} [opts]
 *   tag: 行首标签（默认 `minipi`）
 *   file: 落盘路径（默认 `~/.minipi/logs/main.log`）
 *   mirrorToConsole: 是否同时写 console（开发期开着便于看终端；默认 true）
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function, log: Function, file: string }}
 */
export function createLogger(opts = {}) {
  /**
   * `tag` **默认为空**，这是刻意的。
   * 调用点（`index.js` / `window.js` …）的文案本身已经带 `[minipi]` / `[minipi:window]`
   * 前缀了。若这里再加一个 tag，日志会变成 `[minipi] [minipi] 启动中`——
   * 重复前缀既丑又干扰 grep（`grep '\[minipi\]'` 会连成对出现）。
   * 留这个选项是为了将来真有「整个模块统一标签」的需求时不必改调用点。
   */
  const tag = opts.tag ?? "";
  const file = opts.file ?? MAIN_LOG_FILE;
  const mirror = opts.mirrorToConsole !== false;
  const prefix = tag ? `[${tag}] ` : "";

  /**
   * @param {"info"|"warn"|"error"|"debug"} level
   * @param {unknown[]} args
   */
  const write = (level, args) => {
    const text = args.map(fmt).join(" ");
    const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${prefix}${text}\n`;

    // ① 落盘（同步，崩溃也不丢最后几行）
    try {
      rotateIfNeeded(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, "utf8");
    } catch {
      /* 写不进去不能拦住产品 */
    }

    // ② 镜像到 console（打包后没有控制台，这步是空操作；开发期有用）
    if (mirror) {
      try {
        const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        sink.call(console, `${prefix}${text}`);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    file,
    log: (...a) => write("info", a),
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
    debug: (...a) => write("debug", a),
  };
}
