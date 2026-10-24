#!/usr/bin/env node
/**
 * QA · 大窗布局（T2 规格 §4）。
 *
 * 守五条可量化的：
 *   ① 内容列 **672 ± 2**（对话列 ≥ 720）
 *   ② 会话栏 **208**
 *   ③ 右栏是**抽屉**：默认收起、开合**不改变对话列宽度**、不产生横向滚动
 *   ④ 大窗助手消息**去气泡**（无底色 / 无描边）
 *   ⑤ 360 宽（mini）无横向滚动
 *
 * 为什么量计算样式而不是看截图：这些是**数值验收标准**（spec §1.4），
 * 截图只能"看着像"，量出来才能守住回归。
 *
 * 运行：`node scripts/qa-layout.mjs`。无 Chrome 时全部记「未测到」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9391;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-layout-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}${extra ? `  · ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? `  · ${extra}` : ""}`);
  }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);

console.log("======================================================================");
console.log(" QA · 大窗布局（T2）");
console.log("======================================================================");

/* ---------------------------------------------------------------- 静态 */
const html = fs.readFileSync(HTML_PATH, "utf8");
group("[A] 静态审查：关键数值与结构");
ok(/height:46px/.test(html), "大窗头部 46px");
ok(/\.full__col--sessions\{ width:208px/.test(html), "会话栏 208px");
ok(/\.full__col--side\{[\s\S]{0,200}position:absolute/.test(html), "右栏是绝对定位（抽屉，不占栅格）");
ok(/width:264px/.test(html), "抽屉宽 264px");
ok(/\.full__col--tree \.tree\{ max-width:672px; margin:0 auto; \}/.test(html), "内容列 672 居中");
ok(/\.full \.msg--pi \.pibody\{[\s\S]{0,160}background:none; border:0;/.test(html), "大窗助手去气泡（无底色无描边）");
ok(/id="btnDrawer"/.test(html), "头部有抽屉开关");
ok(/data-open="false"/.test(html), "抽屉默认收起");

/* ---------------------------------------------------------------- Chrome */
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].filter(Boolean).find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

let chrome = null;
let conn = null;
const cdpTargets = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("找不到 CDP page target");
};
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          id += 1;
          const mid = id;
          return new Promise((res, rej) => {
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", reject);
  });
}
async function evaluate(expr) {
  const r = await conn.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
  }
  return r.result.value;
}

if (!CHROME) {
  ok(false, "本机无 Chrome → 布局数值未测到（不伪绿）");
} else {
  ok(true, `找到 Chrome：${CHROME}`);
  try {
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--window-size=1000,760",
        "--allow-file-access-from-files",
        `file:///${HTML_PATH.replace(/\\/g, "/")}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    conn = await connect((await cdpTargets()).webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1600);
    ok((await evaluate("window.__minipi ? window.__minipi.mock() : null")) === true, "mock 探针就绪");

    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(400);

    group("[B] 数值验收：208 / 672 / 46");
    const m1 = await evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      const r = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
      const col = q('.full__col--tree');
      const inner = col ? col.getBoundingClientRect().width : 0;
      const tree = q('#fullTree');
      const treeW = tree ? Math.round(tree.getBoundingClientRect().width) : 0;
      const scroll = col ? col.scrollWidth - Math.round(col.clientWidth) : 0;
      return {
        sessions: r('.full__col--sessions'),
        head: r('.full__head'),
        colWidth: Math.round(inner),
        treeWidth: treeW,
        hScroll: scroll,
      };
    })()`);
    ok(m1.sessions && m1.sessions.w === 208, "会话栏宽 208", String(m1.sessions?.w));
    ok(m1.head && m1.head.h === 46, "头部高 46", String(m1.head?.h));
    ok(m1.colWidth >= 720, "★ 对话列 ≥ 720", `${m1.colWidth}px`);
    ok(Math.abs(m1.treeWidth - 672) <= 2, "★ 内容列 672 ± 2", `${m1.treeWidth}px`);
    ok(m1.hScroll <= 0, "对话列无横向滚动", `溢出 ${m1.hScroll}px`);

    group("[C] 抽屉：默认收起 / 开合不挤压 / Esc 可关");
    const closed = await evaluate(`(() => {
      const s = document.querySelector('#fullSide');
      const b = s.getBoundingClientRect();
      const col = document.querySelector('.full__col--tree').getBoundingClientRect().width;
      return { open: s.getAttribute('data-open'), opacity: getComputedStyle(s).opacity, x: Math.round(b.x), col: Math.round(col) };
    })()`);
    ok(closed.open === "false", "默认 data-open=false");
    ok(Number(closed.opacity) === 0, "收起时不可见（opacity 0）", closed.opacity);

    await evaluate("document.querySelector('#btnDrawer').click()");
    await sleep(400);
    const opened = await evaluate(`(() => {
      const s = document.querySelector('#fullSide');
      const b = s.getBoundingClientRect();
      const col = document.querySelector('.full__col--tree').getBoundingClientRect().width;
      const full = document.querySelector('.full').getBoundingClientRect();
      return {
        open: s.getAttribute('data-open'),
        opacity: getComputedStyle(s).opacity,
        w: Math.round(b.width),
        inView: b.right <= full.right + 1 && b.left >= full.left - 1,
        col: Math.round(col),
        aria: document.querySelector('#btnDrawer').getAttribute('aria-pressed'),
      };
    })()`);
    ok(opened.open === "true", "点 ☰ 后展开");
    ok(Number(opened.opacity) === 1, "展开后可见");
    ok(opened.w === 264, "抽屉宽 264", String(opened.w));
    ok(opened.inView === true, "抽屉完整落在窗口内（不越界）");
    ok(opened.col === m1.colWidth, "★ 开合**不改变**对话列宽度（不挤压）", `${opened.col} vs ${m1.colWidth}`);
    ok(opened.aria === "true", "开关 aria-pressed=true");

    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    ok((await evaluate("document.querySelector('#fullSide').getAttribute('data-open')")) === "false", "Esc 关闭抽屉");

    group("[D] 大窗助手去气泡");
    await evaluate(`(() => {
      const e = document.querySelector('#fullInput');
      e.value = '布局验收：助手正文不应有气泡底';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnSendFull').click();
      return true;
    })()`);
    for (let i = 0; i < 24; i += 1) {
      const idle = await evaluate("(() => { const b = document.querySelector('#btnAbortFull'); return !b || b.disabled === true; })()");
      const len = await evaluate("(document.querySelector('#fullTree') || {textContent:''}).textContent.trim().length");
      if (idle && len > 40) break;
      await sleep(500);
    }
    const pi = await evaluate(`(() => {
      const el = document.querySelector('#fullTree .msg--pi .pibody');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, borderW: cs.borderTopWidth, borderStyle: cs.borderTopStyle, maxW: cs.maxWidth };
    })()`);
    ok(Boolean(pi), "大窗里有助手正文节点");
    ok(pi && (pi.bg === "rgba(0, 0, 0, 0)" || pi.bg === "transparent"), "★ 助手正文无底色", String(pi?.bg));
    ok(pi && (pi.borderW === "0px" || pi.borderStyle === "none"), "★ 助手正文无描边", `${pi?.borderW} ${pi?.borderStyle}`);

    group("[E] mini 360 宽无横向滚动");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await sleep(400);
    const mini = await evaluate(`(() => {
      const m = document.querySelector('.mini');
      const body = document.querySelector('#miniBody');
      return {
        miniW: m ? Math.round(m.getBoundingClientRect().width) : 0,
        bodyOverflow: body ? body.scrollWidth - Math.round(body.clientWidth) : 0,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    ok(mini.miniW > 0 && mini.miniW <= 360, "mini 宽 360", String(mini.miniW));
    ok(mini.bodyOverflow <= 0, "小窗对话区无横向滚动", `溢出 ${mini.bodyOverflow}px`);
    ok(mini.docOverflow <= 0, "整页无横向滚动", `溢出 ${mini.docOverflow}px`);
  } catch (err) {
    ok(false, `行为断言执行异常：${err?.message ?? err}`);
  } finally {
    try {
      conn?.close?.();
    } catch {
      /* ignore */
    }
    try {
      if (chrome) process.kill(-chrome.pid);
    } catch {
      try {
        chrome?.kill?.();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log("\n======================================================================");
console.log(` 通过 ${passed} 项 · 失败 ${failed} 项`);
console.log(" 覆盖边界：量计算样式与几何；不覆盖真窗口 960×680 的物理约束（mock stage 固定同尺寸）、不覆盖 18 组截图矩阵。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
