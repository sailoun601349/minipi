#!/usr/bin/env node
/**
 * QA · **每个可点的入口，点下去必须有可见结果**（headless Chrome 行为断言）。
 *
 * 为什么需要它：静态审查（按钮有没有 id / data-*）在 minipi 上是**全绿**的 ——
 * 59 个按钮全部有接线。但用户仍然遇到「菜单按钮点了没任何内容」：原因是
 *   ☰ 的 click 里 `openMenu()` 之后，事件继续冒泡到 document 的全局委托，
 *   那里 `if (!t.closest('#ballMenu')) closeMenu()` 又把菜单关了 —— 同一拍内先开后关。
 * 这类 bug **静态查不出、只有点一遍才知道**，所以单独建一条行为门禁。
 *
 * 覆盖的入口（每条都断言"可见且非空"，不是"元素存在"）：
 *   · 小窗 ☰ → 球菜单（4 项、在视口内）
 *   · 菜单项：模型设置 / 打开大窗
 *   · 小窗「文档」→ 导出 popover
 *   · 大窗「模型设置」→ 设置面板（且有提供方卡片）
 *   · 球右键 → 切小窗 + 弹菜单
 *   · Esc / 点外部 → 关闭
 *
 * 运行：`node scripts/qa-controls.mjs`。无 Chrome 时只做静态部分。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9397;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-ctl-"));
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
console.log(" QA · 无死入口（点下去必须有可见结果）");
console.log("======================================================================");

/* ---------------------------------------------------------------- A0 静态 */
group("[A0] 静态审查：overlay 的定位上下文");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const at = html.lastIndexOf('<script type="module">');
  const markup = html.slice(0, at);
  // 菜单必须是 #stage 的**兄弟**，不能在舞台里面：
  // #stage 在 mock 下带 transform，会把 position:fixed 劫持成相对定位。
  const stageStart = markup.indexOf('<div id="stage"');
  const stageEnd = markup.indexOf("\n</div>", stageStart);
  const menuAt = markup.indexOf('id="ballMenu"');
  ok(stageStart > -1 && stageEnd > -1 && menuAt > -1, "能定位 #stage 与 #ballMenu");
  ok(menuAt > stageEnd, "★ 球菜单在 #stage **之外**（否则 transform 会让 fixed 定位失效）");
  ok(/\.ballmenu\{[^}]*position:fixed/.test(html), "菜单用 fixed 定位（坐标由 JS 计算）");
  ok(/function openMenu\(anchorEl\)/.test(html), "openMenu 接收锚点（贴着触发钮展开）");
  ok(/const menuTrigger = t\.closest\('#ballMenu,#btnMiniMenu,#ball,#capMenu,#btnCap,#btnCapFull,#cmdPanel'\)/.test(html),
    "★ 点外部关闭排除触发钮（防「开了立刻被关」）");
  ok((html.match(/id="btnCap"/g) || []).length + (html.match(/id="btnCapFull"/g) || []).length === 2,
    "两态各有 `+` 能力入口");
  ok(/id="capMenu"/.test(html) && (html.match(/data-cap=/g) || []).length === 5,
    "能力菜单 5 项（3 个动作 + 2 个模式）", String((html.match(/data-cap=/g) || []).length));
  ok(/id="cmdPanel"/.test(html), "有斜杠命令面板");
  /* 令牌体检（2026-10-22 补）：**引用的令牌必须真的定义过**。
     为什么需要它：qa-theme 只查硬编码颜色、qa-future-ui 只查「新增令牌四处齐备」，
     两条都放过「var(--不存在的令牌)」——后果是整条声明作废（边框/底色静默消失），
     肉眼在深色主题下几乎看不出来。`--ico` 是 iconEl() 运行时注入的，列入白名单。 */
  {
    const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || "";
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    const runtime = new Set(["--ico"]);
    const missing = used.filter((t) => !defined.has(t) && !runtime.has(t));
    ok(missing.length === 0, "所有 var(--x) 都有定义（运行时注入的 --ico 除外）", missing.join(", ") || "0 处未定义");
  }
  ok((html.match(/class="js-web-toggle"/g) || []).length === 2, "两个输入区各有一个「联网」勾选框");
  ok(/id="webOnMini"/.test(html) && /id="webOnFull"/.test(html), "勾选框 id 齐备（小窗 / 大窗）");
  ok(!/btnWebToggle/.test(html), "设置面板里不再重复放一个开关（单一事实来源）");
  ok(/id="btnPinMini"/.test(html) && /id="btnPinFull"/.test(html), "★ 两窗各有「置顶」按钮（用户 2026-10-20）");
  ok(/id="btnMinMini"/.test(html) && /id="btnMinFull"/.test(html), "★ 两窗各有「最小化」按钮");
  ok(/class="[^"]*js-pin[^"]*"/.test(html) && /class="[^"]*js-min[^"]*"/.test(html), "置顶/最小化用统一 class 接线");
  ok(/function toggleAlwaysOnTop\(/.test(html) && /function minimizeWindow\(/.test(html), "渲染层有置顶/最小化的处理函数");
  /* mock 宿主里以方法简写暴露（`setAlwaysOnTop({ on }) {`，无冒号）；真 preload 的
     `setAlwaysOnTop: (arg) => call(...)` 在 src/preload/index.js，另读那份文件断言。 */
  ok(/setAlwaysOnTop\(\{ on \}\)/.test(html) && /minimizeWindow\(\)/.test(html), "mock 宿主暴露 setAlwaysOnTop / minimizeWindow");
  {
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload", "index.js"), "utf8");
    ok(/setAlwaysOnTop:/.test(preload) && /minimizeWindow:/.test(preload), "preload 暴露 setAlwaysOnTop / minimizeWindow");
  }
  ok(/data-ballmenu="about"/.test(html) && /id="aboutPanel"/.test(html), "球菜单有「关于」入口 + 面板");
  ok(/基于 Pi/.test(html), "关于面板显式标注「基于 Pi」");
  ok(!/v0\.87\.0/.test(html) && !/pi-coding-agent@\d/.test(html), "渲染层**没有**写死 Pi 版本号（运行时读）");
  const cmds = (html.match(/cmd: '\/[a-z]+'/g) || []).map((x) => x.slice(6, -1));
  ok(cmds.length === 5 && cmds.join(",") === "/new,/model,/theme,/export,/help", "5 个斜杠命令齐备", cmds.join(","));
}

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

async function cdpTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("找不到 CDP page target");
}
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

/** 某个 overlay 的「可见且非空」快照 —— 这是本脚本的核心判据。 */
const overlaySnap = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    exists: true,
    hidden: el.hidden,
    display: cs.display,
    visible: !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
    w: Math.round(r.width), h: Math.round(r.height),
    x: Math.round(r.x), y: Math.round(r.y),
    textLen: (el.textContent || '').trim().length,
    items: el.querySelectorAll('button,[role="menuitem"]').length,
    inViewport: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
  };
})()`;

if (!CHROME) {
  ok(false, "本机无 Chrome → 无法执行行为断言（明确「未测到」，不伪绿）");
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
        "--window-size=380,520",
        "--allow-file-access-from-files",
        `file:///${HTML_PATH.replace(/\\/g, "/")}`,
      ],
      { detached: true, stdio: "ignore" },
    );

    const page = await cdpTargets();
    conn = await connect(page.webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1500);
    const mockReady = await evaluate("window.__minipi ? window.__minipi.mock() : null");
    ok(mockReady === true, "window.__minipi 探针就绪（mock 模式）", `mock=${mockReady}`);

    /* ---------------------------------------------------------- B1 小窗 ☰ */
    group("[B1] 小窗 ☰ → 球菜单必须可见、非空、在视口内");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await sleep(250);

    const before = await evaluate(overlaySnap("#ballMenu"));
    ok(before.visible === false, "点之前菜单是隐藏的");

    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(250);
    const menu = await evaluate(overlaySnap("#ballMenu"));
    ok(menu.visible === true, "★ 点 ☰ 之后菜单**真的可见**（曾经开了立刻被关）", `w=${menu.w} h=${menu.h}`);
    ok(menu.items >= 4, "菜单里有 4 个可点项", `实得 ${menu.items}`);
    ok(menu.textLen > 8, "菜单有文字内容（不是空壳）", `${menu.textLen} 字`);
    ok(menu.inViewport === true, "菜单完整落在视口内（不会被裁掉）", `x=${menu.x} y=${menu.y} w=${menu.w} h=${menu.h}`);
    const ariaOn = await evaluate(`document.querySelector('#btnMiniMenu').getAttribute('aria-expanded')`);
    ok(ariaOn === "true", "触发钮 aria-expanded=true（可访问性状态同步）");

    /* ---------------------------------------------------------- B2 再点关 / Esc / 点外部 */
    group("[B2] 关闭路径：再点 ☰ / Esc / 点外部");
    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(200);
    ok((await evaluate(overlaySnap("#ballMenu"))).visible === false, "再点 ☰ 关闭");

    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(200);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(200);
    ok((await evaluate(overlaySnap("#ballMenu"))).visible === false, "Esc 关闭");

    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(200);
    await evaluate(`document.querySelector('#miniBody').click()`);
    await sleep(200);
    ok((await evaluate(overlaySnap("#ballMenu"))).visible === false, "点外部关闭");

    /* ---------------------------------------------------------- B3 菜单项真的有效果 */
    group("[B3] 菜单项点下去必须**有结果**（不是空点击）");
    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(200);
    await evaluate(`document.querySelector('[data-ballmenu="settings"]').click()`);
    await sleep(700);
    const panel = await evaluate(overlaySnap("#settingsPanel"));
    ok(panel.visible === true, "「模型设置」打开设置面板", `w=${panel.w} h=${panel.h}`);
    ok(panel.textLen > 40, "面板里有实际内容", `${panel.textLen} 字`);
    const provCards = await evaluate("document.querySelectorAll('#provList .provCard').length");
    ok(provCards >= 2, "面板里渲染出了提供方卡片（不是空面板）", `实得 ${provCards}`);
    await evaluate("document.querySelector('#btnSettingsClose').click()");
    await sleep(200);

    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(200);
    await evaluate(`document.querySelector('[data-ballmenu="full"]').click()`);
    await sleep(400);
    ok((await evaluate("document.body.dataset.mode")) === "full", "「打开大窗」真的切到大窗");

    /* ---------------------------------------------------------- B4 导出 popover */
    group("[B4] 「文档」→ 导出 popover 必须可见且非空");
    // 先造一条回答：让「文档」有作用对象
    await evaluate("window.__minipi.__mockCallsReset()");
    await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      el.value = '为导出准备一条回答';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnSendFull').click();
      return true;
    })()`);
    /* popover 是**懒创建**的：拿不到「最后一条已完成回答」（status !== 'streaming' 且有正文）
       就只 toast、不建 DOM。所以必须等回答真正落定。
       ⚠ 判据用「中断按钮 disabled」而不是「没有 .pulse」：`.pulse` 只在首字到达后才出现，
         用"没有 pulse"会在**刚开始流式**的那一刻误判成"已结束"（这个坑刚踩过）。 */
    let settled = false;
    for (let i = 0; i < 24; i += 1) {
      const done = await evaluate(`(() => {
        const turns = (window.__minipi.turns && window.__minipi.turns()) || 0;
        const abort = document.querySelector('#btnAbortFull');
        const idle = !abort || abort.disabled === true;
        const len = (document.querySelector('#fullTree') || { textContent: '' }).textContent.trim().length;
        return turns >= 1 && idle && len > 40;
      })()`);
      if (done) { settled = true; break; }
      await sleep(500);
    }
    ok(settled === true, "回答已落定（导出入口才有作用对象）");

    await evaluate("document.querySelector('#btnOutcomeFullFoot').click()");
    await sleep(500);
    const pop = await evaluate(overlaySnap("#exportPop"));
    ok(pop.exists === true, "导出 popover 元素存在");
    ok(pop.visible === true, "★ 点「文档」后 popover 可见", `w=${pop.w} h=${pop.h}`);
    ok(pop.textLen > 10, "popover 里有内容（格式选项 / 说明）", `${pop.textLen} 字`);
    const fmtBtns = await evaluate(`[...document.querySelectorAll('#exportPop [data-export-format],#exportPop button')].map(b=>b.textContent.trim()).filter(Boolean).length`);
    ok(fmtBtns >= 2, "popover 里有可选格式", `实得 ${fmtBtns} 个按钮`);

    /* ---------------------------------------------------------- B5 大窗设置入口 */
    group("[B5] 大窗「模型设置」按钮");
    await evaluate("document.querySelector('#btnSettings').click()");
    await sleep(700);
    const panel2 = await evaluate(overlaySnap("#settingsPanel"));
    ok(panel2.visible === true, "大窗的「模型设置」也能打开面板", `w=${panel2.w} h=${panel2.h}`);
    ok(panel2.textLen > 40, "面板有内容", `${panel2.textLen} 字`);
    /* ---------------------------------------------------------- 联网开关 */
    group("[B5b] 输入区下方「联网」勾选框：默认开、勾一下同步两处");
    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(400);
    const web0 = await evaluate(`(() => {
      const a = document.querySelector('#webOnMini');
      const b = document.querySelector('#webOnFull');
      return { hasA: !!a, hasB: !!b, a: a ? a.checked : null, b: b ? b.checked : null };
    })()`);
    ok(web0.hasA && web0.hasB, "小窗与大窗各有一个勾选框");
    ok(web0.a === true && web0.b === true, "★ 默认都是勾上的（联网默认开）", `${web0.a} / ${web0.b}`);

    // 取消勾选：两处要同步，且真的写了设置
    await evaluate(`(() => { const b = document.querySelector('#webOnFull'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(500);
    const web1 = await evaluate(`(() => ({
      a: document.querySelector('#webOnMini').checked,
      b: document.querySelector('#webOnFull').checked,
      setting: window.__minipi.mockSettings ? window.__minipi.mockSettings().webEnabled : null,
    }))()`);
    ok(web1.a === false && web1.b === false, "★ 取消勾选后两处同步为未选中", `${web1.a} / ${web1.b}`);

    // 再勾回来
    await evaluate(`(() => { const b = document.querySelector('#webOnMini'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(500);
    const web2 = await evaluate(`(() => ({
      a: document.querySelector('#webOnMini').checked,
      b: document.querySelector('#webOnFull').checked,
    }))()`);
    ok(web2.a === true && web2.b === true, "再勾回来两处同步", `${web2.a} / ${web2.b}`);

    /* ---------------------------------------------------------- 关于 */
    group("[B6] 球菜单 → 关于：必须显示真实的 Pi 版本");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await sleep(250);
    await evaluate("document.querySelector('#btnMiniMenu').click()");
    await sleep(250);
    await evaluate(`document.querySelector('[data-ballmenu="about"]').click()`);
    await sleep(600);
    const about = await evaluate(overlaySnap("#aboutPanel"));
    ok(about.visible === true, "★ 点「关于」打开面板", `w=${about.w} h=${about.h}`);
    ok(about.textLen > 30, "面板里有实际内容", `${about.textLen} 字`);
    const aboutText = await evaluate("document.querySelector('#aboutRows').textContent");
    ok(/基于 Pi/.test(aboutText), "★ 明确写出「基于 Pi」", aboutText.replace(/\s+/g, " ").slice(0, 80));
    ok(/v\d+\.\d+\.\d+/.test(aboutText), "带出了具体版本号", (aboutText.match(/v\d+\.\d+\.\d+/) || [""])[0]);
    ok(/Electron/.test(aboutText) && /Chromium/.test(aboutText), "运行时版本也在（Electron / Chromium）");
    ok(!/[A-Z]:\\\\/.test(aboutText), "面板里**没有**绝对路径（不泄露本机路径）");
    await evaluate("document.querySelector('#btnAboutClose').click()");
    await sleep(200);
    ok((await evaluate(overlaySnap("#aboutPanel"))).visible === false, "能关闭");

    /* ---------------------------------------------------------- T3 能力菜单 */
    group("[T3-1] `+` 能力菜单：可见、非空、点下去有结果");
    await evaluate("document.querySelector('#btnSettingsClose').click()");
    await sleep(200);
    await evaluate("document.querySelector('#btnCapFull').click()");
    await sleep(300);
    const cap = await evaluate(overlaySnap("#capMenu"));
    ok(cap.visible === true, "★ 点 `+` 后能力菜单可见", `w=${cap.w} h=${cap.h}`);
    ok(cap.items >= 5, "菜单里有 5 个可点项", `实得 ${cap.items}`);
    ok(cap.inViewport === true, "菜单完整落在视口内", `x=${cap.x} y=${cap.y}`);

    await evaluate(`document.querySelector('[data-cap="settings"]').click()`);
    await sleep(700);
    ok((await evaluate(overlaySnap("#settingsPanel"))).visible === true, "「模型设置」项能打开面板");
    await evaluate("document.querySelector('#btnSettingsClose').click()");
    await sleep(200);

    /* ---------------------------------------------------------- T3 斜杠命令 */
    group("[T3-2] 斜杠命令：`/` 触发、过滤、键盘选择、Enter 执行且**不发消息**");
    await evaluate("window.__minipi.__mockCallsReset()");
    await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      el.focus();
      el.value = '/';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const panelAll = await evaluate(overlaySnap("#cmdPanel"));
    ok(panelAll.visible === true, "★ 行首输入 `/` 弹出命令面板", `w=${panelAll.w} h=${panelAll.h}`);
    ok(panelAll.items === 5, "面板列出 5 个命令", `实得 ${panelAll.items}`);

    await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      el.value = '/th';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const filtered = await evaluate(`[...document.querySelectorAll('#cmdPanel .cmdpanel__item')].map(b=>b.getAttribute('data-cmd'))`);
    ok(filtered.join(",") === "/theme", "输入 `/th` 过滤到 /theme", filtered.join(","));

    // Enter 执行：应当切主题，**不能**发成一条 prompt
    await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(600);
    const afterExec = await evaluate(`({
      theme: document.documentElement.dataset.theme || '',
      panelHidden: document.querySelector('#cmdPanel').hidden,
      input: document.querySelector('#fullInput').value,
    })`);
    const callsAfterExec = await evaluate("window.__minipi.__mockCalls()");
    ok(callsAfterExec.filter((c) => c.kind === "prompt").length === 0, "★ Enter 执行命令**没有**把 /th 发给模型");
    ok(afterExec.theme === "light", "★ /theme 真的切了主题（system→light）", afterExec.theme);
    ok(afterExec.panelHidden === true, "执行后面板收起");
    ok(afterExec.input === "", "执行后输入框清空");

    group("[T3-3] 命令面板键盘：↑↓ 选择 / Tab 补全 / Esc 关闭");
    await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      el.value = '/';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const sel0 = await evaluate(`document.querySelector('#cmdPanel .cmdpanel__item[aria-selected="true"]').getAttribute('data-cmd')`);
    await evaluate(`(() => { const el=document.querySelector('#fullInput'); el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); return true; })()`);
    await sleep(200);
    const sel1 = await evaluate(`document.querySelector('#cmdPanel .cmdpanel__item[aria-selected="true"]').getAttribute('data-cmd')`);
    ok(sel0 === "/new" && sel1 === "/model", "↓ 移动选中项", `${sel0} → ${sel1}`);

    await evaluate(`(() => { const el=document.querySelector('#fullInput'); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); return true; })()`);
    await sleep(200);
    const completed = await evaluate(`document.querySelector('#fullInput').value`);
    ok(completed.trim() === "/model", "Tab 补全到选中命令", JSON.stringify(completed));

    await evaluate(`(() => { const el=document.querySelector('#fullInput'); el.value='/'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return true; })()`);
    await sleep(250);
    ok((await evaluate("document.querySelector('#cmdPanel').hidden")) === true, "Esc 关闭面板");

    /* ---------------------------------------------------------- T9 产出中心（D-14） */
    group("[T9] 产出中心：抽屉清单 + 搜索过滤");
    {
      await evaluate(`document.querySelector('[data-mock="mode-full"]').click()`);
      await sleep(320);
      await evaluate(`document.querySelector('#btnDrawer').click()`);
      await sleep(460);
      const rows = await evaluate("document.querySelectorAll('#assetList .assetrow').length");
      ok(rows === 2, "抽屉里列出 2 条产出", String(rows));
      ok((await evaluate("document.querySelector('#assetEmpty').hidden")) === true, "有数据时不显示空态");
      ok((await evaluate("document.querySelectorAll('#assetList [data-asset-act]').length")) === 6,
        "每条 3 个动作按钮（打开 / 定位 / 删除）");

      await evaluate(`(() => { const i = document.querySelector('#assetSearch'); i.value = '周报'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(560);
      const filtered = await evaluate("document.querySelectorAll('#assetList .assetrow').length");
      ok(filtered === 1, "搜索「周报」→ 1 条", String(filtered));
      const title = await evaluate("(document.querySelector('#assetList .assetrow__title') || {}).textContent");
      ok(title === "周报", "过滤结果的标题正确", String(title));
      await evaluate(`(() => { const i = document.querySelector('#assetSearch'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(460);
    }
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
console.log(" 覆盖边界：断言「点下去有可见结果」；不覆盖真实 IPC（mock 宿主）、不覆盖球态 48×48 下的右键（需真窗口）。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
