#!/usr/bin/env node
/**
 * 启动器：**先清 `ELECTRON_RUN_AS_NODE`，再拉起 electron**。
 *
 * 为什么必须有这一层：
 *   本机环境变量里存在 `ELECTRON_RUN_AS_NODE=1`。带着它跑 `electron .`，
 *   Electron 会退化成纯 Node，`import { BrowserWindow } from "electron"` 直接报
 *   `does not provide an export named 'BrowserWindow'`，主进程代码一行都跑不到。
 *   而 `src/main/index.js` 里的 `delete process.env.ELECTRON_RUN_AS_NODE`
 *   **救不了本进程**（ESM 的 import 会被提升到模块体之前执行）——所以必须在
 *   spawn 之前把变量从子进程环境里摘掉。
 *
 * 用法：
 *   node scripts/start.mjs                # 起 App
 *   node scripts/start.mjs --selftest     # 起自测套件（三态变形 / 未聚焦节流 / IPC 往返）
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

/** 会把 electron 弄瘸的环境变量，一律不让它传进子进程。 */
const POISONOUS_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_FORCE_IS_PACKAGED"];

const argv = process.argv.slice(2);
const selftestIdx = argv.indexOf("--selftest");
const wantSelftest = selftestIdx !== -1;
if (wantSelftest) argv.splice(selftestIdx, 1);

/* 1) 解析 electron 可执行文件（npm 包的 index.js 会读 path.txt 给出 dist/electron.exe） */
let electronPath = null;
try {
  electronPath = require("electron");
} catch (err) {
  console.error("[minipi:start] 拿不到 electron 可执行文件：", err?.message ?? err);
}

if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  console.error(
    [
      "",
      "[minipi:start] ❌ 找不到 electron 二进制（依赖装了但二进制没下来 —— 本机 npm 走 npmmirror，",
      "               Electron 二进制默认从 GitHub 取，会「假成功」）。",
      "",
      "  修：node scripts/check-electron.mjs",
      "  或：$env:ELECTRON_MIRROR=\"https://npmmirror.com/mirrors/electron/\"; node node_modules/electron/install.js",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/* 2) 清掉污染变量 */
const env = { ...process.env };
const cleared = [];
for (const key of POISONOUS_ENV) {
  if (key in env) {
    delete env[key];
    cleared.push(key);
  }
}
if (cleared.length > 0) {
  console.log(`[minipi:start] 已从子进程环境清掉：${cleared.join(", ")}`);
}

/* 3) 起 electron */
const target = wantSelftest ? path.join(ROOT, "scripts", "selftest", "main.mjs") : ROOT;
const extraArgs = [];
if (wantSelftest) {
  // 自测要 import src/main/index.js 里的 registerIpc()，但不能顺手把真 App 也启动起来
  env.MINIPI_NO_BOOTSTRAP = "1";
}
console.log(`[minipi:start] electron=${path.basename(electronPath)} · 入口=${path.relative(ROOT, target) || "."}`);

const child = spawn(electronPath, [target, ...extraArgs, ...argv], {
  cwd: ROOT,
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (err) => {
  console.error("[minipi:start] 拉起 electron 失败：", err?.message ?? err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) console.log(`[minipi:start] electron 被信号结束：${signal}`);
  process.exit(typeof code === "number" ? code : 1);
});

// Ctrl+C 时把子进程一起带走
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });
}
