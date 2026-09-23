'use strict';
/* 通用小工具：sleep / 事件等待 / 截图落盘 / 参数解析 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 等一个 Electron 事件（带超时，超时返回 false 而不是抛错） */
export function once(emitter, event, timeoutMs = 3000) {
  return new Promise(resolve => {
    let done = false;
    const on = (...args) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      emitter.removeListener(event, on);
      resolve({ ok: true, args });
    };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      emitter.removeListener(event, on);
      resolve({ ok: false, args: [] });
    }, timeoutMs);
    emitter.once(event, on);
  });
}

/** 等窗口完成一次真实重绘（两帧 rAF），比 sleep 更贴近「用户看见新尺寸」的时刻 */
export async function waitForRepaint(webContents, budgetMs = 2500) {
  const code = 'new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(true);});});})';
  try {
    await Promise.race([webContents.executeJavaScript(code, true), sleep(budgetMs)]);
    return true;
  } catch {
    return false;
  }
}

/** 写 PNG 截图并返回文件名；失败返回 null（截图不该让整轮 spike 挂掉） */
export async function saveShot(image, outDir, name) {
  try {
    if (!image || image.isEmpty()) return null;
    await fs.writeFile(path.join(outDir, name), image.toPNG());
    return name;
  } catch {
    return null;
  }
}

/** 语义化版本比较：a >= b ? 1 : -1（只看前三段数字） */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** 极简参数解析： --out dir  --sec 3  --skip-visual */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'skip-visual' || key === 'online') { out[key] = true; continue; }
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = val;
  }
  return out;
}

export function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}
