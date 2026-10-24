#!/usr/bin/env node
/**
 * QA · 悬浮球右键菜单 + 外观（静态契约 + headless Chrome / mock 交互）。
 *
 * 需求（用户原话）：
 *   ①「悬浮窗也有浅色和深色外观」；
 *   ②「右键可以出现菜单，有外观、设置、关闭悬浮窗、退出 minipi 等操作，
 *      不再右键就能弹出窗口，而是左键点击弹出」。
 *
 * 本脚本守两条：
 *   [S] 静态契约：协议通道 / preload 透传 / 主进程窗口几何 / 渲染层菜单与外观入口；
 *   [H] 交互（mock）：右键出菜单、外观三选一即时生效、Esc 关闭、
 *       点球只关菜单不切窗、再点球才进 mini。
 *
 * 覆盖边界：
 *   · 真机「临时撑开窗口 / 还原 48×48」在 Electron 里，headless 只能验证 mock 形态；
 *   · 「关闭悬浮窗」只断言入口存在（真隐藏窗口无法在 headless 里验证）。
 *
 * 运行：`node scripts/qa-ball-menu.mjs`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9401;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-ballmenu-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}${extra ? `  · ${extra}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${extra ? `  · ${extra}` : ""}`); }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);

console.log("======================================================================");
console.log(" QA · 悬浮球右键菜单 + 浅/深外观");
console.log("======================================================================");

/* ============================================================ [S] 静态契约 */
group("[S] 静态契约");
{
  const protocol = fs.readFileSync(path.join(ROOT, "src", "shared", "protocol.js"), "utf8");
  ok(/SHOW_BALL_MENU:\s*"minipi:showBallMenu"/.test(protocol), "协议：SHOW_BALL_MENU");
  ok(/HIDE_BALL_MENU:\s*"minipi:hideBallMenu"/.test(protocol), "协议：HIDE_BALL_MENU");
  ok(/HIDE_BALL:\s*"minipi:hideBall"/.test(protocol), "协议：HIDE_BALL");
  ok(/BALL_MENU_CLOSED:\s*"minipi:ballMenuClosed"/.test(protocol), "事件：BALL_MENU_CLOSED");
  ok(/BALL_MENU_SIZE/.test(protocol), "协议：BALL_MENU_SIZE（菜单盒子）");
  /* 拖拽改成三步（begin/move/end）：坐标由主进程读 OS 游标 ——
     渲染层的 screenX / movementX 都会被"窗口自己在动"污染（见 window.js 注释）。 */
  ok(/BALL_DRAG_BEGIN:\s*"minipi:ballDragBegin"/.test(protocol), "协议：BALL_DRAG_BEGIN（拖拽开始）");
  ok(/BALL_DRAG_MOVE:\s*"minipi:ballDragMove"/.test(protocol), "协议：BALL_DRAG_MOVE（跟随游标）");
  ok(/BALL_DRAG_END:\s*"minipi:ballDragEnd"/.test(protocol), "协议：BALL_DRAG_END（结束 + 吸边）");
  ok(/SNAP_BALL:\s*"minipi:snapBall"/.test(protocol), "协议：SNAP_BALL（吸边）");

  const preload = fs.readFileSync(path.join(ROOT, "src", "preload", "index.js"), "utf8");
  ok(/showBallMenu:\s*\(\)/.test(preload), "preload：showBallMenu()");
  ok(/hideBallMenu:\s*\(\)/.test(preload), "preload：hideBallMenu()");
  ok(/hideBall:\s*\(\)/.test(preload), "preload：hideBall()");
  ok(/onBallMenuClosed:\s*\(handler\)/.test(preload), "preload：onBallMenuClosed()");
  ok(/ballDragBegin:\s*\(\)/.test(preload), "preload：ballDragBegin()");
  ok(/ballDragMove:\s*\(arg\)/.test(preload), "preload：ballDragMove()");
  ok(/ballDragEnd:\s*\(\)/.test(preload), "preload：ballDragEnd()");

  const win = fs.readFileSync(path.join(ROOT, "src", "main", "window.js"), "utf8");
  ok(/async openBallMenu\(/.test(win), "窗口层：openBallMenu()");
  ok(/async closeBallMenu\(/.test(win), "窗口层：closeBallMenu()");
  ok(/\bhideBall\(\)\s*\{/.test(win), "窗口层：hideBall()");
  ok(/win\.on\("blur",\s*\(\)\s*=>\s*\{[\s\S]{0,120}_menuOpen/.test(win), "窗口层：失焦自动收起");
  ok(/_menuOpen/.test(win) && /this\._applying \|\| this\._menuOpen/.test(win), "窗口层：展开期间不把扩张位置记成球位置");
  ok(/beginBallDrag\(\)\s*\{/.test(win), "窗口层：beginBallDrag()（记下「游标-窗口」偏移）");
  ok(/moveBallToCursor\(/.test(win) && /getCursorScreenPoint\(\)/.test(win),
    "★ 窗口层：用 OS 游标定位（不依赖渲染层坐标）");
  ok(/endBallDrag\(\)\s*\{/.test(win), "窗口层：endBallDrag()（结束后吸边）");
  ok(/snapBall\(threshold/.test(win), "窗口层：snapBall()（吸附左右边缘）");

  /* ★ 2026-10-20 严重 bug 的回归守门：
     用户按住球拖动 → 球不跟手，反而四向"长大"直到铺满屏幕并挡住桌面。
     根因：Windows 下无边框窗口带 WS_THICKFRAME，48×48 的窗口**整个都是 resize 热区**，
     OS 把"拖球"当成"拖边框缩放"。只写 resizable:false 挡不住。 */
  // 断言用 includes 而不是正则：这些串里全是 Windows 路径/引号，正则转义写错会静默失效
  ok(win.includes("thickFrame: false"), "★ 窗口 thickFrame:false（去掉系统 resize 热区）");
  ok(win.includes("_healBallSize()"), "窗口层：球态尺寸自愈 _healBallSize()");
  ok(win.includes('win.on("resize"'), "★ 监听 resize 并还原球态尺寸");
  ok((win.match(/_healBallSize\(/g) || []).length >= 4,
    "拖拽/吸边入口先自愈一次（防止在已变大的窗口上开始拖）",
    `${(win.match(/_healBallSize\(/g) || []).length} 处`);

  const html = fs.readFileSync(HTML_PATH, "utf8");
  /* ★ 半隐藏（类 360）：贴边 3 秒无操作 → 一半滑出屏幕；移入滑出、移出立刻收回。
     全部用 includes 断言（这些串里引号/反斜杠多，正则转义写错会静默失效）。 */
  /* ★ 半隐藏（类 360）的现行语义（2026-10-20 用户定稿）：
       · 贴边后**不留延时**，鼠标移出就直接隐藏；
       · 鼠标判定用**圆**而不是方框，并带滞回 —— 否则方框四角的透明区会来回触发显隐，
         表现为"乒乓球一样一直跳"。 */
  ok(!win.includes("BALL_HIDE_DELAY_MS"), "★ 没有「3 秒延时」了（用户要求移出即隐藏）");
  // 只断言"那个自动隐藏的调度函数没了"，不断言 setTimeout 全无（文件里别处还有用到）
  ok(!win.includes("scheduleBallAutoHide"), "没有「自动隐藏」的调度函数");
  ok(win.includes("_isCursorOnBall("), "★ 用圆形命中判定（不是方框的 mouseenter/leave）");
  ok(win.includes("_isCursorOnBall(-2)"), "移入留 2px 滞回（避免边缘抖动）");
  ok(win.includes("_isCursorOnBall(this._ballHidden ? -2 : 4)"),
    "★ 移出留 4px 滞回（消掉乒乓球自激）");
  ok(win.includes("wa.x - half"), "半隐藏位移 = 半个球身出屏");
  /* ★ 2026-10-20 第二次翻车（"操作几次后就不隐藏了" + "拖到顶部自己跑到右侧"）的守门：
     显隐不能靠 DOM 事件驱动（会漏发、会在方框角落抖），要由主进程按几何巡检收敛；
     而且"贴哪条边"必须每 tick 现算 —— 用陈旧的边会把球弹到别的边缘去。 */
  ok(win.includes("BALL_HOVER_TICK_MS"), "★ 有光标巡检周期（不依赖 DOM 事件）");
  ok(win.includes("_syncBallPeek()"), "★ 存在幂等的状态收敛函数");
  ok(win.includes("_startBallHoverWatch()"), "进入球态会启动巡检");
  ok(!/this\._ballEdge = this\._edgeOf\(b\) \?\?/.test(win), "★ 不再用陈旧的边兜底（否则会弹到别的边缘）");
  ok(/const edge = this\._edgeOf\(b\);/.test(win), "边在每次判定时重新计算");
  /* ★ 2026-10-20 第三次翻车（"左侧不隐藏" / "点球会抖"）的守门：
     ① 隐藏后 x 变成 wa.x - half，若边识别只认"完整贴边"，隐藏动作会把自己的边判丢
        ⇒ 状态机在"隐藏/恢复"之间反复，表现就是"左侧不隐藏"；
     ② 切形态的中间态里巡检必须停，否则中间 bounds 会被判成"不在边上"→ 抖一下。 */
  ok(/Math\.abs\(b\.x - \(wa\.x - half\)\) <= tol/.test(win), "★ 边识别同时认「半隐藏」位置的 x");
  ok(/this\._applying\) return;/.test(win), "★ 形态过渡期间巡检不参与（防抖）");
  ok(win.includes("this._stopBallHoverWatch()") && win.includes("this._startBallHoverWatch()"),
    "切换形态时停/恢复巡检");
  ok(!html.includes("Promise.resolve(host.ballPin"), "渲染层点击不再搬一次窗口（那是「点球抖一下」的来源）");
  /* ★ 第四次翻车（"按住不松手一直抖" / "靠外围点击不出小窗"）的守门：
     ① 跟随光标时必须有 2px 死区，否则游标 ±1 的读数抖动会让窗口每帧挪 1px；
     ② "是拖拽还是点击"必须以主进程的 moved 为准 —— 旧写法"来过一次 pointermove 就吞掉 click"
        会让按下时抖 1px 的点击失效。 */
  ok(/Math\.abs\(Math\.round\(x\) - b\.x\) < 2/.test(win), "★ 移动有 2px 死区（按住不动不再抖）");
  ok(html.includes("r.moved !== true"), "★ 渲染层按 moved 判定点击（不再靠 pointermove 猜）");
  ok(!html.includes("suppressBallClick"), "已移除 click 抑制那套（它是误吞点击的根源）");
  /* ⚠ 这里不能断言 `setTimeout` 全无 —— 文件里还有别的地方用。
     上面那条已覆盖"没有自动隐藏定时器"的语义（scheduleBallAutoHide 已删）。 */
  ok(protocol.includes('BALL_PEEK: "minipi:ballPeek"'), "协议：BALL_PEEK（半隐藏状态推送）");
  ok(preload.includes("onBallPeek:") && preload.includes("ballPeekIn:") && preload.includes("ballPin:"),
    "preload：onBallPeek / ballPeekIn / ballPin");
  ok(html.includes(".ball--peek{ opacity:.5; }"), "★ 半隐藏时球 50% 透明");
  ok(html.includes("onBallPeek") && html.includes("ball--peek"), "渲染层：订阅半隐藏状态并改透明度");
  ok(!/toast\([^)]*已开启联网/.test(html), "★ 切联网**不再弹提示**（用户要求：直接生效即可）");

  ok(/id="ballCtxMenu"/.test(html), "渲染层：球右键菜单 DOM 存在");
  ok(/data-ballctx="settings"/.test(html) && /data-ballctx="hide-ball"/.test(html) && /data-ballctx="quit"/.test(html),
    "菜单项：设置 / 关闭悬浮窗 / 退出");
  ok((html.match(/data-appearance-opt="/g) || []).length === 6,
    "外观：跟随系统 / 浅色 / 深色（球右键 + ☰ 菜单各一份，共 6 处）",
    String((html.match(/data-appearance-opt="/g) || []).length));
  ok(/function openBallCtxMenu\(/.test(html) && /function closeBallCtxMenu\(/.test(html), "渲染层：开合函数");
  ok(/function setThemeFromBallMenu\(/.test(html), "渲染层：外观切换走 settings.theme");
  // 只认「旧右键实现」这一整段：右键 → 先撑 mini → 再弹菜单（不是文件里任何 goState('mini')）
  ok(!/setTimeout\(\(\)\s*=>\s*\{\s*openMenu\(\$\('#btnMiniMenu'\)\s*\|\|\s*\$\('#ball'\)\);?\s*\},\s*60\)/.test(html),
    "★ 旧右键实现已删除（不再先撑 mini 再弹菜单）");
  ok(/ball\.addEventListener\('contextmenu'[\s\S]{0,220}openBallCtxMenu/.test(html),
    "右键处理器走 openBallCtxMenu()");
  ok(/--ball-bg-1:/.test(html) && /--ball-border:/.test(html) && /--ball-ink:/.test(html),
    "球专属外观令牌（浅/深各一套）");
  ok(/\.ball\{[^}]*box-shadow:none/.test(html), "★ 球无任何外阴影（窗口=球，阴影只会在角区留边）");
  ok(!/\.ball:hover\{[^}]*transform:scale/.test(html), "悬停不再放大（避免被 48px 窗口裁切）");
  ok(/pointerdown/.test(html) && /ballDragBegin/.test(html), "渲染层：整球 pointer 拖拽（走三步 API）");
  /* 这条是**回归守门**：之前用 screenX/movementX 算位移，窗口一动就自激，
     用户实测"往右拖球往左跑"。现在渲染层不许再出现这两个量。 */
  const codeOnly = html
    .split('\n')
    .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
    .join('\n');
  ok(!/[^a-zA-Z]screenX/.test(codeOnly) && !/[^a-zA-Z]movementX/.test(codeOnly),
    "★ 渲染层代码里不再出现 screenX / movementX（那是自激的根因）");
  // 结束走 ballDragEnd，**吸边在主进程内部完成**（渲染层不该再单独调 snapBall）
  ok(/ballDragEnd\(\)/.test(html), "渲染层：拖拽结束调 ballDragEnd()（内部顺带吸边）");
  ok(!/\.ball\{[^}]*?-webkit-app-region:\s*drag\s*;/.test(html), "★ 球不再靠 CSS drag 区域（否则球心拖不动）");
  ok(/box-shadow:none/.test(html) && !/--gap:/.test(html), "窗口即卡片：无留白 / 无阴影（用户要求）");
}

/* ============================================================ [H] 交互 */
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH || "",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (!CHROME) {
  console.log("  （未安装 Chrome：headless 交互未执行 —— 这是「未测到」，不是通过）");
  console.log(`\nqa:ball-menu: ${passed}/${passed + failed} passed（静态部分）`);
  process.exit(failed === 0 ? 0 : 1);
}
ok(true, `找到 Chrome：${CHROME}`);

let chrome = null;
let conn = null;
try {
  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1280,900", "--allow-file-access-from-files",
    `file:///${HTML_PATH.replace(/\\/g, "/")}`,
  ], { detached: true, stdio: "ignore" });

  let page = null;
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch { /* retry */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("找不到 CDP page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") pageErrors.push(String(msg.params?.exceptionDetails?.text || "exception"));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") pageErrors.push("console.error");
  });
  const send = (m, p) => new Promise((res, rej) => {
    id += 1;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " / " + (r.exceptionDetails.exception?.description || ""));
    return r.result.value;
  };
  conn = { send, close: () => ws.close() };

  await send("Runtime.enable");
  await sleep(1600);

  group("[H1] 右键出菜单（mock）");
  const opened = await evaluate(`
    const ball = document.querySelector('#ball');
    if (!ball) return { ok: false, why: 'no-ball' };
    ball.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const menu = document.querySelector('#ballCtxMenu');
    const opts = [...document.querySelectorAll('#ballCtxMenu [data-appearance-opt]')].map(b => b.getAttribute('data-appearance-opt'));
    const acts = [...document.querySelectorAll('[data-ballctx]')].map(b => b.getAttribute('data-ballctx'));
    return {
      ok: true,
      mode: document.body.dataset.mode,
      open: !!(menu && !menu.hidden),
      dataset: document.documentElement.dataset.ballmenu || '',
      opts, acts,
      positioned: !!(menu && menu.style.left && menu.style.top),
    };
  `);
  ok(opened.ok === true, "球存在");
  ok(opened.open === true, "★ 右键弹出球菜单", opened.open ? "" : "菜单仍隐藏");
  ok(opened.dataset === "open", "根节点进入球菜单态（ballmenu=open）", opened.dataset);
  ok(opened.mode === "ball", "★ 右键不再切到 mini（仍在 ball）", opened.mode);
  ok(opened.positioned === true, "菜单有定位（left/top 已写入）");
  ok((opened.opts || []).join(",") === "system,light,dark", "外观三项齐全", (opened.opts || []).join(","));
  ok((opened.acts || []).join(",") === "settings,hide-ball,quit", "菜单项齐全", (opened.acts || []).join(","));

  group("[H2] 外观：浅色 / 深色即时生效");
  const light = await evaluate(`
    document.querySelector('#ballCtxMenu [data-appearance-opt="light"]').click();
    await new Promise(r => setTimeout(r, 120));
    const bg = getComputedStyle(document.querySelector('.ball')).backgroundImage;
    return {
      theme: document.documentElement.dataset.theme || '',
      checked: document.querySelector('#ballCtxMenu [data-appearance-opt="light"]').getAttribute('aria-checked'),
      lightBg: /rgb\\(255, 255, 255\\)|rgb\\(232, 232, 232\\)/.test(bg),
    };
  `);
  ok(light.theme === "light", "切浅色 → html[data-theme=light]（mock）", light.theme);
  ok(light.checked === "true", "浅色项打勾");
  ok(light.lightBg === true, "★ 球的浅色外观生效（白色系渐变）");

  const dark = await evaluate(`
    document.querySelector('#ballCtxMenu [data-appearance-opt="dark"]').click();
    await new Promise(r => setTimeout(r, 120));
    const bg = getComputedStyle(document.querySelector('.ball')).backgroundImage;
    return {
      theme: document.documentElement.dataset.theme || '',
      darkBg: /rgb\\(43, 43, 43\\)|rgb\\(18, 18, 18\\)/.test(bg),
    };
  `);
  ok(dark.theme === "dark", "切深色 → html[data-theme=dark]", dark.theme);
  ok(dark.darkBg === true, "★ 球的深色外观生效（深色系渐变）");

  group("[H3] Esc 关闭 / 点球只关菜单、不切窗");
  const esc = await evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    return {
      hidden: document.querySelector('#ballCtxMenu').hidden,
      dataset: document.documentElement.dataset.ballmenu || '',
      mode: document.body.dataset.mode,
    };
  `);
  ok(esc.hidden === true && esc.dataset === "", "★ Esc 收起菜单（不留态）", JSON.stringify(esc));

  const clickBall = await evaluate(`
    const ball = document.querySelector('#ball');
    ball.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    ball.click();
    await new Promise(r => setTimeout(r, 200));
    return {
      hidden: document.querySelector('#ballCtxMenu').hidden,
      mode: document.body.dataset.mode,
    };
  `);
  ok(clickBall.hidden === true, "点球先收菜单");
  ok(clickBall.mode === "ball", "★ 点球不会顺手切窗（仍是 ball）", clickBall.mode);

  group("[H4] 左键打开小窗（原有行为保持）");
  const openMini = await evaluate(`
    document.querySelector('#ball').click();
    await new Promise(r => setTimeout(r, 350));
    return { mode: document.body.dataset.mode };
  `);
  ok(openMini.mode === "mini", "★ 左键 → mini", openMini.mode);

  group("[H5] 页面无异常");
  ok(pageErrors.length === 0, "无 console.error / 未捕获异常", pageErrors.join(" | "));

  conn.close();
} catch (err) {
  failed += 1;
  console.log(`  FAIL  执行异常：${err?.message ?? err}`);
} finally {
  try { conn && conn.close(); } catch { /* ignore */ }
  try { chrome && chrome.kill(); } catch { /* ignore */ }
}

console.log("\n======================================================================");
console.log(`qa:ball-menu: ${passed}/${passed + failed} passed`);
console.log("覆盖边界：真机窗口撑开/还原（Electron）与真隐藏窗口未在此验证。");
process.exit(failed === 0 ? 0 : 1);
