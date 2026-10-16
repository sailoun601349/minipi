#!/usr/bin/env node
/**
 * 提供方定义（模型配置第二批）· 纯 Node 验证。
 *
 * 守四块：
 *   A. `ProviderStore` —— `~/.minipi/providers.json` 的白名单归一化 / 原子写 / 坏文件兜底；
 *   B. `toProviderConfigInput` —— minipi 定义 → Pi `ProviderConfigInput` 的字段映射；
 *   C. `applyProviderDefinitions` —— 「让运行时严格等于存储」的同步语义（含故障隔离）；
 *   D. `discover-models` —— 清单端点拼接 / 响应解析 / 超时与错误分类 / **密钥不外泄**。
 *
 * 另外还有一段 E：在**真实 ModelRuntime** 上跑一遍注入与回退（不发网络请求），
 * 证明「写自己的配置 + registerProvider」这条路真的能把提供方立起来 —— 纯函数测了不等于接得上。
 *
 * 运行：`node scripts/verify-providers.mjs`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProviderStore,
  normalizeProviderDefinition,
  normalizeProvidersDoc,
  normalizeProviderModel,
} from "../src/main/pi/providers-store.js";
import { applyProviderDefinitions, toProviderConfigInput, buildProviderCatalog } from "../src/main/pi/session.js";
import { discoverModels, listingUrl, parseModelListing, LISTABLE_PROTOCOLS } from "../src/main/pi/discover-models.js";
import { LIMITS, PROVIDER_API_IDS, PROVIDER_ID_PATTERN_SOURCE } from "../src/shared/protocol.js";

let pass = 0;
let fail = 0;
function ok(cond, label, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? ` · ${extra}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? ` · ${extra}` : ""}`);
  }
}
const group = (t) => console.log(`\n${t}`);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-providers-"));
const newStore = (name = "p") => new ProviderStore({ filePath: path.join(tmpRoot, `${name}.json`), logger: { warn() {} } });

console.log("=".repeat(76));
console.log(" 提供方定义 · 纯 Node 验证");
console.log("=".repeat(76));

/* ==================================================================== A */
group("[A] ProviderStore：归一化 / 原子写 / 坏文件兜底");
{
  const store = newStore("a");
  ok(store.ids().length === 0, "文件不存在时加载 = 空配置");
  store.load();
  ok(Object.keys(store.get()).length === 0, "load() 后仍为空");
  ok(fs.existsSync(store.filePath) === false, "没有定义时不创建文件");
}
{
  const store = newStore("b");
  store.load();
  const def = store.set("qa-gateway", {
    displayName: "QA Gateway",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    models: [{ id: "m1", name: "M1", contextWindow: 128000, maxTokens: 8192 }],
  });
  ok(def.provider === "qa-gateway", "set() 返回归一化后的定义");
  ok(fs.existsSync(store.filePath), "落盘成功");
  ok(fs.existsSync(`${store.filePath}.tmp`) === false, "没有残留 .tmp（原子替换）");
  const raw = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  ok(raw.version === 1, "文件带 version");
  ok(raw.providers["qa-gateway"].models[0].id === "m1", "模型落盘");
  ok(!JSON.stringify(raw).includes("apiKey"), "★ 文件里没有 apiKey 字段");

  const again = newStore("b");
  again.load();
  ok(again.getOne("qa-gateway")?.displayName === "QA Gateway", "重新加载读得回");
  ok(again.remove("qa-gateway") === true, "remove() 返回 true");
  ok(again.remove("qa-gateway") === false, "重复 remove() 返回 false");
  ok(Object.keys(JSON.parse(fs.readFileSync(again.filePath, "utf8")).providers).length === 0, "删除已落盘");
}
{
  const store = newStore("c");
  store.load();
  const bad = [
    ["Bad_ID", { baseUrl: "https://x/v1" }, "大写/下划线 id"],
    ["1abc", { baseUrl: "https://x/v1" }, "数字开头 id"],
    ["ok", { baseUrl: "ftp://x/v1" }, "非 http(s) 协议"],
    ["ok", { baseUrl: "javascript:alert(1)" }, "javascript: 协议"],
    ["ok", { baseUrl: "/relative/path" }, "相对路径"],
    ["ok", { baseUrl: "https://x/v1", api: "nope" }, "未知协议"],
    ["ok", { baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "a" }, { id: "a" }] }, "模型 id 重复"],
    ["ok", { baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "" }] }, "空模型 id"],
    ["ok", { baseUrl: "https://x/v1", api: "openai-completions", models: [{ id: "x".repeat(LIMITS.PROVIDER_MODEL_ID_MAX_CHARS + 1) }] }, "模型 id 超长"],
    ["ok", { baseUrl: `https://x/${"a".repeat(LIMITS.PROVIDER_BASE_URL_MAX_CHARS)}` }, "baseUrl 超长"],
    ["ok", {}, "空定义（什么都没改）"],
    ["ok", "not-an-object", "definition 不是对象"],
  ];
  let rejected = 0;
  for (const [id, def, label] of bad) {
    try {
      store.set(id, def);
    } catch {
      rejected += 1;
    }
  }
  ok(rejected === bad.length, `非法定义全部被拒（${rejected}/${bad.length}）`);
  ok(store.ids().length === 0, "拒绝之后存储仍为空（没写脏）");

  const tooMany = { baseUrl: "https://x/v1", api: "openai-completions", models: Array.from({ length: LIMITS.PROVIDER_MODELS_MAX + 1 }, (_, i) => ({ id: `m${i}` })) };
  let threw = false;
  try {
    store.set("ok", tooMany);
  } catch {
    threw = true;
  }
  ok(threw, `模型条数 > ${LIMITS.PROVIDER_MODELS_MAX} 被拒`);
}
{
  // models: null = 「不带模型目录覆盖」；落盘后这个键应当消失
  const store = newStore("d");
  store.load();
  store.set("zai", { api: "openai-completions", models: null });
  const raw = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  ok(!("models" in raw.providers.zai), "models:null 落盘后被摘掉（= 沿用默认目录）");
  ok(raw.providers.zai.api === "openai-completions", "其它字段保留");
}
{
  const store = newStore("e");
  fs.writeFileSync(store.filePath, "{ this is not json", "utf8");
  store.load();
  ok(Object.keys(store.get()).length === 0, "坏 JSON ⇒ 回退空配置（不让 App 起不来）");
  ok(fs.existsSync(`${store.filePath}.bad`), "坏文件被备份成 .bad");
  ok(store.warnings.length >= 1, "产生了告警（不静默）");
}
{
  const doc = normalizeProvidersDoc({
    providers: {
      good: { baseUrl: "https://x/v1", api: "openai-completions" },
      BAD: { baseUrl: "https://x/v1" },
      "also-good": { displayName: "N" },
    },
  });
  ok(Object.keys(doc.providers).length === 2, "整份归一化：坏条目丢弃、好条目保留", Object.keys(doc.providers).join(","));
}
{
  ok(normalizeProviderModel({ id: " m ", contextWindow: -1, maxTokens: 1.5 })?.contextWindow === undefined, "容量为负数 ⇒ 丢弃（不夹到边界假装有效）");
  ok(normalizeProviderModel({ id: "m", maxTokens: Number.NaN })?.maxTokens === undefined, "容量 NaN ⇒ 丢弃");
  ok(normalizeProviderModel({ modelId: "alt" })?.id === "alt", "兼容 modelId 写法");
  ok(normalizeProviderDefinition("ok", { displayName: "x" }) !== null, "只给 displayName 也算有效定义");
  ok(normalizeProviderDefinition("ok", {}) === null, "空定义无效");
}
{
  const store = newStore("f");
  store.load();
  const big = "a".repeat(LIMITS.PROVIDER_DISPLAY_NAME_MAX_CHARS + 50);
  const def = store.set("ok", { baseUrl: "https://x/v1", displayName: big });
  ok(def.displayName.length === LIMITS.PROVIDER_DISPLAY_NAME_MAX_CHARS, "displayName 截断到上限");
}

/* ==================================================================== B */
group("[B] toProviderConfigInput：minipi 定义 → Pi ProviderConfigInput");
{
  const cfg = toProviderConfigInput({
    provider: "qa",
    displayName: "QA Gateway",
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    models: [{ id: "m1", name: "M1", contextWindow: 128000, maxTokens: 8192 }, { id: "m2" }],
  });
  ok(cfg.name === "QA Gateway", "displayName → name");
  ok(cfg.baseUrl === "https://gw.example/v1", "baseUrl 透传");
  ok(cfg.api === "openai-completions", "provider 级 api");
  ok(cfg.models.length === 2, "模型条数");
  ok(cfg.models[1].name === "m2", "模型没给 name 时用 id 补齐（Pi 要求 name）");
  ok(cfg.models[0].api === "openai-completions", "模型级也带 api（覆盖内置目录时不会丢协议）");
  ok(cfg.models[0].contextWindow === 128000 && cfg.models[1].contextWindow === undefined, "容量只在有值时带上");
}
{
  const cfg = toProviderConfigInput({ provider: "deepseek", baseUrl: "https://proxy/v1" });
  ok(cfg.models === undefined, "只覆盖地址 ⇒ 不带 models（Pi 会保留原目录）");
  ok(cfg.name === undefined && cfg.api === undefined, "未提供的字段不凭空造");
}

/* ==================================================================== C */
group("[C] applyProviderDefinitions：让运行时严格等于存储");
{
  const registered = new Map();
  const log = [];
  const fake = {
    getRegisteredProviderIds: () => [...registered.keys()],
    registerProvider(id, cfg) {
      if (id === "boom") throw new Error("模拟注入失败");
      registered.set(id, cfg);
      log.push(`+${id}`);
    },
    unregisterProvider(id) {
      registered.delete(id);
      log.push(`-${id}`);
    },
  };
  const report = applyProviderDefinitions(fake, {
    a: { provider: "a", baseUrl: "https://a/v1", api: "openai-completions" },
    boom: { provider: "boom", baseUrl: "https://b/v1", api: "openai-completions" },
    c: { provider: "c", displayName: "C" },
  });
  ok(report.applied.join(",") === "a,c", "成功的记进 applied", report.applied.join(","));
  ok(report.failed.length === 1 && report.failed[0].id === "boom", "失败的记进 failed（带 id）");
  ok(report.failed[0].reason.length > 0, "失败原因非空（不静默）");
  ok(registered.has("c"), "★ 一个提供方注入失败**不影响**其它提供方");

  const report2 = applyProviderDefinitions(fake, { c: { provider: "c", displayName: "C" } });
  // `boom` 压根没注册成功（registerProvider 抛了），所以它不在「当前已注册」集合里，
  // 自然也不会出现在 removed 里 —— 这是正确行为，别把断言写成"两个都要卸掉"。
  ok(report2.removed.includes("a"), "目标里没有的 id 会被卸掉", report2.removed.join(","));
  ok(registered.size === 1 && registered.has("c"), "卸完之后只剩目标里的");

  const report3 = applyProviderDefinitions(fake, {});
  ok(report3.removed.includes("c") && registered.size === 0, "空目标 ⇒ 全部卸掉（回落到内置/默认）");
}
{
  ok(applyProviderDefinitions(null, { a: {} }).applied.length === 0, "runtime 为空不崩");
  ok(applyProviderDefinitions({}, { a: {} }).applied.length === 0, "runtime 没有 registerProvider 不崩");
}

/* ==================================================================== D */
group("[D] discover-models：端点拼接 / 解析 / 错误分类 / 密钥不外泄");
{
  ok(listingUrl("https://api.openai.com/v1", "openai-completions") === "https://api.openai.com/v1/models", "openai-compatible ⇒ {base}/models");
  ok(listingUrl("https://api.openai.com/v1/", "openai-completions") === "https://api.openai.com/v1/models", "去掉尾部斜杠");
  ok(listingUrl("https://gw.example/v1/models", "openai-completions") === "https://gw.example/v1/models", "已经是 /models 就不重复拼");
  ok(listingUrl("https://api.anthropic.com", "anthropic-messages") === "https://api.anthropic.com/v1/models", "anthropic ⇒ 补 /v1/models");
  ok(listingUrl("https://api.anthropic.com/v1", "anthropic-messages") === "https://api.anthropic.com/v1/models", "anthropic 已带 /v1 就只补 /models");
  let threw = null;
  try {
    listingUrl("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai");
  } catch (e) {
    threw = e.message;
  }
  ok(Boolean(threw) && threw.includes("DISCOVER_FAILED"), "不支持的协议显式报错（不是静默空数组）", String(threw).slice(0, 60));
  ok(LISTABLE_PROTOCOLS.length === 3, "可拉清单的协议是 3 个", LISTABLE_PROTOCOLS.join(","));
  let threw2 = null;
  try {
    listingUrl("", "openai-completions");
  } catch (e) {
    threw2 = e.message;
  }
  ok(Boolean(threw2) && threw2.includes("DISCOVER_FAILED"), "空地址报错");
}
{
  ok(parseModelListing({ data: [{ id: "a" }, { id: "b", name: "Bee" }] }).length === 2, "OpenAI 形状 {data:[]}");
  const anth = parseModelListing({ data: [{ id: "claude-x", display_name: "Claude X" }] });
  ok(anth[0].modelId === "claude-x" && anth[0].name === "Claude X", "Anthropic 形状取 display_name");
  ok(parseModelListing({ models: [{ id: "m" }] })[0].modelId === "m", "{models:[]} 形状");
  ok(parseModelListing(["raw-a"]).length === 1, "裸数组（元素是字符串）");
  ok(parseModelListing({ data: [{ id: "a" }, { id: "a" }, { id: "" }] }).length === 1, "按 id 去重、丢掉空 id");
  ok(parseModelListing({ data: [{ id: "a" }] })[0].name === "a", "没名字就用 id 当名字");
  for (const [body, label] of [[{}, "空对象"], [{ x: 1 }, "没有列表字段"], [{ data: "nope" }, "data 不是数组"]]) {
    let bad = false;
    try {
      parseModelListing(body);
    } catch {
      bad = true;
    }
    ok(bad, `结构不认识就报错：${label}`);
  }
  let empty = false;
  try {
    parseModelListing({ data: [] });
  } catch {
    empty = true;
  }
  ok(empty, "空清单报错（不是静默返回 []）");
}
{
  const KEY = "sk-SECRET-DO-NOT-LEAK";
  const makeFetch = (impl) => impl;
  // 成功
  let seen = null;
  let res = await discoverModels({
    baseUrl: "https://gw.example/v1",
    api: "openai-completions",
    apiKey: KEY,
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "m1" }] }) };
    },
  });
  ok(res.models.length === 1 && res.url === "https://gw.example/v1/models", "成功路径返回模型清单");
  ok(seen.headers.authorization === `Bearer ${KEY}`, "openai 系用 Authorization: Bearer");
  ok(seen.headers['x-api-key'] === undefined, "不额外塞 anthropic 头");

  let seenA = null;
  await discoverModels({
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    apiKey: KEY,
    fetchImpl: async (url, init) => {
      seenA = init.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "c1" }] }) };
    },
  });
  ok(seenA['x-api-key'] === KEY, "anthropic 用 x-api-key");
  ok(typeof seenA['anthropic-version'] === "string", "anthropic 带 anthropic-version");
  ok(seenA.authorization === undefined, "anthropic 不用 Bearer");
}
{
  const KEY = "sk-SECRET-DO-NOT-LEAK";
  const cases = [
    [async () => ({ ok: false, status: 404, text: async () => "" }), "HTTP 404"],
    [async () => ({ ok: true, status: 200, text: async () => "not json" }), "响应不是 JSON"],
    [async () => ({ ok: true, status: 200, text: async () => "{}" }), "响应没有列表"],
    [async () => { const e = new Error("boom"); e.name = "TimeoutError"; throw e; }, "超时"],
  ];
  for (const [impl, label] of cases) {
    let msg = null;
    try {
      await discoverModels({ baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: KEY, fetchImpl: impl });
    } catch (e) {
      msg = e.message;
    }
    ok(Boolean(msg) && msg.includes("DISCOVER_FAILED"), `${label} ⇒ DISCOVER_FAILED`, String(msg).slice(0, 50));
    ok(msg !== null && !msg.includes(KEY), `★ ${label} 的错误文案里**没有**密钥`);
  }
  let big = null;
  try {
    await discoverModels({
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "x".repeat(LIMITS.DISCOVER_MODELS_MAX_BYTES + 10) }),
    });
  } catch (e) {
    big = e.message;
  }
  ok(Boolean(big) && big.includes("DISCOVER_FAILED"), "超大响应被拒");
}

/* ==================================================================== E */
group("[E] 真实 ModelRuntime：注入 → 可见 → 卸载 → 回落（不发网络请求）");
{
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const rt = await ModelRuntime.create();
  const baseline = new Set(rt.getProviders().map((p) => p.id));
  ok(baseline.has("deepseek"), "基线里有内置的 deepseek");

  const defs = {
    "qa-probe-gw": {
      provider: "qa-probe-gw",
      displayName: "QA Probe GW",
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      models: [{ id: "probe-1", name: "Probe 1", contextWindow: 128000, maxTokens: 8192 }],
    },
  };
  const report = applyProviderDefinitions(rt, defs);
  ok(report.applied.includes("qa-probe-gw"), "自定义提供方注入成功");

  const catalog = buildProviderCatalog(rt, defs, baseline);
  const row = catalog.find((p) => p.provider === "qa-probe-gw");
  ok(Boolean(row), "★ 注入后能在提供方目录里看到它");
  ok(row.custom === true, "★ 被标为「自定义」（基线里没有它）");
  ok(row.edited === true, "被标为「已编辑」");
  ok(row.modelsEdited === true, "被标为「模型目录已自定义」");
  ok(row.models.length === 1 && row.models[0].modelId === "probe-1", "它的模型清单取自我们的定义");
  ok(row.api === "openai-completions", "协议正确回传");
  ok(rt.getModel("qa-probe-gw", "probe-1") !== undefined, "运行时能按 provider/model 取到该模型");
  ok(row.configured === false, "没配密钥 ⇒ configured=false（界面显示红点）");
  ok(!JSON.stringify(catalog).includes("https://gw.example/v1\"],"), "定义里没有夹带别的东西");

  // 覆盖内置：只改地址
  applyProviderDefinitions(rt, { ...defs, deepseek: { provider: "deepseek", baseUrl: "https://proxy.example/v1" } });
  const ds = rt.getProvider("deepseek");
  ok(ds.baseUrl === "https://proxy.example/v1", "内置提供方的地址被覆盖");
  ok(rt.getModels("deepseek").length === 2, "★ 只覆盖地址时内置模型**不丢**");

  // 卸载：内置回落，自定义消失
  const clean = applyProviderDefinitions(rt, {});
  ok(clean.removed.includes("deepseek") && clean.removed.includes("qa-probe-gw"), "两个都被卸掉");
  ok(rt.getProvider("deepseek").baseUrl === "https://api.deepseek.com", "★ 内置提供方回落到原始地址");
  ok(rt.getModels("deepseek").length === 2, "★ 回落之后模型仍在");
  ok(rt.getProvider("qa-probe-gw") === undefined, "自定义提供方随之消失");
}

/* ==================================================================== 收尾 */
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("\n" + "=".repeat(76));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
console.log(" 覆盖边界：不覆盖真实网络拉取（用注入的 fetch 测协议与错误分类）、不覆盖界面。");
console.log("=".repeat(76));
process.exit(fail === 0 ? 0 : 1);
