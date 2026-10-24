#!/usr/bin/env node
/**
 * 真产品渲染层实拍：改造前 vs 改造后，ball / mini / full × dark / light。
 *
 * 拍的是**真产品** src/renderer/index.html（mock 模式 html[data-mock="1"]），
 * 不是设计预览 —— 这样才反映落地后的真实观感。
 *
 * 用法：
 *   node scripts/shot-compare.mjs before <file>   # 拍备份
 *   node scripts/shot-compare.mjs after  <file>   # 拍当前
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODE = process.argv[2] || "after";
const OUT = process.argv[3] || `qa/compare-${MODE}.png`;
const SRC = MODE === "before"
  ? path.resolve(".workbuddy/backup/pre-future-ui-20261021/renderer-index.html")
  : path.resolve("src/renderer/index.html");

const PORT = 9488;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-shotcmp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error("✗ 无 Chrome"); process.exit(1); }

const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1000,760",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* retry */ }
    await sleep(120);
  }
  throw new Error("no cdp target");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => res({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((r) => pending.set(i, r));
      },
      close: () => ws.close(),
    });
    ws.onerror = rej;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        if (m.error) pending.get(m.id)({ __error: m.error });
        else pending.get(m.id)(m.result);
        pending.delete(m.id);
      }
    };
  });
}

/** 截取某个选择器包围盒 */
async function shotEl(cdp, expr, out) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(expr)});
      if (!e) return null; const b = e.getBoundingClientRect();
      return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }; })()`,
    returnByValue: true,
  });
  const box = r.result && r.result.value;
  if (!box) throw new Error(`selector not found: ${expr}`);
  const s = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
    captureBeyondViewport: true,
  });
  if (!s || !s.data) throw new Error(`capture failed: ${JSON.stringify(s)}`);
  fs.writeFileSync(out, Buffer.from(s.data, "base64"));
  return box;
}

const html = fs.readFileSync(SRC, "utf8");
const tmp = path.join(os.tmpdir(), `minipi-shotcmp-${MODE}.html`);
fs.writeFileSync(tmp, html);

const t = await target();
const cdp = await connect(t.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1000, height: 760, deviceScaleFactor: 1, mobile: false,
});
await cdp.send("Page.navigate", { url: "file:///" + tmp.replace(/\\/g, "/") });
await sleep(2200);

// 打开 mock 舞台（让页面按 48/360/960 渲染）
await cdp.send("Runtime.evaluate", {
  expression: `document.documentElement.setAttribute('data-mock','1');
    const mp = document.getElementById('mockPanel');
    if (mp) mp.style.display = 'none';`,
});
await sleep(500);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const [mode, theme] of [["full", "dark"], ["full", "light"], ["mini", "dark"], ["mini", "light"], ["ball", "dark"], ["ball", "light"]]) {
  const SZ = { full: [960, 680], mini: [360, 480], ball: [48, 48] }[mode];
  // 通过 mock 控制台的按钮走真实状态机（goState → store.mode → renderMode），
  // 再用 inline style 钉住 #stage 几何（mock CSS 依赖 html[data-mode]，会被 renderMode 覆写）
  await cdp.send("Runtime.evaluate", {
    expression: `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
      const mp = document.getElementById('mockPanel');
      if (mp) mp.style.display = 'none';
      const st = document.getElementById('stage');
      if (st) { st.style.width = '${SZ[0]}px'; st.style.height = '${SZ[1]}px'; }
      for (const rid of ['ballRoot','miniRoot','fullRoot']) {
        const n = document.getElementById(rid);
        if (n) n.hidden = (rid !== '${mode}Root');
      }`,
  });
  await sleep(700);
  const out = OUT.replace(/\.png$/, `-${mode}-${theme}.png`);
  const geo = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const st = document.getElementById('stage');
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
      st.style.width = '${SZ[0]}px'; st.style.height = '${SZ[1]}px';
      for (const rid of ['ballRoot','miniRoot','fullRoot']) {
        const n = document.getElementById(rid);
        if (n) n.hidden = (rid !== '${mode}Root');
      }
      const cs = getComputedStyle(st);
      return { w: cs.width, h: cs.height, theme: document.documentElement.dataset.theme,
               roots: ['ballRoot','miniRoot','fullRoot'].map(i => i + '=' + (document.getElementById(i).hidden ? 'hid' : 'SHOW')) }; })()`,
    returnByValue: true,
  });
  await sleep(150);
  const box = await shotEl(cdp, "#stage", out);
  console.log(`  ${mode}/${theme} → ${out}  (${Math.round(box.w)}×${Math.round(box.h)})  computed=${JSON.stringify(geo.result && geo.result.value)}`);
}

cdp.close();
child.kill();
console.log("done");
