#!/usr/bin/env node
/**
 * QA · 小窗连续性 + 工具标记折叠卡（headless Chrome，纯 DOM 断言）。
 *
 * 守两条本轮改动：
 *   ① **小窗要是连续的会话流**。改前 `renderViews()` 的 mini 分支只取
 *      `store.turns[turns.length - 1]`，于是小窗「一轮一屏」——用户得打开大窗才发现
 *      前面的轮次还在。现在两边同构：都遍历全量轮次。
 *   ② **模型吐出的工具调用标记要折叠成提示卡**。`quick` 无工具，模型会把
 *      `<invoke name="cmd"><parameter …>` 当正文写出来（真实事件流取证见 protocol.js §8b），
 *      直接渲染就是一屏尖括号。现在折叠成 `.toolnote`，并且**不能再有裸露的 `<invoke` 文本**。
 *
 * 只读，不改任何 `src/` 文件。运行：`node scripts/qa-mini-continuity.mjs`。
 * 若本机无 Chrome，跳过 headless 部分、只做静态审查（退出码仍正确）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9394;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-mini-"));
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
console.log(" QA · 小窗连续会话流 + 工具标记折叠卡 · 纯 DOM 断言");
console.log("======================================================================");

/* ================================================================= A0 */
group("[A0] 静态审查：接线存在且没有新增未转义 sink");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  ok(/function renderRichParts/.test(html), "renderRichParts 存在");
  ok(/function buildToolNoteCard/.test(html), "buildToolNoteCard 存在");
  ok(/function splitToolMarkup/.test(html), "splitToolMarkup 镜像存在");
  ok(/const TOOL_INVOKE_MAX_BLOCKS = 20/.test(html), "TOOL_INVOKE_MAX_BLOCKS 镜像值 = 20");
  ok(/body\.appendChild\(renderRichParts\(seg\.text\)\)/.test(html), "思考段收尾后走 renderRichParts");
  // 小窗必须遍历全量轮次，不能再有「只取最后一轮」的写法
  ok(/store\.turns\.forEach\(\(turn, idx\) => \{[\s\S]{0,400}miniBody\.appendChild\(buildTurnNode\(turn, 'mini'/.test(html),
    "小窗分支遍历 store.turns 全量轮次");
  ok(!/const turn = store\.turns\[store\.turns\.length - 1\];/.test(html), "旧「只取最后一轮」写法已删除");
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

/** 两轮「用户 → 思考 → 回答」；第二轮思考里塞一个工具标记 + 一个 XSS 载荷。 */
const DRIVE = `
(() => {
  const S = 's_qa';
  let seq = 0;
  const push = (e) => window.__minipi.inject(S, ++seq, e);
  const TOOL = '<invoke name="cmd"> <parameter name="cmd">cmd /c "echo %MODEL%"</parameter> <parameter name="justification">检查环境变量</parameter> </invoke>';
  const XSS = '<img src=x onerror="window.__pwned_tn=1">';
  const turn = (q, think, ans) => {
    push({ type: 'agent_start' });
    push({ type: 'turn_start' });
    push({ type: 'message_start', messageRole: 'user', message: { role: 'user', content: [{ type: 'text', text: q }] } });
    push({ type: 'message_end', messageRole: 'user' });
    push({ type: 'message_start', messageRole: 'assistant' });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: think } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ans } });
    push({ type: 'message_update', assistantMessageEvent: { type: 'text_end' } });
    push({ type: 'message_end', messageRole: 'assistant' });
    push({ type: 'agent_settled' });
  };
  turn('第一轮问题', '第一轮的思考过程', '第一轮的回答正文');
  turn('第二轮问题', '第二轮思考：' + TOOL + ' 以及 ' + XSS + ' 结束。', '第二轮的回答正文');
  return { turns: window.__minipi.turns() };
})()
`;

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
        "--window-size=400,600",
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

    await evaluate("window.__minipi && (document.querySelector('[data-mock=\"mode-mini\"]').click(), true)");
    await sleep(200);

    /* ---------------------------------------------------------- B1 */
    group("[B1] 小窗 = 连续会话流（遍历全量轮次）");
    const drive = await evaluate(DRIVE);
    ok(drive && drive.turns === 2, "注入 2 轮事件后 store.turns = 2", `实得 ${drive && drive.turns}`);
    await sleep(400); // 等渲染层走完 rAF / 100ms 兜底

    const snap = await evaluate(`(() => {
      const mini = document.querySelector('#miniBody');
      const full = document.querySelector('#fullTree');
      const q = (root, sel) => root ? root.querySelectorAll(sel).length : -1;
      return {
        miniUsers: q(mini, '.msg--user'),
        fullUsers: q(full, '.msg--user'),
        miniDividers: q(mini, '.turndivider'),
        fullDividers: q(full, '.turndivider'),
        miniTurns: q(mini, '.msg--pi'),
        fullTurns: q(full, '.msg--pi'),
        miniText: mini ? mini.textContent : '',
        miniScroll: mini ? mini.scrollHeight : -1,
        miniClient: mini ? mini.clientHeight : -1,
        mode: document.body.dataset.mode,
      };
    })()`);

    ok(snap.miniUsers === 2, "小窗渲染出 **2** 个用户气泡（改前只有 1 个）", `实得 ${snap.miniUsers}`);
    ok(snap.miniUsers === snap.fullUsers, "小窗与大窗的用户气泡数一致", `${snap.miniUsers} vs ${snap.fullUsers}`);
    ok(snap.miniDividers === 1, "小窗有 1 条轮次分隔线（第 2 轮）", `实得 ${snap.miniDividers}`);
    ok(snap.miniDividers === snap.fullDividers, "分隔线数与大窗一致");
    ok(snap.miniTurns === 2 && snap.fullTurns === 2, "两边都渲染了 2 轮", `${snap.miniTurns} / ${snap.fullTurns}`);
    ok(snap.miniText.includes('第一轮问题') && snap.miniText.includes('第二轮问题'), "两轮的问题都在小窗里");
    ok(snap.miniText.includes('第一轮的回答正文'), "第一轮的回答仍在小窗里（连续，不是被覆盖）");
    ok(snap.miniText.includes('第二轮的回答正文'), "第二轮的回答在小窗里");
    ok(snap.miniScroll > snap.miniClient, "小窗内容超过可视高度 ⇒ 真的可滚动",
      `scrollHeight=${snap.miniScroll} clientHeight=${snap.miniClient}`);
    ok(snap.mode === 'mini', "当前处于 mini 形态", `mode=${snap.mode}`);

    /* ---------------------------------------------------------- B2 */
    /* 展开「第二轮思考」的折叠体：工具标记卡在思考正文里，落定后默认收起（用户 2026-10-20），
       不展开就看不见 .toolnote —— 先点开再断言（B3 仍断言「默认收起」）。 */
    const thinkBodies = await evaluate(`(() => {
      const full = document.querySelector('#fullTree');
      if (!full) return { ok: false, reason: 'no fullTree' };
      const heads = [...full.querySelectorAll('.thinkbox__head')];
      const head = heads[heads.length - 1];
      if (!head) return { ok: false, reason: 'no think head' };
      head.click();
      return { ok: true, heads: heads.length };
    })()`);
    ok(thinkBodies && thinkBodies.ok === true, "展开第二轮思考的折叠体（点标题行）", JSON.stringify(thinkBodies));
    await sleep(150);

    group("[B2] 工具标记折叠成提示卡（不再裸露 <invoke>）");
    const tool = await evaluate(`(() => {
      const full = document.querySelector('#fullTree');
      const card = full ? full.querySelector('.toolnote') : null;
      const rows = card ? [...card.querySelectorAll('.toolnote__row')].map((r) => r.textContent) : [];
      return {
        cards: full ? full.querySelectorAll('.toolnote').length : -1,
        thinkBodies: full ? full.querySelectorAll('.thinkbox__body').length : -1,
        title: card ? (card.querySelector('.toolnote__title') || {}).textContent : null,
        tag: card ? (card.querySelector('.toolnote__tag') || {}).textContent : null,
        rows,
        hasLiteralInvoke: full ? full.textContent.includes('<invoke') : true,
        hasLiteralParameter: full ? full.textContent.includes('<parameter') : true,
        imgs: full ? full.querySelectorAll('img').length : -1,
        pwned: typeof window.__pwned_tn,
      };
    })()`);
    ok(tool.thinkBodies >= 1, "点开后思考正文真的进 DOM（折叠是可见的，不是丢了）", `实得 ${tool.thinkBodies}`);

    ok(tool.cards === 1, "识别出 1 张工具提示卡", `实得 ${tool.cards}`);
    ok(tool.title && tool.title.includes('cmd'), "提示卡标题带工具名", String(tool.title));
    ok(tool.tag && tool.tag.includes('未启用'), "提示卡标注「当前场景未启用工具」", String(tool.tag));
    ok(tool.rows.length === 2, "两个 parameter 都展示出来", `实得 ${tool.rows.length}`);
    ok(tool.rows.some((r) => r.includes('echo %MODEL%')), "命令原文可见（不是被吞掉）");
    ok(tool.rows.some((r) => r.includes('检查环境变量')), "justification 可见");
    ok(tool.hasLiteralInvoke === false, "DOM 里**没有**裸露的 `<invoke`");
    ok(tool.hasLiteralParameter === false, "DOM 里**没有**裸露的 `<parameter`");
    ok(tool.imgs === 0, "工具卡里的 XSS 载荷没变成 <img> 节点", `imgs=${tool.imgs}`);
    ok(tool.pwned === 'undefined', "onerror 未执行（window.__pwned_tn 未定义）");

    /* ---------------------------------------------------------- B3 */
    /* B2 已手动展开过第二轮思考 → fold 显式 true。这里再点一次收起，验证「用户点过就听用户的」
       与「默认收起」两条约定：收起后正文不进 DOM，点开后又能看见（B2 已验）。 */
    await evaluate(`(() => {
      const full = document.querySelector('#fullTree');
      if (!full) return false;
      const heads = [...full.querySelectorAll('.thinkbox__head')];
      const head = heads[heads.length - 1];
      if (head) head.click();
      return true;
    })()`);
    await sleep(150);

    group("[B3] 折叠默认值：流式中展开、落定后**两窗都收起**；XSS 仍被挡");
    const plain = await evaluate(`(() => {
      const mini = document.querySelector('#miniBody');
      const full = document.querySelector('#fullTree');
      return {
        miniThinkBoxes: mini ? mini.querySelectorAll('.thinkbox').length : -1,
        miniThinkBodies: mini ? mini.querySelectorAll('.thinkbox__body').length : -1,
        fullThinkBoxes: full ? full.querySelectorAll('.thinkbox').length : -1,
        fullThinkBodies: full ? full.querySelectorAll('.thinkbox__body').length : -1,
        fullText: full ? full.textContent : '',
        fullImgs: full ? full.querySelectorAll('img').length : -1,
        miniImgs: mini ? mini.querySelectorAll('img').length : -1,
        pwned: typeof window.__pwned_tn,
      };
    })()`);
    ok(plain.miniThinkBoxes === 2, "小窗里两轮的思考段都在", `实得 ${plain.miniThinkBoxes}`);
    ok(plain.miniThinkBodies === 0, "小窗的思考段默认收起（正文不进 DOM，省得挤爆 360 宽）", `实得 ${plain.miniThinkBodies}`);
    ok(plain.fullThinkBodies === 0, "★ 大窗的思考段落定后也收起（用户 2026-10-20：结束后自动收缩）", `实得 ${plain.fullThinkBodies}`);
    ok(plain.fullText.includes('第二轮思考') === false, "大窗默认只看结果正文，不看思考正文");
    ok(plain.fullImgs === 0 && plain.miniImgs === 0, "两窗都没有 <img> 注入节点");
    ok(plain.pwned === 'undefined', "onerror 未执行（window.__pwned_tn 未定义）");
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
console.log(" 覆盖边界：断言渲染层 DOM 结构与文本；不覆盖真模型事件（模型是否真吐标记见 verify:thought 的口径说明）。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
