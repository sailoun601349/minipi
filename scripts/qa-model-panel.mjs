#!/usr/bin/env node
/**
 * QA · 模型设置面板（提供方卡片）· headless Chrome 纯 DOM 断言。
 *
 * 本轮把设置面板从「一个大下拉 + 一个 provider 下拉」重做成
 * **提供方卡片列表**（对齐 deepseek-harness 的信息架构）：
 *   卡片 = 名称 + provider 标签 + 密钥状态圆点 + 编辑 → 卡内展开 API 密钥 + 模型选择。
 *
 * 这个脚本守四件事：
 *   ① 默认**只列国内厂商**（featured），其余折叠进「添加提供方」；
 *   ② 圆点只表达「密钥配置状态」（绿=已配置、红=缺失），不表达连通性；
 *   ③ **密钥只写不读**：输入框恒为空、type=password、保存后立刻清空、DOM 里不留 key；
 *   ④ 默认模型是 `deepseek/deepseek-flash`（没显式选过时显示为「默认」）。
 *
 * 运行：`node scripts/qa-model-panel.mjs`。无 Chrome 时只做静态审查。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PORT = 9395;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-models-"));
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
console.log(" QA · 模型设置面板（提供方卡片）· 纯 DOM 断言");
console.log("======================================================================");

/* ---------------------------------------------------------------- A0 */
group("[A0] 静态审查：数据来源与「密钥只写不读」的接线");
{
  const html = fs.readFileSync(HTML_PATH, "utf8");
  ok(/host\.listProviders\(\)/.test(html), "渲染层调 host.listProviders()");
  ok(/function buildProviderCard/.test(html), "buildProviderCard 存在");
  ok(/function renderProviderList/.test(html), "renderProviderList 存在");
  ok(/function saveProviderCard/.test(html), "saveProviderCard 存在");
  ok(/data-prov-key/.test(html) && /data-prov-model/.test(html) && /data-prov-save/.test(html), "卡片三个动作属性齐全");
  // 渲染层不能自己硬编码国内厂商清单（必须吃主进程回传的 featured）
  ok(!/FEATURED_PROVIDER_IDS\s*=\s*\[/.test(html), "渲染层没有自己维护厂商清单（吃 featured）");
  // 旧的单下拉写法要被清掉，否则会留下两套入口
  ok(!/id="modelSelect"/.test(html), "旧 #modelSelect 下拉已移除");
  ok(!/id="keyProvider"/.test(html), "旧 #keyProvider 下拉已移除");
}

/* ---------------------------------------------------------------- Chrome */
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
        "--window-size=520,720",
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

    // 切大窗（设置按钮在大窗侧栏）+ 打开设置面板
    await evaluate("document.querySelector('[data-mock=\"mode-full\"]').click()");
    await sleep(200);
    await evaluate("document.querySelector('#btnSettings').click()");
    await sleep(600); // 等 listProviders 的 Promise resolve + 重绘

    /* ------------------------------------------------------------ B1 */
    group("[B1] 默认只列国内厂商；其余折叠");
    const listSnap = await evaluate(`(() => {
      const panel = document.querySelector('#settingsPanel');
      const cards = panel ? [...panel.querySelectorAll('#provList .provCard')] : [];
      return {
        panelVisible: panel ? !panel.hidden : false,
        count: cards.length,
        providers: cards.map((c) => c.getAttribute('data-provider')),
        current: (document.querySelector('#modelCurrent') || {}).textContent || '',
        moreHidden: document.querySelector('#provMore') ? document.querySelector('#provMore').hidden : null,
        addLabel: (document.querySelector('#btnProvAdd') || {}).textContent || '',
      };
    })()`);

    ok(listSnap.panelVisible === true, "设置面板已打开");
    ok(listSnap.count === 2, "默认展示 2 张卡片（featured：deepseek + zai）", `实得 ${listSnap.count}`);
    ok(listSnap.providers.includes('deepseek'), "deepseek 在默认列表里");
    ok(!listSnap.providers.includes('openai'), "openai 不在默认列表（折叠了）");
    ok(listSnap.moreHidden === true, "「其他提供方」区域默认收起");
    ok(/添加提供方/.test(listSnap.addLabel), "有「添加提供方」按钮", String(listSnap.addLabel).trim());
    ok(/deepseek-flash|V4\.1 Flash/i.test(listSnap.current), "顶部显示默认模型 deepseek-flash", String(listSnap.current).slice(0, 90));
    ok(listSnap.current.includes('默认'), "并标注这是「默认」而非用户显式选择");

    /* ------------------------------------------------------------ B2 */
    group("[B2] 卡片：密钥状态圆点 + 元信息");
    const cardSnap = await evaluate(`(() => {
      const get = (id) => document.querySelector('#provList .provCard[data-provider="' + id + '"]');
      const dump = (id) => {
        const c = get(id);
        if (!c) return null;
        const dot = c.querySelector('.provDot');
        return {
          name: (c.querySelector('.provCard__name') || {}).textContent || '',
          tag: (c.querySelector('.provCard__tag') || {}).textContent || '',
          dotClass: dot ? dot.className : '',
          dotTitle: dot ? dot.title : '',
          meta: (c.querySelector('.provCard__meta') || {}).textContent || '',
          editLabel: (c.querySelector('[data-prov-edit]') || {}).textContent || '',
        };
      };
      return { deepseek: dump('deepseek'), zai: dump('zai') };
    })()`);

    ok(cardSnap.deepseek && cardSnap.deepseek.name === 'DeepSeek', "卡片显示提供方显示名", cardSnap.deepseek?.name);
    ok(cardSnap.deepseek.tag === 'deepseek', "卡片带 provider id 小标签");
    ok(/provDot--on/.test(cardSnap.deepseek.dotClass), "已配置的 deepseek 是绿点");
    ok(cardSnap.deepseek.meta.includes('已配置'), "元信息写明「已配置」");
    ok(cardSnap.deepseek.meta.includes('当前模型'), "元信息标明它承载当前模型");
    ok(cardSnap.deepseek.meta.includes('2 个模型'), "元信息带模型条数");
    ok(cardSnap.zai && /provDot--off/.test(cardSnap.zai.dotClass), "未配置的 zai 是红点");
    ok(cardSnap.zai.meta.includes('未配置'), "未配置卡片写明「未配置」");
    ok(cardSnap.deepseek.editLabel === '编辑', "卡片有「编辑」按钮");

    /* ------------------------------------------------------------ B3 */
    group("[B3] 展开编辑卡：密钥只写不读 + 模型选择");
    await evaluate(`document.querySelector('#provList .provCard[data-provider="deepseek"] [data-prov-edit]').click()`);
    await sleep(200); // renderProviderList 同步重绘

    const editorSnap = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="deepseek"]');
      const key = c.querySelector('[data-prov-key]');
      const sel = c.querySelector('[data-prov-model]');
      return {
        hasEditor: !!c.querySelector('.provCard__editor'),
        keyType: key ? key.type : null,
        keyValue: key ? key.value : null,
        keyPlaceholder: key ? key.placeholder : null,
        options: sel ? [...sel.options].map((o) => o.value) : [],
        selected: sel ? sel.value : null,
      };
    })()`);

    ok(editorSnap.hasEditor === true, "点「编辑」展开卡内编辑器");
    ok(editorSnap.keyType === 'password', "API 密钥是 password 类型", String(editorSnap.keyType));
    ok(editorSnap.keyValue === '', "密钥输入框**恒为空**（不回显）", JSON.stringify(editorSnap.keyValue));
    ok(/留空|保持/.test(String(editorSnap.keyPlaceholder)), "已配置的提供方 placeholder 提示「留空则不变」", String(editorSnap.keyPlaceholder));
    ok(editorSnap.options.length === 2, "模型下拉列出 2 个模型", `实得 ${editorSnap.options.length}`);
    ok(editorSnap.options.includes('deepseek-flash') && editorSnap.options.includes('deepseek-v4-pro'), "两个模型都在选项里");
    ok(editorSnap.selected === 'deepseek-flash', "默认选中 deepseek-flash", String(editorSnap.selected));

    /* ------------------------------------------------------------ B4 */
    group("[B4] 保存：密钥落库后清空输入框、DOM 不留 key");
    await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="deepseek"]');
      c.querySelector('[data-prov-key]').value = 'sk-QA-SHOULD-NOT-PERSIST';
      c.querySelector('[data-prov-save]').click();
      return true;
    })()`);
    await sleep(700); // 等 saveProviderCard 的 await + loadModelPanel 重绘

    const afterSave = await evaluate(`(() => {
      const panel = document.querySelector('#settingsPanel');
      const c = document.querySelector('#provList .provCard[data-provider="deepseek"]');
      return {
        htmlHasKey: panel ? panel.innerHTML.includes('sk-QA-SHOULD-NOT-PERSIST') : true,
        editorStillOpen: c ? !!c.querySelector('.provCard__editor') : null,
        editorOpenCount: panel ? panel.querySelectorAll('.provCard__editor').length : -1,
        toast: (document.querySelector('#toast') || {}).textContent || '',
      };
    })()`);

    ok(afterSave.htmlHasKey === false, "★ 保存后 DOM 里**找不到**任何 key 明文");
    ok(afterSave.editorStillOpen === false, "保存成功后编辑器自动收起");
    ok(afterSave.editorOpenCount === 0, "没有别的卡片被误展开", `实得 ${afterSave.editorOpenCount}`);

    /* ------------------------------------------------------------ B5 */
    group("[B5] 「添加提供方」展开其余厂商");
    await evaluate("document.querySelector('#btnProvAdd').click()");
    await sleep(250);
    const more = await evaluate(`(() => {
      const box = document.querySelector('#provMore');
      const cards = box ? [...box.querySelectorAll('.provCard')] : [];
      return {
        hidden: box ? box.hidden : null,
        providers: cards.map((c) => c.getAttribute('data-provider')),
        addLabel: (document.querySelector('#btnProvAdd') || {}).textContent || '',
      };
    })()`);
    ok(more.hidden === false, "点一下展开「其他提供方」");
    ok(more.providers.includes('openai'), "openai 出现在展开区", more.providers.join(','));
    ok(/收起/.test(more.addLabel), "按钮文案变成「收起」", String(more.addLabel).trim());

    /* ------------------------------------------------------------ B6 */
    group("[B6] 空保存不发请求 + 无 XSS 注入");
    const guard = await evaluate(`(() => {
      const c = document.querySelector('#provMore .provCard[data-provider="openai"]');
      c.querySelector('[data-prov-edit]').click();
      return true;
    })()`);
    ok(guard === true, "能展开折叠区里的卡片");
    await sleep(150);
    await evaluate(`(() => {
      const c = document.querySelector('#provMore .provCard[data-provider="openai"]');
      c.querySelector('[data-prov-save]').click();
      return true;
    })()`);
    await sleep(300);
    const emptySave = await evaluate(`(() => {
      const c = document.querySelector('#provMore .provCard[data-provider="openai"]');
      return {
        editorOpenCount: document.querySelectorAll('.provCard__editor').length,
        stillOpen: c ? !!c.querySelector('.provCard__editor') : null,
        imgs: document.querySelectorAll('#settingsPanel img').length,
      };
    })()`);
    ok(emptySave.editorOpenCount === 1, "什么都没填时保存不关编辑器（提示用户）", `实得 ${emptySave.editorOpenCount}`);
    ok(emptySave.imgs === 0, "面板里没有注入出来的 <img> 节点");
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
console.log(" 覆盖边界：断言渲染层 DOM；不覆盖真 Pi 凭据落盘（那条在 verify:models 的凭证存储用例里）。");
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
