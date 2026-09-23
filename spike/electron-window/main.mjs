'use strict';
/* ============================================================================
   minipi 开工门禁序 7 · Electron 透明窗口 spike（ESM 主进程）
   ----------------------------------------------------------------------------
   这一个文件跑完 4 件必须实测的事，并产出：
     <out>/report.json        机器可读的完整结论（含每次采样的原始像素）
     <out>/*.png              关键节点的截图（供人眼复核）
   4 件事：
     T1  透明窗口 setBounds 是否掉透明（48×48 → 360×480 → 960×680，各记耗时）
     T2  透明窗口能否用 maximize() API（官方只禁了「系统菜单 / 双击标题栏」两条路径）
     T3  未聚焦 / 被遮挡窗口的渲染节流（backgroundThrottling true vs false）—— M0 硬指标
     T4  运行期 setBackgroundThrottling() 是否生效

   本文件本身就是「ESM 主进程」这条约束的验证物：package.json 是 "type": "module"，
   入口是 .mjs，全程只用 import，没有一处 require()。
   ============================================================================ */

import { app, BrowserWindow, screen, desktopCapturer } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { samplePixels, cornerVerdict, rgbNear } from './lib/pixels.mjs';
import { sleep, once, waitForRepaint, saveShot, parseArgs, nowMs, cmpVersion } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(__dirname, 'renderer');

const argv = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(typeof argv.out === 'string' ? argv.out : path.join(__dirname, 'out'));
const SEC = Number(argv.sec || 3) || 3;              // 每次节流测量的时长（秒）
const SKIP_VISUAL = argv['skip-visual'] === true;    // 跳过 desktopCapturer 视觉核对
const HARD_TIMEOUT_MS = Number(argv.timeout || 150000);

const SIZE = {
  ball: { width: 48, height: 48 },
  mini: { width: 360, height: 480 },
  full: { width: 960, height: 680 }
};

const report = {
  tool: 'minipi-spike-electron-window',
  version: '0.1.0',
  generatedAt: new Date().toISOString(),
  env: {},
  displays: [],
  params: { secPerMeasure: SEC, skipVisual: SKIP_VISUAL, outDir: OUT_DIR, argv },
  tests: {},
  summary: {},
  screenshots: [],
  notes: [],
  errors: []
};

const windows = [];
function track(w) { windows.push(w); return w; }
function destroyAll() {
  for (const w of windows.splice(0)) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* noop */ } }
}
function note(s) { report.notes.push(s); }
function err(tag, e) { report.errors.push({ at: tag, message: String(e && e.message || e), stack: String(e && e.stack || '') }); }

/* ------------------------------------------------------------------ 环境信息 */
function collectEnv() {
  let winVer = null;
  try { winVer = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null; } catch { /* noop */ }
  report.env = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : null,
    windowsVersion: winVer,
    nodeEngineRequired: '>=22.19.0',
    nodeEngineOk: cmpVersion(process.versions.node, '22.19.0') >= 0,
    mainProcessEsm: true,
    cpuCount: os.cpus() ? os.cpus().length : null
  };
  report.displays = screen.getAllDisplays().map(d => ({
    id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
    rotation: d.rotation, primary: d.id === screen.getPrimaryDisplay().id
  }));
}

/* ============================================================================
   T1 · 透明窗口 setBounds 是否掉透明
   ============================================================================ */
async function test1Transparency() {
  const t = { name: 'T1 透明窗口 setBounds 是否掉透明', steps: [], verdict: null };
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const origin = { x: wa.x + 40, y: wa.y + 40 };

  const ball = track(new BrowserWindow({
    x: origin.x, y: origin.y, width: SIZE.ball.width, height: SIZE.ball.height,
    frame: false,
    transparent: true,
    resizable: false,          // 官方：transparent 窗口设 resizable:true 可能失效 → 全程走程序化 setBounds
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  }));
  ball.setAlwaysOnTop(true, 'screen-saver');
  await ball.loadFile(path.join(RENDERER, 'ball.html'));
  ball.showInactive();
  await waitForRepaint(ball.webContents);
  await sleep(400);

  t.createdWith = { ...SIZE.ball, frame: false, transparent: true, resizable: false, backgroundColor: '#00000000' };

  /* 采样函数：capturePage -> 角像素 alpha */
  async function captureAndJudge(tag, shotName) {
    const img = await ball.webContents.capturePage();
    const sample = samplePixels(img);
    const verdict = cornerVerdict(sample);
    if (shotName) {
      const saved = await saveShot(img, OUT_DIR, shotName);
      if (saved) report.screenshots.push({ name: saved, what: tag });
    }
    return { verdict, sample };
  }

  /* --- 方法自检：先在静止的 48×48 上采一次 ---
     如果连「静止的透明球窗」四角都不是 alpha=0，那说明 capturePage 在本平台不保留 alpha，
     那么后面所有结论都不能用这个方法下定论 → 明确标记 methodAlphaSensitive=false。 */
  const control = await captureAndJudge('控制组：静止的 48×48 透明球窗', '01-ball-48x48.png');
  const methodAlphaSensitive = control.verdict.readable ? control.verdict.allCornersTransparent === true : false;
  t.methodControl = {
    at: '48×48 静止（未做过任何 setBounds）',
    alphaSensitive: methodAlphaSensitive,
    verdict: control.verdict
  };
  if (!methodAlphaSensitive) {
    note('capturePage 在静止的透明窗口上就采不到 alpha=0 —— 该方法在本平台不可用作透明判据，' +
      'T1 的结论需以 05-visual-check-crop.png（背板色是否透出）与人眼复核为准。');
  }

  /* --- 主序列：48×48 → 360×480 → 960×680 --- */
  const seq = [
    { label: '48×48（原地，基线）', size: SIZE.ball, shot: null },
    { label: '360×480（Mini）', size: SIZE.mini, shot: '02-mini-360x480.png' },
    { label: '960×680（Full）', size: SIZE.full, shot: '03-full-960x680.png' },
    { label: '48×48（从 960×680 缩回）', size: SIZE.ball, shot: '04-back-to-48x48.png' }
  ];

  for (const step of seq) {
    const bounds = { x: origin.x, y: origin.y, ...step.size };
    const t0 = nowMs();
    ball.setBounds(bounds, false);
    const setBoundsSyncMs = nowMs() - t0;

    const resized = await once(ball, 'resize', 2000);
    const tResize = nowMs();
    const repaintOk = await waitForRepaint(ball.webContents);
    const totalMs = nowMs() - t0;

    /* 白闪间接指标：变形后立刻采一帧中心像素（capturePage 本身要几 ms，所以只能当间接证据） */
    const tFlash0 = nowMs();
    const flashImg = await ball.webContents.capturePage();
    const flashMs = nowMs() - tFlash0;
    const flash = samplePixels(flashImg);
    const flashCenter = flash.empty ? null : flash.center;

    const { verdict, sample } = await captureAndJudge(
      `T1 · ${step.label}`, step.shot
    );

    t.steps.push({
      label: step.label,
      requested: bounds,
      setBoundsSyncMs: Number(setBoundsSyncMs.toFixed(2)),
      resizeEventFired: resized.ok,
      msToResizeEvent: Number((tResize - t0).toFixed(2)),
      repaintOk,
      totalMsToFirstRepaint: Number(totalMs.toFixed(2)),
      actualBounds: ball.getBounds(),
      cornersAllTransparent: verdict.allCornersTransparent,
      maxCornerAlpha: verdict.maxCornerAlpha,
      cornerAlphas: verdict.alphas,
      corners: verdict.corners,
      center: verdict.center,
      whiteFlashProbe: {
        sampleAfterMs: Number(flashMs.toFixed(2)),
        centerPixel: flashCenter,
        // alpha 接近满且三通道接近 255 才算「疑似一帧白」
        looksLikeOpaqueWhite: !!flashCenter && flashCenter.a > 250 && flashCenter.r > 245 &&
          flashCenter.g > 245 && flashCenter.b > 245
      }
    });
    await sleep(300);
  }

  /* --- 附带：把 resizable 打开后再 setBounds（官方警告的那条路） --- */
  try {
    ball.setResizable(true);
    await sleep(150);
    ball.setBounds({ x: origin.x, y: origin.y, width: 420, height: 520 }, false);
    await waitForRepaint(ball.webContents);
    await sleep(300);
    const withResizable = await captureAndJudge('T1 · resizable:true 后 setBounds(420×520)', null);
    t.resizableProbe = {
      tested: true,
      bounds: ball.getBounds(),
      cornersAllTransparent: withResizable.verdict.allCornersTransparent,
      maxCornerAlpha: withResizable.verdict.maxCornerAlpha,
      cornerAlphas: withResizable.verdict.alphas
    };
    ball.setResizable(false);
    ball.setBounds({ x: origin.x, y: origin.y, ...SIZE.ball }, false);
  } catch (e) { err('T1.resizableProbe', e); t.resizableProbe = { tested: false, error: String(e && e.message || e) }; }

  /* --- 视觉核对：透明球窗压在纯品红背板窗上，用桌面截图看角像素是不是品红 --- */
  if (SKIP_VISUAL) {
    t.visualBackdropCheck = { skipped: true, reason: '传入 --skip-visual' };
  } else {
    t.visualBackdropCheck = await visualBackdropCheck(ball, origin);
  }

  /* --- 结论 --- */
  const alphaSteps = t.steps.filter(s => s.cornersAllTransparent !== null);
  const survived = alphaSteps.length > 0 && alphaSteps.every(s => s.cornersAllTransparent === true);
  t.verdict = {
    transparentSurvivesSetBounds: methodAlphaSensitive ? survived : null,
    methodAlphaSensitive,
    maxCornerAlphaAcrossSteps: alphaSteps.length ? Math.max(...alphaSteps.map(s => s.maxCornerAlpha)) : null,
    msPerTransform: t.steps.map(s => ({ label: s.label, totalMsToFirstRepaint: s.totalMsToFirstRepaint, setBoundsSyncMs: s.setBoundsSyncMs })),
    resizableTrueStillTransparent: t.resizableProbe ? t.resizableProbe.cornersAllTransparent : null,
    visualBackdropShowsThrough: t.visualBackdropCheck && typeof t.visualBackdropCheck === 'object'
      ? (t.visualBackdropCheck.allCornersShowBackdrop ?? null) : null,
    howToRead: 'transparentSurvivesSetBounds===true 且 visualBackdropShowsThrough!==false ⇒ 单窗口三态方案在该平台成立。'
  };

  ball.hide();
  t.__win = ball;
  return t;
}

/* 用「纯色背板 + 桌面截图」独立核对透明（不依赖 capturePage 是否保留 alpha） */
async function visualBackdropCheck(ball, origin) {
  const out = { attempted: true };
  try {
    const bounds = { x: origin.x, y: origin.y, ...SIZE.full };
    const backdrop = track(new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: false, resizable: false, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: false, focusable: false, show: false,
      backgroundColor: '#FF00FF',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    }));
    await backdrop.loadFile(path.join(RENDERER, 'plain.html'), { query: { color: '#FF00FF', label: 'backdrop' } });
    backdrop.showInactive();

    ball.setBounds(bounds, false);
    ball.setAlwaysOnTop(true, 'screen-saver');
    ball.showInactive();
    await waitForRepaint(ball.webContents);
    await sleep(700);

    const disp = screen.getPrimaryDisplay();
    const want = {
      width: Math.round(disp.bounds.width * disp.scaleFactor),
      height: Math.round(disp.bounds.height * disp.scaleFactor)
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: want });
    if (!sources || !sources.length) throw new Error('desktopCapturer 未返回任何 screen source');
    const src = sources.find(s => String(s.display_id) === String(disp.id)) || sources[0];
    const img = src.thumbnail;
    const isz = img.getSize();
    const sx = isz.width / disp.bounds.width;
    const sy = isz.height / disp.bounds.height;

    let rect = {
      x: Math.round((bounds.x - disp.bounds.x) * sx),
      y: Math.round((bounds.y - disp.bounds.y) * sy),
      width: Math.round(bounds.width * sx),
      height: Math.round(bounds.height * sy)
    };
    rect.x = Math.max(0, Math.min(rect.x, isz.width - 1));
    rect.y = Math.max(0, Math.min(rect.y, isz.height - 1));
    rect.width = Math.max(1, Math.min(rect.width, isz.width - rect.x));
    rect.height = Math.max(1, Math.min(rect.height, isz.height - rect.y));

    const crop = img.crop(rect);
    const sample = samplePixels(crop);
    /* 只保存裁出来的那一小块（球窗区域），不保存整屏截图，避免把用户桌面整块写进文件 */
    const saved = await saveShot(crop, OUT_DIR, '05-visual-check-crop.png');
    if (saved) report.screenshots.push({ name: saved, what: 'T1 视觉核对：球窗区域的屏幕截图（背板为纯品红 #FF00FF）' });

    const magenta = { r: 255, g: 0, b: 255 };
    const corners = sample.empty ? [] : Object.keys(sample.corners).map(k => ({
      corner: k, pixel: sample.corners[k], isBackdropMagenta: rgbNear(sample.corners[k], magenta, 28)
    }));
    Object.assign(out, {
      sourceName: src.name, thumbnailSize: isz, scaleFactor: disp.scaleFactor, cropRect: rect,
      corners,
      allCornersShowBackdrop: corners.length === 4 && corners.every(c => c.isBackdropMagenta),
      conclusion: corners.length === 4 && corners.every(c => c.isBackdropMagenta)
        ? '球窗四角透出了背板的品红 ⇒ 透明完好'
        : '球窗四角没有透出品红 ⇒ 该处不透明（透明掉了，或背板没被正确压在下面）'
    });
  } catch (e) {
    err('T1.visualBackdropCheck', e);
    out.failed = true;
    out.error = String(e && e.message || e);
    out.howToReadFallback = '视觉核对失败（可能是无桌面会话 / 截图权限 / desktopCapturer 限制）。' +
      '请人工打开 03-full-960x680.png 与 05*.png 复核球窗四角是否透明。';
  }
  return out;
}

/* ============================================================================
   T2 · 透明窗口能否用 maximize() API
   ============================================================================ */
async function test2Maximize(win) {
  const t = { name: 'T2 透明窗口能否用 maximize() API' };
  const b0 = win.getBounds();
  win.show();
  await sleep(250);

  let threw = null;
  try {
    win.maximize();
  } catch (e) {
    threw = String(e && e.message || e);
  }
  await sleep(800);
  await waitForRepaint(win.webContents);
  await sleep(250);

  const after = win.getBounds();
  const disp = screen.getDisplayMatching(after);
  const wa = disp.workArea;

  let isMaximized = null, isFullScreen = null, isMinimized = null;
  try { isMaximized = win.isMaximized(); } catch (e) { isMaximized = 'throw:' + String(e && e.message || e); }
  try { isFullScreen = win.isFullScreen(); } catch (e) { isFullScreen = 'throw:' + String(e && e.message || e); }
  try { isMinimized = win.isMinimized(); } catch (e) { isMinimized = 'throw:' + String(e && e.message || e); }

  const img = await win.webContents.capturePage();
  const saved = await saveShot(img, OUT_DIR, '06-after-maximize.png');
  if (saved) report.screenshots.push({ name: saved, what: 'T2：调用 maximize() 之后的窗口截图' });
  const verdict = cornerVerdict(samplePixels(img));

  const fillsWorkArea = Math.abs(after.width - wa.width) <= 2 && Math.abs(after.height - wa.height) <= 2;
  const grew = after.width > b0.width || after.height > b0.height;

  t.result = {
    beforeBounds: b0,
    threw,
    afterBounds: after,
    workArea: wa,
    grew,
    fillsWorkArea,
    isMaximized,
    isFullScreen,
    isMinimized,
    cornersAllTransparentAfterMaximize: verdict.allCornersTransparent,
    maxCornerAlpha: verdict.maxCornerAlpha,
    verdict: threw === null && (fillsWorkArea || grew)
      ? 'maximize() 可用（未抛错且窗口确实变大）。官方只禁止「系统菜单」与「双击标题栏」两条路径，程序化 API 未禁。'
      : (threw !== null
        ? 'maximize() 抛错 ⇒ 该平台不能靠 API 最大化，Full 态要么不做最大化、要么自绘。'
        : 'maximize() 未抛错但窗口没变大 ⇒ 调用被静默忽略，等同于不可用。')
  };

  try { win.unmaximize(); } catch (e) { err('T2.unmaximize', e); }
  await sleep(500);
  t.result.boundsAfterUnmaximize = win.getBounds();
  win.hide();
  return t;
}

/* ============================================================================
   T3 · 未聚焦 / 被遮挡窗口的渲染节流（backgroundThrottling）
   ============================================================================ */
function makeProbeWindow(bounds, backgroundThrottling) {
  return track(new BrowserWindow({
    ...bounds,
    frame: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    show: false,
    backgroundColor: '#101820',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling }
  }));
}

function makeStealer(bounds) {
  return track(new BrowserWindow({
    ...bounds, frame: true, resizable: false, alwaysOnTop: false, show: false,
    backgroundColor: '#202A36',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true }
  }));
}

function makeOccluder(bounds) {
  return track(new BrowserWindow({
    ...bounds, frame: false, resizable: false, alwaysOnTop: true, show: false,
    backgroundColor: '#3A2C05',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true }
  }));
}

function getThrottling(win) {
  try {
    const wc = win.webContents;
    return typeof wc.getBackgroundThrottling === 'function' ? wc.getBackgroundThrottling() : null;
  } catch { return null; }
}

async function measureProbe(win, ms) {
  const t0 = nowMs();
  let res;
  try {
    res = await win.webContents.executeJavaScript(`window.__probeStart(${ms})`, true);
  } catch (e) {
    return { failed: true, error: String(e && e.message || e), wallMs: Number((nowMs() - t0).toFixed(1)) };
  }
  const wallMs = Number((nowMs() - t0).toFixed(1));
  let info = null;
  try { info = await win.webContents.executeJavaScript('window.__probeInfo()', true); } catch { /* noop */ }
  return {
    rafTicks: res.raf,
    interval100msTicks: res.interval,
    rafPerSec: Number((res.raf / (res.elapsedMs / 1000)).toFixed(1)),
    intervalPerSec: Number((res.interval / (res.elapsedMs / 1000)).toFixed(1)),
    pageElapsedMs: res.elapsedMs,
    wallMs,
    pageSaysHidden: res.hidden,
    pageVisibility: res.visibilityState,
    pageHasFocus: res.hasFocus,
    throttlingGetter: getThrottling(win),
    info
  };
}

async function test3Throttling() {
  const t = { name: 'T3 未聚焦 / 被遮挡窗口的渲染节流（M0 硬指标）', secPerMeasure: SEC };
  const wa = screen.getPrimaryDisplay().workArea;
  const probeBoundsA = { x: wa.x + 40, y: wa.y + 260, width: 420, height: 260 };
  const probeBoundsB = { x: wa.x + 520, y: wa.y + 260, width: 420, height: 260 };
  const stealerBounds = { x: wa.x + 40, y: wa.y + 560, width: 300, height: 120 };

  const A = makeProbeWindow(probeBoundsA, false);
  const B = makeProbeWindow(probeBoundsB, true);
  const stealer = makeStealer(stealerBounds);

  await A.loadFile(path.join(RENDERER, 'probe.html'));
  await B.loadFile(path.join(RENDERER, 'probe.html'));
  await stealer.loadFile(path.join(RENDERER, 'plain.html'), { query: { color: '#202A36', label: 'focus-stealer' } });

  A.show(); B.show(); stealer.show();
  A.setAlwaysOnTop(false); B.setAlwaysOnTop(false);
  try { app.focus({ steal: true }); } catch { /* noop */ }
  stealer.focus();
  await sleep(600);

  const occluderA = makeOccluder({ x: probeBoundsA.x - 2, y: probeBoundsA.y - 2, width: probeBoundsA.width + 4, height: probeBoundsA.height + 4 });
  const occluderB = makeOccluder({ x: probeBoundsB.x - 2, y: probeBoundsB.y - 2, width: probeBoundsB.width + 4, height: probeBoundsB.height + 4 });
  await occluderA.loadFile(path.join(RENDERER, 'plain.html'), { query: { color: '#3A2C05', label: 'occluder-A' } });
  await occluderB.loadFile(path.join(RENDERER, 'plain.html'), { query: { color: '#3A2C05', label: 'occluder-B' } });

  async function measureBoth(phase) {
    const r = {};
    for (const [key, win] of [['A_throttlingFalse', A], ['B_throttlingTrue', B]]) {
      r[key] = await measureProbe(win, SEC * 1000);
    }
    r.phase = phase;
    return r;
  }

  /* 条件一：可见但未聚焦（焦点被 stealer 拿走，两个探针都不被遮挡） */
  stealer.focus();
  await sleep(400);
  t.visibleUnfocused = await measureBoth('可见但未聚焦');

  /* 条件二：被不透明窗口完全遮挡 + 未聚焦 */
  occluderA.show();
  occluderB.show();
  occluderA.setAlwaysOnTop(true, 'screen-saver');
  occluderB.setAlwaysOnTop(true, 'screen-saver');
  occluderA.focus();
  await sleep(700);
  t.occludedUnfocused = await measureBoth('被遮挡且未聚焦');

  const shotA = await A.webContents.capturePage();
  const savedA = await saveShot(shotA, OUT_DIR, '07-probe-A-occluded.png');
  if (savedA) report.screenshots.push({ name: savedA, what: 'T3：探针 A（backgroundThrottling:false）在被遮挡条件下的截图' });

  /* 判定（不替用户下结论，只给阈值口径） */
  const cmp = (label, x, y) => ({
    label,
    throttlingFalse: x,
    throttlingTrue: y,
    ratioRaf: x && x.rafTicks != null && y && y.rafTicks != null
      ? Number((x.rafTicks / Math.max(1, y.rafTicks)).toFixed(2)) : null
  });
  t.comparison = [
    cmp('可见但未聚焦 · rAF', t.visibleUnfocused.A_throttlingFalse, t.visibleUnfocused.B_throttlingTrue),
    cmp('被遮挡且未聚焦 · rAF', t.occludedUnfocused.A_throttlingFalse, t.occludedUnfocused.B_throttlingTrue)
  ];
  t.verdict = {
    problemReal: t.occludedUnfocused.B_throttlingTrue && t.occludedUnfocused.B_throttlingTrue.rafTicks != null
      ? t.occludedUnfocused.B_throttlingTrue.rafTicks < t.occludedUnfocused.A_throttlingFalse.rafTicks * 0.5
      : null,
    fixWorks: t.occludedUnfocused.A_throttlingFalse && t.occludedUnfocused.A_throttlingFalse.rafTicks != null
      ? t.occludedUnfocused.A_throttlingFalse.rafTicks > 0
      : null,
    howToRead: '看 occludedUnfocused：B（true）的 rafTicks 远小于 A（false）⇒ 节流问题真实存在；' +
      'A 在遮挡下 rafTicks 仍接近 60×秒数 ⇒ backgroundThrottling:false 确实把「遮挡即停画」关掉了。'
  };

  occluderA.hide(); occluderB.hide();
  A.hide(); B.hide(); stealer.hide();
  t.__probeA = A;
  t.__probeB = B;
  t.__occluderA = occluderA;
  return t;
}

/* ============================================================================
   T4 · 运行期 setBackgroundThrottling() 是否生效
   ============================================================================ */
async function test4RuntimeToggle(t3) {
  const t = { name: 'T4 运行期 setBackgroundThrottling() 是否生效' };
  const A = t3.__probeA, B = t3.__probeB, occluderA = t3.__occluderA;

  t.api = {
    onWebContents: !!(A.webContents && typeof A.webContents.setBackgroundThrottling === 'function'),
    getterAvailable: typeof A.webContents.getBackgroundThrottling === 'function'
  };

  A.show();
  B.show();
  occluderA.show();
  occluderA.setAlwaysOnTop(true, 'screen-saver');
  occluderA.focus();
  await sleep(700);

  t.getterBefore = getThrottling(A);

  /* 1) 打开节流 */
  let setTrue = null;
  try { A.webContents.setBackgroundThrottling(true); setTrue = 'ok'; }
  catch (e) { setTrue = 'throw:' + String(e && e.message || e); err('T4.set(true)', e); }
  await sleep(500);
  t.afterSetTrue = {
    call: setTrue,
    getter: getThrottling(A),
    measure: await measureProbe(A, SEC * 1000)
  };

  /* 2) 关掉节流 */
  let setFalse = null;
  try { A.webContents.setBackgroundThrottling(false); setFalse = 'ok'; }
  catch (e) { setFalse = 'throw:' + String(e && e.message || e); err('T4.set(false)', e); }
  await sleep(500);
  t.afterSetFalse = {
    call: setFalse,
    getter: getThrottling(A),
    measure: await measureProbe(A, SEC * 1000)
  };

  /* 3) 与 B（构造期就是 true）对照，确认「运行期切换 」确实换了一套行为 */
  t.referenceB_throttlingTrue = await measureProbe(B, SEC * 1000);

  const a1 = t.afterSetTrue.measure.rafTicks;
  const a2 = t.afterSetFalse.measure.rafTicks;
  const b1 = t.referenceB_throttlingTrue.rafTicks;
  t.verdict = {
    runtimeToggleEffective: (a1 != null && a2 != null) ? a2 > a1 : null,
    falseMatchesConstructTimeFalse: null,
    matchesReferenceWindow: (a1 != null && b1 != null) ? (a1 <= b1 + 2) : null,
    howToRead: 'runtimeToggleEffective===true ⇒ setBackgroundThrottling() 是一等 API，可在「窗口可见时关、隐藏后开」之间来回切。',
    numbers: { a_setTrue_raf: a1, a_setFalse_raf: a2, b_constructTrue_raf: b1 }
  };

  occluderA.hide();
  return t;
}

/* ============================================================================
   主流程
   ============================================================================ */
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      T1_transparentSurvivesSetBounds: report.tests.T1?.verdict?.transparentSurvivesSetBounds ?? null,
      T1_visualBackdropShowsThrough: report.tests.T1?.verdict?.visualBackdropShowsThrough ?? null,
      T2_maximizeWorks: report.tests.T2?.result?.verdict?.startsWith('maximize() 可用') ?? null,
      T3_throttlingProblemReal: report.tests.T3?.verdict?.problemReal ?? null,
      T3_backgroundThrottlingFalseKeepsPainting: report.tests.T3?.verdict?.fixWorks ?? null,
      T4_runtimeToggleEffective: report.tests.T4?.verdict?.runtimeToggleEffective ?? null,
      errors: report.errors.length
    };
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(serialize(), null, 2), 'utf8');
    printSummary();
  } catch (e) {
    console.error('[spike] 写报告失败:', e);
  } finally {
    destroyAll();
    app.exit(code);
  }
}

/* 报告里不要塞进 Electron 的窗口对象 */
function serialize() {
  return JSON.parse(JSON.stringify(report, (k, v) => (k.startsWith('__') ? undefined : v)));
}

function printSummary() {
  const line = '-'.repeat(72);
  console.log('');
  console.log(line);
  console.log(' minipi 开工门禁序 7 · 透明窗口 spike 结果');
  console.log(line);
  console.log(' 环境 : Electron ' + report.env.electron + ' / Chrome ' + report.env.chrome +
    ' / Node ' + report.env.node + (report.env.nodeEngineOk ? '  (>=22.19 OK)' : '  (!! < 22.19)'));
  console.log(' 系统 : ' + report.env.platform + ' ' + report.env.osRelease +
    ' | WindowsVersion ' + report.env.windowsVersion);
  console.log(' 报告 : ' + path.join(OUT_DIR, 'report.json'));
  console.log(line);
  const s = report.summary || {};
  const mark = (v) => v === true ? 'PASS' : (v === false ? 'FAIL' : 'n/a ');
  console.log(' [T1] setBounds 后透明幸存        : ' + mark(s.T1_transparentSurvivesSetBounds));
  console.log(' [T1] 背板色透出（视觉核对）      : ' + mark(s.T1_visualBackdropShowsThrough));
  console.log(' [T2] maximize() 可用            : ' + mark(s.T2_maximizeWorks));
  console.log(' [T3] 未聚焦/遮挡节流问题真实存在 : ' + mark(s.T3_throttlingProblemReal));
  console.log(' [T3] backgroundThrottling:false 有效 : ' + mark(s.T3_backgroundThrottlingFalseKeepsPainting));
  console.log(' [T4] 运行期切换生效              : ' + mark(s.T4_runtimeToggleEffective));
  console.log(line);

  const st = report.tests.T1?.steps || [];
  if (st.length) {
    console.log(' T1 变形耗时（ms，到首帧重绘）:');
    for (const x of st) {
      console.log('   ' + x.label.padEnd(22, ' ') +
        ' sync=' + String(x.setBoundsSyncMs).padStart(7) +
        '  total=' + String(x.totalMsToFirstRepaint).padStart(8) +
        '  角alpha=' + JSON.stringify(x.cornerAlphas));
    }
  }
  const t3 = report.tests.T3;
  if (t3) {
    const f = (r) => r ? ('raf=' + r.rafTicks + ' interval=' + r.interval100msTicks + ' wall=' + r.wallMs + 'ms') : 'n/a';
    console.log(' T3 ' + t3.name);
    console.log('   可见未聚焦  A(bt=false) ' + f(t3.visibleUnfocused?.A_throttlingFalse));
    console.log('   可见未聚焦  B(bt=true ) ' + f(t3.visibleUnfocused?.B_throttlingTrue));
    console.log('   被遮挡      A(bt=false) ' + f(t3.occludedUnfocused?.A_throttlingFalse));
    console.log('   被遮挡      B(bt=true ) ' + f(t3.occludedUnfocused?.B_throttlingTrue));
  }
  if (report.errors.length) {
    console.log(line);
    console.log(' 错误 ' + report.errors.length + ' 条：');
    for (const e of report.errors) console.log('   @' + e.at + ' ' + e.message);
  }
  console.log(line);
  console.log(' 截图：' + (report.screenshots.map(x => x.name).join(', ') || '（无）'));
  console.log(' 解读口径见 README.md「每项结果怎么判读」；回填门禁表见 RESULT-TEMPLATE.md');
  console.log(line);
  console.log('');
}

app.on('window-all-closed', () => { /* 自己控制退出时机，绝不在这里 quit */ });

process.on('uncaughtException', (e) => { err('uncaughtException', e); finish(1); });
process.on('unhandledRejection', (e) => { err('unhandledRejection', e); finish(1); });

app.whenReady().then(async () => {
  /* 兜底超时：无论如何都要留下报告 */
  const killer = setTimeout(() => {
    err('timeout', new Error('超过 ' + HARD_TIMEOUT_MS + 'ms 未跑完，强制收尾'));
    finish(2);
  }, HARD_TIMEOUT_MS);
  killer.unref?.();

  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    collectEnv();

    const t1 = await test1Transparency();
    report.tests.T1 = t1;

    const t2 = await test2Maximize(t1.__win);
    report.tests.T2 = t2;
    t1.__win.hide();

    const t3 = await test3Throttling();
    report.tests.T3 = t3;

    const t4 = await test4RuntimeToggle(t3);
    report.tests.T4 = t4;

    note('T1 的判据是 capturePage 的四角 alpha；若 T1.methodControl.alphaSensitive 为 false，' +
      '说明该方法在本平台不保留 alpha，必须改看 visualBackdropCheck 与截图。');
    note('T3/T4 只记录次数，不下「通过/不通过」的绝对值门槛 —— 请在 RESULT-TEMPLATE.md 里按你的机器填结论。');
    note('本套件不修改任何业务代码；vendor/pi、docs/、qa/ 均未触碰。');
  } catch (e) {
    err('main', e);
  }
  clearTimeout(killer);
  await finish(report.errors.length ? 2 : 0);
});
