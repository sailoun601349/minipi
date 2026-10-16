#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MinipiCredentialStore } from "../src/main/pi/credentials-store.js";
import { buildModelCatalog, buildProviderCatalog, resolvePreferredModel } from "../src/main/pi/session.js";
import {
  DEFAULT_MODEL_PREFERENCE,
  DEFAULT_SETTINGS,
  FEATURED_PROVIDER_IDS,
  INVOKE,
  LIMITS,
  PROVIDER_API_IDS,
  PROVIDER_ID_PATTERN_SOURCE,
} from "../src/shared/protocol.js";
import { normalizeSettings } from "../src/main/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
function check(label, ok) { checks.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"} ${label}`); }

const model = { provider: "mock", id: "m1", name: "Mock One" };
check("model preference resolves modelId", resolvePreferredModel({ provider: "mock", modelId: "m1" }, () => model) === model);
check("model preference rejects missing model", resolvePreferredModel({ provider: "mock", modelId: "missing" }, () => undefined) === undefined);

/* ---- 默认模型兜底：偏好为空/失效时回退到 DEFAULT_MODEL_PREFERENCE ---- */
const flash = { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" };
const realGetModel = (provider, id) =>
  provider === "deepseek" && id === "deepseek-flash" ? flash : undefined;
check("默认偏好常量指向 deepseek/deepseek-flash",
  DEFAULT_MODEL_PREFERENCE.provider === "deepseek" && DEFAULT_MODEL_PREFERENCE.modelId === "deepseek-flash");
check("pref 为 null ⇒ 回退到默认模型", resolvePreferredModel(null, realGetModel) === flash);
check("pref 为 undefined ⇒ 回退到默认模型", resolvePreferredModel(undefined, realGetModel) === flash);
check("pref 指向不存在的模型 ⇒ 回退到默认模型",
  resolvePreferredModel({ provider: "mock", modelId: "nope" }, realGetModel) === flash);
check("pref 合法 ⇒ 用户选择优先，不被默认顶掉",
  resolvePreferredModel({ provider: "deepseek", modelId: "deepseek-flash" }, () => model) === model);
check("默认模型也拿不到 ⇒ 返回 undefined（不抛）", resolvePreferredModel(null, () => undefined) === undefined);

/* ---- 提供方目录（模型设置页的数据源） ---- */
const runtimeMock = {
  getProviders: () => [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" }],
  getModels: () => [
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 384000 },
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 384000 },
  ],
  getAvailableSnapshot: () => [flash],
  getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
};
const providers = buildProviderCatalog(runtimeMock);
check("provider catalog 有 1 条", providers.length === 1);
check("provider catalog 名称/地址正确",
  providers[0].provider === "deepseek" && providers[0].name === "DeepSeek" && providers[0].baseUrl === "https://api.deepseek.com");
check("provider catalog 带密钥状态", providers[0].configured === true && providers[0].authSource === "stored");
check("provider catalog 带模型清单（含 modelId/name/容量）",
  providers[0].models.length === 2 && providers[0].models[0].modelId === "deepseek-flash" &&
  providers[0].models[0].contextWindow === 1000000 && providers[0].models[1].maxTokens === 384000);
check("provider catalog 标出可用性", providers[0].models[0].available === true && providers[0].models[1].available === false);
check("provider catalog 不含任何密钥（无 apiKey/key/token/headers 字段）",
  !/"(apiKey|key|token|headers)"/i.test(JSON.stringify(providers)));
check("provider catalog 对空 runtime 不崩", buildProviderCatalog(undefined).length === 0);
check("provider catalog 模型数受上限约束",
  buildProviderCatalog({ getProviders: () => [{ id: "p", name: "P" }], getModels: () => new Array(LIMITS.PROVIDER_MODELS_MAX + 50).fill({ id: "x" }) })[0].models.length === LIMITS.PROVIDER_MODELS_MAX);

/* ---- 国内厂商清单 ---- */
check("FEATURED_PROVIDER_IDS 含 deepseek", FEATURED_PROVIDER_IDS.includes("deepseek"));
check("FEATURED_PROVIDER_IDS 全为非空字符串", FEATURED_PROVIDER_IDS.every((id) => typeof id === "string" && id.length > 0));
check("FEATURED_PROVIDER_IDS 无重复", new Set(FEATURED_PROVIDER_IDS).size === FEATURED_PROVIDER_IDS.length);
check("国内清单覆盖智谱/Kimi/MiniMax/通义/小米",
  ["zai", "moonshotai-cn", "minimax-cn", "qwen-token-plan-cn", "xiaomi"].every((id) => FEATURED_PROVIDER_IDS.includes(id)));
check("默认清单里**不含**境外厂商（openai/anthropic/bedrock）",
  !["openai", "anthropic", "amazon-bedrock"].some((id) => FEATURED_PROVIDER_IDS.includes(id)));

const catalog = buildModelCatalog({
  getModels: () => [model],
  getAvailableSnapshot: () => [model],
  getProviderAuthStatus: () => ({ configured: true }),
});
check("catalog uses modelId", catalog[0]?.modelId === "m1");
check("catalog reports available", catalog[0]?.available === true);
check("catalog is credential-free", !JSON.stringify(catalog).includes("key") && !("apiKey" in (catalog[0] || {})));
check("default model preference is null", DEFAULT_SETTINGS.model === null);
check("model invoke channels exist", INVOKE.LIST_MODELS && INVOKE.SET_MODEL && INVOKE.SET_API_KEY);
check("provider invoke channel exists", INVOKE.LIST_PROVIDERS === "minipi:listProviders");
check(
  "提供方定义三个通道齐备",
  INVOKE.SET_PROVIDER === "minipi:setProvider" &&
    INVOKE.REMOVE_PROVIDER === "minipi:removeProvider" &&
    INVOKE.DISCOVER_MODELS === "minipi:discoverModels",
);
{
  const preload = fs.readFileSync(path.join(root, "src", "preload", "index.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main", "index.js"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  check("preload 暴露 listProviders", /listProviders:\s*\(\)\s*=>\s*call\(INVOKE\.LIST_PROVIDERS\)/.test(preload));
  check("preload 暴露 setProvider / removeProvider / discoverModels",
    /setProvider:\s*\(arg\)\s*=>/.test(preload) && /removeProvider:\s*\(arg\)\s*=>/.test(preload) && /discoverModels:\s*\(arg\)\s*=>/.test(preload));
  check("main 注册 LIST_PROVIDERS 处理器", /handle\(INVOKE\.LIST_PROVIDERS/.test(main));
  check("main 注册 SET_PROVIDER / REMOVE_PROVIDER / DISCOVER_MODELS",
    /handle\(INVOKE\.SET_PROVIDER/.test(main) && /handle\(INVOKE\.REMOVE_PROVIDER/.test(main) && /handle\(INVOKE\.DISCOVER_MODELS/.test(main));
  check("main 把 providerStore 注入 PiSessionHost", /providerStore,/.test(main) && /new ProviderStore\(/.test(main));
  // ⚠ 比的是**调用点** `pi.init().catch`，不是裸的 `pi.init`：文件里还有一句
  //   「提供方定义必须在 pi.init() 之前加载完」的注释，裸搜会搜到注释、结论就反了。
  check(
    "main 在真正调用 pi.init() 之前加载 providerStore",
    main.indexOf("providerStore.load()") < main.indexOf("pi.init().catch"),
  );
  check("providerStore 走的是 minipi 自己的文件（不碰 Pi 的 models.json）",
    /PROVIDERS_PATH = path\.join\(os\.homedir\(\), "\.minipi", "providers\.json"\)/.test(
      fs.readFileSync(path.join(root, "src", "main", "pi", "providers-store.js"), "utf8"),
    ));
  check("providers-store 不写 apiKey（只存结构）",
    !/out\.apiKey\s*=/.test(fs.readFileSync(path.join(root, "src", "main", "pi", "providers-store.js"), "utf8")));
  check("★ 渲染层的 PROVIDER_API_IDS 镜像与 protocol.js 逐字一致",
    PROVIDER_API_IDS.every((api) => renderer.includes(`'${api}'`)));
  check("渲染层没有自己写死 KEY_API_IDS 之外的协议", !/api:\s*'openai-completions',\s*\n\s*api:\s*'/i.test(renderer));
}
check("model limits exist", LIMITS.MODEL_CATALOG_MAX === 200 && LIMITS.MODEL_API_KEY_MAX_CHARS === 512);
check("provider limits exist", LIMITS.PROVIDER_LIST_MAX === 80 && LIMITS.PROVIDER_MODELS_MAX === 80);
check(
  "提供方第二批的上限齐备",
  LIMITS.PROVIDER_ID_MAX_CHARS > 0 &&
    LIMITS.PROVIDER_BASE_URL_MAX_CHARS > 0 &&
    LIMITS.PROVIDER_MODEL_ID_MAX_CHARS > 0 &&
    LIMITS.DISCOVER_MODELS_TIMEOUT_MS > 0 &&
    LIMITS.DISCOVER_MODELS_MAX > 0 &&
    LIMITS.DISCOVER_MODELS_MAX_BYTES > 0,
);
check("协议枚举恰好 4 个且含 anthropic-messages",
  PROVIDER_API_IDS.length === 4 && PROVIDER_API_IDS.includes("anthropic-messages") && PROVIDER_API_IDS.includes("google-generative-ai"));
check("Provider ID 形态是「小写字母开头 + [a-z0-9-]」", PROVIDER_ID_PATTERN_SOURCE === "^[a-z][a-z0-9-]*$");

/* ---- provider catalog 的第二批字段 ---- */
{
  const baseline = ["deepseek", "zai"];
  const defs = { zai: { provider: "zai", baseUrl: "https://proxy/v1" }, "qa-new": { provider: "qa-new" } };
  const rows = buildProviderCatalog(
    {
      getProviders: () => [
        { id: "deepseek", name: "DeepSeek" },
        { id: "zai", name: "Z.AI", baseUrl: "https://proxy/v1" },
        { id: "qa-new", name: "qa-new", baseUrl: "https://x/v1" },
      ],
      getModels: (id) => (id === "zai" ? [{ id: "glm", name: "GLM", api: "openai-completions" }] : []),
      getAvailableSnapshot: () => [],
      getProviderAuthStatus: () => ({ configured: false }),
    },
    defs,
    baseline,
  );
  const zai = rows.find((r) => r.provider === "zai");
  const qa = rows.find((r) => r.provider === "qa-new");
  const ds = rows.find((r) => r.provider === "deepseek");
  check("catalog: 被覆盖的内置 ⇒ edited 但不 custom", zai.edited === true && zai.custom === false);
  check("catalog: 基线里没有的 ⇒ custom", qa.custom === true && qa.edited === true);
  check("catalog: 没动过的内置 ⇒ 两个标记都是 false", ds.edited === false && ds.custom === false);
  check("catalog: 回传 hasBaseUrlOverride", zai.hasBaseUrlOverride === true && ds.hasBaseUrlOverride === false);
  check("catalog: 回传提供方协议（取自模型）", zai.api === "openai-completions");
  check("catalog: 回传模型的 api", zai.models[0].api === "openai-completions");
}
check("settings normalizes model", normalizeSettings({ model: { provider: "mock", modelId: "m1" } }).model.modelId === "m1");
check("settings rejects malformed model", normalizeSettings({ model: { provider: "", modelId: "m1" } }).model === null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-credentials-"));
const filePath = path.join(tempDir, "credentials.json");
const store = new MinipiCredentialStore({ filePath, fallbackRead: async (id) => id === "fallback" ? { type: "api_key", key: "fallback-secret" } : undefined });
await store.modify("mock", async () => ({ type: "api_key", key: "test-secret" }));
check("credential store persists key", (await store.read("mock"))?.key === "test-secret");
check("credential store falls back to Pi auth", (await store.read("fallback"))?.key === "fallback-secret");
check("credential file is outside repository", !filePath.startsWith(root));
await store.delete("mock");
check("credential store deletes own key", (await store.read("mock")) === undefined);
fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`verify:models: ${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
