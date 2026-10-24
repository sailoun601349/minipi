#!/usr/bin/env node
/**
 * QA · 会话列表（CD-SS-1 / B1-3）：大窗左栏「列出 → 搜索 → 置顶 / 归档 / 改名 / 删除 → 恢复」。
 *
 * 为什么必须单建一条 headless 门禁：
 *   会话列表是**数据驱动的动态重建**（`renderSessions()` 每次清空重画），行内动作全靠
 *   事件委托 `[data-sess-act]`。静态审查只能证明「有 data-* 属性」，证明不了：
 *     · 点一下真的把 `setSessionPinned` 发出去了（而不是只改了 DOM）；
 *     · 删除是**两段式**（第一下只进确认态，第二下才真删）—— 少写一段就变成一点就删；
 *     · 「新建会话」不会把旧会话从列表里抹掉（本批最核心的产品行为）。
 *
 * 宿主是**注入的假宿主**（`Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前塞
 * `window.minipi`），因此：
 *   · 渲染层走的是**真实宿主分支**（不是 mock 分支），`host.listSessions` 等调用可被记账；
 *   · 数据、返回、时序全由本脚本控制 —— 断言可以精确到「收到什么参数」；
 *   · 真实 `~/.minipi` 完全不参与，也不写任何文件。
 *
 * 断言纪律：
 *   1. 每条断言一次页面往返，**单条 try/catch 隔离**：一条挂了后面照跑。
 *   2. 没测到（无 Chrome 等）记 null / SKIP，绝不伪绿。
 *   3. 不改任何 `src/**`；变异验证只改**假宿主**（`QA_MUTATE_ARCHIVED=1` / `QA_MUTATE_CREATE_NOPUSH=1`），见报告。
 *
 * 用法：`node scripts/qa-session-list.mjs`（退出码 0 = 全绿）
 *      `QA_MUTATE_ARCHIVED=1 node scripts/qa-session-list.mjs`（变异验证：宿主忽略归档过滤 → 必须红）
 *      `QA_MUTATE_CREATE_NOPUSH=1 node scripts/qa-session-list.mjs`（变异验证：新建后不进列表 → 必须红）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9398;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-sess-"));
const MUTATE_ARCHIVED = process.env.QA_MUTATE_ARCHIVED === "1";
const MUTATE_CREATE_NOPUSH = process.env.QA_MUTATE_CREATE_NOPUSH === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skipped = [];

function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  · ${detail}`}`);
  }
  return !!cond;
}
function S(label, why) {
  skip += 1;
  skipped.push(`${label}（${why}）`);
  console.log(`  SKIP  ${label}  · ${why}  [null]`);
}

console.log("=".repeat(74));
console.log(" QA · 会话列表（大窗左栏：列出 / 搜索 / 置顶 / 归档 / 改名 / 删除 / 恢复）");
if (MUTATE_ARCHIVED) console.log(" ⚠ 变异模式 QA_MUTATE_ARCHIVED=1：假宿主忽略 archived 过滤（本应判红）");
if (MUTATE_CREATE_NOPUSH) console.log(" ⚠ 变异模式 QA_MUTATE_CREATE_NOPUSH=1：createSession 不进列表数据（本应判红）");
console.log("=".repeat(74));

/* ---------------------------------------------------------------- 假宿主注入源 */
/**
 * 在页面脚本之前注入 `window.minipi`。
 * 设计要点：
 *   · 未显式实现的方法用 Proxy 兜底成 `() => Promise.resolve({ok:true})` —— 渲染层启动会碰
 *     十几个宿主方法（onBallPeek / hide / quit …），**漏一个就启动失败**，兜底比逐个补安全；
 *   · 会话数据是**可变的数组**，`createSession` / `deleteSession` / `renameSession` 会真改它，
 *     于是「新建后旧会话还在不在」是**真行为**，不是写死的返回值；
 *   · 每次调用都记账（`__qa.calls`），断言读「收到了哪个方法、参数是什么」。
 */
const HOST_SOURCE = `(() => {
  const now = Date.now();
  /* 删除时主进程会带回的「正文去向」路径。
     刻意写成一段**带空格以外特殊字符、有明确文件名**的绝对路径，
     这样断言「渲染层原样展示」时不会被泛化匹配骗过去。 */
  const MOCK_TRASHED_TO = 'C:\\\\Users\\\\qa\\\\.minipi\\\\trash\\\\s_qa6_0006.jsonl.20261023T120000';
  const SEED = () => ([
    { id: 's_qa1_0001', title: '周报怎么写的', sceneId: 'chat', pinned: true,  archived: false, createdAt: now - 7200e3,    updatedAt: now - 3600e3,  preview: '帮我写周报', lastSeq: 3 },
    { id: 's_qa2_0002', title: '合同条款解释', sceneId: 'work', pinned: false, archived: false, createdAt: now - 86400e3,   updatedAt: now - 7200e3,  preview: '这条怎么理解', lastSeq: 1 },
    { id: 's_qa3_0003', title: '旧的项目复盘', sceneId: 'chat', pinned: false, archived: true,  createdAt: now - 259200e3,  updatedAt: now - 259200e3, preview: '复盘一下', lastSeq: 2 },
    { id: 's_qa4_0004', title: '下周计划',     sceneId: 'chat', pinned: false, archived: false, createdAt: now - 90000e3,   updatedAt: now - 10800e3, preview: '周报里提到的三件事', lastSeq: 1 },
    { id: 's_qa5_0005', title: 'Gamma 计划',   sceneId: 'chat', pinned: false, archived: false, createdAt: now - 95000e3,   updatedAt: now - 14400e3, preview: '', lastSeq: 1 },
    { id: 's_qa6_0006', title: '无关内容',     sceneId: 'chat', pinned: false, archived: false, createdAt: now - 99000e3,   updatedAt: now - 18000e3, preview: '', lastSeq: 1 },
  ]);
  let sessions = SEED();
  const calls = [];
  const handlers = { windowState: [], event: [], hotkey: [] };
  let seq = 0;
  let lastCreated = null;

  const record = (kind, args) => { calls.push({ kind, args }); };

  window.__qa = {
    calls,
    seed: SEED,
    /* 暴露给断言用：MOCK_TRASHED_TO 是 IIFE 内的 const，页面全局取不到，
       而断言表达式是在页面里 eval 的 —— 不放出来就只能把路径字符串复制一遍，
       那样「断言里的期望值」和「mock 实际返回的值」会各自漂移，测试就废了。 */
    trashedTo: MOCK_TRASHED_TO,
    get sessions() { return sessions; },
    setSessions(next) { sessions = next.map((x) => ({ ...x })); return sessions.length; },
    reset() { sessions = SEED(); calls.length = 0; seq = 0; lastCreated = null; return true; },
    callsReset() { calls.length = 0; return true; },
    count(kind) { return calls.filter((c) => c.kind === kind).length; },
    last(kind) { const hit = calls.filter((c) => c.kind === kind); return hit.length ? hit[hit.length - 1] : null; },
    /* 最近一次 createSession 生成的 id —— 「新建后新会话真的出现在列表里」要靠它定位 */
    lastCreated() { return lastCreated; },
    /* createSession 之后又调了几次 listSessions（渲染层有没有刷新列表的证据） */
    listCallsAfterCreate() {
      let i = -1;
      calls.forEach((c, n) => { if (c.kind === 'createSession') i = n; });
      return i < 0 ? 0 : calls.slice(i + 1).filter((c) => c.kind === 'listSessions').length;
    },
    emitWindowState(p) { handlers.windowState.forEach((h) => h(p)); },
  };

  const api = {
    /* ---- 会话列表（本门禁的主角） ---- */
    listSessions({ query, archived } = {}) {
      record('listSessions', { query, archived });
      const q = String(query || '').toLowerCase();
      const items = sessions
        /* 变异开关：忽略 archived 过滤 —— 归档视图断言必须因此变红 */
        .filter((x) => (archived ? ${MUTATE_ARCHIVED ? "true" : "x.archived === true"} : x.archived !== true))
        .filter((x) => (q ? (x.title + ' ' + x.preview).toLowerCase().includes(q) : true))
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
      return Promise.resolve({ items });
    },
    renameSession({ id, title }) {
      record('renameSession', { id, title });
      const it = sessions.find((x) => x.id === id);
      if (it) it.title = title;
      return Promise.resolve({ ok: true, item: it || null });
    },
    setSessionPinned({ id, pinned }) {
      record('setSessionPinned', { id, pinned });
      const it = sessions.find((x) => x.id === id);
      if (it) it.pinned = pinned;
      return Promise.resolve({ ok: true, item: it || null });
    },
    setSessionArchived({ id, archived }) {
      record('setSessionArchived', { id, archived });
      const it = sessions.find((x) => x.id === id);
      if (it) it.archived = archived;
      return Promise.resolve({ ok: true, item: it || null });
    },
    deleteSession({ id }) {
      record('deleteSession', { id });
      sessions = sessions.filter((x) => x.id !== id);
      /* 真主进程会带回「正文被挪到回收站的绝对路径」（session-store.js:450 用
         path.join(trashDir, basename + .stamp) 造）。这里给一个**非空**的假路径，
         是为了让渲染层的「显示真实路径」分支被真正走到 —— 返回 {ok:true} 只会
         走到兜底文案那条分支，等于没测。（见下方 MOCK_TRASHED_TO 断言） */
      return Promise.resolve({ ok: true, trashedTo: MOCK_TRASHED_TO });
    },
    resumeSession({ id }) {
      record('resumeSession', { id });
      const it = sessions.find((x) => x.id === id) || {};
      return Promise.resolve({
        sessionId: id,
        title: it.title || '新会话',
        lastSeq: 0,
        sceneId: it.sceneId || 'chat',
        history: [
          { role: 'user', content: '继续上次的话题', timestamp: now - 60000 },
          { role: 'assistant', content: [{ type: 'text', text: '这是恢复出来的历史回答' }], timestamp: now - 59000 },
        ],
      });
    },
    createSession({ sceneId } = {}) {
      record('createSession', { sceneId });
      seq += 1;
      const id = 's_new' + seq + '_' + String(1000 + seq);
      lastCreated = id;
      /* 变异开关：创建成功但**不进列表数据** —— 模拟"新建了却没出现在列表里"的旧行为 */
      if (!${MUTATE_CREATE_NOPUSH ? "true" : "false"}) {
        sessions = sessions.concat([{
          id, title: '新会话', sceneId: sceneId || 'chat', pinned: false, archived: false,
          createdAt: Date.now(), updatedAt: Date.now(), preview: '', lastSeq: 0,
        }]);
      }
      return Promise.resolve({ sessionId: id, sceneId: sceneId || 'chat', model: 'mock/model', lastSeq: 0, title: '新会话' });
    },

    /* ---- 启动必需 --- */
    getSettings() { return Promise.resolve({ webEnabled: true, alwaysOnTop: false, sceneId: 'chat' }); },
    setSettings(partial) { record('setSettings', partial || {}); return Promise.resolve({ webEnabled: true, alwaysOnTop: false, sceneId: 'chat' }); },
    setWindowState({ state }) {
      record('setWindowState', { state });
      handlers.windowState.forEach((h) => h({ state }));
      return Promise.resolve({ ok: true, state });
    },
    sessionState() { return Promise.resolve({ status: 'idle', lastSeq: 0, messageCount: 0, costUsd: null }); },
    getAbout() {
      return Promise.resolve({ minipi: { version: 'qa', electron: '0', chrome: '0', node: '0', platform: 'test' }, pi: { name: 'pi', version: '0', aiVersion: '0' }, consistent: true });
    },
    listModels() { return Promise.resolve({ current: null, defaultModel: null, models: [] }); },
    listProviders() { return Promise.resolve({ current: null, defaultModel: null, featured: [], providers: [] }); },
    listAssets() { return Promise.resolve({ items: [] }); },
    onWindowState(h) { handlers.windowState.push(h); return () => {}; },
    onEvent(h) { handlers.event.push(h); return () => {}; },
    onHotkey(h) { handlers.hotkey.push(h); return () => {}; },
    onOutcome() { return () => {}; },
    onApproval() { return () => {}; },
    onBallPeek() { return () => {}; },
    onBallMenuClosed() { return () => {}; },
  };

  window.minipi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      /* 兜底：渲染层会碰很多宿主方法，漏一个就启动失败。未知方法 = 记账 + 成功。 */
      return (...args) => { record(key, args.length === 1 ? args[0] : args); return Promise.resolve({ ok: true }); };
    },
  });
  return true;
})()`;

/* ---------------------------------------------------------------- CDP 小工具 */
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

/** 单条断言：一次页面往返，返回 `{ pass, detail }`；抛异常只记这一条 FAIL。 */
async function A(label, expr) {
  let r;
  try {
    r = await evaluate(expr);
  } catch (err) {
    fail += 1;
    failures.push(`${label}（求值异常：${err && err.message ? err.message : err}）`);
    console.log(`  FAIL  ${label}  · 求值异常：${err && err.message ? err.message : err}`);
    return;
  }
  if (!r || typeof r !== "object") {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}  · 断言表达式没返回 {pass,detail}：${JSON.stringify(r)}`);
    return;
  }
  ok(r.pass === true, label, r.detail === undefined ? undefined : String(r.detail));
}

/** 动作（点击 / 输入）。失败不抛出，只记一条 FAIL，避免带崩整组。 */
async function act(label, expr) {
  try {
    return await evaluate(expr);
  } catch (err) {
    fail += 1;
    failures.push(`${label}（动作异常：${err && err.message ? err.message : err}）`);
    console.log(`  FAIL  ${label}  · 动作异常：${err && err.message ? err.message : err}`);
    return null;
  }
}

/** 重置假宿主数据 + 让渲染层重新拉一次列表。 */
async function resetList() {
  await act("重置假宿主数据", "window.__qa.reset()");
  await act(
    "触发一次列表刷新",
    `(() => { const el = document.querySelector('#sessSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await sleep(350);
}

const rowsExpr = "document.querySelectorAll('#sessList .sessrow').length";
const rowTitlesExpr = "[...document.querySelectorAll('#sessList .sessrow .sess__t')].map(e => e.textContent)";

/* ---------------------------------------------------------------- 主流程 */
if (!CHROME) {
  S("headless Chrome 行为断言", "本机没有找到 Chrome（未测到，不伪绿）");
  console.log("\n 结论：无法执行行为断言 → 退出码 1（缺环境不等于通过）");
  process.exit(1);
}

console.log(` 找到 Chrome：${CHROME}`);
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
      "--window-size=1200,860",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );

  const page = await cdpTargets();
  conn = await connect(page.webSocketDebuggerUrl);
  await conn.send("Runtime.enable");
  await conn.send("Page.enable");
  /* ★ 关键：在**任何页面脚本之前**把假宿主塞进 window。
     渲染层的 `const realHost = window.minipi ? window.minipi : null` 是模块顶层求值，
     晚一步注入就只能走 mock 分支，宿主调用就记不到账了。 */
  await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: HOST_SOURCE });
  await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}` });

  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      booted = await evaluate("document.readyState === 'complete' && !!window.__minipi && !!window.__qa && !!document.querySelector('#sessList')");
      if (booted) break;
    } catch {
      /* 页面还在加载 */
    }
    await sleep(250);
  }
  ok(booted, "页面就绪且假宿主已注入（渲染层走真实宿主分支）");
  if (!booted) throw new Error("页面没能在 10s 内就绪");
  await sleep(600);

  /* ---------------------------------------------------------- A 渲染 */
  console.log("\n[A] 渲染：大窗左栏列出会话");
  /* 启动时渲染层自己建了一个会话（connectSession）→ 假宿主数组里多一条。
     先复位成确定的种子数据，再切大窗（goState('full') 内部会 loadSessions）。 */
  await act("复位假宿主数据", "window.__qa.reset()");
  await act("切到大窗", "document.querySelector('#btnEnlarge').click()");
  await sleep(500);
  await A("大窗的会话列表容器可见（有尺寸、不是 display:none）", `(() => {
    const el = document.querySelector('#sessList');
    if (!el) return { pass: false, detail: '#sessList 不存在' };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { pass: r.width > 0 && r.height > 0 && cs.display !== 'none', detail: \`w=\${Math.round(r.width)} h=\${Math.round(r.height)}\` };
  })()`);
  await A("★ N 条会话渲染 N 行（5 条未归档）", `(() => {
    const n = ${rowsExpr};
    return { pass: n === 5, detail: 'rows=' + n };
  })()`);
  await A("★ 置顶的排第一（pinned desc 在渲染层也成立）", `(() => {
    const t = ${rowTitlesExpr};
    return { pass: t[0] === '周报怎么写的', detail: JSON.stringify(t) };
  })()`);
  await A("每行都有时间文本（HH:MM / MM-DD，不是空白）", `(() => {
    const metas = [...document.querySelectorAll('#sessList .sessrow .sess__m')].map(e => e.textContent.trim());
    const rows = ${rowsExpr};
    const good = metas.length === rows && rows > 0 && metas.every(m => /\\d{2}:\\d{2}|\\d{2}-\\d{2}/.test(m));
    return { pass: good, detail: 'rows=' + rows + ' ' + JSON.stringify(metas) };
  })()`);
  await A("行里有置顶徽标（pinned 行的可见反馈）", `(() => {
    const badge = document.querySelector('#sessList .sessrow .sessrow__pinbadge');
    return { pass: !!badge && badge.textContent.trim() === '置顶', detail: badge ? badge.textContent : 'null' };
  })()`);

  /* ---------------------------------------------------------- B 搜索 */
  console.log("\n[B] 搜索：关键词下推到宿主，行数下降");
  await resetList();
  await act("输入「周报」", `(() => {
    const el = document.querySelector('#sessSearch');
    el.value = '周报';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await A("★ 搜索后行数下降且只剩 2 条", `(() => {
    const n = ${rowsExpr};
    return { pass: n === 2, detail: 'rows=' + n + ' titles=' + JSON.stringify(${rowTitlesExpr}) };
  })()`);
  await A("★ 命中包含「只在预览里出现」的会话（证明搜索下推到宿主，前端没自作主张）", `(() => {
    const t = ${rowTitlesExpr};
    return { pass: t.includes('下周计划') && t.includes('周报怎么写的'), detail: JSON.stringify(t) };
  })()`);
  await A("搜索时确实带着 query 调了宿主 listSessions", `(() => {
    const last = window.__qa.last('listSessions');
    return { pass: !!last && last.args && last.args.query === '周报', detail: JSON.stringify(last && last.args) };
  })()`);
  await act("清空搜索框", `(() => {
    const el = document.querySelector('#sessSearch');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await A("清空搜索后恢复 5 行", `(() => {
    const n = ${rowsExpr};
    return { pass: n === 5, detail: 'rows=' + n };
  })()`);
  /* BUG-4 已修：`renderSessions()` 现在按 `store.sessionQuery` 分叉空态 ——
     有搜索词且 0 结果 ⇒ 「没有匹配的会话」且隐藏「新建会话」出口（别把人往新建上带）。 */
  await act("搜一个不存在关键词", `(() => {
    const el = document.querySelector('#sessSearch');
    el.value = 'zzz-不可能命中';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await A("搜不到时列表为空（行数 0，不是残留上一次结果）", `(() => {
    const n = ${rowsExpr};
    return { pass: n === 0, detail: 'rows=' + n };
  })()`);
  await A("★ BUG-4 回归：搜索无结果是独立状态，文案是「没有匹配的会话」", `(() => {
    const el = document.querySelector('#sessEmpty');
    if (!el) return { pass: false, detail: '没有 #sessEmpty' };
    const vis = !el.hidden && getComputedStyle(el).display !== 'none';
    const txt = el.textContent.trim();
    return { pass: vis && txt === '没有匹配的会话', detail: 'hidden=' + el.hidden + ' text=' + txt };
  })()`);
  await A("★ 搜索无结果时不显示「新建会话」出口（别把「搜不到」演成「没会话」）", `(() => {
    const el = document.querySelector('#sessEmptyNew');
    if (!el) return { pass: false, detail: '没有 #sessEmptyNew' };
    return { pass: el.hidden === true, detail: 'hidden=' + el.hidden };
  })()`);
  await act("清空搜索", `(() => {
    const el = document.querySelector('#sessSearch');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);

  /* ---------------------------------------------------------- C 空态 */
  console.log("\n[C] 空态：文案 + 可点出口");
  await act("把宿主数据清空", "window.__qa.setSessions([])");
  await act("刷新列表", `(() => { const el = document.querySelector('#sessSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(350);
  await A("★ 0 条时显示空态文案「还没有会话」（与「搜索无结果」分开）", `(() => {
    const el = document.querySelector('#sessEmpty');
    if (!el) return { pass: false, detail: '没有 #sessEmpty' };
    const vis = !el.hidden && getComputedStyle(el).display !== 'none';
    const txt = el.textContent.trim();
    return { pass: vis && txt === '还没有会话', detail: 'hidden=' + el.hidden + ' text=' + txt };
  })()`);
  await A("★ 空态给了一个可点出口（#sessEmptyNew 可见，禁止死路）", `(() => {
    const el = document.querySelector('#sessEmptyNew');
    if (!el) return { pass: false, detail: '没有 #sessEmptyNew' };
    const r = el.getBoundingClientRect();
    return { pass: !el.hidden && r.width > 0 && r.height > 0, detail: 'w=' + Math.round(r.width) };
  })()`);
  await act("点空态里的「新建会话」", `(() => { window.__qa.callsReset(); document.querySelector('#sessEmptyNew').click(); return true; })()`);
  await sleep(500);
  await A("★ 空态出口真的建了会话（createSession 收到调用）", `(() => {
    const n = window.__qa.count('createSession');
    return { pass: n === 1, detail: 'createSession×' + n };
  })()`);

  /* ---------------------------------------------------------- D 行内动作 */
  console.log("\n[D] 行内动作：置顶 / 归档 / 改名 / 删除（两段式）");
  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点第一行的「置顶」", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa2_0002"] [data-sess-act="pin"]').click(); return true; })()`);
  await sleep(400);
  await A("★ 点置顶 → 宿主 setSessionPinned 收到 {id, pinned:true}", `(() => {
    const c = window.__qa.last('setSessionPinned');
    return { pass: !!c && c.args.id === 's_qa2_0002' && c.args.pinned === true, detail: JSON.stringify(c && c.args) };
  })()`);

  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点第一行的「归档」", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa5_0005"] [data-sess-act="archive"]').click(); return true; })()`);
  await sleep(400);
  await A("点归档 → 宿主 setSessionArchived 收到 {id, archived:true}", `(() => {
    const c = window.__qa.last('setSessionArchived');
    return { pass: !!c && c.args.id === 's_qa5_0005' && c.args.archived === true, detail: JSON.stringify(c && c.args) };
  })()`);

  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("第一次点「删除」", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa6_0006"] [data-sess-act="delete"]').click(); return true; })()`);
  await sleep(250);
  await A("★ 删除是两段式：第一下**只进确认态**，不调 deleteSession", `(() => {
    const row = document.querySelector('.sessrow[data-sess-id="s_qa6_0006"]');
    const btn = row && row.querySelector('[data-sess-act="delete"]');
    const del = window.__qa.count('deleteSession');
    return {
      pass: !!row && row.getAttribute('data-confirm') === 'true' && del === 0 && !!btn && btn.textContent.includes('确认'),
      detail: 'confirm=' + (row && row.getAttribute('data-confirm')) + ' deleteSession×' + del + ' label=' + (btn && btn.textContent),
    };
  })()`);
  await A("确认态下这一行还在（没有先删了再问）", `(() => {
    const n = ${rowsExpr};
    return { pass: n === 5, detail: 'rows=' + n };
  })()`);
  await act("第二次点「确认删除」", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa6_0006"] [data-sess-act="delete"]').click(); return true; })()`);
  await sleep(400);
  await A("★ 第二下才真删：deleteSession 收到正确 id，且行消失", `(() => {
    const c = window.__qa.last('deleteSession');
    const n = ${rowsExpr};
    return { pass: !!c && c.args.id === 's_qa6_0006' && n === 4, detail: 'args=' + JSON.stringify(c && c.args) + ' rows=' + n };
  })()`);
  /* 「参数对」不等于「只调了一次」：如果一次点击触发了两个事件监听器，
     会发出两次 deleteSession。第二次删同一个 id 在主进程是幂等的（无声失败），
     所以**只看 rows 和 args 完全发现不了**。必须数字数。 */
  await A("★ 删除第二下「恰好」调用 deleteSession 一次（不是 0 次也不是 2 次）", `(() => {
    const n = window.__qa.count('deleteSession');
    return { pass: n === 1, detail: 'deleteSession×' + n };
  })()`);
  /* BUG-6：toast 曾承诺「已移入回收站」（暗示可恢复），但 v1 根本没有恢复入口。
     现在文案改成「正文在回收站目录，暂未提供恢复入口」—— 这条钉住"别承诺做不到的事"。 */
  await A("★ BUG-6 回归：删除后的提示不承诺「可恢复」，而是说清没有恢复入口", `(() => {
    const texts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    const hit = texts.find(t => t.includes('回收站')) || '';
    return {
      pass: hit.includes('暂未提供恢复入口') && !/已移入回收站|可恢复/.test(hit),
      detail: JSON.stringify(texts),
    };
  })()`);
  /* 主进程把正文挪走后会回传 `trashedTo`。这条钉两件事：
     ① 渲染层**原样展示**这个路径（用户能据此自己去回收站找文件）；
     ② 渲染层**不自己拼路径** —— 拼的路径和真实路径一旦不同，
        用户按提示去找会找到空气，比不提示更糟。 */
  await A("★ 删除提示里带主进程回传的真实回收站路径（不是自己拼的）", `(() => {
    const texts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    const hit = texts.find(t => t.includes('回收站')) || '';
    return { pass: hit.includes(window.__qa.trashedTo), detail: JSON.stringify(hit) };
  })()`);

  await resetList();
  await act("点「改名」（行内输入框）", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa1_0001"] [data-sess-act="rename"]').click(); return true; })()`);
  await sleep(200);
  await A("★ 改名走行内输入框（出现 .sessrow__rename 且预填原标题）", `(() => {
    const input = document.querySelector('.sessrow[data-sess-id="s_qa1_0001"] .sessrow__rename');
    return { pass: !!input && input.value === '周报怎么写的', detail: input ? 'value=' + input.value : '没有输入框' };
  })()`);
  await act("改名后回车", `(() => {
    const input = document.querySelector('.sessrow[data-sess-id="s_qa1_0001"] .sessrow__rename');
    window.__qa.callsReset();
    input.value = '季度复盘（改名测试）';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(450);
  await A("★ 回车提交 → renameSession 收到新标题", `(() => {
    const c = window.__qa.last('renameSession');
    return { pass: !!c && c.args.id === 's_qa1_0001' && c.args.title === '季度复盘（改名测试）', detail: JSON.stringify(c && c.args) };
  })()`);
  await A("改名后标题在列表里更新（不是只发了 IPC）", `(() => {
    const t = ${rowTitlesExpr};
    return { pass: t.includes('季度复盘（改名测试）'), detail: JSON.stringify(t) };
  })()`);

  await resetList();
  await act("打开改名框后按 Esc", `(() => {
    document.querySelector('.sessrow[data-sess-id="s_qa2_0002"] [data-sess-act="rename"]').click();
    return true;
  })()`);
  await sleep(200);
  await act("Esc 取消", `(() => {
    const input = document.querySelector('.sessrow[data-sess-id="s_qa2_0002"] .sessrow__rename');
    window.__qa.callsReset();
    input.value = '不该被保存的标题';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  await A("★ Esc 取消 → renameSession 一次都没调用（取消不是保存）", `(() => {
    const n = window.__qa.count('renameSession');
    return { pass: n === 0, detail: 'renameSession×' + n };
  })()`);

  /* ---------------------------------------------------------- E 恢复 */
  console.log("\n[E] 点行恢复：resumeSession + 高亮 + 历史回填");
  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点第二行（合同条款解释）", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa2_0002"] .sessrow__main').click(); return true; })()`);
  await sleep(600);
  await A("★ 点行 → resumeSession 收到正确 id", `(() => {
    const c = window.__qa.last('resumeSession');
    return { pass: !!c && c.args.id === 's_qa2_0002', detail: JSON.stringify(c && c.args) };
  })()`);
  await A("★ 恢复后该行高亮（data-active=true，且只有一行）", `(() => {
    const act = [...document.querySelectorAll('#sessList .sessrow[data-active="true"]')].map(r => r.getAttribute('data-sess-id'));
    return { pass: act.length === 1 && act[0] === 's_qa2_0002', detail: JSON.stringify(act) };
  })()`);
  await A("恢复后历史被回填进对话树（不是「装作记得」）", `(() => {
    const tree = document.querySelector('#fullTree');
    const txt = tree ? tree.textContent : '';
    return { pass: txt.includes('这是恢复出来的历史回答'), detail: 'len=' + txt.length };
  })()`);

  /* ---------------------------------------------------------- F 新建不删旧 */
  console.log("\n[F] 新建会话不删旧（本批最核心的产品行为）");
  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点左栏「新会话」", `(() => { document.querySelector('#btnNewSession').click(); return true; })()`);
  await sleep(300);
  const needConfirm = await evaluate(`(() => { const bar = document.querySelector('#confirmBar'); return !!bar && !bar.hidden; })()`);
  if (needConfirm) {
    await act("确认条上点「开始新会话」", `(() => { document.querySelector('[data-confirm-ok]').click(); return true; })()`);
    await sleep(700);
  }
  await A(`★ 新建会话真的建了（createSession×1，确认条=${needConfirm ? "有" : "直接执行"}）`, `(() => {
    const n = window.__qa.count('createSession');
    return { pass: n === 1, detail: 'createSession×' + n };
  })()`);
  await A("★ 新建后旧会话一条都没少（列表里 5 条旧标题全在）", `(() => {
    const t = ${rowTitlesExpr};
    const olds = ['周报怎么写的', '合同条款解释', '下周计划', 'Gamma 计划', '无关内容'];
    const missing = olds.filter((x) => !t.includes(x));
    return { pass: missing.length === 0, detail: 'rows=' + t.length + ' missing=' + JSON.stringify(missing) + ' titles=' + JSON.stringify(t) };
  })()`);
  /* BUG-2 已修：`performNewSession()` 末尾补了 `void loadSessions()`。
     这里等"列表真的翻到 6 行"（`void` 是异步的，给 2s 轮询），再断言三件事：
       ① 新会话的 id 出现在列表里；② 旧会话一条没少；③ 宿主确实被再问了一次 listSessions。 */
  let settledRows = 0;
  for (let i = 0; i < 20; i += 1) {
    settledRows = await evaluate(rowsExpr);
    if (settledRows === 6) break;
    await sleep(100);
  }
  await A("★ BUG-2 回归：新建后新会话立刻出现在列表里（6 行：5 旧 + 1 新）", `(() => {
    const id = window.__qa.lastCreated();
    const ids = [...document.querySelectorAll('#sessList .sessrow')].map(r => r.getAttribute('data-sess-id'));
    return { pass: ids.length === 6 && ids.includes(id), detail: 'created=' + id + ' rows=' + JSON.stringify(ids) };
  })()`);
  await A("★ BUG-2 回归：createSession 之后宿主被再问了一次 listSessions（列表真的刷新了）", `(() => {
    const n = window.__qa.listCallsAfterCreate();
    return { pass: n >= 1, detail: 'createSession 之后的 listSessions 调用 = ' + n + ' 次' };
  })()`);

  /* ---------------------------------------------------------- G 归档视图 */
  console.log("\n[G] 归档视图切换");
  await resetList();
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点「归档」视图开关", "document.querySelector('#btnSessArchived').click()");
  await sleep(450);
  await A("★ 归档视图：按钮 aria-pressed=true 且宿主收到 archived:true", `(() => {
    const btn = document.querySelector('#btnSessArchived');
    const c = window.__qa.last('listSessions');
    return { pass: btn.getAttribute('aria-pressed') === 'true' && !!c && c.args.archived === true, detail: 'pressed=' + btn.getAttribute('aria-pressed') + ' args=' + JSON.stringify(c && c.args) };
  })()`);
  await A("★ 归档视图只列归档会话（1 条，标题正确）", `(() => {
    const t = ${rowTitlesExpr};
    return { pass: t.length === 1 && t[0] === '旧的项目复盘', detail: JSON.stringify(t) };
  })()`);

  /* ---------------------------------------------------------- H 从归档里捞回来 */
  console.log("\n[H] 归档视图里的「取消归档」");
  await A("★ 归档视图里那一行的按钮文案是「取消归档」（不是「归档」）", `(() => {
    const btn = document.querySelector('.sessrow[data-sess-id="s_qa3_0003"] [data-sess-act="archive"]');
    return { pass: !!btn && btn.textContent.trim() === '取消归档', detail: btn ? btn.textContent.trim() : '没有按钮' };
  })()`);
  await act("清调用记录", "window.__qa.callsReset()");
  await act("点「取消归档」", `(() => { document.querySelector('.sessrow[data-sess-id="s_qa3_0003"] [data-sess-act="archive"]').click(); return true; })()`);
  await sleep(450);
  await A("★ 点「取消归档」→ setSessionArchived 收到 {id, archived:false}", `(() => {
    const c = window.__qa.last('setSessionArchived');
    return { pass: !!c && c.args.id === 's_qa3_0003' && c.args.archived === false, detail: JSON.stringify(c && c.args) };
  })()`);

  await resetList();
  await act("再点一次回到默认视图", "document.querySelector('#btnSessArchived').click()");
  await sleep(450);
  await A("再点一次 → 回到未归档视图（5 行、aria-pressed=false）", `(() => {
    const n = ${rowsExpr};
    const pressed = document.querySelector('#btnSessArchived').getAttribute('aria-pressed');
    return { pass: n === 5 && pressed === 'false', detail: 'rows=' + n + ' pressed=' + pressed };
  })()`);
} catch (err) {
  fail += 1;
  failures.push(`流程异常：${err && err.message ? err.message : err}`);
  console.log(`\n  FAIL  流程异常：${err && err.message ? err.message : err}`);
} finally {
  try {
    if (conn) conn.close();
  } catch {
    /* ignore */
  }
  /* 整个 Chrome 进程树（--user-data-dir 是我们自己的临时目录） */
  try {
    if (chrome && chrome.pid) spawn("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(400);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* 删不掉不影响结论 */
  }
}

console.log("\n" + "=".repeat(74));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项 · 未测到 ${skip} 项`);
if (fail > 0) console.log(` 失败项：\n   ✗ ${failures.join("\n   ✗ ")}`);
if (skip > 0) console.log(` 未测到：\n   · ${skipped.join("\n   · ")}`);
if (MUTATE_ARCHIVED || MUTATE_CREATE_NOPUSH) console.log(" （变异模式：出现失败是**预期**的）");
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
