#!/usr/bin/env node
/**
 * QA · **基础业务闭环**（headless Chrome + mock 宿主，纯 DOM + 调用参数断言）。
 *
 * 用户对这条链路的要求（原话）：
 *   「不同窗口输入问题，都能接入大模型从而回复展示给用户。
 *     同时能使得用户可以下载内容成 md 或者 docx 格式文档。」
 *
 * 这个脚本把它拆成 6 组可自动验证的断言：
 *   [B1] 小窗能提问：输入 + Enter → 真的把 prompt 发给了宿主，且参数正确
 *   [B2] 大窗能提问：★ 大窗**必须**有自己的输入框（曾经完全没有，只能看不能问）
 *   [B3] 回答能展示：流式回答渲染进两窗的会话流
 *   [B4] 草稿互通：小窗打一半展开成大窗，字不丢
 *   [B5] 导出 md：最后一条回答的 [导出] → popover 选 Markdown → 宿主收到 format='md'
 *   [B6] 导出 docx：从大窗输入区的「文档」→ popover 选 Word → format='docx'；
 *        产出卡片带「打开 / 另存为」并能真的调到宿主
 *
 * 覆盖边界（写在明处，别当成"全验证了"）：
 *   · 用 mock 宿主，**不验证真实模型调用**（那条在 `npm run verify:loop-live`）；
 *   · 不弹出真实的系统"另存为"对话框（headless 下没有），只断言调用与参数。
 *
 * 运行：`node scripts/qa-business-loop.mjs`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9396;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-loop-"));
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
console.log(" QA · 基础业务闭环（提问 → 回答 → 导出 md/docx）");
console.log("======================================================================");

/* ================================================================= A0 */
group("[A0] 静态审查：两态都要有输入区与产出入口");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const miniInput = (html.match(/class="[^"]*js-composer[^"]*"\s+id="miniInput"/) || [])[0];
  const fullInput = (html.match(/class="[^"]*js-composer[^"]*"\s+id="fullInput"/) || [])[0];
  ok(Boolean(miniInput), "小窗有输入框（textarea.js-composer#miniInput）");
  ok(Boolean(fullInput), "★ 大窗**也有**输入框（textarea.js-composer#fullInput）");
  ok((html.match(/class="[^"]*js-send/g) || []).length === 2, "两态各有发送按钮（.js-send ×2）");
  ok((html.match(/class="[^"]*js-abort/g) || []).length === 2, "两态各有中断按钮（.js-abort ×2）");
  // ⚠ 逐行扫、**真正跳过块注释**：修复说明里就写着 `const inputEl = $('#miniInput')` 这句旧写法，
  //   朴素地全文搜会搜到注释、结论正好反了（这个坑今天踩过两次）。
  //   注意「行首是 *」这种朴素的判定不够 —— 块注释中间的说明行可能以任意字符开头，
  //   所以这里用一个小状态机跟 `/*` … `*/`。
  let inBlockComment = false;
  const staleSingleton = [];
  for (const raw of html.split("\n")) {
    let line = raw;
    if (inBlockComment) {
      const close = line.indexOf("*/");
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    const open = line.indexOf("/*");
    if (open !== -1) {
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        inBlockComment = true;
        line = line.slice(0, open);
      } else {
        line = line.slice(0, open) + line.slice(close + 2);
      }
    }
    const code = line.includes("//") ? line.slice(0, line.indexOf("//")) : line;
    if (/const\s+inputEl\s*=/.test(code)) staleSingleton.push(raw.trim());
  }
  ok(staleSingleton.length === 0, "★ 没有残留的「单例输入框」写法（那正是大窗不能提问的根因）", staleSingleton.join(" | "));
  ok(/function activeComposer\(/.test(html), "有 activeComposer()：按当前形态取输入框");
  ok(/function syncComposerDraft\(/.test(html), "有 syncComposerDraft()：草稿互通");
  ok(/function syncAbortButtons\(/.test(html), "有 syncAbortButtons()：两态中断按钮状态一起改");
  // 产出入口：小窗一个、大窗两个（侧栏 + 输入区）
  ok(/id="btnOutcome"/.test(html), "小窗有「文档」入口");
  ok(/id="btnOutcomeFull"/.test(html) && /id="btnOutcomeFullFoot"/.test(html), "大窗有「文档」入口（侧栏 + 输入区）");
  // 新导出链路（Phase 3）：回答操作行 → 锚定 popover → 宿主 generateOutcome
  ok(/class="msgacts/.test(html) || /'msgacts'/.test(html), "回答操作行 .msgacts 存在（每条 AI 回答底部）");
  ok(/data-msg-export/.test(html), "操作行有「导出这条回答」按钮（[data-msg-export]）");
  ok(/pop\.id = 'exportPop'/.test(html), "导出 popover 单例 #exportPop 存在");
  ok(/buildPopFormatItem\('docx'/.test(html) && /buildPopFormatItem\('md'/.test(html),
    "popover 里有 Word / Markdown 两个格式项");
  ok(!/id="outcomeComposer"/.test(html), "旧「产出对话框」已删除（用户明确反对的面板流程）");
}

/* ================================================================= Chrome */
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => {
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

/** 在某个输入框里敲字并回车（模拟真实键盘输入：input 事件 + Enter keydown）。 */
const typeAndEnter = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'no-input';
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return 'sent';
})()`;

/** 在某个输入框里敲字并点某个发送按钮。 */
const typeAndClick = (selector, btnSelector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const btn = document.querySelector(${JSON.stringify(btnSelector)});
  if (!el || !btn) return 'missing';
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  btn.click();
  return 'sent';
})()`;

if (!CHROME) {
  ok(false, "本机无 Chrome → 无法执行 headless 断言（明确「未测到」，不伪绿）");
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
        "--window-size=980,700",
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

    /* ---------------------------------------------------------- B1 */
    group("[B1] 小窗提问：输入 + Enter → 真的发给宿主");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await evaluate("window.__minipi.__mockCallsReset()");
    await sleep(200);

    ok((await evaluate(typeAndEnter("#miniInput", "小窗提问：什么是银企直联？"))) === "sent", "小窗输入框能接收输入并回车");
    await sleep(400);
    let calls = await evaluate("window.__minipi.__mockCalls()");
    const p1 = calls.find((c) => c.kind === "prompt");
    ok(Boolean(p1), "★ 宿主收到了 prompt 调用");
    ok(p1?.text === "小窗提问：什么是银企直联？", "prompt 文本正确", String(p1?.text));
    ok(p1?.behavior === "steer", "带上了契约要求的 behavior", String(p1?.behavior));
    ok((await evaluate("document.querySelector('#miniInput').value")) === "", "发送后输入框被清空");

    const miniUser = await evaluate("document.querySelectorAll('#miniBody .msg--user').length");
    ok(miniUser === 1, "小窗里出现 1 条用户气泡", `实得 ${miniUser}`);

    /* ---------------------------------------------------------- B3 */
    group("[B3] 回答展示：流式回答渲染进会话流");
    await sleep(2500); // 等 mock 的脚本流播完
    const answered = await evaluate(`(() => {
      const mini = document.querySelector('#miniBody');
      const full = document.querySelector('#fullTree');
      return {
        miniText: mini ? mini.textContent : '',
        fullText: full ? full.textContent : '',
        miniStreaming: !!document.querySelector('#miniBody .pulse'),
      };
    })()`);
    ok(answered.miniText.length > 30, "小窗里能看到回答正文", `${answered.miniText.length} 字`);
    ok(answered.fullText.includes("小窗提问"), "大窗的会话树里也能看到这一轮");
    ok(answered.miniStreaming === false, "流结束后 loading 动画消失");

    /* ---------------------------------------------------------- B2 */
    group("[B2] 大窗提问：★ 大窗必须能自己提问（曾经只能看不能问）");
    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(250);
    const fullHasInput = await evaluate(`(() => {
      const el = document.querySelector('#fullInput');
      const root = document.querySelector('#fullRoot');
      return { exists: !!el, insideFull: !!(el && root && root.contains(el)), visible: !!(el && el.offsetParent !== null) };
    })()`);
    ok(fullHasInput.exists === true, "大窗里有输入框节点");
    ok(fullHasInput.insideFull === true, "它确实挂在大窗里（不是复用小窗那个）");
    ok(fullHasInput.visible === true, "大窗形态下它可见");

    await evaluate("window.__minipi.__mockCallsReset()");
    ok((await evaluate(typeAndClick("#fullInput", "#btnSendFull", "大窗提问：司库管理的核心是什么？"))) === "sent", "大窗输入 + 点「发送」");
    await sleep(400);
    calls = await evaluate("window.__minipi.__mockCalls()");
    const p2 = calls.find((c) => c.kind === "prompt");
    ok(Boolean(p2), "★ 从大窗发出的提问也到了宿主");
    ok(p2?.text === "大窗提问：司库管理的核心是什么？", "文本正确（取的是大窗输入框，不是小窗）", String(p2?.text));
    await sleep(2500);
    const fullAfter = await evaluate(`(() => {
      const full = document.querySelector('#fullTree');
      return { users: full.querySelectorAll('.msg--user').length, text: full.textContent };
    })()`);
    ok(fullAfter.users === 2, "大窗会话树里现在有 2 条用户气泡", `实得 ${fullAfter.users}`);
    ok(fullAfter.text.includes("大窗提问"), "第二轮提问进了大窗会话流");

    /* ---------------------------------------------------------- B4 */
    group("[B4] 草稿互通与中断按钮同步");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await sleep(200);
    await evaluate(`(() => {
      const el = document.querySelector('#miniInput');
      el.value = '写了一半的话';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
    const draft = await evaluate("document.querySelector('#fullInput').value");
    ok(draft === "写了一半的话", "★ 小窗打一半展开成大窗，草稿不丢", JSON.stringify(draft));
    await evaluate(`(() => {
      const el = document.querySelector('#miniInput');
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    const abortSync = await evaluate(`(() => {
      const a = document.querySelector('#btnAbort');
      const b = document.querySelector('#btnAbortFull');
      return { mini: a ? a.disabled : null, full: b ? b.disabled : null };
    })()`);
    ok(abortSync.mini === abortSync.full, "两态「中断」按钮状态一致（不会一个能点一个不能）", `${abortSync.mini} / ${abortSync.full}`);

    /* ---------------------------------------------------------- B5 */
    group("[B5] 导出 Markdown（从最后一条回答的 [导出] → popover → md）");
    await evaluate("document.querySelector('[data-mock=\"mode-mini\"]').click()");
    await sleep(250);
    await evaluate("window.__minipi.__mockCallsReset()");

    const clickedExport = await evaluate(`(() => {
      const body = document.querySelector('#miniBody');
      const btns = [...body.querySelectorAll('[data-msg-export]')];
      const b = btns[btns.length - 1];
      if (!b) return 'no-export-button';
      b.click();
      return 'clicked';
    })()`);
    ok(clickedExport === "clicked", "★ 点最后一条回答的 [导出]（回答操作行入口）", clickedExport);

    await sleep(200);
    const pop = await evaluate(`(() => {
      const p = document.querySelector('#exportPop');
      if (!p) return null;
      return {
        open: !p.hidden,
        insideMini: !!p.closest('.mini'),
        formats: [...p.querySelectorAll('[data-format]')].map((b) => b.getAttribute('data-format')),
        custom: !!p.querySelector('[data-adv]'),
      };
    })()`);
    ok(pop && pop.open === true, "弹出锚定导出 popover（不是新窗口 / 独立面板）");
    ok(pop && pop.insideMini === true, "popover 挂在当前窗口卡片内（不会被重绘冲掉）");
    ok(pop && pop.formats.includes("md") && pop.formats.includes("docx"), "popover 里有 md 与 docx 两个格式", (pop?.formats || []).join(","));
    ok(pop && pop.custom === true, "popover 有「自定义整理要求…」入口");

    await evaluate(`document.querySelector('#exportPop [data-format="md"]').click()`);
    await sleep(200);
    /* 后台导出（用户 2026-10-20）：会话流里**不**出现「正在生成文档…」占位卡 */
    const genShown = await evaluate("!!document.querySelector('#miniBody .gencard')");
    ok(genShown === false, "选格式后会话流里**没有**占位卡（导出全程后台）");

    await sleep(1000);
    calls = await evaluate("window.__minipi.__mockCalls()");
    const g1 = calls.find((c) => c.kind === "generateOutcome");
    ok(Boolean(g1), "★ 宿主收到了 generateOutcome");
    ok(g1?.arg?.format === "md", "format = 'md'（按用户选的格式，不是默认 docx）", String(g1?.arg?.format));
    ok(g1?.arg?.intent === "把刚才这轮回答整理成一份 Markdown 笔记", "默认整理要求带上了「Markdown 笔记」", String(g1?.arg?.intent));
    ok(typeof g1?.arg?.sessionId === "string" && g1.arg.sessionId.length > 0, "带上了会话 id", String(g1?.arg?.sessionId));

    await sleep(900);
    const genGone = await evaluate("!document.querySelector('#miniBody .gencard')");
    ok(genGone === true, "产出到达后会话流里仍无占位卡（只有产出卡）");

    /* ---------------------------------------------------------- B6 */
    group("[B6] 导出 docx + 产出卡片的「打开 / 另存为」");
    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(250);
    await evaluate("window.__minipi.__mockCallsReset()");
    await evaluate("document.querySelector('#btnOutcomeFullFoot').click()");
    await sleep(200);
    const popFull = await evaluate(`(() => {
      const p = document.querySelector('#exportPop');
      if (!p) return null;
      return {
        open: !p.hidden,
        insideFull: !!p.closest('.full'),
        formats: [...p.querySelectorAll('[data-format]')].map((b) => b.getAttribute('data-format')),
      };
    })()`);
    ok(popFull && popFull.open === true, "从**大窗输入区**的「文档」也能打开同一个 popover");
    ok(popFull && popFull.insideFull === true, "popover 挂在大窗卡片里");
    ok(popFull && popFull.formats.includes("docx"), "popover 里有 docx 格式");

    await evaluate(`document.querySelector('#exportPop [data-format="docx"]').click()`);
    await sleep(1200);
    calls = await evaluate("window.__minipi.__mockCalls()");
    const g2 = calls.find((c) => c.kind === "generateOutcome");
    ok(Boolean(g2), "从大窗「文档」也真的调到了宿主", String(g2?.arg?.format));
    ok(g2?.arg?.format === "docx", "format = 'docx'", String(g2?.arg?.format));
    ok(g2?.arg?.intent === "把刚才这轮回答整理成一份结构化的文档", "意图正确（默认整理要求）", String(g2?.arg?.intent));

    await sleep(1000);
    const card = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.outcome')];
      const c = cards[cards.length - 1];
      if (!c) return null;
      return {
        count: cards.length,
        text: c.textContent,
        buttons: [...c.querySelectorAll('button')].map((b) => ({ label: b.textContent, action: b.getAttribute('data-outcome-action') })),
      };
    })()`);
    ok(Boolean(card), "产出卡片出现在对话流里");
    const labels = (card?.buttons || []).map((b) => b.label);
    ok(labels.some((l) => l.includes("打开")), "卡片有「打开」按钮", labels.join(" / "));
    ok(labels.some((l) => l.includes("另存为") || l.includes("下载")), "★ 卡片有「另存为」（= 用户要的下载）", labels.join(" / "));

    await evaluate("window.__minipi.__mockCallsReset()");
    const clicked = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.outcome')];
      const c = cards[cards.length - 1];
      const byLabel = (kw) => [...c.querySelectorAll('button')].find((b) => b.textContent.includes(kw));
      const save = byLabel('另存为') || byLabel('下载');
      if (!save) return 'no-save-button';
      save.click();
      return 'clicked';
    })()`);
    ok(clicked === "clicked", "能点到「另存为」");
    await sleep(600);
    calls = await evaluate("window.__minipi.__mockCalls()");
    ok(calls.some((c) => c.kind === "saveOutcomeAs"), "★ 点「另存为」真的调到了宿主（下载链路通）");

    await evaluate("window.__minipi.__mockCallsReset()");
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.outcome')];
      const c = cards[cards.length - 1];
      const open = [...c.querySelectorAll('button')].find((b) => b.textContent.includes('打开'));
      if (open) open.click();
      return true;
    })()`);
    await sleep(500);
    calls = await evaluate("window.__minipi.__mockCalls()");
    ok(calls.some((c) => c.kind === "openOutcome"), "点「打开」也调到了宿主");
  } catch (err) {
    ok(false, `headless 断言执行异常：${err?.message ?? err}`);
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
console.log(" 覆盖边界：用 mock 宿主 —— 不验证真实模型调用（见 npm run verify:loop-live），");
console.log("           不弹真实系统「另存为」对话框（headless 下没有），只断言调用与参数。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
