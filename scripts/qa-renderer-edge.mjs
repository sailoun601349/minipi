#!/usr/bin/env node
/**
 * QA · 象限 C：渲染层边界（`src/renderer/index.html`）。
 *
 * 本机 Electron GPU 崩、起不来，所以走 headless Chrome + CDP（复用方砚的 harness 思路）：
 *   ① **静态审查**：扫内联 sink（innerHTML / outerHTML / insertAdjacentHTML …）是否对模型文本做了转义；
 *   ② **函数单测**：把渲染层内联的 `middleTruncate` / `formatBytes` / `formatClock` /
 *      `escapeHtml` / `sanitizeHref` / `inlineHTML` / `markdownPreview` 喂边界值；
 *      **emoji 与组合字符是重点** —— 中间截断会不会劈开一个 emoji 造成乱码；
 *   ③ **XSS 实测**：往 `inlineText` / markdown 源里塞 `<script>` / `<img onerror>` / `javascript:`，
 *      断言渲染结果里**没有可执行的节点**（内联事件属性 / script 标签）。
 *
 * 只读，不改任何 `src/` 文件。运行：`node scripts/qa-renderer-edge.mjs`。
 * 若本机无 Chrome，脚本跳过 headless 部分并只做静态审查（退出码仍正确）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9391;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-cdp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const findings = [];
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
function finding(level, id, title, detail) {
  findings.push({ level, id, title, detail });
  console.log(`  >>> [${level}] ${id} ${title}`);
}

console.log("======================================================================");
console.log(" QA · 象限 C：渲染层边界");
console.log("======================================================================");

/* ================================================================== C1 */
group("[C1] 静态审查：内联 JS 的 HTML sink 是否对模型文本转义");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const lines = html.split("\n");
  const sinks = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"];
  const inComment = (line) => /^\s*(\/\*|\*|\/\/)/.test(line);
  let suspicious = [];
  lines.forEach((line, i) => {
    const code = line.includes("//") ? line.slice(0, line.indexOf("//")) : line;
    for (const s of sinks) {
      if (!code.includes(s)) continue;
      if (inComment(line)) continue; // 注释里的说明不算 sink
      // 安全的形态：
      //   · 赋值右侧含 inlineHTML(...) / escapeHtml(...)
      //   · 赋值为空串或纯字面量（不含插值/变量）
      const rhs = code.slice(code.indexOf(s) + s.length);
      const assignPart = rhs.replace(/^\s*=\s*/, "");
      const hasEscapeWrap = /inlineHTML\s*\(|escapeHtml\s*\(/.test(assignPart);
      const isStaticString = /^\s*(['"`])(?:(?!\1)[\s\S])*\1\s*;?\s*$/.test(assignPart) && !/\$\{/.test(assignPart);
      const isEmptyString = /^\s*(['"`])\1\s*;?\s*$/.test(assignPart);
      // read（非赋值）：`return d.innerHTML`（探针返回值）也非注入点
      const isReadOnly = !/=\s*$/.test(code.slice(0, code.indexOf(s) + s.length)) && !/innerHTML\s*=/.test(code);
      if (!(hasEscapeWrap || isStaticString || isEmptyString || isReadOnly)) {
        suspicious.push({ n: i + 1, line: line.trim().slice(0, 110) });
      }
    }
  });
  for (const s of suspicious) console.log(`    L${s.n}: ${s.line}`);
  ok(suspicious.length === 0, `未发现「未转义就 innerHTML」的 sink（可疑 ${suspicious.length} 处）`);
  if (suspicious.length > 0) finding("P1", "C1-SINK", `${suspicious.length} 处 innerHTML 赋值未见转义包装`, JSON.stringify(suspicious));

  ok(/function escapeHtml/.test(html), "escapeHtml 存在");
  ok(/function sanitizeHref/.test(html), "sanitizeHref 存在");
  ok(/function middleTruncate/.test(html), "middleTruncate 存在");
  ok(/\.textContent\s*=/.test(html), "存在 textContent 安全赋值");
}

/* ================================================================== C2 */
group("[C2] headless Chrome 就绪检测");
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
  ok(true, "本机无 Chrome → 跳过 headless 部分（静态审查已完成）");
  console.log("  （跳过：未安装 Chrome，headless 断言未执行——这是「未测到」，非通过）");
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
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const page = await cdpTargets();
    conn = await connect(page.webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1500);
    const ready = await evaluate("window.__minipi ? window.__minipi.mock() : null");
    ok(ready === true, "window.__minipi 探针就绪（mock 模式）", `mock=${ready}`);

    /* ============================================================== C3 */
    group("[C3] middleTruncate 边界（emoji / 组合字符 / 空值 / 超长）");
    {
      const cases = [
        { args: ["周报-2026-09-23.docx", 20], note: "正常" },
        { args: ["", 20], note: "空串" },
        { args: [null, 20], note: "null" },
        { args: [undefined, 20], note: "undefined" },
        { args: [12345, 5], note: "数字" },
        { args: ["a".repeat(500), 20], note: "超长 ASCII" },
        { args: ["👨‍👩‍👧-会议纪要-最终版.docx", 12], note: "emoji 家庭（ZJW 序列）" },
        { args: ["👍👍👍👍👍👍👍👍.docx", 6], note: "emoji 重复" },
        { args: ["한글-보고서-최종.docx", 10], note: "韩文" },
        { args: ["e\u0301\u0301\u0301\u0301\u0301.docx", 6], note: "组合字符 é（e+组合重音）" },
        { args: [".docx", 3], note: "极短含扩展名" },
        { args: ["a.docx", 0], note: "maxChars=0" },
        { args: ["a.docx", -5], note: "maxChars 负数" },
        { args: ["a.docx", NaN], note: "maxChars NaN" },
        { args: ["a.docx", 3.7], note: "maxChars 小数" },
        { args: ["....", 2], note: "全点" },
      ];
      const results = await evaluate(`(() => {
        const f = window.__minipi.middleTruncate;
        const cases = ${JSON.stringify(cases.map((c) => c.args))};
        return cases.map(a => { try { return { ok:true, v:f(a[0],a[1]) }; } catch(e){ return { ok:false, e:String(e) }; } });
      })()`);
      results.forEach((r, i) => {
        const c = cases[i];
        if (!r.ok) {
          finding("P2", "C3-THROW", `middleTruncate(${JSON.stringify(c.args)}) 抛异常`, r.e);
          ok(false, `${c.note} 不抛异常`);
          return;
        }
        const v = String(r.v);
        // 不能抛，且结果应是字符串
        // emoji 劈开的检测：结果含孤立代理项（lone surrogate）
        const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
        if (hasLoneSurrogate) {
          finding("P2", "C3-EMOJI", `${c.note} 截断劈开了 emoji / 产生了孤立代理项（乱码风险）`, `结果=${JSON.stringify(v)}`);
        }
        ok(!hasLoneSurrogate, `${c.note} 未劈开 emoji`, `→ ${JSON.stringify(v).slice(0, 60)}`);
      });
    }

    /* ============================================================== C4 */
    group("[C4] formatBytes 边界 + formatClock 经卡片渲染路径验证");
    {
      const fb = await evaluate(`(() => {
        const f = window.__minipi.formatBytes;
        return [undefined,null,-1,0,1,1023,1024,1048576,1073741824,Number.MAX_SAFE_INTEGER,NaN,Infinity,"123",{},[]]
          .map(v => { try { return { i: JSON.stringify(v), o: f(v) }; } catch(e){ return { i: JSON.stringify(v), e: String(e) }; } });
      })()`);
      let allStr = true;
      for (const r of fb) {
        if (r.e) { allStr = false; finding("P2", "C4-THROW", `formatBytes(${r.i}) 抛异常`, r.e); }
        else if (typeof r.o !== "string") allStr = false;
      }
      ok(allStr, `formatBytes 对所有边界返回字符串（14 值）`, fb.map((r) => `${r.i}=${r.o}`).join(" ").slice(0, 120));

      // 注意：formatClock **未**暴露到 window.__minipi（只有 middleTruncate / formatBytes）。
      // 所以不能直接调它——改为经产出卡片渲染路径喂畸形 createdAt，观察是否抛错。
      const clockCases = [undefined, null, -1, 0, 1, NaN, Infinity, "x", 1e15, 8.64e15 + 1];
      for (let i = 0; i < clockCases.length; i += 1) {
        let threw = false;
        try {
          await evaluate(`window.__minipi.injectOutcome({
            outcomeId:'o_clk_${i}', sessionId:'s_1', format:'md', degraded:false,
            fileName:'clock-${i}.md', bytes:1, title:'clock', createdAt: ${JSON.stringify(clockCases[i])}, actions:['open']
          })`);
          await sleep(80);
          const meta = await evaluate("(()=>{const c=document.querySelector('#miniBody .outcome__meta');return c?c.textContent:'';})()");
          ok(typeof meta === "string", `createdAt=${JSON.stringify(clockCases[i])} → formatClock 未抛错（meta="${meta}"）`);
        } catch (err) {
          threw = true;
          finding("P1", "C4-CLOCK", `createdAt=${JSON.stringify(clockCases[i])} 令卡片渲染抛异常`, String(err));
          ok(false, `createdAt=${JSON.stringify(clockCases[i])} 渲染不抛错`);
        }
      }
      // 确认 formatClock 确实未暴露（记录为「未测到的直接单测」）
      const clockExposed = await evaluate("typeof window.__minipi.formatClock");
      console.log(`  note  window.__minipi.formatClock 类型=${clockExposed}（未暴露 → 只能经卡片路径间接验证）`);
    }

    /* ============================================================== C5 */
    group("[C5] XSS 实测：inlineText / markdown 里的脚本注入");
    {
      const payloads = [
        '<script>window.__pwned=1</script>',
        '<img src=x onerror="window.__pwned=2">',
        '<svg onload="window.__pwned=3"></svg>',
        '[click](javascript:window.__pwned=4)',
        '<a href="javascript:window.__pwned=5">x</a>',
        '"><script>window.__pwned=6</script>',
        '<iframe src="javascript:window.__pwned=7"></iframe>',
        '**bold** <script>window.__pwned=8</script>',
        '# 标题 <script>window.__pwned=9</script>',
        '- 列表 <img src=x onerror="window.__pwned=10">',
        '> 引用 <script>window.__pwned=11</script>',
        '`代码 <script>window.__pwned=12</script>`',
        '![img](javascript:window.__pwned=13)',
        '<math><mtext><script>window.__pwned=14</script></mtext></math>',
      ];

      // 判定口径：把 markdownPreview 的输出**真正解析成 DOM**，检查是否存在
      //   · 真实 <script>/<iframe>/<svg>/<math> 元素
      //   · 任意元素带 on* 事件属性
      //   · 任意 <a> 的 href 是 javascript:/data:/vbscript:
      // 只看「已解析的元素/属性」，绝不用正则扫文本（那会把已转义的 &lt;img onerror=...&gt; 误报）。
      const detectExpr = (src) => `(() => {
        const host = document.createElement('div');
        host.innerHTML = window.__minipi.markdownPreview(${JSON.stringify(src)});
        let scripts=0, handlers=0, jsUrls=0, tags=[];
        host.querySelectorAll('script,iframe,svg,math,object,embed').forEach(e=>{scripts++;tags.push(e.tagName);});
        host.querySelectorAll('*').forEach(el=>{
          for (const a of el.attributes) if (/^on/i.test(a.name)) handlers++;
          if (el.tagName==='A' && /^\\s*(javascript|data|vbscript):/i.test(el.getAttribute('href')||'')) jsUrls++;
        });
        return { scripts, handlers, jsUrls, tags };
      })()`;

      for (let i = 0; i < payloads.length; i += 1) {
        const p = payloads[i];
        const det = await evaluate(detectExpr(p));
        // 同时注入产出卡片喂 inlineText，确认卡片 DOM 无可执行节点
        await evaluate(`window.__minipi.injectOutcome({
          outcomeId:'o_xss_${i}', sessionId:'s_1', format:'md', degraded:true,
          fileName:'xss-${i}.md', bytes:10, title:'xss', createdAt: Date.now(),
          actions:['open','saveAs','revise'], inlineText: ${JSON.stringify(p)}
        })`);
        await sleep(60);
        const domCheck = await evaluate(`(() => {
          const h = document.querySelector('#miniBody');
          if (!h) return { scripts:0, handlers:0, jsUrls:0 };
          let scripts=0, handlers=0, jsUrls=0;
          scripts += h.querySelectorAll('script,iframe,svg,math,object,embed').length;
          h.querySelectorAll('*').forEach(el => {
            for (const a of el.attributes) if (/^on/i.test(a.name)) handlers++;
            if (el.tagName==='A' && /^\\s*(javascript|data|vbscript):/i.test(el.getAttribute('href')||'')) jsUrls++;
          });
          return { scripts, handlers, jsUrls };
        })()`);

        const bad = det.scripts > 0 || det.handlers > 0 || det.jsUrls > 0 || domCheck.scripts > 0 || domCheck.handlers > 0 || domCheck.jsUrls > 0;
        if (bad) {
          finding("P0", "C5-XSS", `XSS 载荷 ${i} 产生了真实可执行节点/属性`, `parsed=${JSON.stringify(det)} · dom=${JSON.stringify(domCheck)} · payload=${p}`);
        }
        ok(!bad, `载荷 ${i} 无可执行节点（真实 DOM 解析）`, `scripts=${det.scripts}/handlers=${det.handlers}/jsUrls=${det.jsUrls}`);
      }

      // 最强证据：脚本从未执行
      const pwned = await evaluate("window.__pwned === undefined");
      ok(pwned === true, "window.__pwned 始终未定义（14 条载荷均无可执行注入）");
    }

    /* ============================================================== C6 */
    group("[C6] sanitizeHref / inlineHTML 协议白名单");
    {
      // 通过 markdownPreview 走 inlineHTML
      const urls = [
        ["[a](javascript:alert(1))", "javascript:"],
        ["[a](data:text/html,<script>1</script>)", "data:"],
        ["[a](vbscript:msgbox)", "vbscript:"],
        ["[a](https://example.com)", "https://"],
        ["[a](/local/path)", "/local"],
        ["[a](#anchor)", "#anchor"],
      ];
      for (const [src, tag] of urls) {
        const out = await evaluate(`window.__minipi.markdownPreview(${JSON.stringify(src)})`);
        const hasJsHref = /href\s*=\s*["']?(?:javascript|data|vbscript):/i.test(out);
        if (hasJsHref) {
          finding("P0", "C6-HREF", `危险协议未被过滤：${tag}`, out.slice(0, 200));
        }
        ok(!hasJsHref, `协议白名单：${tag} 未出现在 href`, out.replace(/<[^>]*>/g, "").slice(0, 60));
      }
    }

    /* ============================================================== C7 */
    group("[C7] 产出卡片渲染边界（空字段 / 超长 / 非字符串）");
    {
      const weirdCards = [
        { outcomeId: "o_w1", sessionId: "s_1", format: "docx", degraded: false, fileName: "", bytes: -1, title: "", createdAt: 0, actions: [] },
        { outcomeId: "o_w2", sessionId: "s_1", format: "weird", degraded: false, fileName: "a".repeat(2000) + ".docx", bytes: 1e12, title: "t", createdAt: NaN, actions: ["open"] },
        { outcomeId: "o_w3", sessionId: "s_1", format: "md", degraded: true, fileName: "x.md", bytes: null, title: null, createdAt: Date.now(), actions: null },
      ];
      for (let i = 0; i < weirdCards.length; i += 1) {
        let threw = false;
        try {
          await evaluate(`window.__minipi.injectOutcome(${JSON.stringify(weirdCards[i])})`);
          await sleep(150);
          const txt = await evaluate("window.__minipi.outcomeDomText()");
          const ovf = await evaluate("window.__minipi.outcomeOverflow()");
          if (ovf && ovf.overflows) {
            finding("P2", "C7-OVERFLOW", `畸形卡片 ${i} 造成横向溢出`, JSON.stringify(ovf));
          }
          ok(true, `畸形卡片 ${i} 渲染不抛错（文本长度 ${txt.length}）`, ovf ? `overflow=${ovf.overflows}` : "");
        } catch (err) {
          threw = true;
          finding("P1", "C7-THROW", `畸形卡片 ${i} 令渲染抛异常`, String(err));
          ok(false, `畸形卡片 ${i} 渲染不抛错`);
        }
      }
    }
  } catch (err) {
    finding("P1", "C-HARNESS", "headless 测试过程抛错（环境问题，非产品缺陷）", String(err));
    ok(false, `headless 测试完成（异常：${String(err).slice(0, 120)}）`);
  } finally {
    try { conn && conn.close(); } catch { /* ignore */ }
    try { chrome && chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ 汇总 */
console.log("\n======================================================================");
console.log(` 通过 ${passed} 项 · 失败 ${failed} 项`);
if (findings.length > 0) {
  console.log(` 发现 ${findings.length} 条：`);
  for (const f of findings) console.log(`   [${f.level}] ${f.id} · ${f.title}`);
}
console.log("======================================================================");
process.exit(failed > 0 ? 1 : 0);
