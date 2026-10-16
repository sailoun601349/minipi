#!/usr/bin/env node
/**
 * 双击启动器的**静态**验证（不真的起进程，那条在 `verify-launch-live.mjs`）。
 *
 * 这个文件是被三次「双击弹编译错误框」逼出来的，所以它守的都是真踩过的坑：
 *
 *   ① **编码**——`.vbs` 时代，WSH 在文件没有 UTF-16 BOM 时按系统 ANSI 码页解码，
 *      「UTF-8 无 BOM + 中文」直接被当 GBK 解，抛 800A0409 / 800A0401，一行都没跑到。
 *      → 结论：启动壳必须是**纯 ASCII**（所有字节 < 128）。现在的壳是 `.cmd`。
 *   ② **VBScript 的括号规则**——`fso.DeleteFile(a, b)` 这种「Sub 配括号 + 多参」
 *      直接 800A0414。`.cmd` 里没有这类陷阱。
 *   ③ **单入口**——不许同时存在 `.vbs` / `.lnk` / 第二个 `.cmd`，用户会不知道该点哪个。
 *   ④ **别让失败静默**——启动壳退出码非 0 必须 `pause`，否则黑框一闪、什么也留不下。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
function check(label, ok) {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

const cmdPath = path.join(root, "minipi.cmd");
const launchPath = path.join(root, "scripts", "launch.mjs");
const mainPath = path.join(root, "src", "main", "index.js");
const allPath = path.join(root, "scripts", "verify-all.mjs");
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const cmd = readText(cmdPath);
const launch = readText(launchPath);
const main = readText(mainPath);
const all = readText(allPath);

/* ── ① 启动壳：存在 / 纯 ASCII / CRLF ─────────────────────────────── */
check("minipi.cmd exists（双击入口）", fs.existsSync(cmdPath));
if (fs.existsSync(cmdPath)) {
  const bytes = fs.readFileSync(cmdPath);
  const bad = [...bytes].filter((b) => b > 127).length;
  check(`minipi.cmd is pure ASCII（>128 的字节数 = ${bad}）`, bad === 0);
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    lf += 1;
    if (bytes[i - 1] === 0x0d) crlf += 1;
  }
  check(`minipi.cmd is CRLF（裸 LF = ${lf - crlf}）`, lf - crlf === 0);
}

/* ── ③ 单入口 ────────────────────────────────────────────────────── */
for (const stale of ["minipi.vbs", "minipi.bat", "minipi.lnk", "启动minipi.vbs"]) {
  check(`no stale duplicate entry (${stale})`, !fs.existsSync(path.join(root, stale)));
}

/* ── 启动壳的接线 ─────────────────────────────────────────────────── */
check("minipi.cmd cd 到脚本自身目录（%~dp0）", /cd\s+\/d\s+"%~dp0"/i.test(cmd));
check("minipi.cmd 调 scripts\\launch.mjs", /node\s+"scripts\\launch\.mjs"/i.test(cmd));
check("minipi.cmd 失败时 pause（不让失败静默）", /if\s+errorlevel\s+1\s+pause/i.test(cmd));

/* ── launch.mjs：逻辑都在这里，所以这里要能被 node 直接跑 ──────────── */
check("scripts/launch.mjs exists", fs.existsSync(launchPath));
check("launch.mjs 解析 electron 二进制", /require\("electron"\)/.test(launch));
check("launch.mjs 清掉 ELECTRON_RUN_AS_NODE", /ELECTRON_RUN_AS_NODE/.test(launch));
check("launch.mjs 写 ~/.minipi/logs/launcher.log", /logs[\s\S]{0,40}launcher\.log/.test(launch));
check("launch.mjs 日志轮转（.old）", /\.old/.test(launch));
check("launch.mjs detached 拉起 Electron", /detached:\s*true/.test(launch));
check("launch.mjs unref 后立即退出（黑框只闪一下）", /\.unref\(\)/.test(launch) && /process\.exit\(0\)/.test(launch));
check("launch.mjs 把 electron 的 stdout/stderr 接进日志", /stdio:\s*\[[^\]]*fd[^\]]*\]/.test(launch));
check("launch.mjs 打印 electron pid（供存活自测用）", /electron pid=\$\{child\.pid\}/.test(launch));
check("launch.mjs 缺二进制时非零退出", /process\.exit\(1\)/.test(launch));

/* ── 应用侧：GPU sandbox 开关（否则起来 1 秒就闪退） ──────────────── */
check(
  "src/main/index.js 注入 disable-gpu-sandbox",
  /appendSwitch\("disable-gpu-sandbox"\)/.test(main),
);
check(
  "该开关只在 win32 且未被 MINIPI_KEEP_GPU_SANDBOX=1 覆盖时生效",
  /MINIPI_KEEP_GPU_SANDBOX/.test(main) && /platform\s*===\s*"win32"/.test(main),
);

/* ── 回归门 & npm start 不回归 ───────────────────────────────────── */
check("npm start 仍走 scripts/start.mjs", /scripts[\\/]start\.mjs/.test(readText(path.join(root, "package.json"))));
check("verify:all 收录了本文件", /verify-launcher\.mjs/.test(all));
check("verify:all 收录了真启动自测", /verify-launch-live\.mjs/.test(all));

const failed = checks.filter((item) => !item.ok);
console.log(`verify:launcher: ${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
