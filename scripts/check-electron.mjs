#!/usr/bin/env node
/**
 * 校验 `node_modules/electron/dist/electron.exe` 真的存在；不存在就带镜像重跑
 * electron 自己的 `install.js`。
 *
 * 为什么要它：本机 npm 走 `registry.npmmirror.com`，但 **Electron 的二进制**默认从
 * GitHub 取 —— `npm install` 会「成功」却不装二进制（`node_modules/electron/dist` 缺失），
 * 然后 `npm start` 报一个跟根因毫无关系的错。这个脚本把它变成一条明确的失败/自愈。
 *
 * 挂点：根 package.json 的 `postinstall`（装完自动跑）+ `npm run verify:electron`。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTRON_PKG = path.join(ROOT, "node_modules", "electron");
const EXE_NAME = process.platform === "win32" ? "electron.exe" : "electron";
const EXE_PATH = path.join(ELECTRON_PKG, "dist", EXE_NAME);
const DEFAULT_MIRROR = "https://npmmirror.com/mirrors/electron/";

function ok() {
  const versionFile = path.join(ELECTRON_PKG, "dist", "version");
  let version = "?";
  try {
    version = fs.readFileSync(versionFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  console.log(`[minipi:check-electron] ✅ ${path.relative(ROOT, EXE_PATH)} 存在（electron ${version}）`);
}

function fail(lines) {
  console.error(["[minipi:check-electron] ❌ electron 二进制不可用", ...lines].join("\n"));
}

if (fs.existsSync(EXE_PATH)) {
  ok();
  process.exit(0);
}

// devDependencies 压根没装（例如 npm install --omit=dev）→ 只告警，不算失败
if (!fs.existsSync(ELECTRON_PKG)) {
  console.warn(
    "[minipi:check-electron] ⚠ node_modules/electron 不存在（可能用了 --omit=dev）。跳过校验；" +
      "要跑 App 请先 npm install。",
  );
  process.exit(0);
}

if (process.env.MINIPI_SKIP_ELECTRON_INSTALL === "1") {
  fail([`  已设置 MINIPI_SKIP_ELECTRON_INSTALL=1，不自动下载。目标路径：${path.relative(ROOT, EXE_PATH)}`]);
  process.exit(1);
}

const installJs = path.join(ELECTRON_PKG, "install.js");
if (!fs.existsSync(installJs)) {
  fail([`  找不到 ${path.relative(ROOT, installJs)}，依赖树不完整，请重跑 npm install。`]);
  process.exit(1);
}

const mirror = process.env.ELECTRON_MIRROR || process.env.npm_config_electron_mirror || DEFAULT_MIRROR;
console.log(`[minipi:check-electron] 二进制缺失，正用镜像重跑 install.js：${mirror}`);

const res = spawnSync(process.execPath, [installJs], {
  cwd: ELECTRON_PKG,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_MIRROR: mirror,
    npm_config_electron_mirror: mirror,
  },
});

if (fs.existsSync(EXE_PATH)) {
  ok();
  process.exit(0);
}

fail([
  `  install.js 退出码 ${res.status ?? "?"}，目标路径仍不存在：${path.relative(ROOT, EXE_PATH)}`,
  "  手动修复：",
  `    $env:ELECTRON_MIRROR="${mirror}"; node node_modules/electron/install.js`,
]);
process.exit(1);
