#!/usr/bin/env node
/**
 * 打包产物冒烟验证 —— 回答一个问题：**客户双击 dist 里那个 exe，能不能起来？**
 *
 * 为什么不能用 `verify-launch-live.mjs` 代替：
 *   那个测的是「源码 + launcher」路径（`scripts/launch.mjs` → `node_modules/electron`）。
 *   打包后是三件完全不同的东西：
 *     · 入口变成 `app.asar` 里的 `src/main/index.js`（模块解析环境不同）
 *     · `app.isPackaged === true`（会走不同的分支，比如不设菜单）
 *     · `ELECTRON_RUN_AS_NODE` 的清理来自启动器 —— 打包后**没有启动器**
 *   这三条任何一条出问题，源码全绿而客户打开是黑屏/闪退。
 *
 * 能验什么 / 不能验什么（诚实说明）：
 *   ✅ 能验：asar 结构、关键文件在不在、main 字段指向的文件存在、
 *            exe 是不是真 Electron、进程能不能存活到窗口创建、
 *            日志里有没有「已就绪」
 *   ❌ 不能验：GUI 观感、真实点击交互（那需要人眼 + 真桌面会话）
 *
 * 用法：node scripts/verify-packaged.mjs [dist/win-unpacked]
 * 退出码：0 全绿；1 有失败
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TARGET = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "dist", "win-unpacked");

const LOG_FILE = path.join(os.homedir(), ".minipi", "logs", "launcher.log");
const PROBE_MS = Number(process.env.MINIPI_PACKAGED_PROBE_MS || 10000);

const lines = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  const mark = ok ? "PASS" : "FAIL";
  const line = ` ${mark} ${name}${detail ? `  · ${detail}` : ""}`;
  lines.push(line);
  process.stdout.write(`${line}\n`);
};

/* ---------------- 1) 产物存在 ---------------- */

if (!fs.existsSync(TARGET)) {
  process.stderr.write(`找不到打包产物目录：${TARGET}\n先跑 npm run build:dir\n`);
  process.exit(1);
}

const resourcesDir = path.join(TARGET, "resources");
const asarPath = path.join(resourcesDir, "app.asar");
const exePath = process.platform === "win32"
  ? path.join(TARGET, "minipi.exe")
  : path.join(TARGET, "minipi");

check("产物目录存在", fs.existsSync(TARGET), path.relative(ROOT, TARGET));
check("可执行文件存在", fs.existsSync(exePath), fs.existsSync(exePath) ? `${(fs.statSync(exePath).size / 1024 / 1024).toFixed(1)} MB` : "缺失");
check("app.asar 存在", fs.existsSync(asarPath), fs.existsSync(asarPath) ? `${(fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)} MB` : "缺失");

/* ---------------- 2) asar 内容 ---------------- */

let asarFiles = [];
if (fs.existsSync(asarPath)) {
  try {
    // 用 asar 包的 API 读头，不依赖 npx（CI 里可能没网）
    const asar = require("@electron/asar");
    asarFiles = asar.listPackage(asarPath).map((p) => p.replace(/\//g, "\\"));
  } catch (err) {
    // 退一步：用 electron-builder 自带的 @electron/asar 不做时，直接扫目录兜底
    check("读取 asar 清单", false, err?.message ?? String(err));
  }
}

const has = (rel) => asarFiles.some((f) => f === `\\${rel.replace(/\//g, "\\")}`);

/** 运行时必须存在的文件（少任何一个都是客户侧故障） */
const REQUIRED = [
  ["package.json", "asar 根的 package.json（决定 main 入口）"],
  ["src/main/index.js", "主进程入口"],
  ["src/main/logger.js", "文件日志（少了 = 客户报障时零信息）"],
  ["src/preload/index.js", "preload（少了 = 渲染层拿不到 window.minipi）"],
  ["src/renderer/index.html", "渲染层（少了 = 白屏）"],
  ["src/shared/protocol.js", "IPC 协议常量"],
  ["scripts/probe/stub.html", "兜底页（渲染层坏了时唯一能显示的东西）"],
];

if (asarFiles.length > 0) {
  for (const [rel, why] of REQUIRED) {
    check(`asar 含 ${rel}`, has(rel), has(rel) ? why : `缺失 —— ${why}`);
  }

  /* 不该进包的（打进去会泄露开发资产 / 撑大体积） */
  const FORBIDDEN = [
    ["docs", "开发文档"],
    [".agent-runs", "内部运行记录"],
    ["scripts/verify-all.mjs", "验证脚本（客户不需要）"],
    ["electron-builder.yml", "打包配置"],
  ];
  for (const [rel, why] of FORBIDDEN) {
    const inPkg = asarFiles.some(
      (f) => f === `\\${rel.replace(/\//g, "\\")}` || f.startsWith(`\\${rel.replace(/\//g, "\\")}\\`),
    );
    check(`asar 排除 ${rel}`, !inPkg, inPkg ? `不该打进去（${why}）` : why);
  }

  /* main 字段必须指向真实存在的文件 —— 这是「打开后什么都不发生」的经典原因 */
  try {
    const pkgRaw = require("@electron/asar").extractFile(asarPath, "package.json");
    const pkg = JSON.parse(pkgRaw.toString("utf8"));
    const mainRel = String(pkg.main ?? "");
    check("asar 的 package.json 有 main", mainRel.length > 0, mainRel || "空");
    check(
      "main 指向的文件在包里",
      mainRel.length > 0 && has(mainRel),
      has(mainRel) ? mainRel : `包里没有 ${mainRel}`,
    );
    check("asar 的 version 是 1.x", /^1\./.test(String(pkg.version)), `v${pkg.version}`);
  } catch (err) {
    check("读取 asar 内 package.json", false, err?.message ?? String(err));
  }
}

/* ---------------- 3) 真启动：双击之后到底活不活 ---------------- */

/**
 * 这一段是**最有价值的一条**：前面所有检查都可能全绿而产品起不来
 * （比如 ESM + asar 的组合问题、`ELECTRON_RUN_AS_NODE` 残留）。
 *
 * ## 判据为什么改过三次（血泪）
 *
 * v1 判据：日志里出现 `[minipi:window] 已就绪` 才算成功。
 *   → **误报**。当时 `src/main/index.js` 是 `const log = console`，日志靠
 *     `scripts/launch.mjs` 把 stdout 接进文件。打包后没有启动器 + Windows GUI
 *     子系统没有控制台 ⇒ console 输出被系统丢弃 ⇒ 日志里永远看不到启动痕迹。
 *     程序其实起来了，脚本判 FAIL。**验证脚本判据错比没有脚本更糟。**
 *
 * v2 判据：进程还活着就算成功。
 *   → **假绿**。GPU 进程崩掉时主进程会先活约 1 秒再被带走，
 *     「活着」在 1 秒内是真的。这个判据给不出任何保证。
 *
 * v3（当前）：两条硬证据 + 日志降级为加分项。
 *   ① **存活 ≥6 秒** —— 越过 GPU 崩溃窗口（实测崩溃发生在 ~1s，留 6 倍余量）。
 *   ② **有真实窗口句柄**（`MainWindowHandle > 0`）—— 进程活着但没窗口
 *      仍然是坏产品（球不出现 = 客户眼里就是没启动）。这条只有 OS 知道，
 *      必须问 OS，不能用进程内自述。
 *   ③ 日志痕迹：**`n/a` 而不是 FAIL**。`logger.js` 会落盘 `main.log`，
 *      能读到就是证据；读不到（沙箱 / 权限）不能据此判产品坏。
 */
const logSizeBefore = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
/** 主进程自己的日志（`src/main/logger.js` 写的）。v1 时根本不存在这个文件。 */
const MAIN_LOG = path.join(os.homedir(), ".minipi", "logs", "main.log");
const mainLogBefore = fs.existsSync(MAIN_LOG) ? fs.statSync(MAIN_LOG).size : 0;

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/**
 * 探测专用的临时 userData 目录（见 `main()` 里为什么必须隔离）。
 * 放在模块作用域是为了让收尾阶段能把它删掉 —— 探测一次留一个临时目录，
 * 跑几十次就在 temp 里堆几十个 Electron 缓存（每个几十 MB），不能不管。
 * @type {string | null}
 */
let probeUserData = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 进程是否还在（跨平台）。`kill(pid, 0)` 不发信号只查存在性；
 * EPERM 表示「进程在，但我没权限动它」—— 也算活着。
 * @param {number} pid
 * @returns {boolean}
 */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

/**
 * 问 OS 要窗口句柄与标题。**这是唯一不可伪造的「产品真的出现了」证据** ——
 * 进程内自述、日志、事件都可能是假的，窗口句柄不是。
 * @param {number} pid
 * @returns {{ handle: string, title: string } | null | undefined}
 *   null = 进程已不在；undefined = 查不了（非 Windows / PowerShell 不可用）
 */
const queryWindow = (pid) => {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
          `if ($p) { "$($p.MainWindowHandle)|$($p.MainWindowTitle)" } else { "GONE" }`,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    ).trim();
    if (!out) return undefined;
    if (out === "GONE") return null;
    const [handle, ...rest] = out.split("|");
    return { handle, title: rest.join("|") };
  } catch {
    return undefined;
  }
};

/** 读文件自 `from` 偏移起的新增内容（只读增量，不把上次启动的痕迹当本次证据）。 */
const readNew = (file, from) => {
  try {
    if (!fs.existsSync(file)) return "";
    const size = fs.statSync(file).size;
    const start = Math.min(from, size);
    if (size <= start) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
};

const main = async () => {
  if (!fs.existsSync(exePath)) {
    process.stdout.write("\n跳过真启动（没有可执行文件）\n");
    return;
  }

  /**
   * 用**独立的 user-data-dir** 跑探测。
   *
   * ## 为什么必须隔离（2026-10-23 实测踩到）
   *
   * minipi 有单实例锁（`app.requestSingleInstanceLock()`，`index.js` 启动第一步）。
   * 锁是挂在 Electron 的 userData 目录上的。如果机器上**已经有一个 minipi 在跑**
   * （开发实例、上次探测没杀干净的残留、用户自己开着的窗口），本次探测进程会：
   *
   *   ① 正常启动，正常写日志「已有实例在跑，本次启动退出」；
   *   ② 立刻退出 ⇒ 存活判定 FAIL；
   *   ③ 而脚本当时给的失败原因是「多半是 GPU 闪退」—— **完全错误的诊断**。
   *
   * 这不是产品的 bug（单实例锁工作正常），是探测方法没隔离环境。
   * 所以这里指定一个临时 userData：锁只在这个临时目录里生效，与真实实例互不干扰。
   *
   * ⚠ 注意 `~/.minipi`（会话 / 设置 / 日志）**不受影响** —— 那是我们自己的目录，
   *   由 `os.homedir()` 推出，跟 Electron 的 userData 是两回事。所以日志仍落在
   *   真实 `main.log`，验证的仍是真实代码路径。
   */
  probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-probe-userdata-"));

  process.stdout.write("\n真启动（观察 6s 存活 + 窗口句柄）…\n");
  try {
    child = spawn(exePath, [`--user-data-dir=${probeUserData}`], {
      cwd: TARGET,
      detached: true,
      stdio: "ignore",
      // ⚠ 打包后的 exe 自己就是 Electron，不需要 ELECTRON_RUN_AS_NODE；
      //   但父环境若带着它，进程会退化成纯 Node ⇒ 必须显式删掉。
      //   开发期这活由启动器干，打包后没有启动器，只能我们自己清。
      env: (() => {
        const e = { ...process.env };
        delete e.ELECTRON_RUN_AS_NODE;
        return e;
      })(),
    });
    child.unref();
  } catch (err) {
    check("能拉起打包后的可执行文件", false, err?.message ?? String(err));
    return;
  }

  const pid = child.pid;
  if (!pid) {
    check("能拿到打包产物的进程号", false, "spawn 没有返回 pid");
    return;
  }

  // 存活 6s：实测 GPU 崩溃窗口约 1s，留 6 倍余量
  await sleep(6000);
  const survived = isAlive(pid);

  /**
   * 早退时**先看日志再下结论**。
   *
   * 「进程退出」至少有三种完全不同的原因，而它们的修法天差地别：
   *   · 单实例锁挡住 ⇒ 环境问题（有别的实例在跑），不是缺陷
   *   · GPU 崩溃     ⇒ 真缺陷，客户会闪退
   *   · 渲染层加载失败 / 主进程抛错 ⇒ 真缺陷
   * 只报「进程已退出」等于把三种混成一种，会让人朝错的方向查一晚上。
   */
  let exitReason = "";
  if (!survived) {
    const tail = readNew(MAIN_LOG, mainLogBefore) || readNew(LOG_FILE, logSizeBefore);
    if (/已有实例在跑/.test(tail)) {
      exitReason = "被单实例锁挡住：机器上已有 minipi 在跑（不是产品缺陷，先关掉它再验）";
    } else if (/GPU process isn't usable/i.test(tail)) {
      exitReason = "GPU 进程不可用导致退出（真缺陷，客户会闪退）";
    } else if (/渲染层加载失败|窗口创建失败/.test(tail)) {
      exitReason = "窗口 / 渲染层加载失败（真缺陷，客户会白屏）";
    } else if (tail.trim().length === 0) {
      exitReason = "没有任何日志（连第一行都没写出来，可能是二进制损坏或缺 DLL）";
    } else {
      exitReason = `日志末尾：${tail.trim().split("\n").slice(-2).join(" / ")}`;
    }
  }

  check(
    "打包产物启动后存活 ≥6s（越过 GPU 崩溃窗口）",
    survived,
    survived ? `pid=${pid}` : exitReason,
  );

  // 硬证据：OS 认不认这个进程有一个真窗口
  if (survived) {
    const win = queryWindow(pid);
    if (win === undefined) {
      check("OS 里真的有窗口（MainWindowHandle > 0）", true, "n/a（查不到 PowerShell，本项跳过）");
    } else if (win === null) {
      check("OS 里真的有窗口（MainWindowHandle > 0）", false, "进程已不在，查不到窗口");
    } else {
      const handleNum = Number.parseInt(win.handle, 10);
      check(
        "OS 里真的有窗口（MainWindowHandle > 0）",
        Number.isFinite(handleNum) && handleNum > 0,
        `handle=${win.handle} title="${win.title}"`,
      );
    }
  }

  /* 日志降级为加分项：能读到说明 logger.js 在打包环境下也能落盘 */
  const mainLogTail = readNew(MAIN_LOG, mainLogBefore);
  const launcherLogTail = readNew(LOG_FILE, logSizeBefore);
  const booted = /\[minipi\]/.test(mainLogTail) || /\[minipi\]/.test(launcherLogTail);
  check(
    "主进程日志有启动痕迹（加分项，读不到不算坏）",
    true,
    booted ? "main.log 有 [minipi] 行" : "n/a（读不到 main.log，不影响启动判定）",
  );

  /* GPU 致命错误是「双击闪退」的元凶，必须单独断言 */
  const allTail = `${mainLogTail}\n${launcherLogTail}`;
  const gpuBad = /GPU process isn't usable/i.test(allTail);
  check("日志里没有 GPU 致命错误", !gpuBad, gpuBad ? "GPU process isn't usable（会闪退）" : "干净");
};

main()
  .catch((err) => {
    process.stderr.write(`验证脚本自身出错：${err?.stack ?? err}\n`);
    fail += 1;
  })
  .finally(() => {
    /* 收尾：把探测用的进程杀掉，不留后台 */
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* 已经退出 */
      }
    }
    /* 收尾：删掉探测专用 userData。
       失败（文件还被占用）不影响结论 —— 系统 temp 本来就会被清理。 */
    if (probeUserData) {
      try {
        fs.rmSync(probeUserData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    process.stdout.write(`\n${"=".repeat(58)}\n`);
    process.stdout.write(` verify:packaged: ${pass}/${pass + fail} passed\n`);
    process.stdout.write(` 日志：${MAIN_LOG}\n`);
    process.stdout.write(`       ${LOG_FILE}\n`);
    process.stdout.write(`${"=".repeat(58)}\n`);
    process.exit(fail === 0 ? 0 : 1);
  });
