#!/usr/bin/env node
/**
 * **真机**验证两件只有 Electron 里才能证的事（headless Chrome 证不了）。
 *
 * ## ① 主题切换真的生效
 *
 * `qa:theme` 用 mock 的 `html[data-theme]` 验了"令牌能切"，但**真机走的是另一条路**：
 *   settings.theme → 主进程 `nativeTheme.themeSource` → 渲染层 `prefers-color-scheme` → CSS
 * 这条路上任何一节断了，界面都不会变。2026-10-20 的实际故障就在这里：
 * `SettingsStore.set()` 里还有一份逐键白名单，`theme` 不在其中，`set({theme})` 被静默丢弃，
 * 于是 `nativeTheme.themeSource` 永远收到 `system` ⇒ 用户点浅色/深色**毫无反应**。
 *
 * 本脚本证三件事：
 *   a. `SettingsStore.set({theme})` 真的落盘并能读回（**往返**，不是"调用了没报错"）；
 *   b. `nativeTheme.themeSource` 改了之后，渲染层的 `prefers-color-scheme` 与计算样式 `--bg` 真的翻转；
 *   c. 深→浅→深 能来回切（不是单向的假开关）。
 *
 * ## ② 「关于」里的 Pi 版本是真的
 *
 * 断言运行时探测出的版本 == `node_modules` 里实际安装的版本，且 `pi` 与 `pi-ai` 同线。
 * 这样"关于"页面不可能显示一个过期或编造的版本号。
 *
 * 运行：`node scripts/verify-theme-live.mjs`（需要可用的 GPU，与 selftest 同款约束）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, nativeTheme } from "electron";

import { SettingsStore } from "../src/main/settings.js";
import { getAboutInfo } from "../src/main/versions.js";
import { FALLBACK_ENTRY, PRELOAD_PATH, RENDERER_ENTRY } from "../src/main/window.js";

/* ⚠ 本机必须自己带上这颗开关：`src/main/index.js` 在 app 启动时注入 disable-gpu-sandbox，
   但本脚本是独立入口、不走那条路径 —— 不加它 GPU 进程会以 0xC0000005 反复退出，
   最终 FATAL "GPU process isn't usable. Goodbye." 把进程带走（表现为脚本中途无输出）。
   注意**不要**用 --disable-gpu：透明窗依赖 DWM 合成。 */
app.commandLine.appendSwitch("disable-gpu-sandbox");

/* ⚠ 必须给**独立的 userData 目录**：`verify:all` 里前面已经跑过别的 Electron 脚本
   （selftest / launch-live），它们共用默认 userData。两个 Electron 同时抓同一个 profile
   ⇒ 后来者拿不到 Chromium 的 profile 锁，**静默退出 1** —— 表现为"单独跑 22/22，
   进套件就 EXIT=1"（2026-10-20 就是这么翻的）。独立目录后与运行顺序无关。 */
const USER_DATA = path.join(os.tmpdir(), `minipi-theme-live-ud-${process.pid}`);
app.setPath("userData", USER_DATA);

let pass = 0;
let fail = 0;
function ok(cond, label, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? ` · ${extra}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? ` · ${extra}` : ""}`);
  }
}

const SETTINGS_FILE = path.join(os.tmpdir(), `minipi-theme-live-${process.pid}.json`);

/** 读渲染层里的关键量：媒体查询 + 令牌 + 背景色。 */
const PROBE = `(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
    bg: cs.getPropertyValue('--bg').trim(),
    surface: cs.getPropertyValue('--surface').trim(),
    theme: document.documentElement.dataset.theme || '',
  };
})()`;

app.whenReady().then(async () => {
  console.log("=".repeat(74));
  console.log(" 真机验证 · 主题切换链路 + 关于里的 Pi 版本");
  console.log("=".repeat(74));

  let win = null;
  try {
    /* ---------------------------------------------------------- ①-a 设置往返 */
    console.log("\n[1] SettingsStore 的主题往返（这是当初的故障点）");
    const store = new SettingsStore({ filePath: SETTINGS_FILE });
    store.load();
    ok(store.get().theme === "system", "默认跟随系统", store.get().theme);
    ok(store.set({ theme: "light" }).theme === "light", "★ set({theme:'light'}) 立刻读回 light");
    ok(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).theme === "light", "★ 已落盘（重启后仍生效）");
    ok(store.set({ theme: "dark" }).theme === "dark", "set({theme:'dark'}) 生效");
    ok(store.set({ theme: "purple" }).theme === "dark", "非法值被忽略，不污染原值");
    ok(store.set({ noFocusSteal: true }).theme === "dark", "改别的键不会顺手把主题冲掉");

    /* ---------------------------------------------------------- ①-b 渲染层跟随 */
    console.log("\n[2] nativeTheme → prefers-color-scheme → 令牌（真窗口）");
    nativeTheme.themeSource = "light";
    win = new BrowserWindow({
      width: 380,
      height: 520,
      show: false,
      // ⚠ 本机自建窗口必须带 sandbox:false + preload，否则 loadFile 会 ERR_FAILED 且不触发 did-fail-load
      webPreferences: { preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    const entry = fs.existsSync(RENDERER_ENTRY) ? RENDERER_ENTRY : FALLBACK_ENTRY;
    await win.loadFile(entry);
    await new Promise((r) => setTimeout(r, 350));

    const light = await win.webContents.executeJavaScript(PROBE);
    ok(light.prefersLight === true, "themeSource=light ⇒ prefers-color-scheme: light", String(light.prefersLight));
    ok(light.bg === "#f7f7f7", "浅色令牌生效 --bg", light.bg);
    ok(light.surface === "#ffffff", "浅色卡面 --surface", light.surface);
    ok(light.theme === "", "真机**不**依赖 data-theme（只靠媒体查询）", JSON.stringify(light.theme));

    nativeTheme.themeSource = "dark";
    await new Promise((r) => setTimeout(r, 350));
    const dark = await win.webContents.executeJavaScript(PROBE);
    ok(dark.prefersLight === false, "themeSource=dark ⇒ prefers-color-scheme: dark", String(dark.prefersLight));
    ok(dark.bg === "#181818", "深色令牌生效 --bg", dark.bg);
    ok(dark.bg !== light.bg && dark.surface !== light.surface, "★ 深浅两套真的不一样（不是假开关）");

    nativeTheme.themeSource = "light";
    await new Promise((r) => setTimeout(r, 350));
    const back = await win.webContents.executeJavaScript(PROBE);
    ok(back.bg === "#f7f7f7", "★ 深 → 浅 能切回来（可往复）", back.bg);

    nativeTheme.themeSource = "system";
    await new Promise((r) => setTimeout(r, 200));
    ok(nativeTheme.themeSource === "system", "能切回跟随系统");

    /* ---------------------------------------------------------- ② 关于的版本 */
    console.log("\n[3] 「关于」的版本是真的");
    const about = getAboutInfo({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    });
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(
          path.dirname(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
          "..",
          "package.json",
        ),
        "utf8",
      ),
    );
    ok(Boolean(about.pi.version), "探测到了 Pi 版本", String(about.pi.version));
    ok(about.pi.version === installed.version, "★ 探测值 == 实际安装版本（不会说谎）", `${about.pi.version} vs ${installed.version}`);
    ok(about.pi.aiVersion !== null, "探测到了 Pi 模型层版本", String(about.pi.aiVersion));
    ok(about.consistent === true, "Pi 与模型层同一发布线", `${about.pi.version} / ${about.pi.aiVersion}`);
    ok(typeof about.minipi.version === "string" && about.minipi.version.length > 0, "minipi 自身版本", String(about.minipi.version));
    ok(about.minipi.electron === process.versions.electron, "Electron 版本来自运行时", String(about.minipi.electron));
    ok(!/Users|home|C:\\\\/.test(JSON.stringify(about)), "关于信息里**没有**绝对路径（不泄露本机路径）");
  } catch (err) {
    ok(false, `执行异常：${err?.message ?? err}`);
    console.error(err);
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(SETTINGS_FILE, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log("\n" + "=".repeat(74));
  console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
  console.log(" 覆盖边界：真窗口 + 真 nativeTheme；不覆盖「点设置面板按钮」这一步（那条在 qa:theme 的 mock 里）。");
  console.log("=".repeat(74));
  app.exit(fail === 0 ? 0 : 2);
});
