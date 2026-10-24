#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MinipiCredentialStore } from "../src/main/pi/credentials-store.js";
import { buildModelCatalog, buildProviderCatalog, promptCapFor, resolvePreferredModel, PiSessionHost } from "../src/main/pi/session.js";
import { SettingsStore } from "../src/main/settings.js";
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
check("FEATURED_PROVIDER_IDS 只保留 deepseek（用户 2026-10-20 拍板：模型与联网共用同一个 Key）",
  FEATURED_PROVIDER_IDS.length === 1 && FEATURED_PROVIDER_IDS[0] === "deepseek");
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

/* ---- D-08：模型目录要暴露「输入能力」（图片 / 文本） ---- */
{
  const mk = (over) => {
    const m = { provider: "mock", id: "mx", name: "MX", ...over };
    return buildModelCatalog({
      getModels: () => [m],
      getAvailableSnapshot: () => [m],
      getProviderAuthStatus: () => ({ configured: true }),
    })[0] || {};
  };
  const img = mk({ input: ["text", "image"] });
  const txt = mk({ input: ["text"] });
  const none = mk({});
  const nil = mk({ input: null });
  const junk = mk({ input: "image" });

  check("D-08 catalog 暴露 input 数组（text+image 原样透出）",
    Array.isArray(img.input) && img.input.length === 2 && img.input.includes("image") && img.input.includes("text"));
  check("D-08 canImage: 声明了 image ⇒ true", img.canImage === true);
  check("D-08 canImage: 只声明 text ⇒ false", txt.canImage === false && txt.input.length === 1);
  check("D-08 ★ 缺省 input 一律给 []（不是 undefined —— undefined 过 IPC 会变成缺键，渲染层 .includes 直接 TypeError）",
    Array.isArray(none.input) && none.input.length === 0 && none.input !== undefined);
  check("D-08 缺省 input ⇒ canImage === false（不猜「默认支持图」）", none.canImage === false);
  check("D-08 input: null 也归一成 []，canImage === false",
    Array.isArray(nil.input) && nil.input.length === 0 && nil.canImage === false);
  check("D-08 input 类型写错（字符串 \"image\"）不被当成数组 ⇒ [] 且 canImage false",
    Array.isArray(junk.input) && junk.input.length === 0 && junk.canImage === false);
  check("D-08 ★ canImage 与 input 永远自洽（不会出现 canImage=true 但 input 里没有 image）",
    [img, txt, none, nil, junk].every((r) => r.canImage === r.input.includes("image")));
  check("D-08 ★ 整个 catalog 可 JSON 序列化且不含 undefined（跨 IPC 不丢字段）",
    (() => {
      const catalogRows = buildModelCatalog({
        getModels: () => [{ provider: "p", id: "a" }, { provider: "p", id: "b", input: ["text", "image"] }],
        getAvailableSnapshot: () => [],
        getProviderAuthStatus: () => ({ configured: false }),
      });
      const round = JSON.parse(JSON.stringify(catalogRows));
      return round.length === 2 &&
        round.every((r) => Array.isArray(r.input) && typeof r.canImage === "boolean" && "input" in r && "canImage" in r);
    })());
  check("D-08 复制 input，不把 SDK registry 的数组引用透出去（改返回值不污染源）",
    (() => {
      const src = ["text", "image"];
      const m = { provider: "mock", id: "mz", name: "MZ", input: src };
      const row = buildModelCatalog({
        getModels: () => [m],
        getAvailableSnapshot: () => [m],
        getProviderAuthStatus: () => ({ configured: true }),
      })[0];
      row.input.push("HACKED");
      return src.length === 2 && row.canImage === true;
    })());
}

/* ---- P1-1：上下文窗口闸门 promptCapFor(contextWindow) ---- */
/**
 * 契约：`min(LIMITS.PROMPT_MAX_CHARS, floor(ctx * 0.5))`；拿不到 ctx ⇒ 回落 32000。
 *
 * 为什么单测这个纯函数（而不是只测 host.prompt）：公式里有 3 个容易写错的点
 * ——  `floor` vs `round`、`min` 的两个操作数顺序、以及"缺信息时回落到宽松值"，
 * 每一点都是**只在边界值上才暴露**。纯函数测试能一条一条钉，端到端测只会在
 * 某一个幸运的 ctx 上过。
 */
{
  const CAP = LIMITS.PROMPT_MAX_CHARS; // 天花板，读数不硬编码（D1c 常量漂移检查仍然生效）

  check("P1-1 ctx=4095 ⇒ 2047（floor 而不是 round：4095/2=2047.5 向下取整）",
    promptCapFor(4095) === 2047);
  check("P1-1 ctx=8192 ⇒ 4096（2 的整数幂不因 floor 少一）",
    promptCapFor(8192) === 4096);
  check("P1-1 ctx=64000 ⇒ 32000（一半是 32000，正好撞天花板）",
    promptCapFor(64000) === 32000);
  check(`P1-1 ctx=10000000 ⇒ ${CAP}（远超大窗口，天花板压住，不放宽）`,
    promptCapFor(10000000) === CAP);
  check(`P1-1 ctx=null ⇒ ${CAP}（缺信息用最宽松值，不压成 0）`,
    promptCapFor(null) === CAP);
  check(`P1-1 ctx=undefined ⇒ ${CAP}（同上：一个字都发不出去比超窗更糟）`,
    promptCapFor(undefined) === CAP);
  check(`P1-1 ctx=0 ⇒ ${CAP}（0 是"没上报"，不是"窗口为零"）`,
    promptCapFor(0) === CAP);
  check(`P1-1 ctx=-100 ⇒ ${CAP}（负数同样是脏数据，回落不抛）`,
    promptCapFor(-100) === CAP);
  check("★ P1-1 ctx=1 ⇒ 0（极小窗口如实算出 0，不偷偷兜底成 1 —— 兜底会让它一直超窗）",
    promptCapFor(1) === 0);
  check(`P1-1 字符串数字 "64000" ⇒ 32000（老的 providers.json 可能把它存成字符串）`,
    promptCapFor("64000") === 32000);
  check(`P1-1 脏字符串 "abc" / "" / NaN ⇒ ${CAP}（解析不出数字就回落，不产生 NaN 上界）`,
    promptCapFor("abc") === CAP && promptCapFor("") === CAP && promptCapFor(Number.NaN) === CAP);
  check("★ P1-1 返回值永远是安全整数（不会把 2047.5 这种小数当上界，边界断言才稳）",
    [4095, 8192, 64000, 1, 3, 7, 999999].every((n) => Number.isSafeInteger(promptCapFor(n))));
  check(`P1-1 上界永不超过天花板（幂律扫描 1..70000）`,
    Array.from({ length: 700 }, (_, i) => (i + 1) * 100).every((n) => promptCapFor(n) <= CAP));
}

/* ---- P1-1 端到端：闸门真的接进了 prompt() / generateStructured() ---- */
/**
 * 端到端只测两件纯函数测不到的事：
 *   ① 闸门**真的被调用**（常量还在但没人用 = 白写）；
 *   ② 错误文案里给的是**实际生效的数字**（用户拿 4k 模型发 3000 字，被告知"上限 32000"
 *      会以为是自己手滑，实际是模型窗口小 —— 这个误导比不报错更费时间）。
 * 宿主用最小桩：`_records` 里塞一条带 `session.model.contextWindow` 的 record，
 * `_requireSession` 就够用了，不会碰真 SDK / 真凭据。
 */
{
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const mkHost = (contextWindow) => {
    const host = new PiSessionHost({ logger: quiet });
    host._records.set("s_cap_0001", {
      sessionId: "s_cap_0001",
      // 只要 `session.model.contextWindow`；prompt() 在闸门之前不会碰 session 的其他方法
      session: { model: { provider: "p", id: "m", api: "openai-completions", contextWindow } },
      seq: 0,
      log: { push() {}, since: () => [], tail: () => [], items: [], clear() {} },
      status: "idle",
      model: "p/m",
      sceneId: "chat",
      cwd: os.tmpdir(),
      disposed: false,
    });
    return host;
  };
  /** 取一条错误的 message（`errorMessage` 拼的是 `CODE: 文案`）。 */
  const catchMsg = async (fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return String(err && err.message ? err.message : err);
    }
  };

  // ctx=4096 ⇒ 本轮上限 2048。发 2049 字必须被拒，且文案要出现 2048。
  const smallHost = mkHost(4096);
  const smallMsg = await catchMsg(() => smallHost.prompt({ sessionId: "s_cap_0001", text: "x".repeat(2049) }));
  check("★ P1-1 端到端 prompt()：4k 窗口下发 2049 字被拒绝（闸门真接上了，不是只有常量）",
    smallMsg !== null && /INVALID_ARGUMENT/.test(smallMsg));
  check("★ P1-1 端到端 prompt()：错误文案给出**实际生效的 2048**（不是误导性的 32000）",
    smallMsg !== null && smallMsg.includes("2048") && !smallMsg.includes("上限 32000"));
  check("P1-1 端到端 prompt()：文案点明是「按上下文窗口 4096 的一半算」，并说明是字符不是 token",
    smallMsg !== null && smallMsg.includes("4096") && /字符.*非 token|非 token/.test(smallMsg));

  // 同一 host 发 2048 字（**正好等于**上限）必须放行 —— 边界不能写成 `<`。
  const okMsg = await catchMsg(() => mkHost(4096).prompt({ sessionId: "s_cap_0001", text: "y".repeat(2048) }));
  check("P1-1 端到端 prompt()：正好 2048 字不报超长（边界是 > 不是 >=）",
    okMsg === null || !/超长/.test(okMsg));

  // 窗口缺失（老 provider 定义没写 contextWindow）⇒ 回落到 32000，32000 字应放行。
  const noCtxHost = mkHost(undefined);
  const noCtxMsg = await catchMsg(() => noCtxHost.prompt({ sessionId: "s_cap_0001", text: "z".repeat(LIMITS.PROMPT_MAX_CHARS) }));
  check("★ P1-1 端到端 prompt()：模型没上报窗口时回落 32000，正 32000 字仍可发送（不把老 provider 锁死）",
    noCtxMsg === null || !/超长/.test(noCtxMsg));
  const overMsg = await catchMsg(() => mkHost(undefined).prompt({ sessionId: "s_cap_0001", text: "z".repeat(LIMITS.PROMPT_MAX_CHARS + 1) }));
  check("P1-1 端到端 prompt()：回落场景下 32001 字才拒绝，文案说明「未上报窗口，按默认上限」",
    overMsg !== null && /超长/.test(overMsg) && /未上报上下文窗口/.test(overMsg));

  // generateStructured 同一个闸门（4k 窗口 ⇒ 2048，超了必须先拒，不能走到 completeSimple）
  const gsHost = mkHost(4096);
  let reachedRuntime = false;
  gsHost._modelRuntime = {
    completeSimple: async () => {
      reachedRuntime = true;
      return { role: "assistant", content: [{ type: "text", text: "{}" }], stopReason: "stop" };
    },
  };
  const gsMsg = await catchMsg(() => gsHost.generateStructured({ sessionId: "s_cap_0001", instruction: "i".repeat(2049) }));
  check("★ P1-1 端到端 generateStructured()：同样按窗口闸门拒绝，文案带 2048",
    gsMsg !== null && /超长/.test(gsMsg) && gsMsg.includes("2048"));
  check("★ P1-1 端到端 generateStructured()：被拒时**没有**去请求模型（省一次必然失败的调用）",
    reachedRuntime === false);
}

check("default model preference is null", DEFAULT_SETTINGS.model === null);check("model invoke channels exist", INVOKE.LIST_MODELS && INVOKE.SET_MODEL && INVOKE.SET_API_KEY);
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

/* ---- 联网总开关（2026-10-20：用户拍板默认开） ---- */
{
  const f = path.join(os.tmpdir(), `minipi-web-toggle-${process.pid}.json`);
  const st = new SettingsStore({ filePath: f });
  st.load();
  check("settings 默认 webEnabled = true（默认开）", st.get().webEnabled === true);
  check("set({webEnabled:false}) 立刻读回 false", st.set({ webEnabled: false }).webEnabled === false);
  check("已落盘（重启后仍关着）", JSON.parse(fs.readFileSync(f, "utf8")).webEnabled === false);
  check("set({webEnabled:true}) 能开回来", st.set({ webEnabled: true }).webEnabled === true);
  // 类型严格：字符串 "false" 不该被当成 false（否则前端传错类型会静默反转语义）
  check("字符串 \"false\" 被忽略（仍是 true）", st.set({ webEnabled: "false" }).webEnabled === true);
  check("改别的键不会把开关冲掉", (st.set({ noFocusSteal: true }), st.get().webEnabled === true));
  fs.rmSync(f, { force: true });
}

console.log(`verify:models: ${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
