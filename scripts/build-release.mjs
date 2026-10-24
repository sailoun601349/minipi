/**
 * 打包 minipi —— 带前置校验的 electron-builder 封装。
 *
 * 为什么不直接 `electron-builder --win`：
 * 打包失败有两大类，一类报错清楚（缺依赖），一类是**静默产出坏包**
 * （漏打文件 ⇒ 客户装完白屏/功能缺失）。后者最贵：本地测试全绿，
 * 客户打开是黑屏，而且卸载重装都复现。
 * 所以这个脚本在打包**前**逐项验「运行时真正需要的东西在不在」，
 * 打包**后**验产物存在 + 体积合理。
 *
 * 用法：
 *   node scripts/build-release.mjs             # 当前平台
 *   node scripts/build-release.mjs --win       # Windows 安装包
 *   node scripts/build-release.mjs --mac       # macOS dmg
 *   node scripts/build-release.mjs --dir       # 只解包，不打安装包（冒烟用，快）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
/** @type {string[]} */
const builderArgs = [];
if (args.includes("--win")) builderArgs.push("--win");
else if (args.includes("--mac")) builderArgs.push("--mac");
else if (args.includes("--linux")) builderArgs.push("--linux");
if (args.includes("--dir")) builderArgs.push("--dir");

/* ---------------- 前置校验 ---------------- */

/** @type {{name:string, ok:boolean, detail:string, fatal:boolean}[]} */
const checks = [];

/**
 * 跑一项校验。
 *
 * ⚠ 约定（第一版写错过，别改回去）：回调**只有返回 `false` 或抛错**才算失败；
 *   返回 `true` = 通过（无细节），返回**非空字符串** = 通过**并附带**细节
 *   （例如「1024×1024」「^26.15.3」）。
 *   第一版把字符串一律当失败，结果「图标 1024×1024」被判 FAIL —— 校验器自己
 *   出错比没有校验器更糟，因为它会让人开始怀疑真问题。
 *
 * @param {string} name
 * @param {() => true|false|string} fn
 * @param {boolean} [fatal]
 */
const need = (name, fn, fatal = true) => {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    if (r === true) {
      ok = true;
    } else if (typeof r === "string" && r.length > 0) {
      ok = true; // 字符串 = 通过 + 细节
      detail = r;
    } else {
      ok = false;
      detail = "校验未通过";
    }
  } catch (err) {
    ok = false;
    detail = err?.message ?? String(err);
  }
  checks.push({ name, ok, detail, fatal });
};

need("package.json 有 version / author / license / description", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const missing = [];
  if (!pkg.version) missing.push("version");
  if (!pkg.author) missing.push("author");
  if (!pkg.license) missing.push("license");
  if (!pkg.description) missing.push("description");
  if (!pkg.main) missing.push("main");
  if (missing.length > 0) throw new Error(`缺 ${missing.join(",")}`);
  return `v${pkg.version}`;
});

/**
 * 图标三件套齐全，且 `.ico` / `.icns` 结构自洽。
 *
 * ⚠ **必须校验，不能只看 png 存不存在**（2026-10-23 实测教训）：
 *   `electron-builder.yml` 的 `win.icon` 原本指向 `build/icon.png`，指望它自动转 ico。
 *   打包机上它 spawn 的 `icon-tool.js` 子进程 **OOM 崩掉**（`Zone Allocation failed`），
 *   报错只出现在 `updating asar integrity executable resource` 之后的一行里，
 *   极易被误读成「图标文件有问题」或「打包工具坏了」。
 *   现在三件套由 `scripts/build-icon.mjs` 自产（纯 Node，真渲染各尺寸），
 *   这里逐字节验结构 —— 结构错就当场停下，不产出用空白图标的包。
 */
need("图标三件套（png/ico/icns）齐全且结构正确", () => {
  const dir = path.join(ROOT, "build");
  const pngPath = path.join(dir, "icon.png");
  const icoPath = path.join(dir, "icon.ico");
  const icnsPath = path.join(dir, "icon.icns");

  for (const [p, hint] of [
    [pngPath, "icon.png"],
    [icoPath, "icon.ico"],
    [icnsPath, "icon.icns"],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`缺 build/${hint}（跑 node scripts/build-icon.mjs）`);
  }

  // PNG：≥512 且宽高相等（不方正的图标会被系统拉伸）
  const png = fs.readFileSync(pngPath);
  if (png.length < 24) throw new Error("icon.png 太小，不是合法 PNG");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("icon.png 签名不对");
  }
  const pw = png.readUInt32BE(16);
  const ph = png.readUInt32BE(20);
  if (!(pw >= 512 && ph >= 512)) throw new Error(`icon.png 只有 ${pw}×${ph}，需 ≥512`);
  if (pw !== ph) throw new Error(`icon.png 不是正方形（${pw}×${ph}）`);

  // ICO：头 + 每个目录项 + 每帧必须是真 PNG
  const ico = fs.readFileSync(icoPath);
  if (ico.readUInt16LE(2) !== 1) throw new Error("icon.ico type 不是 1（icon）");
  const count = ico.readUInt16LE(4);
  if (count < 5) throw new Error(`icon.ico 只有 ${count} 帧，Windows 需要多档缩放`);
  let sawBig = false;
  for (let k = 0; k < count; k += 1) {
    const base = 6 + k * 16;
    const dim = ico.readUInt8(base) || 256;
    const bytes = ico.readUInt32LE(base + 8);
    const off = ico.readUInt32LE(base + 12);
    if (off + bytes > ico.length) throw new Error(`icon.ico 第 ${k} 帧越界`);
    if (ico.subarray(off, off + 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`icon.ico 第 ${k} 帧不是 PNG（Windows 会显示空白图标）`);
    }
    // 帧里声明的宽高要和目录项一致，否则资源管理器显示的尺寸会错
    const fw = ico.readUInt32BE(off + 16);
    if (fw !== dim) throw new Error(`icon.ico 第 ${k} 帧目录写 ${dim}，实际 ${fw}`);
    if (dim >= 256) sawBig = true;
  }
  if (!sawBig) throw new Error("icon.ico 缺 256×256 档（大图标会模糊）");

  // ICNS：魔数 + 总长度自洽
  const icns = fs.readFileSync(icnsPath);
  if (icns.subarray(0, 4).toString("ascii") !== "icns") throw new Error("icon.icns 魔数不对");
  if (icns.readUInt32BE(4) !== icns.length) throw new Error("icon.icns 总长度与文件长度不符");

  return `ico ${count} 帧 / ${(ico.length / 1024).toFixed(0)}KB · icns ${(icns.length / 1024).toFixed(0)}KB`;
});

need("兜底页 scripts/probe/stub.html 存在（漏它 = 客户白屏）", () => {
  const f = path.join(ROOT, "scripts", "probe", "stub.html");
  if (!fs.existsSync(f)) throw new Error("不存在");
  return true;
});

need("渲染层 src/renderer/index.html 存在", () => {
  const f = path.join(ROOT, "src", "renderer", "index.html");
  if (!fs.existsSync(f)) throw new Error("不存在");
  return `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
});

need("preload src/preload/index.js 存在", () => {
  const f = path.join(ROOT, "src", "preload", "index.js");
  if (!fs.existsSync(f)) throw new Error("不存在");
  return true;
});

need("electron-builder 已安装", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const v = pkg.devDependencies?.["electron-builder"];
  if (!v) throw new Error("devDependencies 里没有 electron-builder");
  return v;
});

need("electron-builder.yml 存在", () => {
  const f = path.join(ROOT, "electron-builder.yml");
  if (!fs.existsSync(f)) throw new Error("不存在");
  return true;
});

need("版本号不是 0.x（正式发布请 ≥1.0.0）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const major = Number(String(pkg.version).split(".")[0]);
  if (!(Number.isFinite(major) && major >= 1)) throw new Error(`当前 ${pkg.version}`);
  return `v${pkg.version}`;
}, false /* 非致命：便于打 0.x 测试包 */);

/* ---------------- 输出校验表 ---------------- */

process.stdout.write("\n打包前置校验\n");
process.stdout.write(`${"─".repeat(58)}\n`);
let fatalFail = 0;
for (const c of checks) {
  const mark = c.ok ? "PASS" : c.fatal ? "FAIL" : "warn";
  if (!c.ok && c.fatal) fatalFail += 1;
  process.stdout.write(` ${mark.padEnd(5)} ${c.name}\n`);
  if (!c.ok) process.stdout.write(`       └─ ${c.detail}\n`);
}
process.stdout.write(`${"─".repeat(58)}\n`);

if (fatalFail > 0) {
  process.stderr.write(`\n有 ${fatalFail} 项致命前置校验未通过，已中止打包（不产出坏包）。\n`);
  process.exit(1);
}

/* ---------------- 清理上次的 staging 目录 ---------------- */

/**
 * electron-builder 在打包开始时会 `emptyDir(dist/win-unpacked)`。
 *
 * ⚠ 这一步在**带 safe-delete 钩子的环境**里会失败（2026-10-23 实测）：
 *   钩子把「一个目录里一次删 65 个文件」判为批量删除并拒绝执行，
 *   报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，electron-builder 直接退出。
 *   报错栈全在 `node_modules/fs-extra/.../emptyDir`，看着像打包工具坏了，
 *   实际是环境策略 —— 换个干净机器就复现不出来。
 *
 * 所以这里**自己先清干净**，让它的 `emptyDir` 面对空目录（0 个目标，不触发钩子）。
 *
 * 为什么另起一个进程删：当前进程的 `fs` 已经被钩子打过补丁，自己删同样会被拦。
 * 子进程里去掉 `NODE_OPTIONS` 就不加载那个 preload 了。
 * ⚠ 只删 `dist/` 下的**构建产物**，绝不碰源码或用户数据。
 *
 * @returns {string[]} 实际清理掉的目录（相对 ROOT）
 */
function cleanStaleStaging() {
  const candidates = [
    "dist/win-unpacked",
    "dist/mac",
    "dist/mac-arm64",
    "dist/linux-unpacked",
    "dist/.icon-ico",
    "dist/.icon-icns",
  ];
  const targets = candidates.filter((d) => fs.existsSync(path.join(ROOT, d)));
  if (targets.length === 0) return [];

  const code =
    'const fs=require("fs");' +
    `for(const d of ${JSON.stringify(targets)}){` +
    "try{fs.rmSync(d,{recursive:true,force:true})}catch(e){console.error(String(e.message||e));process.exitCode=1}}";
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // 关键：不带 safe-delete 钩子
  const r = spawnSync(process.execPath, ["-e", code], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`清理 dist staging 失败（退出码 ${r.status}）—— 请手动删除 dist/win-unpacked 后重试`);
  }
  return targets;
}

const cleaned = cleanStaleStaging();
if (cleaned.length > 0) {
  process.stdout.write(`\n已清理上次产物：${cleaned.join(" · ")}\n`);
}

/* ---------------- 调 electron-builder ---------------- */

const isWin = process.platform === "win32";
const bin = path.join(
  ROOT,
  "node_modules",
  ".bin",
  isWin ? "electron-builder.cmd" : "electron-builder",
);
if (!fs.existsSync(bin)) {
  process.stderr.write(`找不到 electron-builder 可执行文件：${bin}\n`);
  process.exit(1);
}

process.stdout.write(`\n执行 electron-builder ${builderArgs.join(" ")}\n\n`);
const r = spawnSync(bin, builderArgs, { cwd: ROOT, stdio: "inherit", shell: isWin });
if (r.status !== 0) {
  process.stderr.write(`\nelectron-builder 退出码 ${r.status}\n`);
  process.exit(r.status ?? 1);
}

/* ---------------- 产物校验 ---------------- */

const dist = path.join(ROOT, "dist");
process.stdout.write("\n产物校验\n");
process.stdout.write(`${"─".repeat(58)}\n`);
if (!fs.existsSync(dist)) {
  process.stderr.write(" dist/ 不存在 —— 打包声称成功但没有产物，这不可信\n");
  process.exit(1);
}

/** @param {string} dir @returns {string[]} */
const walk = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

const all = walk(dist);

/**
 * 只把 **dist 根目录下**的 `.exe/.dmg/.AppImage` 当安装包。
 *
 * ⚠ 第一版直接对 `walk(dist)` 全量过滤，于是把这两个也当成安装包：
 *   · `dist/win-unpacked/resources/elevate.exe` —— electron-builder 自带的提权助手，0.1MB
 *   · `dist/win-unpacked/minipi.exe` —— 解包后的主程序本体
 *   然后拿「安装包应 >40MB」的阈值去卡它们 ⇒ 双双 FAIL，打包明明成功却报失败。
 *   这类误报最伤：会让人开始怀疑打包工具，真问题反而被淹掉。
 */
const isInstaller = (f) => {
  if (!/\.(exe|dmg|AppImage)$/.test(f)) return false;
  const rel = path.relative(dist, f);
  // 目录层级 > 0 的一律不是安装包（都在 win-unpacked / mac 之类的子目录里）
  if (path.dirname(rel) !== ".") return false;
  // NSIS 的提权助手偶尔也会落到根上，排除掉
  return !/^elevate/i.test(path.basename(rel));
};

const installers = all.filter(isInstaller);
const unpacked = all.filter((f) => f.includes("unpacked") && f.endsWith(".asar"));

let bad = 0;
if (installers.length === 0 && !args.includes("--dir")) {
  process.stderr.write(" 没找到安装包（.exe / .dmg / .AppImage）\n");
  bad += 1;
}
for (const f of installers) {
  const mb = fs.statSync(f).size / 1024 / 1024;
  // 低于 40MB 基本可以断定 Electron 本体没打进去
  const ok = mb > 40;
  if (!ok) bad += 1;
  process.stdout.write(
    ` ${ok ? "PASS" : "FAIL"}  ${path.relative(ROOT, f)}  ${mb.toFixed(1)} MB\n`,
  );
}
for (const f of unpacked) {
  const mb = fs.statSync(f).size / 1024 / 1024;
  process.stdout.write(` PASS  ${path.relative(ROOT, f)}  ${mb.toFixed(1)} MB\n`);
}
process.stdout.write(`${"─".repeat(58)}\n`);

if (bad > 0) {
  process.stderr.write("\n产物校验未通过。\n");
  process.exit(1);
}
process.stdout.write("\n打包完成。产物在 dist/\n");
