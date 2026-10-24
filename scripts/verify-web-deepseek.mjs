#!/usr/bin/env node
/**
 * 联网能力（DeepSeek Search / Fetch）· 纯 Node 验证。
 *
 * 用**注入的 fetch** 覆盖协议层，不花一分钱、不依赖网络：
 *   A. 入参归一化（官方限制逐条守：query ≤128、count 1–50、url 必须 http(s) 且不带用户名密码）
 *   B. 请求形状（URL / Bearer / JSON body / need_content）
 *   C. 响应解析与喂给模型的文本（`<web_content>` 包裹、空结果的友好话术、正文截断）
 *   D. 错误分类与重试（408/429/5xx 重试一次；400/401 不重试）**且错误文案不含密钥**
 *   E. 工具层（无 Key 不注册 / 单轮预算 / 工具不抛异常只返回文本）
 *
 * 运行：`node scripts/verify-web-deepseek.mjs`
 */

import {
  DEEPSEEK_BASE_URL,
  FETCH_PATH,
  SEARCH_PATH,
  WEB_LIMITS,
  WebToolError,
  fetchPage,
  formatPage,
  normalizeFetchInput,
  normalizeSearchInput,
  searchWeb,
} from "../src/main/pi/web/deepseek-web.js";
import { WEB_TOOL_NAMES, buildWebTools, createWebBudget } from "../src/main/pi/web/tools.js";

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

console.log("=".repeat(74));
console.log(" 联网能力（DeepSeek Search / Fetch）· 纯 Node 验证");
console.log("=".repeat(74));

const KEY = "sk-TESTKEY-must-never-leak-123456";

/** 造一个假的 Response。 */
function fakeRes(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/* ==================================================================== A */
group("[A] 入参归一化（逐条对齐官方限制）");
{
  let threw = null;
  try {
    normalizeSearchInput({ query: "   " });
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof WebToolError && threw.code === "INVALID_ARGUMENT", "空 query 被拒");
  ok(threw && !threw.message.includes(KEY), "错误文案不含密钥");

  threw = null;
  try {
    normalizeSearchInput({ query: "x".repeat(WEB_LIMITS.MAX_QUERY_CHARS + 1) });
  } catch (e) {
    threw = e;
  }
  ok(Boolean(threw), `query 超过 ${WEB_LIMITS.MAX_QUERY_CHARS} 字被拒`);

  ok(normalizeSearchInput({ query: " 今天新闻 " }).query === "今天新闻", "query 会 trim");
  ok(normalizeSearchInput({ query: "a", count: 0 }).count === 1, "count=0 夹到 1");
  ok(normalizeSearchInput({ query: "a", count: 999 }).count === 50, "count=999 夹到 50");
  ok(normalizeSearchInput({ query: "a", count: 12 }).count === 12, "count=12 原样");
  ok(normalizeSearchInput({ query: "a", count: 3.7 }).count === 4, "count 小数四舍五入");
  ok(normalizeSearchInput({ query: "a" }).need_content === false, "need_content 默认 false");
  ok(normalizeSearchInput({ query: "a", needContent: true }).need_content === true, "needContent→need_content 映射");
  ok(normalizeSearchInput({ query: "a" }).ori_question === undefined, "没给 oriQuestion 就不带该字段");
  ok(normalizeSearchInput({ query: "a", oriQuestion: "  原始问题  " }).ori_question === "原始问题", "oriQuestion 会被 trim 后带上");
}
{
  const bad = [
    ["https://", "缺主机名"],
    ["ftp://example.com/a", "非 http(s)"],
    ["file:///c:/windows/win.ini", "file 协议"],
    ["/relative/path", "相对路径"],
    ["https://user:pass@example.com/a", "带用户名密码"],
  ];
  let rejected = 0;
  for (const [url, label] of bad) {
    try {
      normalizeFetchInput({ url });
    } catch (e) {
      if (e instanceof WebToolError && e.code === "INVALID_ARGUMENT") rejected += 1;
      else console.log(`     (${label} 抛了别的错误：${e?.message})`);
    }
  }
  ok(rejected === bad.length, `${bad.length} 种非法 URL 全部被拒`, `${rejected}/${bad.length}`);
  ok(normalizeFetchInput({ url: "https://example.com/a?b=1" }).url === "https://example.com/a?b=1", "合法 URL 原样通过");
}

/* ==================================================================== B */
group("[B] 请求形状（URL / 认证头 / body）");
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return fakeRes(200, { results: [{ title: "T", url: "https://e.com/1", summary: "S", rerank_score: 2.1 }] });
  };
  await searchWeb({ query: "DeepSeek V4", count: 3, needContent: false }, { apiKey: KEY, fetchImpl });
  const c = calls[0];
  ok(c.url === `${DEEPSEEK_BASE_URL}${SEARCH_PATH}`, "打到官方 Search 端点", c.url);
  ok(c.init.method === "POST", "用 POST");
  ok(c.init.headers.authorization === `Bearer ${KEY}`, "Authorization: Bearer <key>");
  ok(c.init.headers["content-type"] === "application/json", "Content-Type: application/json");
  const body = JSON.parse(c.init.body);
  ok(body.query === "DeepSeek V4" && body.count === 3 && body.need_content === false, "body 三个字段正确", JSON.stringify(body));
  ok(c.init.signal !== undefined, "带了 AbortSignal（用户点中断能停）");

  const calls2 = [];
  await fetchPage({ url: "https://example.com/article" }, {
    apiKey: KEY,
    fetchImpl: async (url, init) => {
      calls2.push({ url, init });
      return fakeRes(200, { title: "页标题", content: "# 正文\n\n内容" });
    },
  });
  ok(calls2[0].url === `${DEEPSEEK_BASE_URL}${FETCH_PATH}`, "打到官方 Fetch 端点", calls2[0].url);
  ok(JSON.parse(calls2[0].init.body).url === "https://example.com/article", "fetch body 只有 url");
}

/* ==================================================================== C */
group("[C] 响应解析与喂给模型的文本");
{
  const res = await searchWeb(
    { query: "银企直联", count: 2 },
    {
      apiKey: KEY,
      fetchImpl: async () =>
        fakeRes(200, {
          results: [
            { title: "A", url: "https://a.com/x", summary: "摘要A", site_name: "站点A", date: "2026-06-01T00:00:00+00:00", rerank_score: 2.4 },
            { title: "B", url: "https://b.com/y", snippet: "短摘要B", rerank_score: 1.1 },
          ],
        }),
    },
  );
  ok(res.results.length === 2, "解析出 2 条结果");
  ok(res.text.includes("银企直联"), "文本带上原始 query");
  ok(res.text.includes("<web_content"), "★ 网页内容被 <web_content> 包裹（标注为不可信数据）");
  ok(res.text.includes("https://a.com/x") && res.text.includes("https://b.com/y"), "带上来源链接");
  ok(res.text.includes("2026-06-01"), "带上发布日期");
  ok(res.text.includes("摘要A") && res.text.includes("短摘要B"), "summary 缺失时回退 snippet");
  ok(res.text.includes("[1]") && res.text.includes("[2]"), "结果带编号，方便回答里引用");
}
{
  const res = await searchWeb({ query: "没有结果的关键词" }, { apiKey: KEY, fetchImpl: async () => fakeRes(200, { results: [] }) });
  ok(res.results.length === 0, "空结果是正常的（不是错误）");
  ok(/没有匹配结果/.test(res.text) && /换个说法/.test(res.text), "空结果给可执行的建议，而不是空白");
}
{
  const page = await fetchPage(
    { url: "https://example.com/long" },
    { apiKey: KEY, fetchImpl: async () => fakeRes(200, { title: "长文", content: "中".repeat(WEB_LIMITS.MAX_CONTENT_CHARS + 500) }) },
  );
  ok(page.text.includes("已截断"), "★ 超长正文会显式标注「已截断」");
  ok(page.text.length < WEB_LIMITS.MAX_CONTENT_CHARS + 800, "截断后长度受控", `${page.text.length} 字`);
  ok(page.text.includes("<web_content"), "正文同样被包裹");
}
{
  const t = formatPage({ title: "", content: "" }, "https://example.com/empty");
  ok(/没有提取到正文/.test(t), "空正文给可读说明（不返回空字符串）");
}
{
  const t = formatPage({ title: "", content: "" }, "https://example.com/x");
  ok(!t.includes("<web_content"), "空正文不包 web_content（避免模型以为有内容）");
}

/* ==================================================================== D */
group("[D] 错误分类与重试");
{
  const cases = [
    [400, false, "参数不合法"],
    [401, false, "Key 无效"],
    [402, false, "余额不足"],
    [403, false, "安全策略拒绝"],
    [404, false, "无可用内容"],
    [413, false, "请求体过大"],
  ];
  for (const [status, shouldRetry, label] of cases) {
    let calls = 0;
    let err = null;
    try {
      await searchWeb({ query: "x" }, {
        apiKey: KEY,
        fetchImpl: async () => {
          calls += 1;
          return fakeRes(status, { error: { message: `boom ${status}`, type: "invalid_request_error", param: null, code: "invalid_request_error" } });
        },
      });
    } catch (e) {
      err = e;
    }
    ok(err instanceof WebToolError, `${status} 抛 WebToolError（${label}）`);
    ok(calls === 1, `${status} **不重试**（只请求 1 次）`, `实际 ${calls} 次`);
    ok(err && !err.message.includes(KEY), `★ ${status} 错误文案不含密钥`);
    if (shouldRetry) ok(err?.retryable === true, `${status} 标记为可重试`);
  }
}
{
  for (const status of [408, 429, 500, 504]) {
    let calls = 0;
    let err = null;
    try {
      await searchWeb({ query: "x" }, {
        apiKey: KEY,
        fetchImpl: async () => {
          calls += 1;
          return fakeRes(status, "");
        },
      });
    } catch (e) {
      err = e;
    }
    ok(calls === 2, `${status} 重试一次后放弃（共 2 次请求）`, `实际 ${calls} 次`);
    ok(err instanceof WebToolError, `${status} 最终抛 WebToolError`);
  }
}
{
  // 第一次 500、第二次成功 ⇒ 应该恢复
  let calls = 0;
  const res = await searchWeb({ query: "x" }, {
    apiKey: KEY,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? fakeRes(500, "") : fakeRes(200, { results: [{ title: "T", url: "https://e.com" }] });
    },
  });
  ok(calls === 2 && res.results.length === 1, "★ 偶发 5xx 能靠重试恢复（不是一挂到底）");
}
{
  let err = null;
  try {
    await searchWeb({ query: "x" }, { apiKey: "" });
  } catch (e) {
    err = e;
  }
  ok(err?.code === "NO_API_KEY", "没有 Key 时明确报 NO_API_KEY（不发请求）");
}
{
  // 取消：已 abort 的 signal 应立刻结束，且归类为 ABORTED
  const ac = new AbortController();
  ac.abort();
  let err = null;
  try {
    await searchWeb({ query: "x" }, {
      apiKey: KEY,
      signal: ac.signal,
      fetchImpl: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
  } catch (e) {
    err = e;
  }
  ok(err?.code === "ABORTED", "用户中断 → ABORTED（不再重试）", String(err?.code));
}

/* ==================================================================== E */
group("[E] 工具层：无 Key 不注册 / 单轮预算 / 不抛异常");
{
  ok(WEB_TOOL_NAMES.join(",") === "web_search,web_fetch", "工具名固定为 web_search / web_fetch");

  const none = buildWebTools({});
  ok(Array.isArray(none) && none.length === 0, "★ 没传 getApiKey ⇒ 返回空数组（模型看不到工具）");

  const noKey = buildWebTools({ getApiKey: async () => null });
  ok(noKey.length === 2, "工具定义会创建（运行时再判 Key）");
  const r0 = await noKey[0].execute("t1", { query: "x" }, undefined, undefined, {});
  ok(r0?.isError === true && /未配置/.test(r0.content[0].text), "调用时无 Key ⇒ 返回可读提示，不是抛异常");

  const budget = createWebBudget({ search: 2, fetch: 1 });
  const tools = buildWebTools({
    getApiKey: async () => KEY,
    budget,
    fetchImpl: async () => fakeRes(200, { results: [{ title: "T", url: "https://e.com" }], title: "T", content: "正文" }),
  });
  ok(budget.take("search") === true && budget.take("search") === true, "预算前两次可用");
  ok(budget.take("search") === false, "第三次被拒");
  budget.reset();
  ok(budget.take("search") === true, "reset 后恢复");

  const r1 = await tools[0].execute("t2", { query: "白银" }, undefined, undefined, {});
  ok(r1?.content?.[0]?.type === "text" && r1.content[0].text.includes("<web_content"), "工具结果形状正确（content[0].type=text）");
  ok(r1?.isError !== true, "成功时 isError 不为 true");

  // 预算用尽后的第 3 次（上面已用 1 次 + reset 后用 1 次 = 2 次）
  const r2 = await tools[0].execute("t3", { query: "第三次" }, undefined, undefined, {});
  ok(r2?.isError === true && /已用尽/.test(r2.content[0].text), "★ 超预算返回「已用尽」，让循环停下");

  // 工具内部失败也不抛
  const failing = buildWebTools({ getApiKey: async () => KEY, fetchImpl: async () => fakeRes(401, "") });
  const r3 = await failing[1].execute("t4", { url: "https://example.com" }, undefined, undefined, {});
  ok(r3?.isError === true && /Key/.test(r3.content[0].text), "401 变成可读工具结果（不打断整轮）");
}

/* ==================================================================== F */
group("[F] 联网开关：即时生效（不用新建会话）");
{
  const { PiSessionHost } = await import("../src/main/pi/session.js");
  const { WEB_BUDGET_DEFAULT } = await import("../src/main/pi/web/tools.js");
  const silent = { info() {}, warn() {}, error() {} };

  // 1) 无 Key ⇒ 一个工具都不造（那种情况下工具无路可走，注册了才是假按钮）
  const noKey = new PiSessionHost({ logger: silent });
  ok((await noKey._buildWebTools()).length === 0, "读不到 Key ⇒ 不造工具");

  // 2) 不传 webEnabled 时默认开
  ok(noKey._webEnabled() === true, "不传 webEnabled ⇒ **默认开**（用户拍板）");

  // 3) 单轮上限已放宽：正常问答 1–3 次，上限 12 次只作"防失控"
  ok(WEB_BUDGET_DEFAULT.search === 30 && WEB_BUDGET_DEFAULT.fetch === 30,
    "单轮上限定为 30 / 30（只防失控，且不显示在界面上）", `${WEB_BUDGET_DEFAULT.search}/${WEB_BUDGET_DEFAULT.fetch}`);

  // 4) 开关在**调用时**判断：同一份工具，翻转开关立刻改变行为
  let enabled = false;
  let calls = 0;
  const tools = buildWebTools({
    getApiKey: async () => KEY,
    isEnabled: () => enabled,
    fetchImpl: async () => {
      calls += 1;
      return fakeRes(200, { results: [{ title: "T", url: "https://e.com" }] });
    },
  });
  const off = await tools[0].execute("a", { query: "x" }, undefined, undefined, {});
  ok(off?.isError === true && off.details?.code === "WEB_DISABLED", "★ 关掉时返回 WEB_DISABLED（而不是发请求）");
  ok(calls === 0, "★ 关掉时**一次请求都没发**（不花钱）", `实际 ${calls} 次`);

  enabled = true;
  const on = await tools[0].execute("b", { query: "x" }, undefined, undefined, {});
  ok(on?.isError !== true && on.content[0].text.includes("<web_content"), "★ 同一份工具，勾上后立刻能搜（不用新建会话）");
  ok(calls === 1, "这次真的发了 1 次请求", `实际 ${calls} 次`);

  // 5) 关掉时给的说明必须是"可执行"的，不能含糊
  enabled = false;
  const off2 = await tools[1].execute("c", { url: "https://example.com" }, undefined, undefined, {});
  ok(/勾选/.test(off2.content[0].text), "关掉时的说明告诉用户可以勾选开启", off2.content[0].text.slice(0, 40));
}

console.log("\n" + "=".repeat(74));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
console.log(" 覆盖边界：用注入的 fetch 覆盖协议与错误分类；**不**覆盖真实网络（那条见 verify:web-live）。");
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
