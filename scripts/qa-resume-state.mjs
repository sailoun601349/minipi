#!/usr/bin/env node
/**
 * QA · **恢复会话之后**的状态清理（B1-3 / plan §2.3）—— headless Chrome + 注入假宿主。
 *
 * 为什么这条门禁必须存在（来历）：
 *   `qa-session-list` 只验「点行 → 发出了 `resumeSession({id})`、参数对不对」，它**不看恢复之后**
 *   渲染层状态干不干净。验证员 Vic 为此临时写过一份 `evidence/qa-resume-state.mjs`，两次抓到
 *   「实现报告声称的行为」与「代码实际行为」不一致（场景没换 / 失败改了半截）。但那份脚本只活在
 *   evidence 目录里，`verify:all` 不含它 ⇒ **同样的回退在门禁里是静默的**。本文件把它产品化。
 *
 * 守的 6 条行为（对应 plan §2.3 + 实现报告 §6.4）：
 *   ① 流式中点别的会话 → **不切换**，给一句「先中断再切换会话」；
 *   ② 恢复成功后 `store.session` 是**新对象**（不是 `Object.assign` 把旧会话的值叠过来）；
 *   ③ `store.scene` 跟着 `r.sceneId` 走（从 work 会话恢复回来，场景就是 work）；
 *   ④ `store.restoredNote` 有内容，且渲染成一句说明（历史回填了多少条要说清楚）；
 *   ⑤ `resumeSession` 抛错时，**当前会话 / turns / 场景一个都不许动**（别改一半）；
 *   ⑥ 历史原文进 `turns`（真的能接着聊，不是"装作记得"）。
 *   附带：`resetConversationState()` 的清场（审批卡 / seq 计数 / turns）必须真的发生。
 *
 * 假宿主注入（`Page.addScriptToEvaluateOnNewDocument`，页面脚本之前）：
 *   · 列表 2 条：s_qb1_0001（sceneId=work）、s_qb2_0002（chat）—— 有第二条才测得了「流式中切走」和「失败不改半截」；
 *   · `resumeSession` 可按开关返回**成功**或**reject**；
 *   · `sessionState` 一律 reject：否则 4s 轮询会把 `store.session.model` 重新盖一遍，
 *     把「旧值有没有被叠过来」这个判据抹平（这是本脚本最容易假绿的地方，特意写在注释里）；
 *   · `prompt` 永不 settle：用来把渲染层钉在"流式中"。
 *
 * 用法：`node scripts/qa-resume-state.mjs`（退出码 0 = 全绿）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9399;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-resume-"));
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
console.log(" QA · 恢复会话之后的状态（清场 / 场景 / 说明行 / 失败不改半截 / 流式中拒绝切换）");
console.log("=".repeat(74));

/* ---------------------------------------------------------------- 假宿主 */
const HOST_SOURCE = `(() => {
  const now = Date.now();
  const itemA = { id: 's_qb1_0001', title: '上次的会话（办公产出）', sceneId: 'work',
    pinned: false, archived: false, createdAt: now - 7200e3, updatedAt: now - 3600e3, preview: '上次的问题', lastSeq: 4 };
  const itemB = { id: 's_qb2_0002', title: '另一个会话', sceneId: 'chat',
    pinned: false, archived: false, createdAt: now - 9000e3, updatedAt: now - 8000e3, preview: '', lastSeq: 1 };
  const HISTORY_A = [
    { role: 'user', content: '上次我让你把周报改成三段式', timestamp: now - 600e3 },
    { role: 'assistant', content: '已经改成三段式：结论 / 依据 / 下一步。', timestamp: now - 590e3 },
  ];
  const HISTORY_B = [
    { role: 'user', content: 'B 会话的历史提问', timestamp: now - 900e3 },
    { role: 'assistant', content: 'B 会话的历史回答', timestamp: now - 890e3 },
  ];

  const calls = [];
  const handlers = { windowState: [], event: [] };
  let failResume = false;
  let bootSeq = 0;
  const record = (kind, args) => { calls.push({ kind, args }); };

  window.__qa = {
    calls,
    count(kind) { return calls.filter((c) => c.kind === kind).length; },
    last(kind) { const hit = calls.filter((c) => c.kind === kind); return hit.length ? hit[hit.length - 1] : null; },
    setFailResume(v) { failResume = v === true; return failResume; },
    isFailResume() { return failResume; },
    emit(name, payload) { (handlers[name] || []).forEach((h) => { try { h(payload); } catch (e) { console.warn(e); } }); },
  };

  const api = {
    /* ---- 会话列表 + 恢复（本门禁的主角） ---- */
    listSessions(a) {
      record('listSessions', a || {});
      return Promise.resolve({ items: [itemA, itemB] });
    },
    resumeSession({ id } = {}) {
      record('resumeSession', { id });
      if (failResume) {
        /* 错误码格式与主进程一致（"CODE: 说明"），渲染层靠它决定 toast 文案 */
        return Promise.reject(new Error('SESSION_NOT_FOUND: 会话不存在或已删除：' + id));
      }
      const payload = id === 's_qb1_0001'
        ? { sessionId: 's_qb1_0001', title: itemA.title, sceneId: 'work', lastSeq: 0, history: HISTORY_A }
        : { sessionId: 's_qb2_0002', title: itemB.title, sceneId: 'chat', lastSeq: 0, history: HISTORY_B };
      return Promise.resolve(payload);
    },
    createSession({ sceneId } = {}) {
      bootSeq += 1;
      record('createSession', { sceneId });
      return Promise.resolve({
        sessionId: 's_boot_000' + bootSeq, sceneId: sceneId || 'chat',
        model: 'mock/model', lastSeq: 0, title: '新会话',
      });
    },
    /* 刻意 reject：4s 轮询若成功，会把 store.session.model 重新写一遍，
       于是「恢复后 model 是不是旧值」这条判据会被抹平（假绿）。 */
    sessionState() {
      return Promise.reject(new Error('SESSION_NOT_FOUND: (qa) 刷新失败不影响断言'));
    },
    /* 永不 settle：让渲染层停在流式中，用来验「流式中拒绝切换」 */
    prompt({ sessionId, text } = {}) {
      record('prompt', { sessionId, text });
      return new Promise(() => {});
    },
    abort() { record('abort', {}); return Promise.resolve({ ok: true }); },

    /* ---- 启动必需 ---- */
    getSettings() { return Promise.resolve({ sceneId: 'chat', webEnabled: true, alwaysOnTop: false }); },
    setSettings(a) { record('setSettings', a || {}); return Promise.resolve({ sceneId: 'chat', webEnabled: true, alwaysOnTop: false }); },
    setWindowState({ state } = {}) {
      record('setWindowState', { state });
      (handlers.windowState || []).forEach((h) => h({ state }));
      return Promise.resolve({ ok: true, state });
    },
    listModels() { return Promise.resolve({ current: null, defaultModel: null, models: [] }); },
    listProviders() { return Promise.resolve({ current: null, defaultModel: null, featured: [], providers: [] }); },
    listAssets() { return Promise.resolve({ items: [] }); },
    getAbout() {
      return Promise.resolve({ minipi: { version: 'qa', electron: '0', chrome: '0', node: '0', platform: 'test' }, pi: { name: 'pi', version: '0', aiVersion: '0' }, consistent: true });
    },
    onWindowState(h) { handlers.windowState.push(h); return () => {}; },
    onEvent(h) { handlers.event.push(h); return () => {}; },
    onHotkey() { return () => {}; },
    onOutcome() { return () => {}; },
    onApproval() { return () => {}; },
    onBallPeek() { return () => {}; },
    onBallMenuClosed() { return () => {}; },
  };

  window.minipi = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      return (...args) => { record(key, args.length === 1 ? args[0] : args); return Promise.resolve({ ok: true }); };
    },
  });
  return true;
})()`;

/* ---------------------------------------------------------------- CDP 骨架 */
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

async function ev(expression) {
  const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
  }
  return r.result.value;
}

/** 单条断言：一次页面往返，返回 `{pass, detail}`；抛异常只记这一条 FAIL（不连坐）。 */
async function A(label, expr) {
  let r;
  try {
    r = await ev(expr);
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

/** 动作（点击 / 注入）。失败只记一条 FAIL，不带崩整组。 */
async function act(label, expr) {
  try {
    return await ev(expr);
  } catch (err) {
    fail += 1;
    failures.push(`${label}（动作异常：${err && err.message ? err.message : err}）`);
    console.log(`  FAIL  ${label}  · 动作异常：${err && err.message ? err.message : err}`);
    return null;
  }
}

const activeRowExpr = "[...document.querySelectorAll('#sessList .sessrow[data-active=\"true\"]')].map(r => r.getAttribute('data-sess-id'))";
const toastTextsExpr = "[...document.querySelectorAll('.toast')].map(t => t.textContent.trim())";

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
  await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: HOST_SOURCE });
  await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}` });

  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      booted = await ev("document.readyState === 'complete' && !!window.__minipi && !!window.__qa && !!document.querySelector('#sessList')");
      if (booted) break;
    } catch {
      /* loading */
    }
    await sleep(250);
  }
  ok(booted, "页面就绪且假宿主已注入（渲染层走真实宿主分支）");
  if (!booted) throw new Error("页面没能在 10s 内就绪");
  await sleep(600);

  /* ================================================== 0 准备：大窗 + 2 行 */
  console.log("\n[0] 准备：切换大窗、确认列表可用");
  await act("切到大窗", "document.querySelector('#btnEnlarge').click()");
  await sleep(600);
  await A("左栏列出 2 条会话（work 一条、chat 一条）", `(() => {
    const ids = [...document.querySelectorAll('#sessList .sessrow')].map(r => r.getAttribute('data-sess-id'));
    return { pass: ids.length === 2 && ids.includes('s_qb1_0001') && ids.includes('s_qb2_0002'), detail: JSON.stringify(ids) };
  })()`);
  await A("恢复前场景是 chat（默认）", `(() => {
    const s = window.__minipi.scene();
    return { pass: s === 'chat', detail: 'scene=' + s };
  })()`);
  await A("恢复前当前会话是启动时那条（列表里没有它，所以没有高亮行）", `(() => {
    const act = ${activeRowExpr};
    return { pass: act.length === 0, detail: JSON.stringify(act) };
  })()`);

  /* ================================================== 1 造脏状态（为"清场"提供判据） */
  console.log("\n[1] 造脏状态：挂一张审批卡 + 把 seq 计数推到 5");
  await act("注入一张审批卡", `window.__minipi.injectApproval({
    approvalId: 'qa_rs_1', phase: 'push', kind: 'write', toolName: 'write', title: '写入文件',
    alwaysAllowEligible: true, createdAt: Date.now(), expiresAt: Date.now() + 300000, timeoutMs: 300000,
    batch: [{ kind: 'write', toolName: 'write', title: '写入文件', path: '~/.minipi/repo/x.md', bytes: 2048, preview: '# 标题', overwrite: true }]
  })`);
  await act("把 seq 推到 5", "window.__minipi.inject('s_boot_0001', 5, { type: 'done' })");
  await sleep(150);
  await A("脏状态就位：审批卡 1 张", `(() => {
    const n = window.__minipi.approvalCount();
    return { pass: n === 1, detail: 'approvals=' + n };
  })()`);
  await A("脏状态就位：seq.lastSeq 已经是 5", `(() => {
    const q = window.__minipi.seq();
    return { pass: q.lastSeq === 5, detail: JSON.stringify(q) };
  })()`);

  /* ================================================== 2 成功恢复 */
  console.log("\n[2] 成功恢复：点 work 会话那一行");
  await act("清调用记录", "window.__qa.calls.length = 0; true");
  await act("点 s_qb1_0001 行", `document.querySelector('.sessrow[data-sess-id="s_qb1_0001"] .sessrow__main').click(); true`);
  await sleep(900);

  await A("点击发出了 resumeSession({id})，且只发了一次", `(() => {
    const calls = window.__qa.calls.filter(c => c.kind === 'resumeSession');
    return { pass: calls.length === 1 && calls[0].args.id === 's_qb1_0001', detail: JSON.stringify(calls.map(c => c.args)) };
  })()`);
  await A("★ ② 恢复后当前会话换成新 id（高亮行 = s_qb1_0001，且只有一行）", `(() => {
    const act = ${activeRowExpr};
    return { pass: act.length === 1 && act[0] === 's_qb1_0001', detail: JSON.stringify(act) };
  })()`);
  await A("★ ② 不是 Object.assign 叠旧值：旧会话的 model 没被带过来（#fullModel 显示「—」）", `(() => {
    const el = document.querySelector('#fullModel');
    if (!el) return { pass: false, detail: '没有 #fullModel' };
    const txt = el.textContent.trim();
    return { pass: txt === '—' || txt === '', detail: 'fullModel=' + JSON.stringify(txt) };
  })()`);
  await A("★ ③ store.scene 跟着 r.sceneId 变成 work", `(() => {
    const s = window.__minipi.scene();
    return { pass: s === 'work', detail: 'scene=' + s };
  })()`);
  await A("★ ④ restoredNote 渲染成一句说明（#fullTree 顶部说明行含「已恢复」）", `(() => {
    const notes = [...document.querySelectorAll('#fullTree .mini__note')].map(e => e.textContent.trim());
    const hit = notes.find(t => t.includes('已恢复')) || '';
    return { pass: hit.includes('已恢复「上次的会话（办公产出）」') && /条历史消息/.test(hit), detail: JSON.stringify(notes) };
  })()`);
  await A("★ 恢复说明行挂在对话流**最顶部**（插在历史前面，不是末尾）", `(() => {
    const first = document.querySelector('#fullTree .mini__note');
    const tree = document.querySelector('#fullTree');
    const firstTurn = tree ? tree.querySelector('.turn, .msg, [data-turn]') : null;
    if (!first) return { pass: false, detail: '没有说明行' };
    const isFirst = tree.firstElementChild === first;
    const beforeTurn = firstTurn ? (first.compareDocumentPosition(firstTurn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : true;
    return { pass: isFirst && beforeTurn, detail: 'firstChild=' + isFirst + ' beforeTurn=' + beforeTurn };
  })()`);
  await A("★ 清场：审批卡被清空（resetConversationState 真的跑了）", `(() => {
    const n = window.__minipi.approvalCount();
    return { pass: n === 0, detail: 'approvals=' + n };
  })()`);
  /* ⚠ 这条断言曾经写成 `q.sessions.length === 0`，把「perSession 必须为空」当成清场成功的判据 ——
     那是**错的**：恢复分支按 MIN-3 的设计要给 perSession 种一个种子（index.html 的
     `store.seq.perSession.set(r.sessionId, Number(r.lastSeq) || 0)`），否则首条事件会被判跳号。
     真正要守的是：① lastSeq 归零；② 没有残留别的会话的计数（多一条就说明清场漏了）。 */
  await A("★ 清场：seq 计数归零（历史重放不能顶着旧 lastSeq，否则新事件会被判重复）", `(() => {
    const q = window.__minipi.seq();
    const onlyOwnSeed = q.sessions.length === 0
      || (q.sessions.length === 1 && q.sessions[0] === 's_qb1_0001');
    return { pass: q.lastSeq === 0 && q.seen === 0 && q.dupes === 0 && onlyOwnSeed, detail: JSON.stringify(q) };
  })()`);
  await A("MIN-3：恢复后 perSession 里有该会话的种子（首条事件不会被判跳号）", `(() => {
    const q = window.__minipi.seq();
    const seeded = q.sessions.length === 1 && q.sessions[0] === 's_qb1_0001';
    return { pass: seeded, detail: JSON.stringify(q) };
  })()`);
  await A("⑥ 历史被回填成轮次（turns ≥ 1）", `(() => {
    const n = window.__minipi.turns();
    return { pass: n >= 1, detail: 'turns=' + n };
  })()`);
  await A("⑥ store 里有历史文本（textLen > 0）", `(() => {
    const n = window.__minipi.textLen();
    return { pass: n > 0, detail: 'textLen=' + n };
  })()`);
  await A("⑥ DOM 里能看到上次对话的原文（「三段式」）", `(() => {
    const txt = document.querySelector('#fullTree') ? document.querySelector('#fullTree').textContent : '';
    return { pass: txt.includes('三段式'), detail: 'len=' + txt.length };
  })()`);

  /* ================================================== 3 失败恢复：不许改半截 */
  console.log("\n[3] 失败恢复：resumeSession 抛错 → 当前会话 / turns / 场景一个都不许动");
  const beforeFail = await ev(`(() => ({
    turns: window.__minipi.turns(),
    textLen: window.__minipi.textLen(),
    scene: window.__minipi.scene(),
    active: ${activeRowExpr},
  }))()`);
  await act("让宿主下一次 resumeSession 抛错", "window.__qa.setFailResume(true)");
  await act("清调用记录", "window.__qa.calls.length = 0; true");
  await act("点 s_qb2_0002 行（这次会失败）", `document.querySelector('.sessrow[data-sess-id="s_qb2_0002"] .sessrow__main').click(); true`);
  await sleep(700);

  await A("失败时确实调了宿主一次（不是压根没发）", `(() => {
    const n = window.__qa.count('resumeSession');
    return { pass: n === 1, detail: 'resumeSession×' + n };
  })()`);
  await A("★ ⑤ 失败给明确报错（toast 含「恢复失败」）", `(() => {
    const texts = ${toastTextsExpr};
    const hit = texts.find(t => t.includes('恢复失败')) || '';
    return { pass: hit.includes('恢复失败') && /会话不存在/.test(hit), detail: JSON.stringify(texts) };
  })()`);
  await A("★ ⑤ 失败后当前会话没被换掉（高亮行仍是 s_qb1_0001）", `(() => {
    const act = ${activeRowExpr};
    return { pass: act.length === 1 && act[0] === 's_qb1_0001', detail: JSON.stringify(act) };
  })()`);
  await A("★ ⑤ 失败后 turns / textLen 一个字节都没动", `(() => {
    const now = { turns: window.__minipi.turns(), textLen: window.__minipi.textLen(), scene: window.__minipi.scene() };
    const same = now.turns === ${beforeFail.turns} && now.textLen === ${beforeFail.textLen} && now.scene === ${JSON.stringify(beforeFail.scene)};
    return { pass: same, detail: JSON.stringify(now) + ' vs ' + JSON.stringify(${JSON.stringify({ turns: beforeFail.turns, textLen: beforeFail.textLen, scene: beforeFail.scene })}) };
  })()`);
  await act("恢复宿主为成功模式", "window.__qa.setFailResume(false)");

  /* ================================================== 4 流式中拒绝切换 */
  console.log("\n[4] 流式中点别的会话 → 不切换 + 给提示");
  await act("在大窗输入框发一句话（宿主 prompt 永不返回 ⇒ 一直流式）", `(() => {
    const el = document.querySelector('#fullInput');
    el.value = '这条会一直挂着';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btnSendFull').click();
    return true;
  })()`);
  await sleep(500);
  const streamingSnap = await ev(`(() => {
    const abort = document.querySelector('#btnAbortFull');
    return {
      turns: window.__minipi.turns(),
      abortEnabled: !!abort && abort.disabled === false,
      promptCalls: window.__qa.count('prompt'),
    };
  })()`);
  ok(
    streamingSnap && streamingSnap.promptCalls === 1 && streamingSnap.abortEnabled === true,
    "确实进入了流式中（prompt 已发出、中断按钮可用）",
    JSON.stringify(streamingSnap),
  );

  await act("清调用记录", "window.__qa.calls.length = 0; true");
  await act("流式中点 s_qb2_0002 行", `document.querySelector('.sessrow[data-sess-id="s_qb2_0002"] .sessrow__main').click(); true`);
  await sleep(500);
  await A("★ ① 流式中不切换：resumeSession 一次都没发", `(() => {
    const n = window.__qa.count('resumeSession');
    return { pass: n === 0, detail: 'resumeSession×' + n };
  })()`);
  await A("★ ① 给了一句可操作的提示（toast 含「先中断再切换会话」）", `(() => {
    const texts = ${toastTextsExpr};
    const hit = texts.find(t => t.includes('中断')) || '';
    return { pass: hit.includes('先中断再切换会话'), detail: JSON.stringify(texts) };
  })()`);
  await A("★ ① 被拒后当前会话仍是 s_qb1_0001（没被切走）", `(() => {
    const act = ${activeRowExpr};
    return { pass: act.length === 1 && act[0] === 's_qb1_0001', detail: JSON.stringify(act) };
  })()`);
  await A("★ ① 被拒后场景仍是 work（没有被改成 chat）", `(() => {
    const s = window.__minipi.scene();
    return { pass: s === 'work', detail: 'scene=' + s };
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
  try {
    if (chrome && chrome.pid) spawn("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(400);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log("\n" + "=".repeat(74));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项 · 未测到 ${skip} 项`);
if (fail > 0) console.log(` 失败项：\n   ✗ ${failures.join("\n   ✗ ")}`);
if (skip > 0) console.log(` 未测到：\n   · ${skipped.join("\n   · ")}`);
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
