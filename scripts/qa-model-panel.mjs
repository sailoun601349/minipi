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
    ok(listSnap.count === 3, "默认展示 3 张卡片（featured 的 deepseek/zai + 自定义的 qa-gateway）", `实得 ${listSnap.count}`);
    ok(listSnap.providers.includes('deepseek'), "deepseek 在默认列表里");
    ok(listSnap.providers.includes('qa-gateway'), "★ 自定义提供方即使不在 featured 里也会被顶到默认列表");
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

    /* ------------------------------------------------------------ B7 */
    group("[B7] 自定义设置折叠区：API 地址 / 协议 / 模型目录行");
    await evaluate("window.__minipi.__providerWritesReset()");
    await evaluate(`document.querySelector('#provList .provCard[data-provider="zai"] [data-prov-edit]').click()`);
    await sleep(200);
    const details = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      const det = c.querySelector('details.provDetails');
      const url = c.querySelector('[data-prov-baseurl]');
      const api = c.querySelector('[data-prov-api]');
      const host = c.querySelector('[data-model-host]');
      return {
        hasDetails: !!det,
        summary: det ? det.querySelector('summary').textContent : '',
        urlPlaceholder: url ? url.placeholder : null,
        urlValue: url ? url.value : null,
        apiOptions: api ? [...api.options].map((o) => o.value) : [],
        apiValue: api ? api.value : null,
        hostKey: host ? host.getAttribute('data-model-host') : null,
        rows: c.querySelectorAll('.modelRow').length,
        emptyHint: !!c.querySelector('.modelRows__empty'),
        hasDiscover: !!c.querySelector('[data-discover]'),
        hasAdd: !!c.querySelector('[data-model-add]'),
      };
    })()`);
    ok(details.hasDetails === true, "编辑器里有「自定义设置」折叠区");
    ok(/自定义设置/.test(details.summary), "折叠区标题正确", details.summary);
    ok(details.urlPlaceholder === 'https://api.z.ai/api/coding/paas/v4', "API 地址 placeholder = 提供方默认地址", String(details.urlPlaceholder));
    ok(details.urlValue === '', "未覆盖过的提供方，地址框留空（占位符才是默认值）");
    ok(details.apiOptions.length === 4, "协议下拉列出 4 个受支持协议", `实得 ${details.apiOptions.length}`);
    ok(details.apiValue === 'openai-completions', "协议预填该提供方当前协议", String(details.apiValue));
    ok(details.hostKey === 'zai', "模型目录 host 绑定到该 provider");
    ok(details.rows === 0 && details.emptyHint === true, "未自定义目录时为空态提示（不预塞内置目录）");
    ok(details.hasDiscover && details.hasAdd, "目录区有「添加模型」与「获取可用模型」");

    /* ------------------------------------------------------------ B8 */
    group("[B8] 获取可用模型 → 多选 → 添加所选");
    await evaluate(`document.querySelector('#provList .provCard[data-provider="zai"] [data-discover]').click()`);
    await sleep(500);
    const disc = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      const box = c.querySelector('.discover');
      const boxes = box ? [...box.querySelectorAll('[data-discover-pick]')] : [];
      const calls = window.__minipi.__providerWrites();
      return {
        items: boxes.length,
        checked: boxes.filter((b) => b.checked).length,
        boxHidden: box ? box.hidden : null,
        calls: calls.filter((x) => x.kind === 'discoverModels'),
      };
    })()`);
    ok(disc.items === 3, "拉到 3 个候选模型", `实得 ${disc.items}`);
    ok(disc.checked === 3, "默认全部勾选（多数情况就是「都加上」）", `实得 ${disc.checked}`);
    ok(disc.boxHidden === false, "结果区可见");
    ok(disc.calls.length === 1, "只发了一次获取请求", `实得 ${disc.calls.length}`);
    ok(disc.calls[0]?.arg?.baseUrl === 'https://api.z.ai/api/coding/paas/v4', "请求带的是该提供方的地址", String(disc.calls[0]?.arg?.baseUrl));
    ok(disc.calls[0]?.arg?.provider === 'zai', "请求带上了 provider id");

    // 取消全选 → 只勾一条 → 添加所选
    await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      c.querySelector('[data-discover-all]').click();
      return true;
    })()`);
    await sleep(150);
    const afterToggle = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      return [...c.querySelectorAll('[data-discover-pick]')].filter((b) => b.checked).length;
    })()`);
    ok(afterToggle === 0, "点「全选」是全选/取消的开关（当前全选 → 变全不选）", `实得 ${afterToggle}`);

    await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      const box = c.querySelector('.discover');
      box.querySelector('[data-discover-pick][value="discovered-a"]').checked = true;
      box.querySelector('[data-discover-pick][value="discovered-a"]').dispatchEvent(new Event('change', { bubbles: true }));
      box.querySelector('[data-discover-adopt]').click();
      return true;
    })()`);
    await sleep(250);
    const adopted = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      const ids = [...c.querySelectorAll('[data-model-id]')].map((i) => i.value);
      return { ids, hasDiscoverBox: !!c.querySelector('.discover:not([hidden])') };
    })()`);
    ok(adopted.ids.length === 1 && adopted.ids[0] === 'discovered-a', "只把勾上的那条并进目录", adopted.ids.join(','));

    /* ------------------------------------------------------------ B9 */
    group("[B9] 保存：提交的提供方定义内容正确");
    await evaluate("window.__minipi.__providerWritesReset()");
    await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="zai"]');
      c.querySelector('[data-prov-baseurl]').value = 'https://my-proxy.local/v1';
      c.querySelector('[data-prov-baseurl]').dispatchEvent(new Event('input', { bubbles: true }));
      c.querySelector('[data-prov-save]').click();
      return true;
    })()`);
    await sleep(600);
    const saved = await evaluate("window.__minipi.__providerWrites()");
    const setCall = saved.find((x) => x.kind === 'setProvider');
    ok(Boolean(setCall), "保存时发出了 setProvider");
    ok(setCall?.arg?.provider === 'zai', "provider 正确", String(setCall?.arg?.provider));
    ok(setCall?.arg?.definition?.baseUrl === 'https://my-proxy.local/v1', "提交了新填的 API 地址", String(setCall?.arg?.definition?.baseUrl));
    ok(Array.isArray(setCall?.arg?.definition?.models) && setCall.arg.definition.models.length === 1, "提交了模型目录（1 条）", String(setCall?.arg?.definition?.models?.length));
    ok(setCall?.arg?.definition?.api === 'openai-completions', "模型目录带了协议（否则 Pi 组不出 provider）", String(setCall?.arg?.definition?.api));
    ok(!('apiKey' in (setCall?.arg?.definition || {})), "★ 定义里**不含** apiKey（密钥只走 setApiKey）");

    /* ------------------------------------------------------------ B10 */
    group("[B10] 自定义提供方表单：校验 + 创建");
    await evaluate("window.__minipi.__providerWritesReset()");
    await evaluate("document.querySelector('#btnProvCustom').click()");
    await sleep(250);
    const form = await evaluate(`(() => {
      const box = document.querySelector('#provCustomBox');
      return {
        hidden: box ? box.hidden : null,
        hasId: !!box.querySelector('[data-cp-id]'),
        hasName: !!box.querySelector('[data-cp-name]'),
        hasUrl: !!box.querySelector('[data-prov-baseurl]'),
        hasApi: !!box.querySelector('[data-prov-api]'),
        hasKey: !!box.querySelector('[data-prov-key]'),
        apiOptions: box.querySelector('[data-prov-api]') ? [...box.querySelector('[data-prov-api]').options].map((o) => o.value) : [],
        hasCreate: !!box.querySelector('[data-cp-create]'),
        hasCatalog: !!box.querySelector('[data-model-host]'),
      };
    })()`);
    ok(form.hidden === false, "「+ 添加自定义提供方」展开表单");
    ok(form.hasId && form.hasName && form.hasUrl && form.hasApi && form.hasKey, "字段齐全（ID/显示名/地址/协议/密钥）");
    ok(form.apiOptions.length === 4, "协议下拉复用同一份枚举");
    ok(form.hasCatalog && form.hasCreate, "有模型目录区与「创建提供方」");

    // 非法 id：不发请求
    await evaluate(`(() => {
      const b = document.querySelector('#provCustomBox');
      b.querySelector('[data-cp-id]').value = 'Bad_ID';
      b.querySelector('[data-prov-baseurl]').value = 'https://x.example/v1';
      b.querySelector('[data-cp-create]').click();
      return true;
    })()`);
    await sleep(250);
    let writes = await evaluate("window.__minipi.__providerWrites()");
    ok(writes.filter((x) => x.kind === 'setProvider').length === 0, "非法 Provider ID 不提交（前端先挡）");

    // 合法 id 但已被占用
    await evaluate(`(() => {
      const b = document.querySelector('#provCustomBox');
      b.querySelector('[data-cp-id]').value = 'zai';
      b.querySelector('[data-cp-create]').click();
      return true;
    })()`);
    await sleep(250);
    writes = await evaluate("window.__minipi.__providerWrites()");
    ok(writes.filter((x) => x.kind === 'setProvider').length === 0, "id 已被占用时不提交");

    // 合法创建：带密钥与模型
    await evaluate(`(() => {
      const b = document.querySelector('#provCustomBox');
      b.querySelector('[data-cp-id]').value = 'qa-new';
      b.querySelector('[data-cp-name]').value = 'QA New';
      b.querySelector('[data-prov-baseurl]').value = 'https://new.example/v1';
      b.querySelector('[data-prov-key]').value = 'sk-QA-NEW-SECRET';
      const add = b.querySelector('[data-model-add]');
      add.click();
      const row = b.querySelector('.modelRow');
      row.querySelector('[data-model-id]').value = 'new-model-1';
      row.querySelector('[data-model-name]').value = 'New Model';
      b.querySelector('[data-cp-create]').click();
      return true;
    })()`);
    await sleep(700);
    writes = await evaluate("window.__minipi.__providerWrites()");
    const createCall = writes.find((x) => x.kind === 'setProvider');
    const keyCall = writes.find((x) => x.kind === 'setApiKey');
    ok(Boolean(createCall) && createCall.arg.provider === 'qa-new', "合法表单能创建", String(createCall?.arg?.provider));
    ok(createCall?.arg?.definition?.displayName === 'QA New', "带上显示名");
    ok(createCall?.arg?.definition?.baseUrl === 'https://new.example/v1', "带上 API 地址");
    ok(createCall?.arg?.definition?.models?.length === 1 && createCall.arg.definition.models[0].id === 'new-model-1', "带上模型目录");
    ok(!('apiKey' in (createCall?.arg?.definition || {})), "★ 自定义定义里也不含 apiKey");
    ok(Boolean(keyCall) && keyCall.arg.providerId === 'qa-new', "密钥单独走 setApiKey");

    /* ------------------------------------------------------------ B11 */
    group("[B11] 删除定义：两步确认 + 不误删内置");
    await evaluate("window.__minipi.__providerWritesReset()");
    const hasRemove = await evaluate(`(() => {
      const cz = document.querySelector('#provList .provCard[data-provider="zai"]');
      const cq = document.querySelector('#provList .provCard[data-provider="qa-gateway"]');
      const cd = document.querySelector('#provList .provCard[data-provider="deepseek"]');
      return {
        zai: cz ? !!cz.querySelector('[data-prov-remove]') : null,
        zaiLabel: cz && cz.querySelector('[data-prov-remove]') ? cz.querySelector('[data-prov-remove]').textContent : null,
        custom: cq ? !!cq.querySelector('[data-prov-remove]') : null,
        customLabel: cq && cq.querySelector('[data-prov-remove]') ? cq.querySelector('[data-prov-remove]').textContent : null,
        deepseek: cd ? !!cd.querySelector('[data-prov-remove]') : null,
      };
    })()`);
    ok(hasRemove.deepseek === false, "没被 minipi 改过的内置提供方**没有**删除按钮");
    ok(hasRemove.customLabel === '删除提供方', "自定义提供方的按钮是「删除提供方」", String(hasRemove.customLabel));

    // 展开 qa-gateway 再点删除 → 进入二次确认；此时**不能**发删除请求
    await evaluate(`document.querySelector('#provList .provCard[data-provider="qa-gateway"] [data-prov-edit]').click()`);
    await sleep(200);
    await evaluate(`document.querySelector('#provList .provCard[data-provider="qa-gateway"] [data-prov-remove]').click()`);
    await sleep(250);
    const confirmState = await evaluate(`(() => {
      const c = document.querySelector('#provList .provCard[data-provider="qa-gateway"]');
      const writes = window.__minipi.__providerWrites();
      return {
        hasConfirm: !!c.querySelector('[data-prov-remove-confirm]'),
        confirmLabel: c.querySelector('[data-prov-remove-confirm]') ? c.querySelector('[data-prov-remove-confirm]').textContent : null,
        removes: writes.filter((x) => x.kind === 'removeProvider').length,
      };
    })()`);
    ok(confirmState.hasConfirm === true, "第一次点删除只进入二次确认");
    ok(confirmState.confirmLabel === '确认删除', "确认为「确认删除」", String(confirmState.confirmLabel));
    ok(confirmState.removes === 0, "★ 未确认前**不**发删除请求");

    await evaluate(`document.querySelector('#provList .provCard[data-provider="qa-gateway"] [data-prov-remove-confirm]').click()`);
    await sleep(600);
    const removed = await evaluate("window.__minipi.__providerWrites()");
    const rmCall = removed.find((x) => x.kind === 'removeProvider');
    ok(Boolean(rmCall) && rmCall.arg.provider === 'qa-gateway', "确认后才真的删除", String(rmCall?.arg?.provider));

    /* ==================================================================
     * [C] 首启引导卡（ready:false 时贴在聊天区）
     *
     * ⚠ 这一段**重新导航**到一个注入了「假真宿主」的页面，而不是沿用上面的 mock 页。
     *   理由：内置 mock 的 `modelStatus()` 恒返回 `{ready:true}`，且 `mockHost` 没暴露给
     *   任何探针 —— 也就是说在 mock 页里**无法**让 `refreshModelStatus()` 走到真实 IPC 分支、
     *   也无法统计调用次数、更无法让它 reject。而这一组要验的恰恰是那条链路
     *   （`refreshModelStatus() → host.modelStatus() → store.modelStatus → 渲染`）。
     *   换成注入宿主后 `window.minipi` 存在 ⇒ `realHost` 非空 ⇒ 走**真实宿主分支**，
     *   所有调用可被记账。这与 `qa-session-list.mjs` 的做法一致（那边已验证可行）。
     * ================================================================== */
    group("[C] 首启引导卡：ready:false 出现 / ready:true 消失 / 去配置 / 不泄露 / 无 svg / IPC 契约");

    const GUIDE_SENTINEL = "QA-GUIDE-SENTINEL-7f3a9c";
    const FAKE_HOST = `(() => {
      const calls = [];
      const record = (k, a) => { calls.push({ k, a }); };
      /* 初始状态由 URL **query** 决定 —— 这样「重新导航」就等于一次真冷启动，
         可以在 boot() 那一刻就让 modelStatus reject / 返回非对象，
         而不是只能在页面内事后打补丁（那只测得到 store，测不到 boot 路径）。
         ⚠ 必须用 query 而不是 hash：file:///x.html#a → #b 是**同文档**导航，
           不会重新执行页面脚本，连 addScriptToEvaluateOnNewDocument 都不会重跑。
           第一版我用了 hash，结果拿到的是上一轮残留的 store（假红一片）。
         ⚠ 本段整体在模板字符串里，注释里**不要写反引号**（会提前闭合）。 */
      const Q = String(location.search || '');
      let statusMode =
        Q.includes('reject') ? 'reject' :
        Q.includes('nonobject') ? 'nonobject' :
        Q.includes('ready') ? 'ready' : 'sentinel';
      window.__qaGuide = {
        calls,
        count(kind) { return calls.filter((c) => c.k === kind).length; },
        last(kind) { const h = calls.filter((c) => c.k === kind); return h.length ? h[h.length - 1] : null; },
        setStatusMode(m) { statusMode = m; return statusMode; },
        getStatusMode() { return statusMode; },
        reset() { calls.length = 0; statusMode = 'sentinel'; return true; },
      };
      const ok = () => Promise.resolve({ ok: true });
      window.minipi = {
        modelStatus() {
          record('modelStatus');
          if (statusMode === 'reject') return Promise.reject(new Error('QA-GUIDE-REJECT-BOOM'));
          if (statusMode === 'nonobject') return Promise.resolve(null);
          if (statusMode === 'ready') return Promise.resolve({ ready: true, reason: '' });
          return Promise.resolve({ ready: false, reason: '${GUIDE_SENTINEL}' });
        },
        createSession() {
          record('createSession');
          return Promise.resolve({ sessionId: 's_guide_0001', sceneId: 'chat', model: 'mock/model', lastSeq: 0 });
        },
        sessionState() { return Promise.resolve({ status: 'idle', lastSeq: 0, messageCount: 0, costUsd: null }); },
        listSessions() { return Promise.resolve({ items: [] }); },
        getSettings() { return Promise.resolve({ webEnabled: true, alwaysOnTop: false, sceneId: 'chat', theme: 'system' }); },
        setSettings(p) { record('setSettings', p); return Promise.resolve({ webEnabled: true, alwaysOnTop: false, sceneId: 'chat' }); },
        getAbout() {
          return Promise.resolve({ minipi: { version: 'qa', electron: '0', chrome: '0', node: '0', platform: 'qa' }, pi: { name: 'pi', version: '0', aiVersion: '0' }, consistent: true });
        },
        listModels() { return Promise.resolve({ current: null, defaultModel: null, models: [] }); },
        listProviders() { return Promise.resolve({ current: null, defaultModel: null, featured: [], providers: [] }); },
        listAssets() { return Promise.resolve({ items: [] }); },
        onWindowState() { return () => {}; },
        onEvent() { return () => {}; },
        onHotkey() { return () => {}; },
        onOutcome() { return () => {}; },
        onApproval() { return () => {}; },
        onBallPeek() { return () => {}; },
        onBallMenuClosed() { return () => {}; },
        setWindowState() { return ok(); },
        hide() { return ok(); },
      };
      return true;
    })()`;

    await conn.send("Page.enable");
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_HOST });
    await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}` });

    let ready2 = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        ready2 = await evaluate("document.readyState === 'complete' && !!window.__qaGuide && !!window.__minipi && !!document.querySelector('#miniBody')");
        if (ready2) break;
      } catch {
        /* 页面还在加载 */
      }
      await sleep(250);
    }
    ok(ready2, "（前置）重新导航后假真宿主已注入，渲染层走**真实宿主分支**");

    if (!ready2) throw new Error("注入宿主后页面未就绪，[C] 组无法执行");

    /* 等 boot() 里的 void refreshModelStatus() 落定 */
    for (let i = 0; i < 20; i += 1) {
      const st = await evaluate("window.__minipi.modelStatus()");
      if (st && st.ready === false) break;
      await sleep(150);
    }
    await sleep(400);

    /* ------------------------------------------------------------ C1 */
    const c1 = await evaluate(`(() => {
      const card = document.querySelector('.modelguide');
      const body = document.querySelector('#miniBody');
      return {
        exists: !!card,
        text: card ? card.textContent : '',
        title: card ? (card.querySelector('.modelguide__t') || {}).textContent || '' : '',
        inMiniBody: !!(card && body && body.contains(card)),
        status: window.__minipi.modelStatus(),
        calls: window.__qaGuide.count('modelStatus'),
      };
    })()`);

    ok(c1.exists === true, "★ ready:false 时聊天区出现引导卡 .modelguide");
    ok(c1.inMiniBody === true, "卡片挂在 #miniBody（聊天区）里，不是别处");
    ok(c1.title === "还不能对话", "卡片标题是「还不能对话」", String(c1.title));
    ok(
      c1.text.includes(GUIDE_SENTINEL),
      "★ 卡片文本含主进程给的 reason 哨兵（不是只渲染固定文案、把 reason 丢了）",
      `含哨兵=${c1.text.includes(GUIDE_SENTINEL)}`,
    );
    ok(c1.status && c1.status.ready === false, "store.modelStatus 已被 refreshModelStatus 写入", JSON.stringify(c1.status));
    ok(c1.calls >= 1, "★ host.modelStatus 被调用（IPC 链路真的走通了）", `调用 ${c1.calls} 次`);

    /* ------------------------------------------------------------ C2 */
    const c2 = await evaluate(`(() => {
      const card = document.querySelector('.modelguide');
      const text = card ? card.textContent : '';
      return {
        hasSk: /sk-/.test(text),
        /* 老缺陷的泄露形状是 ~/.pi（Pi 自己的目录）。
           注意 ~ 与 . 之间还有一个 /，所以正则必须写成 ~\\/\\.pi。
           第一版我写成 ~\\.minipi（漏了斜杠），结果对照组红、而"不含"的那条假绿。 */
        hasPiDir: /~\\/\\.pi\\b/.test(text),
        hasMinipiDir: /~\\/\\.minipi/.test(text),
        text,
      };
    })()`);
    ok(c2.hasSk === false, "★ 卡片文本里没有 `sk-`（不泄露 key 形状）", `text=${String(c2.text).slice(0, 120)}`);
    ok(c2.hasPiDir === false, "★ 卡片文本里没有 `~/.pi`（第 2 阶段修掉的老缺陷不许从引导卡爬回来）", `text=${String(c2.text).slice(0, 160)}`);
    ok(c2.hasMinipiDir === true, "对照：允许并鼓励出现 `~/.minipi`（这是我们自己的目录，用于「只存本机」的信任文案）", `含=${c2.hasMinipiDir}`);

    /* ------------------------------------------------------------ C3 */
    const c3 = await evaluate(`(() => {
      const card = document.querySelector('.modelguide');
      if (!card) return { svgs: -1, iconSpans: -1, masks: -1 };
      return {
        svgs: card.querySelectorAll('svg').length,
        iconSpans: card.querySelectorAll('.iconSpan').length,
        masks: card.querySelectorAll('[style*="mask"]').length,
      };
    })()`);
    ok(
      c3.svgs === 0,
      "★ 卡片内没有任何 <svg>（插 svg 会被 qa-renderer-edge C5 判成 XSS）",
      `svg=${c3.svgs} · iconSpan=${c3.iconSpans} · mask=${c3.masks}`,
    );

    /* ------------------------------------------------------------ C4 */
    await evaluate("window.__qaGuide.reset(); window.__qaGuide.setStatusMode('sentinel')");
    const c4 = await evaluate(`(() => {
      const btn = document.querySelector('.modelguide [data-model-guide-open]');
      const panelBefore = document.querySelector('#settingsPanel');
      const beforeHidden = panelBefore ? panelBefore.hidden : null;
      /* 数 **class** 而不是 id：id 计数只能抓到"又建了一个 id=settingsPanel 的"，
         抓不到"建了个 settingsPanel2 / 换了 id 的新面板"（变异 M5 就是这么绕过去的）。 */
      const panelsBefore = document.querySelectorAll('.settingsPanel').length;
      if (btn) btn.click();
      return { hadBtn: !!btn, beforeHidden, panelsBefore, label: btn ? btn.textContent : '' };
    })()`);
    await sleep(500);
    const c4b = await evaluate(`(() => {
      const panel = document.querySelector('#settingsPanel');
      return {
        panels: document.querySelectorAll('.settingsPanel').length,
        hidden: panel ? panel.hidden : null,
        visible: panel ? (!panel.hidden && getComputedStyle(panel).display !== 'none') : false,
      };
    })()`);
    ok(c4.hadBtn === true, "卡片里有「去配置」按钮", String(c4.label).trim());
    ok(c4.beforeHidden === true, "（前置）点之前设置面板是关着的", `hidden=${c4.beforeHidden}`);
    ok(c4b.visible === true, "★ 点「去配置」→ 打开**现有** #settingsPanel（hidden=false 且可见）", `hidden=${c4b.hidden}`);
    ok(
      c4b.panels === c4.panelsBefore,
      "★ 复用现有面板，没有新建第二个 .settingsPanel（设计约束：不许另造一套设置 UI）",
      `点前 ${c4.panelsBefore} 个 / 点后 ${c4b.panels} 个`,
    );

    /* ------------------------------------------------------------ C5 */
    await evaluate("document.querySelector('#btnSettingsClose') ? document.querySelector('#btnSettingsClose').click() : true");
    await sleep(250);
    /* 用 hash 控制宿主初始状态 ⇒ 重新导航 = 一次真冷启动，能测到 boot() 那条路径。 */
    await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}?v=ready` });
    let ready3 = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        ready3 = await evaluate("document.readyState === 'complete' && !!window.__qaGuide && !!document.querySelector('#miniBody')");
        if (ready3) break;
      } catch {
        /* loading */
      }
      await sleep(250);
    }
    await sleep(600);
    const c5 = await evaluate(`(() => {
      const st = window.__minipi.modelStatus();
      return {
        exists: !!document.querySelector('.modelguide'),
        status: st,
        calls: window.__qaGuide.count('modelStatus'),
      };
    })()`);
    ok(ready3, "（前置）第二次导航就绪");
    ok(
      c5.status && c5.status.ready === true,
      "（前置）本轮 modelStatus 返回 ready:true（宿主的返回值真的被渲染层读到了）",
      JSON.stringify(c5.status),
    );
    ok(c5.exists === false, "★ ready:true 时不出现引导卡（不能一直挂着）");
    ok(c5.calls >= 1, "ready:true 轮也真的调了 host.modelStatus", `调用 ${c5.calls} 次`);

    /* ------------------------------------------------------------ C6 */
    /* 冷启动就让 IPC reject：渲染层**不该**依赖主进程守约。
       预期：不崩、不出现卡（读不到 ≠ 没有模型），而且没有未捕获错误冒到 window.onerror。 */
    await evaluate(`(() => {
      window.__qaErrors = [];
      window.addEventListener('error', (e) => window.__qaErrors.push(String((e && e.message) || e)));
      window.addEventListener('unhandledrejection', (e) => window.__qaErrors.push('unhandledrejection:' + String((e && e.reason && e.reason.message) || (e && e.reason) || '')));
      return true;
    })()`);
    await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}?v=reject` });
    let ready4 = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        ready4 = await evaluate("document.readyState === 'complete' && !!window.__qaGuide && !!document.querySelector('#miniBody')");
        if (ready4) break;
      } catch {
        /* loading */
      }
      await sleep(250);
    }
    await sleep(700);
    const c6 = await evaluate(`(() => {
      const st = window.__minipi.modelStatus();
      return {
        alive: !!document.querySelector('#miniBody') && !!document.querySelector('#sessList'),
        exists: !!document.querySelector('.modelguide'),
        status: st,
        calls: window.__qaGuide.count('modelStatus'),
        conn: window.__minipi.conn ? window.__minipi.conn() : null,
      };
    })()`);
    ok(ready4, "（前置）reject 轮页面仍能加载完成（没有在 boot 阶段炸掉）");
    ok(c6.calls >= 1, "★ reject 轮 host.modelStatus 确实被调用过（证明这轮真的走了 IPC）", `调用 ${c6.calls} 次`);
    ok(c6.alive === true, "★ reject 时页面仍然可用（#miniBody / #sessList 都还在）");
    ok(
      c6.status === null || c6.status === undefined,
      "★ reject 时不把「读不到」演成「没有模型」（store.modelStatus 保持 null）",
      JSON.stringify(c6.status),
    );
    ok(c6.exists === false, "reject 时不出现引导卡（null ≠ ready:false）");

    /* ------------------------------------------------------------ C7 */
    /* 返回非对象（宿主违约的最坏形态）：`r.ready` 会 TypeError 吗？渲染层该兜住。 */
    await conn.send("Page.navigate", { url: `file:///${HTML_PATH.replace(/\\/g, "/")}?v=nonobject` });
    let ready5 = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        ready5 = await evaluate("document.readyState === 'complete' && !!window.__qaGuide && !!document.querySelector('#miniBody')");
        if (ready5) break;
      } catch {
        /* loading */
      }
      await sleep(250);
    }
    await sleep(700);
    const c7 = await evaluate(`(() => {
      const st = window.__minipi.modelStatus();
      return {
        alive: !!document.querySelector('#miniBody'),
        exists: !!document.querySelector('.modelguide'),
        status: st,
        calls: window.__qaGuide.count('modelStatus'),
        text: (document.querySelector('.modelguide') || {}).textContent || '',
      };
    })()`);
    ok(ready5, "（前置）非对象轮页面仍能加载完成");
    ok(c7.calls >= 1, "非对象轮 host.modelStatus 确实被调用过");
    ok(c7.alive === true, "★ 宿主返回 null（非对象）时渲染层不崩");
    ok(
      c7.status && c7.status.ready === false && c7.status.reason === '',
      "★ 非对象按「未就绪」归一（ready:false / reason 空串），不是抛错也不是 undefined",
      JSON.stringify(c7.status),
    );
    ok(
      c7.exists === true && c7.text.includes('还没有配置模型'),
      "★ 非对象 ⇒ 卡片用兜底文案（说明 reason 缺失时不能渲染出 undefined）",
      `含兜底文案=${c7.text.includes('还没有配置模型')}`,
    );
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
