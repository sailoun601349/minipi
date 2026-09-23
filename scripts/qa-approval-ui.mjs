#!/usr/bin/env node
/**
 * M4.5 渲染层审批卡 —— 纯 DOM 断言（headless Chrome + CDP）。
 *
 * 本机 Electron GPU 崩、起不了真 UI，故走 headless Chrome + CDP，
 * 在 **mock 模式**下注入审批卡，断言渲染结果。
 *
 * ⚠ 覆盖边界（如实说明，别当成「真 UI 点击」）：
 *   · 本脚本验证的是 **DOM 结构与状态**（三类模板字段、三按钮集与文案、
 *     倒计时文本、勾选框默认态、到 0 置灰、溢出/高度），
 *     以及 `applyApprovalCard` 的 push/update/cancel 状态机。
 *   · **不验证**：真主进程 IPC 往返、真点击触发 shell 执行、真超时被服务端拒绝。
 *     这些属主进程侧行为，渲染层无法自证。
 *   · 「到 0 置灰后等 cancel 移除」用**注入 + 手动等 cancel** 验证状态机，
 *     不做真实 5 分钟等待（用短超时卡加速）。
 *
 * 运行：`node scripts/qa-approval-ui.mjs`
 * 若本机无 Chrome：跳过 headless，退出码 1（明确「未测到」，不伪绿）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9393;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-approval-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const findings = [];
function ok(cond, label, extra) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}${extra ? `  · ${extra}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${extra ? `  · ${extra}` : ""}`); }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);
function finding(level, id, title, detail) {
  findings.push({ level, id, title, detail });
  console.log(`  >>> [${level}] ${id} ${title}`);
}
function finish() {
  console.log("\n======================================================================");
  console.log(` 通过 ${passed} 项 · 失败 ${failed} 项`);
  if (findings.length > 0) {
    console.log(` 发现 ${findings.length} 条：`);
    for (const f of findings) console.log(`   [${f.level}] ${f.id} · ${f.title}`);
  }
  console.log(" 覆盖边界：本脚本断言 DOM 结构与状态机；不覆盖真 IPC 往返 / 真点击执行 / 真服务端超时。");
  console.log("======================================================================");
}

console.log("======================================================================");
console.log(" M4.5 · 渲染层审批卡 · 纯 DOM 断言");
console.log("======================================================================");

/* ---------------- C0：静态审查（不依赖 Chrome） ---------------- */
group("[A0] 静态审查：契约镜像与关键接线存在");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  ok(/const APPROVAL_ACTIONS = Object\.freeze\(\['allowOnce', 'deny', 'terminate'\]\)/.test(html), "APPROVAL_ACTIONS 镜像存在且三值正确");
  ok(/function applyApprovalCard/.test(html), "applyApprovalCard 存在");
  ok(/function buildApprovalCard/.test(html), "buildApprovalCard 存在");
  ok(/function tickApprovals/.test(html), "tickApprovals 倒计时函数存在");
  ok(/host\.onApproval\(/.test(html), "已接 host.onApproval");
  ok(/host\.approvalDecide\(/.test(html), "已调 host.approvalDecide");
  // 铁律：不允许把 action 硬编码成三个按钮（必须从 card.actions 迭代）
  ok(/for \(const action of card\.actions\)/.test(html), "三按钮由 card.actions 迭代（未硬编码）");
  // 默认不勾
  ok(/cb\.checked = false;/.test(html), "勾选框默认不勾");
}

/* ---------------- Chrome 就绪 ---------------- */
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

let chrome = null;
let conn = null;

async function cdpTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error("找不到 CDP page target");
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params) {
        id += 1;
        const mid = id;
        return new Promise((res, rej) => {
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    }));
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

if (!CHROME) {
  ok(false, "本机无 Chrome → 无法执行 headless 断言（明确「未测到」，不伪绿）");
} else {
  ok(true, `找到 Chrome：${CHROME}`);
  try {
    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=400,600", "--allow-file-access-from-files",
      `file:///${HTML_PATH.replace(/\\/g, "/")}`,
    ], { detached: true, stdio: "ignore" });

    const page = await cdpTargets();
    conn = await connect(page.webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1500);
    const ready = await evaluate("window.__minipi ? window.__minipi.mock() : null");
    ok(ready === true, "window.__minipi 探针就绪（mock 模式）", `mock=${ready}`);

    // 切到小窗，并清空审批
    await evaluate("window.__minipi && (document.querySelector('[data-mock=\"mode-mini\"]').click(), true)");
    await sleep(150);

    const base = (over) => `window.__minipi.injectApproval(Object.assign({
      approvalId:'a_test', sessionId:'s_1', phase:'push',
      kind:'edit', toolName:'edit', title:'修改文件',
      actions:['allowOnce','deny','terminate'], alwaysAllowEligible:true,
      createdAt: Date.now(), expiresAt: Date.now()+300000, timeoutMs:300000,
      batch:[{ kind:'edit', toolName:'edit', title:'修改文件', path:'~/.minipi/repo/src/a.js',
        diff:'@@ edit 1/1\\n- const a = 1;\\n+ const a = 2;', diffStat:{added:1,removed:1}, tooLargeToDiff:false }]
    }, ${JSON.stringify(over)}))`;

    /* ========================================================= [A1] write 卡 */
    group("[A1] write 卡：preview + bytes + overwrite 重警示");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_w', phase:'push', kind:'write', toolName:'write', title:'写入文件', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'write', toolName:'write', title:'写入文件', path:'~/.minipi/repo/x.md', bytes:2048, preview:'# 标题\\n正文', overwrite:true}]})");
      await sleep(120);
      const txt = await evaluate("window.__minipi.approvalDomText()");
      ok(/写入文件/.test(txt), "显示标题「写入文件」", txt.slice(0, 40));
      ok(/x\.md/.test(txt), "显示路径 x.md");
      ok(/2\.0 KB|2048 B/.test(txt), "显示字节数");
      ok(/覆盖/.test(txt), "overwrite:true 有覆盖警示", "含「覆盖」");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_w', phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A2] edit 卡 */
    group("[A2] edit 卡：真实 diff（+N -M 着色）");
    {
      await evaluate(base({}));
      await sleep(120);
      const snap = await evaluate("(()=>{const c=document.querySelector('#miniBody .approval');return {diffTxt:c.querySelector('.approval__diff')?c.querySelector('.approval__diff').textContent:'', add:c.querySelectorAll('.d-add').length, del:c.querySelectorAll('.d-del').length, stat:c.querySelector('.approval__stat')?c.querySelector('.approval__stat').textContent:''};})()");
      ok(snap.add >= 1 && snap.del >= 1, "diff 含新增(+)与删除(-)行并着色", `add=${snap.add}/del=${snap.del}`);
      ok(/\+1/.test(snap.stat) && /-1/.test(snap.stat), "显示 diffStat +1 -1", snap.stat);
      ok(/const a = 2/.test(snap.diffTxt), "diff 文本含真实改动内容", snap.diffTxt.slice(0, 40));
      await evaluate("window.__minipi.injectApproval({approvalId:'a_test', phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A3] command 卡 */
    group("[A3] command 卡：全命令原样 + 高危红标 + timeout");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_c', phase:'push', kind:'command', toolName:'bash', title:'执行命令', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'command', toolName:'bash', title:'执行命令', shell:'bash', command:'rm -rf node_modules && npm ci', timeoutSec:120, risk:'high'}]})");
      await sleep(120);
      const s = await evaluate("(()=>{const c=document.querySelector('#miniBody .approval');const pre=c.querySelector('.approval__code');return {cmd:pre?pre.textContent:'', risk:pre?pre.classList.contains('approval__code--risk'):false, warn:!!c.querySelector('.approval__warn'), txt:c.textContent};})()");
      ok(s.cmd === 'rm -rf node_modules && npm ci', "命令原样全文显示（未脱敏）", s.cmd);
      ok(s.risk === true, "risk:high → 代码块加红色样式");
      ok(s.warn === true, "risk:high → 显示高危警示");
      ok(/120s|超时 120/.test(s.txt), "显示 timeoutSec", "含超时");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_c', phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A4] 三按钮 + 勾选框 */
    group("[A4] 三按钮（恒以 actions 为准）+「本会话总是允许」默认不勾");
    {
      await evaluate(base({}));
      await sleep(120);
      const snap = await evaluate("window.__minipi.approvalSnapshot()");
      ok(JSON.stringify(snap.actions) === JSON.stringify(['allowOnce', 'deny', 'terminate']), "三按钮 action 值 = allowOnce/deny/terminate", JSON.stringify(snap.actions));
      ok(JSON.stringify(snap.actionLabels) === JSON.stringify(['允许一次', '拒绝', '中断整轮']), "三按钮文案 = 允许一次/拒绝/中断整轮", JSON.stringify(snap.actionLabels));
      ok(snap.hasRememberBox === true, "alwaysAllowEligible:true → 画勾选框");
      ok(snap.rememberChecked === false, "勾选框默认不勾");

      // actions 子集：只给 allowOnce/deny → 只画两个按钮（验证不硬编码）
      await evaluate("window.__minipi.injectApproval({approvalId:'a_subset', phase:'push', kind:'edit', toolName:'edit', title:'x', alwaysAllowEligible:false, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, actions:['allowOnce','deny'], batch:[{kind:'edit', toolName:'edit', title:'x', path:'a', diff:'@', diffStat:{added:0,removed:0}}]})");
      await sleep(120);
      const snap2 = await evaluate("(()=>{const c=document.querySelector('#miniBody .approval[data-approval-id=\"a_subset\"]');return {acts:[...c.querySelectorAll('[data-approval-action]')].map(b=>b.getAttribute('data-approval-action')), hasRemember:!!c.querySelector('[data-approval-remember]')};})()");
      ok(JSON.stringify(snap2.acts) === JSON.stringify(['allowOnce', 'deny']), "actions 给两项 → 只画两项（证明以 card.actions 为准）", JSON.stringify(snap2.acts));
      ok(snap2.hasRemember === false, "alwaysAllowEligible:false → 不画勾选框");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_test', phase:'cancel'});window.__minipi.injectApproval({approvalId:'a_subset', phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A5] 倒计时 */
    group("[A5] 倒计时：文本 + 到 0 置灰 + 保留卡（等 cancel）");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_short', phase:'push', kind:'edit', toolName:'edit', title:'修改文件', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+1500, timeoutMs:1500, actions:['allowOnce','deny','terminate'], batch:[{kind:'edit', toolName:'edit', title:'修改文件', path:'~/.minipi/repo/a.js', diff:'@@\\n- a\\n+ b', diffStat:{added:1,removed:1}}]})");
      await sleep(200);
      const t1 = await evaluate("(()=>{const el=document.querySelector('#miniBody [data-approval-timer]');return el?el.textContent:null;})()");
      ok(/^剩 0:0\d$|^剩 0:1\d$/.test(t1 || ""), "倒计时显示「剩 m:ss」", t1);
      // 等它过期（短路：注入一张已过期的卡，避免依赖真实秒级等待的抖动）
      await evaluate("window.__minipi.injectApproval({approvalId:'a_short', phase:'update', kind:'edit', toolName:'edit', title:'修改文件', alwaysAllowEligible:true, createdAt:Date.now()-9000, expiresAt:Date.now()-1000, timeoutMs:1500, actions:['allowOnce','deny','terminate'], batch:[{kind:'edit', toolName:'edit', title:'修改文件', path:'~/.minipi/repo/a.js', diff:'@@\\n- a\\n+ b', diffStat:{added:1,removed:1}}]})");
      await sleep(1200);   // 让至少一次 tickApprovals 跑过
      const snap = await evaluate("window.__minipi.approvalSnapshot()");
      ok(snap.expired === true, "到 0 → 卡片加 .approval--expired（置灰）");
      ok(snap.timerText === '已超时', "到 0 → 倒计时文本变「已超时」", snap.timerText);
      ok(snap.buttonsDisabled.every((d) => d === true), "到 0 → 三按钮全部禁用", JSON.stringify(snap.buttonsDisabled));
      const stillThere = await evaluate("window.__minipi.approvalCount()");
      ok(stillThere >= 1, "到 0 **不移除**卡片（等后端 cancel）", `count=${stillThere}`);
      // 推 cancel → 移除
      await evaluate("window.__minipi.injectApproval({approvalId:'a_short', phase:'cancel'})");
      await sleep(100);
      const after = await evaluate("window.__minipi.approvalCount()");
      const cardGone = await evaluate("!document.querySelector('#miniBody .approval[data-approval-id=\\'a_short\\']')");
      ok(after === 0 && cardGone === true, "cancel 到达 → 移除该卡", `count=${after}`);
    }

    /* ========================================================= [A6] 多卡 / 去重 */
    group("[A6] 按 approvalId 索引：多卡共存 + 同 id update 去重");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_1', phase:'push', kind:'edit', toolName:'edit', title:'卡1', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'edit',toolName:'edit',title:'卡1',path:'a',diff:'@',diffStat:{added:0,removed:0}}]})");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_2', phase:'push', kind:'write', toolName:'write', title:'卡2', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'write',toolName:'write',title:'卡2',path:'b',bytes:1,preview:'x',overwrite:false}]})");
      await sleep(120);
      const cnt = await evaluate("window.__minipi.approvalCount()");
      ok(cnt === 2, "两张不同 id 的卡共存（未假设单卡）", `count=${cnt}`);
      // 同 id 再推 push → 仍是 2（去重）
      await evaluate("window.__minipi.injectApproval({approvalId:'a_1', phase:'push', kind:'edit', toolName:'edit', title:'卡1-改', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'edit',toolName:'edit',title:'卡1-改',path:'a',diff:'@',diffStat:{added:0,removed:0}}]})");
      await sleep(100);
      const cnt2 = await evaluate("window.__minipi.approvalCount()");
      ok(cnt2 === 2, "同 id 重推（push/update）→ 就地更新，不新增", `count=${cnt2}`);
      const titleUpdated = await evaluate("!!document.querySelector('#miniBody .approval[data-approval-id=\"a_1\"]')");
      ok(titleUpdated === true, "更新后卡仍在（内容替换）");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_1',phase:'cancel'});window.__minipi.injectApproval({approvalId:'a_2',phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A7] 合并卡 + 360 不溢出 */
    group("[A7] 合并卡（3 项）+ 360×480 不溢出/高度可控");
    {
      await evaluate(`window.__minipi.injectApproval({approvalId:'a_mix', phase:'push', kind:null, toolName:null, title:'共 3 项', alwaysAllowEligible:false, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, actions:['allowOnce','deny','terminate'], batch:[
        {kind:'write',toolName:'write',title:'写入文件',path:'~/.minipi/repo/docs/学习笔记.md',bytes:2048,preview:'# 学习笔记\\n- 一阶泰勒展开\\n- 二阶项可忽略',overwrite:false},
        {kind:'edit',toolName:'edit',title:'修改文件',path:'~/.minipi/repo/src/main/pi/session.js',diff:'@@ edit 1/1\\n- const timeout = 30000;\\n+ const timeout = 60000;',diffStat:{added:1,removed:1},tooLargeToDiff:false},
        {kind:'command',toolName:'bash',title:'执行命令',shell:'bash',command:'rm -rf node_modules && npm ci',timeoutSec:120,risk:'high'}
      ]})`);
      await sleep(150);
      const cnt = await evaluate("window.__minipi.approvalCount()");
      ok(cnt === 1, "合并卡是 1 张卡（含 3 条 batch）", `count=${cnt}`);
      const items = await evaluate("document.querySelectorAll('#miniBody .approval__item').length");
      ok(items === 3, "渲染出 3 条 batch item", `items=${items}`);
      const ovf = await evaluate("window.__minipi.approvalOverflow()");
      ok(ovf && ovf.overflows === false, "小窗页面级不横向溢出（#miniBody 口径，非卡级）", JSON.stringify(ovf));
      const met = await evaluate("window.__minipi.approvalMetrics()");
      ok(met && met.bodyOverflowsX === false, "小窗主体不横向溢出（360 宽）", JSON.stringify(met));
      // 360 宽下卡片宽度不应超过主体
      ok(met && met.cardHeight > 0, "卡片有正高度（渲染出来）", `h=${met && Math.round(met.cardHeight)}`);
      const winW = await evaluate("(()=>{const m=document.querySelector('#miniRoot')||document.body;return window.innerWidth;})()");
      console.log(`  note  当前视口宽 ${winW}（headless window-size 400；真实 mini=360，由 CSS 固定 #stage 360×480）`);
      // 强断言：mock 下 #stage 恒为 360×480，卡片右边界不得超出 stage（横向硬约束）
      const geo = await evaluate("(()=>{const stage=document.querySelector('#stage');const c=document.querySelector('#miniBody .approval');if(!stage||!c)return null;const s=stage.getBoundingClientRect();const r=c.getBoundingClientRect();return {stageW:s.width, cardRight:r.right, stageRight:s.right, overflowRight:r.right>s.right+0.5, cardW:r.width};})()");
      ok(geo && geo.stageW === 360, "mock stage 固定 360 宽（真实 mini 约束）", geo ? `stageW=${geo.stageW}` : "无 stage");
      ok(geo && geo.overflowRight === false, "审批卡右边界不超出 360 宽 stage（横向不溢出）", geo ? `cardRight=${Math.round(geo.cardRight)} stageRight=${Math.round(geo.stageRight)}` : "n/a");
      // 单条（非合并）卡应能装进 480 高可视区（合并卡允许纵向滚动，不硬断言）
      await evaluate("window.__minipi.injectApproval({approvalId:'a_mix',phase:'cancel'})");
      await sleep(60);
      await evaluate("window.__minipi.injectApproval({approvalId:'a_one', phase:'push', kind:'command', toolName:'bash', title:'执行命令', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, actions:['allowOnce','deny','terminate'], batch:[{kind:'command',toolName:'bash',title:'执行命令',shell:'bash',command:'npm test',timeoutSec:null,risk:'normal'}]})");
      await sleep(150);
      const one = await evaluate("window.__minipi.approvalMetrics()");
      ok(one && one.cardHeight <= 480, "单条 command 卡高度 ≤ 480（装得进小窗可视区）", one ? `h=${Math.round(one.cardHeight)}` : "n/a");
      await evaluate("window.__minipi.injectApproval({approvalId:'a_one',phase:'cancel'})");
      await sleep(60);
      await evaluate("window.__minipi.injectApproval({approvalId:'a_mix', phase:'push', kind:null, toolName:null, title:'共 3 项', alwaysAllowEligible:false, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, actions:['allowOnce','deny','terminate'], batch:[{kind:'write',toolName:'write',title:'写入文件',path:'~/.minipi/repo/docs/n.md',bytes:2048,preview:'# x',overwrite:false},{kind:'edit',toolName:'edit',title:'修改文件',path:'~/.minipi/repo/src/s.js',diff:'@@ edit 1/1\\n- a\\n+ b',diffStat:{added:1,removed:1}},{kind:'command',toolName:'bash',title:'执行命令',shell:'bash',command:'npm test',timeoutSec:null,risk:'normal'}]})");
      await sleep(120);
      await evaluate("window.__minipi.injectApproval({approvalId:'a_mix',phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A8] 边界：畸形卡不崩 */
    group("[A8] 边界：畸形 / 缺字段卡不崩");
    {
      const weird = [
        { approvalId: 'a_e1', phase: 'push', batch: null },
        { approvalId: 'a_e2', phase: 'push', kind: 'weird', batch: [{ kind: 'weird' }] },
        { approvalId: 'a_e3', phase: 'push', batch: [] },
        { approvalId: '', phase: 'push' },
        null,
      ];
      let threw = false;
      for (let i = 0; i < weird.length; i += 1) {
        try {
          await evaluate(`window.__minipi.injectApproval(${JSON.stringify(weird[i])})`);
          await sleep(60);
        } catch (e) { threw = true; finding("P2", "A8-THROW", `畸形卡 ${i} 令渲染抛错`, String(e)); }
      }
      ok(!threw, "5 张畸形卡注入均不抛错");
      // 清理
      await evaluate("['a_e1','a_e2','a_e3'].forEach(id=>window.__minipi.injectApproval({approvalId:id,phase:'cancel'}))");
      await sleep(80);
    }

    /* ========================================================= [A9] XSS：命令/diff 不注入 */
    group("[A9] XSS：command / preview 里的脚本不执行");
    {
      await evaluate(`window.__minipi.injectApproval({approvalId:'a_xss', phase:'push', kind:'command', toolName:'bash', title:'执行命令', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'command', toolName:'bash', title:'执行命令', shell:'bash', command:'<img src=x onerror="window.__pwned_ap=1">', timeoutSec:null, risk:'normal'}]})`);
      await sleep(150);
      const pwned = await evaluate("window.__pwned_ap === undefined");
      const handlers = await evaluate("(()=>{let h=0;document.querySelectorAll('#miniBody .approval *').forEach(el=>{for(const a of el.attributes) if(/^on/i.test(a.name)) h++;});return h;})()");
      ok(pwned === true, "命令里的 onerror 未执行（window.__pwned_ap 未定义）");
      ok(handlers === 0, "审批卡内无 on* 事件属性", `handlers=${handlers}`);
      const cmdTxt = await evaluate("document.querySelector('#miniBody .approval__code').textContent");
      ok(/onerror/.test(cmdTxt), "命令文本原样可见（未被吞）", cmdTxt.slice(0, 40));
      await evaluate("window.__minipi.injectApproval({approvalId:'a_xss',phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A10] 横幅 */
    group("[A10] 顶部横幅：有未决审批时显示、撤回后隐藏");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_b', phase:'push', kind:'edit', toolName:'edit', title:'修改文件', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, batch:[{kind:'edit',toolName:'edit',title:'修改文件',path:'a',diff:'@',diffStat:{added:0,removed:0}}]})");
      await sleep(150);
      const bannerShown = await evaluate("!document.querySelector('#miniBanner').hidden");
      ok(bannerShown === true, "有未决审批 → 横幅显示");
      const bannerTxt = await evaluate("document.querySelector('#bannerText').textContent");
      ok(/等待你确认 1 个操作/.test(bannerTxt), "横幅文案含条数", bannerTxt);
      await evaluate("window.__minipi.injectApproval({approvalId:'a_b',phase:'cancel'})");
      await sleep(150);
      const bannerHidden = await evaluate("document.querySelector('#miniBanner').hidden");
      ok(bannerHidden === true, "撤回后 → 横幅隐藏");
    }

    /* ========================================================= [A11] actions 全非法 → 回退三按钮（P2-UI-1） */
    group("[A11] actions 非空但全非法 → 回退契约镜像三按钮（不死卡，P2-UI-1 回归）");
    {
      await evaluate("window.__minipi.injectApproval({approvalId:'a_allbad', phase:'push', kind:'edit', toolName:'edit', title:'修改文件', alwaysAllowEligible:true, createdAt:Date.now(), expiresAt:Date.now()+300000, timeoutMs:300000, actions:['allow','evil'], batch:[{kind:'edit',toolName:'edit',title:'修改文件',path:'a',diff:'@',diffStat:{added:0,removed:0}}]})");
      await sleep(120);
      const acts = await evaluate("[...document.querySelectorAll('#miniBody .approval[data-approval-id=\"a_allbad\"] [data-approval-action]')].map(b=>b.getAttribute('data-approval-action'))");
      ok(JSON.stringify(acts) === JSON.stringify(['allowOnce','deny','terminate']), "actions 全非法 → 回退三按钮（allowOnce/deny/terminate），而非 0 按钮", JSON.stringify(acts));
      const disabled = await evaluate("[...document.querySelectorAll('#miniBody .approval[data-approval-id=\"a_allbad\"] [data-approval-action]')].map(b=>b.disabled)");
      ok(Array.isArray(disabled) && disabled.length === 3 && disabled.every((d) => d === false), "回退后的三按钮全部可点（非死卡）", JSON.stringify(disabled));
      await evaluate("window.__minipi.injectApproval({approvalId:'a_allbad',phase:'cancel'})");
      await sleep(80);
    }

    /* ========================================================= [A12] 点 full 副本 → deciding 只加 full（P3-UI-1） */
    group("[A12] 点 full 副本 → full 副本 deciding、mini 副本不动（P3-UI-1 回归）");
    {
      await evaluate("['a_allbad'].forEach(id=>window.__minipi.injectApproval({approvalId:id,phase:'cancel'}))");
      // 用 mock 生成的卡（进 renderer store + mock approvalStore），保证 decide 不 reject、deciding 态可稳定观测
      await evaluate("document.querySelector('[data-mock=\"approval-edit\"]').click(), true");
      await sleep(150);
      const id = await evaluate("(()=>{const c=document.querySelector('#fullTree .approval[data-approval-id]');return c?c.getAttribute('data-approval-id'):null;})()");
      if (!id) {
        ok(false, "[A12] 未能生成 mock 卡（前置失败）");
      } else {
        const both = await evaluate(`(()=>{const m=document.querySelector('#miniBody .approval[data-approval-id="${id}"]');const f=document.querySelector('#fullTree .approval[data-approval-id="${id}"]');return {mini:!!m, full:!!f};})()`);
        ok(both.mini === true && both.full === true, "mini 与 full 各渲染一份审批卡", JSON.stringify(both));
        // 点 full 副本的 allowOnce（dispatchEvent 冒泡到 document 委托）
        const clickRes = await evaluate(`(()=>{const b=document.querySelector('#fullTree .approval[data-approval-id="${id}"] [data-approval-action="allowOnce"]');if(!b)return 'NO_BTN';if(b.disabled)return 'DISABLED';b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return 'CLICKED';})()`);
        ok(clickRes === 'CLICKED', "点击 full 副本 allowOnce 成功", clickRes);
        await sleep(50); // 远小于 mock 260ms 撤卡窗口，确保观察到 deciding 态
        const state = await evaluate(`(()=>{const m=document.querySelector('#miniBody .approval[data-approval-id="${id}"]');const f=document.querySelector('#fullTree .approval[data-approval-id="${id}"]');return {miniDeciding:m?m.classList.contains('approval--deciding'):null, fullDeciding:f?f.classList.contains('approval--deciding'):null, miniBtns:m?[...m.querySelectorAll('[data-approval-action]')].map(b=>b.disabled):null, fullBtns:f?[...f.querySelectorAll('[data-approval-action]')].map(b=>b.disabled):null};})()`);
        ok(state.fullDeciding === true, "点 full 副本 → full 副本进入 deciding", JSON.stringify(state));
        ok(state.miniDeciding === false, "点 full 副本 → mini 副本**不**进入 deciding", JSON.stringify(state));
        ok(state.fullBtns && state.fullBtns.length >= 1 && state.fullBtns.every((d) => d === true), "full 副本按钮 disabled（防连点）", JSON.stringify(state.fullBtns));
        ok(state.miniBtns && state.miniBtns.length >= 1 && state.miniBtns.every((d) => d === false), "mini 副本按钮保持可点（未被误禁用）", JSON.stringify(state.miniBtns));
        await evaluate(`window.__minipi.injectApproval({approvalId:'${id}',phase:'cancel'})`);
        await sleep(80);
      }
    }

  } catch (err) {
    finding("P1", "A-HARNESS", "headless 测试过程抛错（环境问题，非产品缺陷）", String(err));
    ok(false, `headless 测试完成（异常：${String(err).slice(0, 140)}）`);
  } finally {
    // ⚠ Windows 上 chrome.kill() 偶发把进程组带崩（SIGTERM），先打印汇总再动进程（同秦戈）。
    finish();
    try { conn && conn.close(); } catch { /* ignore */ }
    try { chrome && chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(failed > 0 ? 1 : 0);
  }
}

// 无 Chrome 时也走统一出口（上面的 finally 已 process.exit，正常不会到这）
finish();
process.exit(failed > 0 ? 1 : 0);
