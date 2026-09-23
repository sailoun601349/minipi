/**
 * 宿主层自测套件（Electron 侧）。
 *
 * 跑法：`npm run selftest`（内部是 `node scripts/start.mjs --selftest`，会先清 ELECTRON_RUN_AS_NODE）。
 *
 * 它**跑的是真实宿主层代码**（`src/main/window.js` / `src/main/index.js` 的 IPC 路由 /
 * `src/main/pi/session.js`），不是另写一套假窗口 —— 这样结论才对得上交付物。
 *
 * 覆盖：
 *   T0  preload / contextBridge 是否真的把 window.minipi 注进来，invoke 往返是否通
 *   T1  三态变形：请求尺寸 vs `getBounds()` 实测值、耗时（**不依赖 resize 事件**）
 *   T2  未聚焦 / 被遮挡时渲染是否还在跑（M0-3/M0-4 硬指标：backgroundThrottling:false）
 *   T3  契约与入参校验：非法 state / sceneId / sessionId / text / behavior 是否给可读错误
 *
 * 产物：`scripts/out/selftest.json`（机器可读）+ `scripts/out/selftest.txt`（给人读）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, screen } from "electron";

import { EVENTS, INVOKE } from "../../src/shared/protocol.js";
import { SettingsStore } from "../../src/main/settings.js";
import { FALLBACK_ENTRY, PRELOAD_PATH, WindowManager } from "../../src/main/window.js";
import { PiSessionHost } from "../../src/main/pi/session.js";
// 走**真实的** IPC 路由实现（不是测试里另写一套）
import { registerIpc } from "../../src/main/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, "scripts", "out");

const HARD_TIMEOUT_MS = 240_000;
const THROTTLE_SEC = 3;
const SIZES = { ball: [48, 48], mini: [360, 480], full: [960, 680] };

const report = {
  tool: "minipi-selftest-host",
  startedAt: new Date().toISOString(),
  env: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    osRelease: os.release(),
    windowsVersion: typeof process.getSystemVersion === "function" ? process.getSystemVersion() : null,
    displays: [],
    cursorPoint: null,
    primaryWorkArea: null,
  },
  tests: {},
  summary: {},
  errors: [],
  finishedAt: null,
};

const extraWindows = [];
function track(win) {
  extraWindows.push(win);
  return win;
}
function err(at, e) {
  report.errors.push({ at, message: String(e?.message ?? e) });
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 人工读的纯文本摘要。 */
const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}

/* ========================================================================== */

let wm = null;
let pi = null;
let finished = false;

async function finish(code) {
  if (finished) return;
  finished = true;
  try {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      preloadExposesMinipi: report.tests.T0?.exposesMinipi ?? null,
      invokeRoundTripOk: report.tests.T0?.invokeOk ?? null,
      morphAllStatesMatchRequest: report.tests.T1?.allMatch ?? null,
      morphTotalMs: report.tests.T1?.totalMs ?? null,
      throttleKeepsPaintingWhenOccluded: report.tests.T2?.occluded?.paintsWhenHidden ?? null,
      throttleControlProblemReal: report.tests.T2?.control?.throttleProblemReal ?? null,
      throttleControlFixWorks: report.tests.T2?.control?.fixWorks ?? null,
      throttlingGetter: report.tests.T2?.throttlingGetter ?? null,
      validationAllRejected: report.tests.T3?.allRejected ?? null,
      untrustedSenderRejected: report.tests.T3?.untrustedRejected ?? null,
      settingsStoreRobust: report.tests.T4?.allOk ?? null,
      errors: report.errors.length,
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "selftest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary();
    fs.writeFileSync(path.join(OUT_DIR, "selftest.txt"), `${lines.join("\n")}\n`, "utf8");
  } catch (e) {
    console.error("[selftest] 写报告失败：", e);
  } finally {
    for (const w of extraWindows.splice(0)) {
      try {
        if (!w.isDestroyed()) w.destroy();
      } catch {
        /* ignore */
      }
    }
    try {
      pi?.disposeAll();
    } catch {
      /* ignore */
    }
    try {
      wm?.destroy();
    } catch {
      /* ignore */
    }
    app.exit(code);
  }
}

function printSummary() {
  say("");
  say("=".repeat(74));
  say(" minipi 宿主层自测");
  say("=".repeat(74));
  const mark = (v) => (v === true ? "PASS" : v === false ? "FAIL" : "n/a ");
  say(` [T0] preload 暴露 window.minipi        : ${mark(report.summary.preloadExposesMinipi)}`);
  say(` [T0] invoke 往返                      : ${mark(report.summary.invokeRoundTripOk)}`);
  say(` [T1] 三态变形尺寸全部命中请求值        : ${mark(report.summary.morphAllStatesMatchRequest)}`);
  say(` [T2] 被遮挡/未聚焦仍在画              : ${mark(report.summary.throttleKeepsPaintingWhenOccluded)}`);
  say(` [T3] 非法入参全部被拒                 : ${mark(report.summary.validationAllRejected)}`);
  say(` [T3] 越权（非主窗口）调用被拒          : ${mark(report.summary.untrustedSenderRejected)}`);
  say(` [T4] 设置存储健壮性                   : ${mark(report.summary.settingsStoreRobust)}`);
  say(` 错误 ${report.errors.length} 条`);
  say("=".repeat(74));
}

/* ========================================================================== *
 * T0 · preload / contextBridge / invoke 往返
 * ========================================================================== */
async function testPreload() {
  const t = { name: "T0 preload 与 invoke 往返" };
  const wc = wm.webContents;

  // 等页面脚本跑完（stub 是同步脚本，did-finish-load 后必然已执行）
  await delay(300);

  t.exposesMinipi = await wc.executeJavaScript("typeof window.minipi === 'object' && window.minipi !== null");
  t.apiKeys = await wc.executeJavaScript("Object.keys(window.minipi).sort()");
  t.expectedKeys = [
    "abort",
    "createSession",
    "getSettings",
    "onEvent",
    "onHotkey",
    "onWindowState",
    "prompt",
    "quit",
    "sessionState",
    "setSettings",
    "setWindowState",
  ];
  t.keysMatch = JSON.stringify(t.apiKeys) === JSON.stringify(t.expectedKeys);

  // 真实 invoke 往返（走 ipcRenderer.invoke → ipcMain.handle → SettingsStore）
  t.settingsFromRenderer = await wc.executeJavaScript("window.minipi.getSettings()");
  t.invokeOk = !!t.settingsFromRenderer && typeof t.settingsFromRenderer.sceneId === "string";

  // 主 → 渲染的推送通道：直接发一条假事件，看渲染层收没收到
  const sendOk = wm.sendToRenderer(EVENTS.EVENT, {
    seq: 1,
    sessionId: "s_probe",
    ts: Date.now(),
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
  });
  await delay(150);
  const recv = await wc.executeJavaScript("window.__hostProbe");
  t.pushDelivered = sendOk && recv?.events >= 1;
  t.rendererRecorder = recv;

  // onWindowState 在 did-finish-load 时补推过
  t.windowStatePushedOnLoad = Array.isArray(recv?.windowState) && recv.windowState.length >= 1;

  t.usingFallbackRenderer = wm.usingFallbackRenderer;
  t.ok = t.exposesMinipi && t.invokeOk && t.pushDelivered;
  return t;
}

/* ========================================================================== *
 * T1 · 三态变形
 * ========================================================================== */
async function testMorph() {
  const t = { name: "T1 单窗口三态变形", steps: [], allMatch: true, totalMs: 0 };

  const sequence = [
    ["mini", "ball → mini"],
    ["full", "mini → full"],
    ["ball", "full → ball"],
    ["mini", "ball → mini（回到起点，验证可往复）"],
    ["ball", "mini → ball（收尾）"],
  ];

  for (const [state, label] of sequence) {
    const requested = wm.computeBounds(state);
    const t0 = Date.now();
    const result = await wm.setState(state);
    const ms = Date.now() - t0;
    const [wantW, wantH] = SIZES[state];
    const okW = Math.abs(result.bounds.width - wantW) <= 2;
    const okH = Math.abs(result.bounds.height - wantH) <= 2;
    const match = okW && okH && result.ok === true;
    t.totalMs += ms;
    if (!match) t.allMatch = false;
    t.steps.push({
      label,
      state,
      requested,
      actual: result.bounds,
      ok: result.ok,
      match,
      ms,
      delta: { w: result.bounds.width - wantW, h: result.bounds.height - wantH },
    });
    say(
      ` T1 ${label.padEnd(30, " ")} 请求 ${wantW}×${wantH} → 实测 ${result.bounds.width}×${result.bounds.height}` +
        ` @(${result.bounds.x},${result.bounds.y})  ${String(ms).padStart(4)}ms  ${match ? "OK" : "MISMATCH"}`,
    );
    await delay(120);
  }
  return t;
}

/* ========================================================================== *
 * T2 · 未聚焦 / 被遮挡时渲染是否还在跑（M0-3 / M0-4）
 * ========================================================================== */
async function testThrottle() {
  const t = { name: "T2 backgroundThrottling:false 的 M0 硬指标" };

  t.constructorOption = {
    // 从 window.js 的构造参数里读不回来，这里改成读 webContents 的 getter
    getBackgroundThrottling: null,
  };
  try {
    t.constructorOption.getBackgroundThrottling = wm.webContents.getBackgroundThrottling();
  } catch (e) {
    err("T2.getBackgroundThrottling", e);
  }
  t.throttlingGetter = t.constructorOption.getBackgroundThrottling;

  await wm.setState("mini");
  const b = wm.window.getBounds();
  const probeRect = { x: b.x, y: b.y, width: b.width, height: b.height };

  async function measure(label, { occlude, stealFocus }) {
    // 先归零计数
    await wm.webContents.executeJavaScript("window.__probeReset()");
    let occluder = null;
    let stealer = null;
    try {
      if (occlude) {
        occluder = track(
          new BrowserWindow({
            ...probeRect,
            frame: false,
            transparent: false,
            resizable: false,
            hasShadow: false,
            skipTaskbar: true,
            show: false,
            backgroundColor: "#3A2C05",
            webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
          }),
        );
        await occluder.loadURL(
          "data:text/html;charset=utf-8," + encodeURIComponent("<body style='margin:0;background:#3A2C05'></body>"),
        );
        occluder.setAlwaysOnTop(true, "screen-saver");
        occluder.show();
      }
      if (stealFocus) {
        stealer = track(
          new BrowserWindow({
            x: probeRect.x + 8,
            y: probeRect.y + probeRect.height + 24,
            width: 320,
            height: 120,
            frame: true,
            resizable: false,
            alwaysOnTop: false,
            show: false,
            backgroundColor: "#202A36",
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          }),
        );
        await stealer.loadURL(
          "data:text/html;charset=utf-8," + encodeURIComponent("<body style='margin:0;background:#202A36'></body>"),
        );
        stealer.show();
        stealer.focus();
      }
      if (occluder) occluder.focus();

      await delay(700);
      // 归零要在遮挡/失焦稳定之后
      await wm.webContents.executeJavaScript("window.__probeReset()");
      await delay(THROTTLE_SEC * 1000);
      const read = await wm.webContents.executeJavaScript("window.__probeRead()");
      const perSec = read.elapsedMs > 0 ? Number(((read.raf / read.elapsedMs) * 1000).toFixed(1)) : null;
      return { label, ...read, rafPerSec: perSec, intervalPerSec: Number(((read.interval / read.elapsedMs) * 1000).toFixed(1)) };
    } finally {
      for (const w of [occluder, stealer]) {
        try {
          w?.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    t.visibleFocused = await measure("可见 + 聚焦", { occlude: false, stealFocus: false });
    t.visibleUnfocused = await measure("可见 + 未聚焦", { occlude: false, stealFocus: true });
    t.occluded = await measure("被遮挡 + 未聚焦", { occlude: true, stealFocus: true });
  } catch (e) {
    err("T2.measure", e);
  }

  t.occluded.paintsWhenHidden = t.occluded.rafPerSec !== null && t.occluded.rafPerSec > 5;
  t.verdict =
    t.occluded.paintsWhenHidden === true
      ? "PASS：被遮挡 + 未聚焦时 rAF 仍在全速跑（backgroundThrottling:false 生效）"
      : t.occluded.paintsWhenHidden === false
        ? "FAIL：被遮挡时 rAF 掉到 ~0 ⇒ M0 硬指标不成立"
        : "无法判定";

  const f = (r) => (r ? `raf=${r.raf} (${r.rafPerSec}/s) interval=${r.interval} (${r.intervalPerSec}/s) visibility=${r.visibilityState} focus=${r.hasFocus}` : "n/a");
  say(` T2 可见+聚焦        ${f(t.visibleFocused)}`);
  say(` T2 可见+未聚焦      ${f(t.visibleUnfocused)}`);
  say(` T2 被遮挡+未聚焦    ${f(t.occluded)}`);

  /* --- 控制组 ---
     我们的真实窗口是 transparent，Chromium 似乎不对透明窗做「遮挡」判定
     （上面三次测量的 visibilityState 恒为 visible ⇒ 遮挡没被记账）。
     所以再拉一对**非透明**探针窗（bt=false / bt=true）用同一个遮挡者压住，
     把「本机节流机制确实存在、且 backgroundThrottling:false 确实把它关掉」证明出来。 */
  try {
    t.control = await measureControlPair();
  } catch (e) {
    err("T2.control", e);
  }
  if (t.control) {
    const g = (r) => (r ? `raf=${r.raf} (${r.rafPerSec}/s) visibility=${r.visibilityState}` : "n/a");
    say(` T2[控制组·非透明] bt=false ${g(t.control.btFalse)}`);
    say(` T2[控制组·非透明] bt=true  ${g(t.control.btTrue)}`);
    t.control.throttleProblemReal =
      t.control.btTrue.rafPerSec !== null &&
      t.control.btFalse.rafPerSec !== null &&
      t.control.btTrue.rafPerSec < t.control.btFalse.rafPerSec * 0.5;
    t.control.fixWorks = t.control.btFalse.rafPerSec !== null && t.control.btFalse.rafPerSec > 5;
    say(
      ` T2[控制组] 节流问题真实存在=${t.control.throttleProblemReal} · backgroundThrottling:false 有效=${t.control.fixWorks}`,
    );
  }

  say(` T2 结论：${t.verdict}`);
  return t;
}

/**
 * 控制组：两个**非透明**探针窗（一个 bt=false、一个 bt=true），同一个不透明遮挡者压住。
 * @returns {Promise<{btFalse: object, btTrue: object, occluderVisibility: string}>}
 */
async function measureControlPair() {
  const wa = screen.getPrimaryDisplay().workArea;
  const y = Math.min(wa.y + 620, wa.y + wa.height - 220);
  const mk = (x, bt) =>
    track(
      new BrowserWindow({
        x: wa.x + x,
        y,
        width: 300,
        height: 200,
        frame: true,
        resizable: false,
        hasShadow: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: "#101820",
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: bt },
      }),
    );
  const a = mk(16, false);
  const b = mk(340, true);
  await a.loadFile(FALLBACK_ENTRY);
  await b.loadFile(FALLBACK_ENTRY);
  a.show();
  b.show();

  const occluder = track(
    new BrowserWindow({
      x: wa.x + 12,
      y: y - 4,
      width: 640,
      height: 208,
      frame: false,
      transparent: false,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#3A2C05",
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
    }),
  );
  await occluder.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent("<body style='margin:0;background:#3A2C05'></body>"),
  );
  occluder.setAlwaysOnTop(true, "screen-saver");
  occluder.show();
  occluder.focus();
  await delay(700);

  await a.webContents.executeJavaScript("window.__probeReset()");
  await b.webContents.executeJavaScript("window.__probeReset()");
  await delay(THROTTLE_SEC * 1000);
  const ra = await a.webContents.executeJavaScript("window.__probeRead()");
  const rb = await b.webContents.executeJavaScript("window.__probeRead()");
  const per = (r) => (r.elapsedMs > 0 ? Number(((r.raf / r.elapsedMs) * 1000).toFixed(1)) : null);

  for (const w of [occluder, a, b]) {
    try {
      w.destroy();
    } catch {
      /* ignore */
    }
  }
  return {
    btFalse: { ...ra, rafPerSec: per(ra) },
    btTrue: { ...rb, rafPerSec: per(rb) },
  };
}

/* ========================================================================== *
 * T3 · 契约与入参校验
 * ========================================================================== */
async function testValidation() {
  const t = { name: "T3 契约字段与入参校验", cases: [], allRejected: true };
  const wc = wm.webContents;

  /**
   * 在渲染层里跑一次 invoke，把「成功/失败 + 错误文本」捞回来。
   *
   * ⚠ `await (${expr})` 的 await **不能省**：省略时 `value` 会是一个 **Promise 对象**，
   *   `executeJavaScript` 把它回传主进程时无法结构化克隆，直接抛
   *   `An object could not be cloned.`（本机实测踩过，别改回去）。
   */
  const call = (expr) =>
    wc.executeJavaScript(
      `(async () => { try { return { ok: true, value: await (${expr}) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`,
    );

  async function expectReject(label, expr, expectCode) {
    const r = await call(expr);
    const code = r.ok ? null : String(r.error).slice(String(r.error).indexOf(":") + 1).trim();
    const hit = r.ok === false && (!expectCode || String(r.error).includes(expectCode));
    if (!hit) t.allRejected = false;
    t.cases.push({ label, expectCode, gotOk: r.ok, error: r.ok ? null : r.error, pass: hit });
    say(` T3 ${label.padEnd(34, " ")} ${hit ? "OK  " : "!!  "} ${r.ok ? "(竟然成功了)" : r.error}`);
    return r;
  }

  async function expectOk(label, expr) {
    const r = await call(expr);
    if (!r.ok) t.allRejected = false;
    t.cases.push({ label, expectCode: null, gotOk: r.ok, value: r.value ?? null, error: r.ok ? null : r.error, pass: r.ok === true });
    say(` T3 ${label.padEnd(34, " ")} ${r.ok ? "OK  " : "!!  "} ${r.ok ? JSON.stringify(r.value).slice(0, 160) : r.error}`);
    return r;
  }

  /* --- 窗口 --- */
  await expectReject("setWindowState 非法 state", `window.minipi.setWindowState({ state: 'bogus' })`, "INVALID_ARGUMENT");
  await expectOk("setWindowState → mini", `window.minipi.setWindowState({ state: 'mini' })`);
  await expectReject("setWindowState 入参非对象", `window.minipi.setWindowState('mini')`, "INVALID_ARGUMENT");

  /* --- 会话 --- */
  await expectReject("createSession 非法 sceneId", `window.minipi.createSession({ sceneId: 'nope' })`, "SCENE_NOT_FOUND");
  const created = await expectOk("createSession quick", `window.minipi.createSession({ sceneId: 'quick' })`);
  const sessionId = created?.value?.sessionId ?? null;
  t.createdSessionId = sessionId;

  // 契约字段：一个都不能少
  if (sessionId) {
    const st = await expectOk("sessionState 字段完整性", `window.minipi.sessionState({ sessionId: '${sessionId}' })`);
    const want = ["sessionId", "model", "isStreaming", "messageCount", "lastSeq", "costUsd", "sceneId", "status"];
    const got = st?.value ? Object.keys(st.value).sort() : [];
    t.sessionStateFields = { want, got, missing: want.filter((k) => !got.includes(k)), extra: got.filter((k) => !want.includes(k)) };
    if (t.sessionStateFields.missing.length > 0) t.allRejected = false;
    say(` T3 sessionState 字段              ${t.sessionStateFields.missing.length === 0 ? "OK  " : "!!  "} 缺 ${JSON.stringify(t.sessionStateFields.missing)} / 多 ${JSON.stringify(t.sessionStateFields.extra)}`);
  }

  await expectReject("sessionState 不存在 id", `window.minipi.sessionState({ sessionId: 's_99999' })`, "SESSION_NOT_FOUND");
  await expectReject("abort 不存在 id", `window.minipi.abort({ sessionId: 's_99999' })`, "SESSION_NOT_FOUND");

  /* --- prompt 入参 --- */
  await expectReject("prompt 空文本", `window.minipi.prompt({ sessionId: '${sessionId}', text: '   ' })`, "INVALID_ARGUMENT");
  await expectReject(
    "prompt 超长（40000 字符）",
    `window.minipi.prompt({ sessionId: '${sessionId}', text: 'x'.repeat(40000) })`,
    "INVALID_ARGUMENT",
  );
  await expectReject("prompt 非法 behavior", `window.minipi.prompt({ sessionId: '${sessionId}', text: 'hi', behavior: 'nope' })`, "INVALID_ARGUMENT");
  await expectReject("prompt 不存在会话", `window.minipi.prompt({ sessionId: 's_99999', text: 'hi' })`, "SESSION_NOT_FOUND");

  /* --- 设置 --- */
  await expectReject("setSettings 非法 sceneId", `window.minipi.setSettings({ sceneId: 'nope' })`, "SCENE_NOT_FOUND");
  await expectReject("setSettings 入参非对象", `window.minipi.setSettings('x')`, "INVALID_ARGUMENT");
  // 未知键被白名单丢掉（不是报错，但不能污染设置）
  await expectOk("setSettings 未知键被丢弃", `window.minipi.setSettings({ totallyUnknownKey: 1 })`);

  /* --- 白名单校验：settings 里不应出现未知键 --- */
  const after = await call(`window.minipi.getSettings()`);
  const topKeys = after?.value ? Object.keys(after.value) : [];
  t.settingsTopKeys = topKeys;
  const allowed = ["version", "sceneId", "noFocusSteal", "window"];
  const leaked = topKeys.filter((k) => !allowed.includes(k));
  if (leaked.length > 0) t.allRejected = false;
  say(` T3 设置顶层键白名单               ${leaked.length === 0 ? "OK  " : "!!  "} ${JSON.stringify(topKeys)}`);

  /* --- 越权：非主窗口的 webContents 调管理接口必须被拒 ---
     本 App 无登录态，「越权」的等价物是「不是主窗口发来的调用」。
     registerIpc 里的 assertTrustedSender() 对此返回 INTERNAL（拒绝），
     这里开一个**同样带 preload** 的旁路窗口来真打一发。 */
  try {
    const alien = track(
      new BrowserWindow({
        x: 40,
        y: 40,
        width: 320,
        height: 200,
        show: false,
        skipTaskbar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: PRELOAD_PATH },
      }),
    );
    await alien.loadFile(FALLBACK_ENTRY);
    await delay(250);
    // 这个旁路窗口里 window.minipi 是**真的注进来了**（preload 生效），所以能真打调用
    t.alienHasApi = await alien.webContents.executeJavaScript("typeof window.minipi === 'object'");
    const r = await alien.webContents.executeJavaScript(
      `(async () => { try { const v = await window.minipi.getSettings(); return { ok: true, value: v }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`,
    );
    const hit = r.ok === false && String(r.error).includes("非主窗口");
    if (!hit) t.allRejected = false;
    t.untrustedRejected = hit;
    t.cases.push({ label: "越权：非主窗口调用被拒", expectCode: "INTERNAL", gotOk: r.ok, error: r.ok ? null : r.error, pass: hit });
    say(` T3 ${"越权：非主窗口调用被拒".padEnd(30, " ")} ${hit ? "OK  " : "!!  "} ${r.ok ? "（竟然成功了）" : r.error}`);
    if (!alien.isDestroyed()) alien.destroy();
  } catch (e) {
    err("T3.untrusted", e);
  }

  return t;
}

/* ========================================================================== *
 * T4 · 设置存储健壮性（纯逻辑，不需要窗口）
 * ========================================================================== */
async function testSettingsStore() {
  const t = { name: "T4 设置存储健壮性", cases: [], allOk: true };
  const dir = path.join(os.tmpdir(), `minipi-selftest-store-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const check = (label, pass, detail) => {
    if (!pass) t.allOk = false;
    t.cases.push({ label, pass, detail });
    say(` T4 ${label.padEnd(28, " ")} ${pass ? "OK  " : "!!  "} ${detail ?? ""}`);
  };

  // 1) 首次启动：文件不存在 → 写一份默认值
  {
    const f = path.join(dir, "a.json");
    const s = new SettingsStore({ filePath: f });
    s.load();
    check("缺文件 → 生成默认值", fs.existsSync(f) && s.get().sceneId === "quick", `sceneId=${s.get().sceneId}`);
  }

  // 2) UTF-8 BOM 容错（记事本 / PowerShell -Encoding utf8 会写 BOM）
  {
    const f = path.join(dir, "bom.json");
    fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ version: 1, sceneId: "repo", noFocusSteal: true }), "utf8");
    const s = new SettingsStore({ filePath: f });
    s.load();
    check(
      "UTF-8 BOM 容错",
      s.get().sceneId === "repo" && s.get().noFocusSteal === true,
      `sceneId=${s.get().sceneId} · 警告=${s.warnings.length}`,
    );
  }

  // 3) 坏 JSON → 回退默认 + 备份 .bad（不能让 App 起不来）
  {
    const f = path.join(dir, "bad.json");
    fs.writeFileSync(f, "{ this is not json", "utf8");
    const s = new SettingsStore({ filePath: f });
    s.load();
    check("坏 JSON → 回退默认 + .bad", fs.existsSync(`${f}.bad`) && s.get().sceneId === "quick", `备份存在=${fs.existsSync(`${f}.bad`)}`);
  }

  // 4) 白名单：未知键丢弃、已知键生效
  {
    const s = new SettingsStore({ filePath: path.join(dir, "c.json") });
    s.load();
    const next = s.set({ totallyUnknownKey: 1, sceneId: "desk" });
    check("未知键丢弃 / 已知键生效", !("totallyUnknownKey" in next) && next.sceneId === "desk", `顶层键=${Object.keys(next).join(",")}`);
  }

  // 5) 越界坐标（±999999）被拒
  {
    const s = new SettingsStore({ filePath: path.join(dir, "d.json") });
    s.load();
    const p = s.set({ window: { positions: { ball: { x: 999999, y: -999999 } } } }).window.positions.ball;
    check("越界坐标被拒（null）", p === null, `ball=${JSON.stringify(p)}`);
  }

  // 6) recordPosition：合法位置落盘成功
  {
    const s = new SettingsStore({ filePath: path.join(dir, "e.json") });
    s.load();
    const changed = s.recordPosition("ball", { x: 10, y: 20 });
    check("recordPosition 落盘", changed === true && s.get().window.positions.ball?.x === 10, `changed=${changed}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return t;
}

/* ========================================================================== *
 * main
 * ========================================================================== */

app.on("window-all-closed", () => {
  /* 自己控制退出时机 */
});

process.on("uncaughtException", (e) => {
  err("uncaughtException", e);
  finish(1);
});
process.on("unhandledRejection", (e) => {
  err("unhandledRejection", e);
  finish(1);
});

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    err("timeout", new Error(`超过 ${HARD_TIMEOUT_MS}ms 未跑完`));
    finish(2);
  }, HARD_TIMEOUT_MS);
  killer.unref?.();

  try {
    report.env.displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
    try {
      report.env.cursorPoint = screen.getCursorScreenPoint();
    } catch {
      /* ignore */
    }
    report.env.primaryWorkArea = screen.getPrimaryDisplay().workArea;

    say("=".repeat(74));
    say(" minipi 宿主层自测 · 起点");
    say("=".repeat(74));
    say(` Electron ${report.env.electron} / Chrome ${report.env.chrome} / Node ${report.env.node}`);
    say(` 屏幕 ${JSON.stringify(report.env.primaryWorkArea)} dpr=${screen.getPrimaryDisplay().scaleFactor}`);

    // 用临时设置文件，别把自测结果写进用户真实设置
    const settings = new SettingsStore({
      filePath: path.join(os.tmpdir(), `minipi-selftest-settings-${process.pid}.json`),
    });
    settings.load();

    pi = new PiSessionHost({ emit: () => {}, logger: console });
    wm = new WindowManager({ settings, logger: console });

    // IPC 路由**必须在窗口加载前**注册（渲染层脚本一加载就会调 getSettings）
    registerIpc({ settings, wm, pi, log: console });

    await wm.create();
    say(` 窗口已建 · 渲染层=${wm.usingFallbackRenderer ? "兜底探针页" : "src/renderer/index.html"}`);

    report.tests.T0 = await testPreload();
    report.tests.T1 = await testMorph();
    report.tests.T2 = await testThrottle();
    report.tests.T3 = await testValidation();
    report.tests.T4 = await testSettingsStore();
  } catch (e) {
    err("main", e);
    say(`!! 主流程异常：${e?.stack ?? e}`);
  }

  clearTimeout(killer);
  await finish(report.errors.length > 0 ? 2 : 0);
});
