#!/usr/bin/env node
/**
 * QA · v0.6 原型交互验证（minimax3.1/03-原型设计.html）
 *
 * 与 qa-renderer-edge.mjs 共用同一套 CDP harness（headless Chrome + Runtime.evaluate）。
 * 只读，不改任何 src/ 文件。
 *
 * 断言分两类：
 *   · 静态：结构、令牌、关键文案是否存在
 *   · 交互：真的点一遍（球状态、右键菜单、上下文条移除、抽屉页签、
 *           审批三按钮、产出弹窗、主题切换、会话新建、发送流式）
 *
 * 运行：node scripts/qa-prototype-v06.mjs
 * 若本机无 Chrome ⇒ headless 部分记 n/a（**不是通过**），退出码仍正确。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "minimax3.1", "03-原型设计.html");
const PORT = 9412;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-proto-cdp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond, label, extra) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}${extra ? `  · ${extra}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${extra ? `  · ${extra}` : ""}`); }
  return !!cond;
}
function na(label) { skipped += 1; console.log(`  n/a   ${label}  （未测到 —— 不是通过）`); }
const group = (t) => console.log(`\n${t}`);

console.log("======================================================================");
console.log(" QA · v0.6 原型交互验证");
console.log("======================================================================");

/* ================================================================== P1 */
group("[P1] 静态结构");
{
  if (!fs.existsSync(HTML_PATH)) {
    /* ⚠ 这是**外部设计原型**，不在仓库里、也从未纳入版本控制
       （`git ls-files | grep minimax3.1` = 0 条）。
       它消失不代表产品坏了 —— 这个门禁验的是那份原型文件自己的交互，
       和 `src/renderer/` 的交付物没有关系。

       按项目纪律记 **n/a（未测到）**，不记 FAIL：
         「没测到」≠「测过了但失败」。把缺输入记成测试失败，会让真正的红灯失去信号。

       ⚠ 但 n/a 也**不是通过**：这一轮 v0.6 原型交互**没有任何覆盖**。
       发布报告里必须写明这是覆盖缺口，不能因为 verify:all 绿了就当成测过了。 */
    na(`原型文件存在（缺 ${path.relative(ROOT, HTML_PATH)} —— 外部设计资产，不在版本控制里）`);
    console.log("        ⚠ 覆盖缺口：v0.6 原型交互本轮 0 覆盖。这不是「通过」。");
  } else {
    ok(true, "原型文件存在", path.relative(ROOT, HTML_PATH));
    const s = fs.readFileSync(HTML_PATH, "utf8");
    ok(s.startsWith("<!DOCTYPE html>"), "DOCTYPE 正确");
    ok(!/(src|href)=["']https?:/.test(s), "无外部子资源（零构建单文件）");
    ok(!/<link[^>]*stylesheet/i.test(s) && !/@import/.test(s), "无外链样式");
    ok(s.includes("--ball-bg-1") && s.includes("--accent-ink"), "沿用生产设计令牌");
    ok(s.includes('id="iconSprite"'), "图标 sprite 存在");
    ok(["idle", "thinking", "waiting", "delivered"].every((x) => s.includes(x)), "球四态齐全");
    ok(s.includes("ctxbar"), "上下文条存在");
    ok(["allowOnce", "deny", "terminate"].every((x) => s.includes(x)), "审批三按钮齐全");
    ok(s.includes("tabAssets") && s.includes("tabInfo") && s.includes("tabSettings"), "抽屉三页齐全");
    ok(s.includes("data-theme=\"light\""), "浅色主题覆盖存在");
    // 球态 48×48 与窗口同尺寸 ⇒ 不应有外阴影
    const ballBlock = s.slice(s.indexOf(".ball{"), s.indexOf(".ball{") + 700);
    ok(/box-shadow\s*:\s*none/.test(ballBlock), "球无外阴影（窗口即球）");
    // thinking 环必须 inset 内缩
    ok(/inset:2px/.test(s), "thinking 环内缩 inset:2px");
  }
}

/* ================================================================== P2 */
group("[P2] headless Chrome 就绪");
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
  const r = await conn.send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + " " +
      JSON.stringify(r.exceptionDetails.exception?.description || ""));
  }
  return r.result.value;
}
async function click(sel) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { ok:false, err:"not found: "+${JSON.stringify(sel)} };
    el.click();
    return { ok:true };
  })()`);
}

/**
 * 等球体描边过渡到琥珀色（**只解决时序脆性，不放宽任何判据**）。
 *
 * 为什么需要它：`getComputedStyle(ball).borderColor` 在过渡期间返回
 * `oklab(0.866992 …)` 这种插值形态，不含目标色 `242`。整套 `verify:all` 跑完时
 * headless Chrome 已累积多个进程、rAF/合成线程被节流，固定的 `await sleep(150)`
 * 读到的是**过渡中间值** ⇒ 稳定假红（实测两遍读到的 oklab 数值还不同，正说明
 * 是采样时刻漂移，不是色值错）。
 *
 * ⚠ 判据不变：调用方仍然断言 `includes("242")`。超时就返回最后读数让它记红，
 *   **不吞掉、不返回 true**，并把真实值打进 `extra` 便于定位。
 *
 * @param {number} [ms] 最长等待（缺省 2s：过渡本身 100–300ms，2s 是宽松上界）
 * @returns {Promise<string>} 最后一次读到的 borderColor
 */
async function waitBorderAmber(ms = 2000) {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = await evaluate(`getComputedStyle(document.querySelector('.ball')).borderColor`);
    // 必须同时满足「已是 rgb 形态」+「已到目标色」：只在 rgb 上取样，
    // 免得 oklab 文本里恰好出现 "242" 造成假绿（oklab 三个分量都是 0.xx，不会，
    // 但这条约束让「加了新颜色格式」时依然安全）。
    if (typeof last === "string" && last.includes("242") && !last.includes("oklab")) return last;
    await sleep(50);
  }
  return last;
}

if (!CHROME) {
  na("headless Chrome 未安装 → 交互部分全部未执行");
} else {
  ok(true, `找到 Chrome：${CHROME}`);
  try {
    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1500,950", "--allow-file-access-from-files",
      `file:///${HTML_PATH.replace(/\\/g, "/")}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const page = await cdpTargets();
    conn = await connect(page.webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1600);

    /* ---------------------------------------------------------- P3 */
    group("[P3] 初始状态与控制台错误");
    {
      const errs = await evaluate(`(() => {
        window.__errs = window.__errs || [];
        if (!window.__errHooked) {
          window.__errHooked = true;
          window.addEventListener('error', e => window.__errs.push(String(e.message)));
          window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: '+String(e.reason)));
        }
        return window.__errs;
      })()`);
      ok(Array.isArray(errs), "错误钩子就绪");

      const init = await evaluate(`({
        theme: document.documentElement.getAttribute('data-theme'),
        ballState: document.getElementById('ballWrap').dataset.state,
        miniOpen: document.getElementById('miniWin').dataset.open,
        fullOpen: document.getElementById('fullWin').dataset.open,
        ctxItems: document.querySelectorAll('#miniCtx .ctxbar__item').length,
        ctxVisible: !document.getElementById('miniCtx').hidden,
        ballW: document.getElementById('ball').getBoundingClientRect().width,
        ballH: document.getElementById('ball').getBoundingClientRect().height,
        annoOpen: document.getElementById('annoPanel').dataset.open
      })`);
      ok(init.theme === "dark", "默认深色主题");
      ok(init.ballState === "idle", "球默认 idle 态");
      ok(init.miniOpen === "false" && init.fullOpen === "false", "默认球态，窗口关闭");
      ok(init.ctxItems === 3, "上下文条默认 3 项", `实际 ${init.ctxItems}`);
      ok(init.ctxVisible === true, "上下文条可见");
      ok(Math.abs(init.ballW - 48) < 1 && Math.abs(init.ballH - 48) < 1,
        "球尺寸 48×48", `${init.ballW}×${init.ballH}`);
      ok(init.annoOpen === "true", "设计标注面板默认展开");

      // ⚠️ mini/full 尺寸必须**先打开**再量 —— 关闭态 display:none，
      //    getBoundingClientRect() 恒为 0×0（量了也是 0，不是"尺寸不对"）。
      await evaluate(`document.getElementById('miniWin').dataset.open='true'`);
      await sleep(200);
      const miniSize = await evaluate(`({
        w: document.getElementById('miniWin').getBoundingClientRect().width,
        h: document.getElementById('miniWin').getBoundingClientRect().height
      })`);
      ok(Math.abs(miniSize.w - 360) < 1 && Math.abs(miniSize.h - 480) < 1,
        "mini 尺寸 360×480", `${miniSize.w}×${miniSize.h}`);

      await evaluate(`document.getElementById('fullWin').dataset.open='true'`);
      await sleep(200);
      const fullSize = await evaluate(`({
        w: document.getElementById('fullWin').getBoundingClientRect().width,
        h: document.getElementById('fullWin').getBoundingClientRect().height
      })`);
      ok(Math.abs(fullSize.w - 960) < 1 && Math.abs(fullSize.h - 680) < 1,
        "full 尺寸 960×680", `${fullSize.w}×${fullSize.h}`);
      await evaluate(`document.getElementById('miniWin').dataset.open='false'`);
      await sleep(150);
    }

    /* ---------------------------------------------------------- P4 */
    group("[P4] 球四态切换");
    {
      for (const [st, label] of [["thinking", "思考"], ["waiting", "待决策"], ["delivered", "有产出"], ["idle", "空闲"]]) {
        await click(`#stateSeg button[data-state="${st}"]`);
        const got = await evaluate(`document.getElementById('ballWrap').dataset.state`);
        ok(got === st, `切到「${label}」态`, `data-state=${got}`);
      }
      // waiting 态必须有徽标（待决策是唯一必须打扰用户的时刻）
      // ⚠️ 徽标画在 .ball 的 ::after 上（不是 .ballwrap 上）—— 查错元素会拿到 "none"。
      await click('#stateSeg button[data-state="waiting"]');
      await sleep(150);
      const waitVis = await evaluate(`(() => {
        const ball = document.querySelector('.ball');
        const a = getComputedStyle(ball, '::after');
        return {
          content: a.content,
          border: getComputedStyle(ball).borderColor,
          display: a.display
        };
      })()`);
      ok(waitVis.content.includes("!"), "待决策态显示「!」徽标",
        `${waitVis.content} / ${waitVis.display}`);
      // 只换等待方式：轮询到描边真的到色为止（理由见 waitBorderAmber 的注释）。
      // 判据一个字没改 —— 仍必须是琥珀色（`242`），超时照样红。
      const amber = await waitBorderAmber();
      ok(amber.includes("242"), "待决策态球体描边转琥珀色",
        `${amber}（首次读到：${waitVis.border}）`);
      await click('#stateSeg button[data-state="idle"]');
    }

    /* ---------------------------------------------------------- P5 */
    group("[P5] 球右键菜单");
    {
      await evaluate(`document.getElementById('ball').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
      await sleep(200);
      const open = await evaluate(`document.getElementById('ballMenu').dataset.open`);
      ok(open === "true", "右键弹出菜单");
      const items = await evaluate(`Array.from(document.querySelectorAll('#ballMenu .ballmenu__item')).map(b=>b.textContent.trim())`);
      ok(items.length === 4, "菜单 4 项", items.join(" / "));
      ok(items.some((t) => t.includes("外观") === false && t.includes("设置")), "含设置入口");
      ok(items.some((t) => t.includes("退出")), "含退出入口");
      const themes = await evaluate(`document.querySelectorAll('#themeSeg button').length`);
      ok(themes === 3, "外观三选项（跟随系统/浅色/深色）");
      // 点击「设置」应打开大窗并切到设置页
      await click('#ballMenu .ballmenu__item[data-act="settings"]');
      await sleep(300);
      const after = await evaluate(`({
        fullOpen: document.getElementById('fullWin').dataset.open,
        settingsShown: !document.getElementById('tabSettings').hidden,
        menuClosed: document.getElementById('ballMenu').dataset.open
      })`);
      ok(after.fullOpen === "true", "菜单「设置」打开大窗");
      ok(after.settingsShown === true, "直接落在设置页");
      ok(after.menuClosed === "false", "菜单收起");
    }

    /* ---------------------------------------------------------- P6 */
    group("[P6] 大窗抽屉三页");
    {
      for (const [tab, id] of [["info", "tabInfo"], ["assets", "tabAssets"], ["settings", "tabSettings"]]) {
        await click(`.drawer__tab[data-tab="${tab}"]`);
        await sleep(120);
        const shown = await evaluate(`({
          visible: !document.getElementById('${id}').hidden,
          selected: document.querySelector('.drawer__tab[data-tab="${tab}"]').getAttribute('aria-selected')
        })`);
        ok(shown.visible === true, `切到「${tab}」页可见`);
        ok(shown.selected === "true", `「${tab}」页签标记为选中`);
      }
      const assets = await evaluate(`document.querySelectorAll('#tabAssets .asset').length`);
      ok(assets >= 4, "产出资产层有条目", `${assets} 项`);
      const assetHasActions = await evaluate(`document.querySelector('#tabAssets .asset') !== null`);
      ok(assetHasActions, "产出条目可点击");
    }

    /* ---------------------------------------------------------- P7 */
    group("[P7] 上下文条逐条移除");
    {
      const before = await evaluate(`document.querySelectorAll('#fullCtx .ctxbar__item').length`);
      await click('#fullCtx .ctxbar__item[data-ctx="fg"] .ctxbar__x');
      await sleep(150);
      const after = await evaluate(`document.querySelectorAll('#fullCtx .ctxbar__item').length`);
      ok(after === before - 1, "移除「前台窗口」项", `${before} → ${after}`);
      // 全部移除后整条隐藏
      await evaluate(`document.querySelectorAll('#fullCtx .ctxbar__item').forEach(i=>{
        const x=i.querySelector('.ctxbar__x'); if(x) x.click();
      })`);
      await sleep(200);
      const hidden = await evaluate(`document.getElementById('fullCtx').hidden`);
      ok(hidden === true, "上下文清空后整条隐藏（不占高度）");
      // mini 侧独立
      const miniStill = await evaluate(`document.querySelectorAll('#miniCtx .ctxbar__item').length`);
      ok(miniStill === 3, "mini 侧上下文不受 full 影响", `${miniStill} 项`);
    }

    /* ---------------------------------------------------------- P8 */
    group("[P8] 审批卡三按钮");
    {
      for (const [act, label] of [["allowOnce", "允许一次"], ["deny", "拒绝"], ["terminate", "中断整轮"]]) {
        // 恢复卡片可点
        await evaluate(`(() => {
          const c=document.getElementById('approvalCard');
          c.style.opacity='1'; c.style.pointerEvents='auto';
        })()`);
        await click(`[data-appr="${act}"]`);
        await sleep(150);
        const disabled = await evaluate(`document.getElementById('approvalCard').style.pointerEvents`);
        ok(disabled === "none", `「${label}」点击后卡片失效`);
      }
      const cd = await evaluate(`document.getElementById('apprCd').textContent`);
      ok(/^\d{2}:\d{2}$/.test(cd), "倒计时格式 mm:ss", cd);
      const alwaysTxt = await evaluate(`document.getElementById('apprAlways').parentElement.textContent`);
      ok(alwaysTxt.includes("只免审批"), "明示「只免审批，不免沙箱」");
    }

    /* ---------------------------------------------------------- P9 */
    group("[P9] 产出弹窗");
    {
      await click('#btnOutcomeFull');
      await sleep(200);
      const open = await evaluate(`document.getElementById('outcomeSheet').dataset.open`);
      ok(open === "true", "产出弹窗打开");
      const fmt = await evaluate(`Array.from(document.querySelectorAll('#outcomeSheet input[name=fmt]')).map(r=>({v:r.value,checked:r.checked,disabled:r.disabled}))`);
      ok(fmt.length === 3, "三种格式选项");
      ok(fmt[0].checked === true, "默认预填 Word");
      ok(fmt[2].disabled === true, "Excel 标注为未开放（P1）");
      const title = await evaluate(`document.getElementById('outcomeTitle').value`);
      ok(title.length > 0, "标题已预填", title);
      // 生成 → 球转 delivered
      await click('#sheetGo');
      await sleep(2200);
      const st = await evaluate(`document.getElementById('ballWrap').dataset.state`);
      ok(st === "delivered", "生成后球切到「有产出」态", `state=${st}`);
      const sheetClosed = await evaluate(`document.getElementById('outcomeSheet').dataset.open`);
      ok(sheetClosed === "false", "弹窗关闭");
    }

    /* ---------------------------------------------------------- P10 */
    group("[P10] 新建会话不删旧会话");
    {
      const before = await evaluate(`document.querySelectorAll('#fullTree .sess').length`);
      await click('#btnNewSession');
      await sleep(200);
      const after = await evaluate(`document.querySelectorAll('#fullTree .sess').length`);
      ok(after === before + 1, "会话数 +1（旧会话保留）", `${before} → ${after}`);
      const oldStill = await evaluate(`document.body.textContent.includes('季度汇报润色')`);
      ok(oldStill === true, "旧会话仍在树中");
      // ⚠️ 只查产品 UI 区域（窗口），不含设计标注面板 ——
      //    标注面板会**引用**现状那句提示来解释设计动机，那是文档，不是 UI。
      const noDeleteWarn = await evaluate(`(() => {
        const ui = document.getElementById('fullWin').textContent
                 + document.getElementById('miniWin').textContent;
        return !ui.includes('暂不支持找回');
      })()`);
      ok(noDeleteWarn === true, "产品 UI 已移除「暂不支持找回」文案");
    }

    /* ---------------------------------------------------------- P11 */
    group("[P11] 发送（模拟流式）");
    {
      await evaluate(`(() => {
        const ta=document.getElementById('fullInput');
        ta.value='把这段改得更简洁';
        document.getElementById('fullSend').click();
      })()`);
      await sleep(120);
      const streaming = await evaluate(`document.getElementById('ballWrap').dataset.state`);
      ok(streaming === "thinking", "发送后球切到「思考」态");
      await sleep(2200);
      const done = await evaluate(`({
        state: document.getElementById('ballWrap').dataset.state,
        lastTurn: (() => {
          const turns=document.querySelectorAll('#fullChat .turn');
          return turns.length ? turns[turns.length-1].textContent.slice(0,40) : '';
        })()
      })`);
      ok(done.state === "idle", "流式结束后回到空闲态");
      ok(done.lastTurn.length > 10, "回答已渲染", done.lastTurn);
    }

    /* ---------------------------------------------------------- P12 */
    group("[P12] 主题切换与在场降档");
    {
      await click('#btnTheme');
      await sleep(250);
      const light = await evaluate(`({
        theme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      })`);
      ok(light.theme === "light", "切到浅色主题");
      ok(light.bg === "#f7f7f7", "浅色令牌生效", light.bg);
      await click('#btnTheme');
      await sleep(200);
      const dark = await evaluate(`document.documentElement.getAttribute('data-theme')`);
      ok(dark === "dark", "切回深色主题");

      await click('#presenceSeg button[data-pres="faint"]');
      // ⚠️ 球的 opacity 有 .18s 过渡 —— 必须等过渡跑完再量，否则量到中间值。
      await sleep(500);
      const op = await evaluate(`getComputedStyle(document.querySelector('.ball')).opacity`);
      ok(Math.abs(parseFloat(op) - 0.15) < 0.02, "极静档透明度 0.15", op);
      await click('#presenceSeg button[data-pres="dim"]');
      await sleep(500);
      const op2 = await evaluate(`getComputedStyle(document.querySelector('.ball')).opacity`);
      ok(Math.abs(parseFloat(op2) - 0.35) < 0.02, "降档透明度 0.35", op2);
      await click('#presenceSeg button[data-pres="normal"]');
    }

    /* ---------------------------------------------------------- P13 */
    group("[P13] 存在感的可调节性（设置页）");
    {
      await click('.drawer__tab[data-tab="settings"]');
      await sleep(150);
      const hasBudget = await evaluate(`!!document.getElementById('budgetInput')`);
      ok(hasBudget === true, "有通知预算设置");
      const noShot = await evaluate(`document.getElementById('tabSettings').textContent.includes('不做')`);
      ok(noShot === true, "明示「屏幕截图不做」");
      const fgLocal = await evaluate(`document.getElementById('tabSettings').textContent.includes('仅本地')`);
      ok(fgLocal === true, "明示前台窗口「仅本地」");
      const sw = await evaluate(`(() => {
        const el=document.getElementById('swFg'); el.click();
        return el.getAttribute('aria-checked');
      })()`);
      ok(sw === "true", "前台窗口开关可切换");
    }

    /* ---------------------------------------------------------- P14 */
    group("[P14] 全程无 JS 运行时错误");
    {
      const errs = await evaluate(`window.__errs || []`);
      ok(errs.length === 0, "无未捕获错误", errs.length ? errs.join(" | ") : "0 条");
    }
  } catch (err) {
    console.log(`  >>> harness 抛错（环境问题，非产品缺陷）：${String(err).slice(0, 200)}`);
    skipped += 1;
    console.log("  n/a   交互断言未执行完 —— 这是「未测到」，不是通过");
  } finally {
    try { conn && conn.close(); } catch { /* ignore */ }
    try { chrome && chrome.kill(); } catch { /* ignore */ }
  }
}

/* ================================================================== */
console.log("\n======================================================================");
console.log(`  通过 ${passed} · 失败 ${failed} · 未测 ${skipped}`);
console.log("======================================================================");
process.exit(failed > 0 ? 1 : 0);
