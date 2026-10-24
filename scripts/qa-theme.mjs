#!/usr/bin/env node
/**
 * QA · 双主题（T1）· 令牌 + 切换 + 对比度。
 *
 * 守四件事：
 *   A. **令牌齐备**：规格 §3.2 的语义令牌一个不少，且浅色覆盖在 `@media` 与 `html[data-theme]` 两处都在
 *      （前者给真机跟随系统、后者给 mock/截图强制）。
 *   B. **不再新增硬编码颜色**：`:root` 与两个覆盖块之外，hex/rgba 必须为 0（允许一份显式白名单）。
 *   C. **切换真的生效**：点设置里的三选一，计算样式里的 `--bg` 真的变，且浅色确实比深色亮。
 *   D. **浅色可读**：正文/次级文字在 `--surface` 上的对比度 ≥ 4.5 / ≥ 3.0（WCAG AA）。
 *
 * 运行：`node scripts/qa-theme.mjs`。无 Chrome 时只做 A/B 两项。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9392;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-theme-"));
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
console.log(" QA · 双主题（令牌 / 切换 / 对比度）");
console.log("======================================================================");

/* ------------------------------------------------------------------ A/B 静态 */
const html = fs.readFileSync(HTML_PATH, "utf8");
const at = html.lastIndexOf('<script type="module">');
const css = html.slice(0, at);
const js = html.slice(at);

group("[A] 令牌齐备 + 三处定义");
const REQUIRED = [
  "bg", "bg-2", "surface", "surface-2", "surface-3", "composer",
  "border", "border-strong", "divider",
  "text", "text-2", "muted", "muted-2", "text-inverse",
  "accent", "accent-2", "accent-soft", "on-accent",
  "danger", "danger-soft", "success", "success-soft", "warn", "warn-soft",
  "shadow-1", "shadow-2", "overlay",
  "ball-bg-1", "ball-bg-2", "ball-border", "ball-ink",
  "code-bg", "code-text", "diff-add", "diff-del", "diff-hunk",
];
const missing = REQUIRED.filter((t) => !new RegExp(`--${t}\\s*:`).test(css));
ok(missing.length === 0, `规格 §3.2 的 ${REQUIRED.length} 个令牌全部定义`, missing.join(",") || "");

const rootEnd = css.indexOf('\n}\n', css.indexOf(':root{'));
const darkBlock = css.slice(css.indexOf(':root{'), rootEnd);
const lightMediaAt = css.indexOf("@media (prefers-color-scheme: light)");
const dataLightAt = css.indexOf('html[data-theme="light"]');
ok(darkBlock.includes("--bg:#181818"), "暗色锚点 = #181818（规格 D-02 A 方案）");
ok(lightMediaAt > -1, "有 @media (prefers-color-scheme: light) 覆盖（真机跟随系统）");
ok(dataLightAt > -1, "有 html[data-theme=\"light\"] 覆盖（mock / 截图用）");
ok(/color-scheme:\s*(dark|light)/.test(css), "声明了 color-scheme（原生控件跟着变）");
ok(/html\[data-theme="dark"\]/.test(css), "有 html[data-theme=\"dark\"] 强制覆盖");

group("[B] 除令牌定义外，不许再有硬编码颜色");
{
  // 把 :root / media-light / data-light / data-dark 四个定义块切出去，剩下的才是组件样式
  const cut = (src, from, toMarker) => {
    const i = src.indexOf(from);
    if (i < 0) return src;
    const j = src.indexOf(toMarker, i);
    return src.slice(0, i) + src.slice(j < 0 ? src.length : j);
  };
  let rest = css;
  rest = cut(rest, ":root{", "\n}\n");
  rest = cut(rest, "@media (prefers-color-scheme: light)", "\n}\n}\n");
  rest = cut(rest, 'html[data-theme="light"]', "\n}\n");
  rest = cut(rest, 'html[data-theme="dark"]', "\n}\n");
  // 白名单：允许留在组件里的（空 = 一个都不允许）。
  // 有正当理由的写法：none。真需要时把值加进来并写清楚原因。
  const ALLOW = [];
  const hexes = [...new Set((rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((x) => x.toLowerCase()))].filter(
    (x) => !ALLOW.includes(x),
  );
  const rgbas = [...new Set((rest.match(/rgba?\([^)]*\)/g) || []).map((x) => x.replace(/\s+/g, "")))].filter(
    (x) => !ALLOW.includes(x),
  );
  ok(hexes.length === 0, "组件样式里没有硬编码 hex", hexes.slice(0, 10).join(","));
  ok(rgbas.length === 0, "组件样式里没有硬编码 rgba/rgb", rgbas.slice(0, 6).join(","));
}

group("[B2] **脚本**里也不许写死颜色（换主题时 JS 设过的颜色不会跟着变）");
{
  /* 这一条是补的漏：CSS 清零不等于全清 —— `el.style.color = '#ff9d96'` 这类
     写在 JS 里的颜色**不会**随主题变，浅色下就成了浅粉压白底。
     允许清单只有一项：`iconMarkup()` 里的 `stroke="#000"` ——
     那是拼给 CSS mask 的 data-URI，只取 alpha 通道，颜色本身不参与渲染。 */
  const JS_ALLOW = ['"#000"', "'#000'"];
  const jsColors = [...new Set(
    (js.match(/['"](?:#(?:[0-9a-fA-F]{3,8})|rgba?\([^)]*\))['"]/g) || []).map((x) => x),
  )].filter((x) => !JS_ALLOW.includes(x));
  ok(jsColors.length === 0, "脚本里没有硬编码颜色字面量", jsColors.join(","));
  ok(/style\.color = 'var\(--danger-ink\)'/.test(js), "错误文字色走令牌（不再是写死的浅粉）");
}

group("[C] 主题接线（主进程 + UI）");
{
  const main = fs.readFileSync(path.join(ROOT, "src", "main", "index.js"), "utf8");
  const settings = fs.readFileSync(path.join(ROOT, "src", "main", "settings.js"), "utf8");
  const protocol = fs.readFileSync(path.join(ROOT, "src", "shared", "protocol.js"), "utf8");
  ok(/THEME_IDS = Object\.freeze\(\["system", "light", "dark"\]\)/.test(protocol), "协议里定义了主题三态");
  ok(/ALLOWED_TOP_KEYS[^;]*"theme"/.test(settings), "★ settings 白名单放行 theme（不加会被静默丢弃）");
  ok(/nativeTheme\.themeSource = loaded\.theme/.test(main), "主进程在建窗口前设置 themeSource（无首帧闪烁）");
  ok(
    main.indexOf("nativeTheme.themeSource = loaded.theme") < main.indexOf("await wm.create()"),
    "设置在 wm.create() **之前**",
  );
  ok(/nativeTheme\.themeSource = next\.theme/.test(main), "改设置时即时落到 nativeTheme");
  ok(/async function chooseTheme\(/.test(js) || /function chooseTheme\(/.test(js), "渲染层有 chooseTheme()");
  /* 2026-10-20 用户要求：外观从设置面板**搬到菜单**，设置里只留模型。
     两个菜单（☰ 与球右键）各 3 项，共用 data-appearance-opt。 */
  ok((html.match(/data-appearance-opt=/g) || []).length >= 6,
    "菜单里有 3 个外观选项（☰ + 球右键各一份）", String((html.match(/data-appearance-opt=/g) || []).length));
  ok(!/data-theme-opt=/.test(html), "★ 设置面板不再重复放外观（单一入口）");
  ok(/settingsPanel__h">模型设置/.test(html), "设置面板标题回到「模型设置」");
}

/* ------------------------------------------------------------------ Chrome */
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
  ok(false, "本机无 Chrome → 跳过行为与对比度断言（明确「未测到」，不伪绿）");
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
        "--window-size=1000,720",
        "--allow-file-access-from-files",
        `file:///${HTML_PATH.replace(/\\/g, "/")}`,
      ],
      { detached: true, stdio: "ignore" },
    );
    conn = await connect((await cdpTargets()).webSocketDebuggerUrl);
    await conn.send("Runtime.enable");
    await sleep(1500);
    ok((await evaluate("window.__minipi ? window.__minipi.mock() : null")) === true, "mock 探针就绪");

    group("[D] 主题切换真的改变了计算样式");
    const bgOf = async (theme) =>
      evaluate(`(() => {
        ${theme === "system" ? "delete document.documentElement.dataset.theme;" : `document.documentElement.dataset.theme='${theme}';`}
        const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        return v;
      })()`);
    const darkBg = await bgOf("dark");
    const lightBg = await bgOf("light");
    ok(darkBg === "#181818", "dark ⇒ --bg = #181818", darkBg);
    ok(lightBg === "#f7f7f7", "light ⇒ --bg = #f7f7f7", lightBg);

    group("[E] 设置面板的三选一点下去要生效");
    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(250);
    await evaluate("document.querySelector('#btnSettings').click()");
    await sleep(700);
    const opts = await evaluate(`[...document.querySelectorAll('[data-appearance-opt]')].map(b=>b.dataset.appearanceOpt)`);
    ok(opts.slice(0, 3).join(",") === "system,light,dark", "三个选项都在", opts.slice(0, 3).join(","));

    // 菜单里的外观项：点 ☰ → 点「浅色」
    await evaluate("document.querySelector('#btnMiniMenu') && document.querySelector('#btnMiniMenu').click()");
    await sleep(300);
    await evaluate(`(() => { const el = document.querySelector('#ballMenu [data-appearance-opt="light"]'); if (el) el.click(); return true; })()`);
    await sleep(450);
    const afterLight = await evaluate(`({
      checked: [...document.querySelectorAll('[data-appearance-opt]')].filter(b=>b.getAttribute('aria-checked')==='true').map(b=>b.dataset.appearanceOpt),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      htmlTheme: document.documentElement.dataset.theme || '',
    })`);
    ok(afterLight.checked.includes("light"), "★ 点「浅色」后菜单勾选跟到 light", afterLight.checked.join(","));
    ok(afterLight.htmlTheme === "light", "mock 下 data-theme 被置为 light（真机不设，靠媒体查询）", afterLight.htmlTheme);
    ok(afterLight.bg === "#f7f7f7", "浅色令牌真的生效", afterLight.bg);

    group("[F] 浅色可读性（WCAG AA）");
    const contrast = await evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      const lum = (hex) => {
        const m = hex.replace('#','');
        const v = m.length === 3 ? m.split('').map(c=>parseInt(c+c,16)) : [0,2,4].map(i=>parseInt(m.slice(i,i+2),16));
        const f = (c) => { const s = c/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); };
        return 0.2126*f(v[0]) + 0.7152*f(v[1]) + 0.0722*f(v[2]);
      };
      const ratio = (a,b) => { const [x,y] = [lum(a), lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
      const surface = g('--surface');
      return {
        surface,
        textOnSurface: +ratio(g('--text'), surface).toFixed(2),
        text2OnSurface: +ratio(g('--text-2'), surface).toFixed(2),
        mutedOnSurface: +ratio(g('--muted'), surface).toFixed(2),
        accentOnSurface: +ratio(g('--accent'), surface).toFixed(2),
      };
    })()`);
    ok(contrast.textOnSurface >= 4.5, `正文对比度 ≥ 4.5`, `${contrast.textOnSurface}:1 on ${contrast.surface}`);
    ok(contrast.text2OnSurface >= 4.5, "次级正文 ≥ 4.5", `${contrast.text2OnSurface}:1`);
    ok(contrast.mutedOnSurface >= 3.0, "辅助文字 ≥ 3.0", `${contrast.mutedOnSurface}:1`);
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
console.log(" 覆盖边界：断言令牌与计算样式；不覆盖真实 nativeTheme 切换（需真窗口）、不覆盖 18 组截图矩阵。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
