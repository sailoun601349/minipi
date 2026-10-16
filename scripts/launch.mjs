#!/usr/bin/env node
/**
 * minipi 真正的启动实现。`minipi.cmd` 只是三行壳，逻辑全在这里 ——
 * 这样「双击之后到底发生了什么」是可以被 `node scripts/launch.mjs` 直接复现和验证的。
 *
 * 它做四件事：
 *   1. 建 `~/.minipi/logs`，把日志追加到 `launcher.log`（超 1MB 轮转 `.old`）；
 *   2. 解析 electron 二进制（`require("electron")` 给的是 `dist/electron.exe` 路径）；
 *   3. 清掉 `ELECTRON_RUN_AS_NODE`（理由见 `src/main/index.js` 文件头；双击环境里本来没有，
 *      这里只是防御）；
 *   4. **detached 拉起 Electron 后立刻退出** —— 所以 `.cmd` 的黑框只闪一下，
 *      Electron 自己活得比它久。Electron 的 stdout/stderr 直接落到日志文件里。
 *
 * 为什么要 detach：不 detach 的话 node 要陪着 Electron 跑一整天，
 * 双击出来的黑框就会一直挂在任务栏上。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const LOG_DIR = path.join(os.homedir(), ".minipi", "logs");
const LOG_FILE = path.join(LOG_DIR, "launcher.log");
const LOG_MAX_BYTES = 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
    fs.rmSync(`${LOG_FILE}.old`, { force: true });
    fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
  }
} catch {
  /* 轮转失败不影响启动 */
}

const fd = fs.openSync(LOG_FILE, "a");
const write = (text) => {
  try {
    fs.writeSync(fd, text.endsWith("\n") ? text : `${text}\n`);
  } catch {
    /* 日志写不进去也不能拦着启动 */
  }
};
const closeLog = () => {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
};

write(`\n[minipi:launch] ${new Date().toISOString()} node=${process.pid} root=${ROOT}`);

let electronPath = "";
try {
  electronPath = require("electron");
} catch (err) {
  write(`[minipi:launch] 找不到 electron 包：${err?.message ?? err}`);
}
if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  write("[minipi:launch] electron 二进制缺失。修法：node scripts/check-electron.mjs，或见 README §8");
  closeLog();
  process.exit(1);
}

/** 会把 electron 弄瘸的环境变量，一律不让它传进子进程。 */
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_FORCE_IS_PACKAGED"]) {
  if (key in env) delete env[key];
}

const child = spawn(electronPath, [ROOT], {
  cwd: ROOT,
  env,
  detached: true,
  stdio: ["ignore", fd, fd],
});

child.on("error", (err) => {
  write(`[minipi:launch] 拉起 electron 失败：${err?.message ?? err}`);
  closeLog();
  process.exit(1);
});

child.once("spawn", () => {
  write(`[minipi:launch] electron pid=${child.pid} exe=${electronPath}`);
  child.unref();
  closeLog();
  process.exit(0);
});
