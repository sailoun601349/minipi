#!/usr/bin/env node
/**
 * 双击启动器的**真启动自测**。
 *
 * 为什么需要它：静态检查能证明「文件长得对」，证明不了「双击之后真的起来了」。
 * 这个脚本把 `scripts/launch.mjs` 当成用户双击后真正会跑的那条路径跑一遍，
 * 然后回答三个问题：
 *
 *   1. 启动壳本身退出码是不是 0（非 0 的话，用户看到的就是「黑框闪一下」）？
 *   2. 启动壳退出**之后**，Electron 是不是还活着？（detach 有没有生效）
 *   3. 日志里有没有 Electron 主进程自己的启动痕迹？（窗口建没建、热键注册没注册）
 *
 * 它必然拉起一个真窗口再关掉。失败信息会直接给出日志路径。
 *
 * 背景（2026-09-24）：本机 GPU 进程的 sandbox 起不来，Electron 会在
 * `app.whenReady()` 之后约 1 秒被 `GPU process isn't usable. Goodbye.` 带走 ——
 * 表现就是双击闪退。修法在 `src/main/index.js`：`disable-gpu-sandbox`。
 * 本脚本正是那条修复的端到端回归门。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_FILE = path.join(os.homedir(), ".minipi", "logs", "launcher.log");

const PROBE_MS = Number(process.env.MINIPI_LAUNCH_PROBE_MS || 9000);

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  · ${detail}` : ""}`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── 1. 跑一遍用户真正会跑的那条路 ───────────────────────────────── */
const before = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
const t0 = Date.now();
// 注意：stdio 用 "inherit"。在本机沙箱里 pipe 版 spawnSync 会直接 EBUSY，
// 而这条脚本要能在「沙箱里自测」这个前提下跑起来，所以别用编码抓输出。
const run = spawnSync(process.execPath, [path.join(root, "scripts", "launch.mjs")], {
  cwd: root,
  stdio: "inherit",
  timeout: 20000,
});
const shellCost = Date.now() - t0;
check("launch.mjs 退出码为 0（双击不会看到报错框）", run.status === 0, `exit=${run.status} · ${shellCost}ms`);
check("launch.mjs 快速返回（黑框只闪一下）", shellCost < 3000, `${shellCost}ms`);

/* ── 2. 从日志里取 Electron PID ───────────────────────────────────── */
const after = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
const appended = after.slice(before.length);
const pidMatches = [...appended.matchAll(/electron pid=(\d+)/g)];
check("日志里记下了 electron pid", pidMatches.length > 0, pidMatches.map((m) => m[1]).join(",") || "无");
const electronPid = pidMatches.length ? Number(pidMatches[pidMatches.length - 1][1]) : 0;

/* ── 3. 等它把窗口建起来，然后看它还活着没有 ──────────────────────── */
let stillAlive = false;
let bootLog = "";
if (electronPid) {
  const deadline = Date.now() + PROBE_MS;
  while (Date.now() < deadline) {
    sleep(600);
    if (!alive(electronPid)) break;
    stillAlive = true;
  }
  bootLog = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").slice(-4000) : "";
}

/* ⚠ 前置条件：minipi 是**单实例**的。如果用户自己正开着 App，本次启动会命中
   单实例锁并立刻退出（日志里是「已有实例在跑，本次启动退出」）——
   这不是回归，是设计。这种情况必须判为 **SKIP**，不能判红：
   否则"开着 App 跑回归"永远是一条红灯，久而久之没人再认真看红。 */
if (/已有实例在跑/.test(bootLog)) {
  console.log("\n  SKIP  用户已有一个 minipi 实例在运行（单实例锁生效）");
  console.log("        本脚本需要独占启动：请先退出 minipi，再跑 `npm run verify:launch-live`。");
  console.log("        这不是失败 —— 只是前置条件不满足。");
  process.exit(0);
}

check(
  `Electron 在启动壳退出后存活 ≥ ${PROBE_MS}ms（detach + GPU sandbox 修复都生效）`,
  stillAlive,
  electronPid ? `pid=${electronPid}` : "没有 pid",
);
check("日志里有主进程启动痕迹（[minipi] 启动中）", /\[minipi\] 启动中/.test(bootLog));
check("日志里有窗口就绪痕迹（[minipi:window] 已就绪）", /\[minipi:window\] 已就绪/.test(bootLog));
check(
  "日志里没有 GPU 致命错误（GPU process isn't usable）",
  !/GPU process isn't usable/.test(bootLog),
);

/* ── 4. 收尾：把自测拉起来的窗口关掉 ─────────────────────────────── */
if (electronPid) {
  try {
    process.kill(electronPid, "SIGTERM");
  } catch {
    /* 已经退了 */
  }
  const until = Date.now() + 6000;
  while (Date.now() < until && alive(electronPid)) sleep(400);
  check("自测结束后 Electron 已退出（不留后台进程）", !alive(electronPid), `pid=${electronPid}`);
}

const failed = checks.filter((item) => !item.ok);
console.log(`verify:launch-live: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log(`\n日志：${LOG_FILE}`);
  console.log(appended.trim().split("\n").slice(-25).join("\n"));
}
process.exit(failed.length ? 1 : 0);
