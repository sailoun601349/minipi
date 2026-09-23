/**
 * M5 产出链路验证（纯 Node，不依赖 Electron / Pi SDK 真实会话）。
 *
 * 为什么单独一个脚本：本机 Electron GPU 进程会崩（`GPU process isn't usable`），
 * `npm run selftest` 跑不完。产出链路的**绝大部分**逻辑是纯函数 + 可注入依赖，
 * 正好可以离线跑完（`OutcomeService` 的 piHost / shell / dialog 都是注入的）。
 *
 * 覆盖（对应施工方案 §3 + 团队交付清单）：
 *   [1] schema 校验（合法 / 必填 / 宽容路径 / 截断）
 *   [2] buildFileName 文件名规则
 *   [3] parseOutcomeJson 剥围栏 / 截 {} / 坏 JSON
 *   [4] renderMarkdown（含 null 不抛错）
 *   [5] renderDocx **真渲染**（Buffer + PK 魔数）
 *   [6] 降级①：模型返回非 JSON → 仍出 md
 *   [7] 降级②：docx 渲染抛错 → 改出 md
 *   [8] 降级③：outbox 不可写 → 不抛错 + inlineText
 *   [9] 同名不覆盖
 *   [10] open() 找不到 id → OUTCOME_NOT_FOUND
 *   [11] list() 条数 / limit 生效
 *   [12] 协议一致性（新键值逐字比对）
 *
 * 用法：`node scripts/verify-outcome.mjs`（退出码 0 = 全通过）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ERROR_CODES,
  EVENTS,
  INVOKE,
  LIMITS,
  OUTCOME_ACTIONS,
  OUTCOME_FORMAT,
  OUTCOME_FORMAT_IDS,
} from "../src/shared/protocol.js";

import { buildFileName, normalizeOutcome, validateOutcome } from "../src/main/pi/outcome/schema.js";
import { buildOutcomePrompt, buildRetryPrompt, parseOutcomeJson } from "../src/main/pi/outcome/prompt.js";
import { renderMarkdown } from "../src/main/pi/outcome/render-md.js";
import { renderDocx } from "../src/main/pi/outcome/render-docx.js";
import { OutcomeService } from "../src/main/pi/outcome/index.js";

let pass = 0;
let fail = 0;

/** @param {boolean} cond @param {string} label */
function ok(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("=".repeat(70));
console.log(" minipi M5 产出链路验证（纯 Node）");
console.log(` Node ${process.version} · platform ${process.platform}`);
console.log("=".repeat(70));

/* ------------------------------------------------------------------ 临时目录 */
// 不污染真实 ~/.minipi/outbox。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-outcome-test-"));
const outbox = path.join(tmpRoot, "outbox");
fs.mkdirSync(outbox, { recursive: true });
console.log(`\n 临时 outbox：${outbox}`);

/** @type {object[]} */
const emitted = [];
const logger = { info() {}, warn() {}, error() {} };

/**
 * 造一个假的 OutcomeService 依赖：假 piHost（可控 generateStructured 返回）。
 * @param {(instruction: string) => Promise<{text: string}>} structuredImpl
 * @param {object} [overrides]
 */
function makeService(structuredImpl, overrides = {}) {
  const piHost = {
    hasSession: (id) => id === "s_1",
    generateStructured: (input) => structuredImpl(input.instruction),
  };
  return new OutcomeService({
    piHost,
    logger,
    emitOutcome: (c) => emitted.push(c),
    outboxDir: overrides.outboxDir ?? outbox,
    ...overrides,
  });
}

/** 一个合法的 OutcomeDoc。 */
const sampleDoc = {
  title: "周报",
  subtitle: ["2026-09-23"],
  sections: [
    { heading: "今日完成", bullets: ["修复登录接口空指针", "对接产品排期"] },
    { heading: "明日计划", bullets: ["写完单元测试"] },
  ],
};

/* ================================================================ [1] schema 校验 */
console.log("\n[1] schema 校验");
{
  const r1 = validateOutcome(sampleDoc);
  ok(r1.ok === true && r1.doc !== null, "合法 doc → ok:true");
  ok(r1.doc.sections.length === 2, "sections 保留 2 节");
  ok(r1.doc.subtitle.length === 1, "subtitle 保留 1 行");

  ok(validateOutcome({ sections: [{ heading: "a", bullets: [] }] }).ok === false, "title 缺失 → 失败");
  ok(validateOutcome({ title: "   ", sections: [{ heading: "a", bullets: [] }] }).ok === false, "title 全空白 → 失败");
  ok(validateOutcome({ title: "x", sections: [] }).ok === false, "sections 空数组 → 失败");
  ok(validateOutcome({ title: "x", sections: "notarray" }).ok === false, "sections 非数组 → 失败");

  // bullets 不是数组 → errors 里要有可读中文
  const bad = validateOutcome({ title: "x", sections: [{ heading: "a", bullets: 123 }] });
  // 注意：bullets 非数组但无 items/content 时，errors 里会记一条；但 section 仍被保留（空 bullets）。
  // 由于 sections 至少有 1 节，最终 ok 可能为 true（宽容）——我们断言「要么 ok、要么 errors 可读」。
  ok(
    bad.ok === true || bad.errors.every((e) => typeof e === "string" && e.length > 0),
    "bullets 非数组：要么宽容通过，要么 errors 是可读中文",
  );

  // 宽容路径 ①：items 别名
  const rItems = validateOutcome({ title: "x", sections: [{ heading: "a", items: ["一", "二"] }] });
  ok(rItems.ok === true && rItems.doc.sections[0].bullets.join(",") === "一,二", "items 别名 → 归一化成 bullets");

  // 宽容路径 ②：content 字符串按换行 / 分号切
  const rContent = validateOutcome({
    title: "x",
    sections: [{ heading: "a", content: "第一行\n第二行；第三行" }],
  });
  ok(
    rContent.ok === true && rContent.doc.sections[0].bullets.length === 3,
    "content 字符串 → 按换行/分号切成 3 条",
  );

  // 空字符串 bullet 被过滤
  const rEmpty = validateOutcome({ title: "x", sections: [{ heading: "a", bullets: ["a", "", "  ", "b"] }] });
  ok(rEmpty.ok === true && rEmpty.doc.sections[0].bullets.join(",") === "a,b", "空/空白 bullet 被过滤");

  // sections 51 项 → 截断到 50
  const many = Array.from({ length: 51 }, (_, i) => ({ heading: `h${i}`, bullets: [`b${i}`] }));
  const rMany = validateOutcome({ title: "x", sections: many });
  ok(rMany.ok === true && rMany.doc.sections.length === 50, "sections 51 项 → 截断到 50");

  // 超长 bullet → 截断到 2000
  const long = "あ".repeat(2500);
  const rLong = validateOutcome({ title: "x", sections: [{ heading: "a", bullets: [long] }] });
  ok(
    rLong.ok === true && rLong.doc.sections[0].bullets[0].length === LIMITS.OUTCOME_BULLET_MAX_CHARS,
    `超长 bullet → 截断到 ${LIMITS.OUTCOME_BULLET_MAX_CHARS}`,
  );

  // 标题空白压缩
  const rSpace = validateOutcome({ title: "  周   报  ", sections: [{ heading: "a", bullets: ["b"] }] });
  ok(rSpace.doc.title === "周 报", "标题内连续空白 → 压成单空格");

  // normalizeOutcome 抢救
  const rescued = normalizeOutcome({ bullets: ["一", "二"] });
  ok(rescued !== null && rescued.title === "未命名" && rescued.sections.length === 1, "normalizeOutcome：缺 title + 顶层 bullets → 抢救成功");
  ok(normalizeOutcome({}) === null, "normalizeOutcome：空对象 → null（放弃）");
}

/* ================================================================ [2] buildFileName */
console.log("\n[2] buildFileName 文件名规则");
{
  const d = new Date(2026, 8, 23); // 2026-09-23 本地时间
  ok(buildFileName("周报", "docx", d) === "周报-2026-09-23.docx", `「周报」→ 周报-2026-09-23.docx（实际 ${buildFileName("周报", "docx", d)}）`);
  ok(buildFileName("周报", "md", d) === "周报-2026-09-23.md", "md 扩展名正确");

  const illegal = buildFileName('a/b:c*d?e"f<g>h|i', "md", d);
  ok(!/[\\/:*?"<>|]/.test(illegal.replace(/-\d{4}-\d{2}-\d{2}\.md$/, "")), `非法字符被清除（实际 ${illegal}）`);
  // 连续 - 压成一个
  ok(buildFileName("a//b", "md", d).startsWith("a-b-"), "连续非法字符压成单个 -");

  ok(buildFileName("", "docx", d) === "未命名-2026-09-23.docx", `空标题 → 未命名-…（实际 ${buildFileName("", "docx", d)}）`);
  ok(buildFileName("   ", "md", d) === "未命名-2026-09-23.md", "全空白标题 → 未命名");

  const longTitle = "字".repeat(200);
  const longName = buildFileName(longTitle, "md", d);
  ok(longName.startsWith("字".repeat(120)) && longName.includes("-2026-09-23.md"), "超长标题 → 截到 120");

  // 前后缀清理
  ok(buildFileName("---周报---", "md", d) === "周报-2026-09-23.md", "首尾 - 被去掉");
}

/* ================================================================ [3] parseOutcomeJson */
console.log("\n[3] parseOutcomeJson 解析");
{
  ok(parseOutcomeJson('{"title":"x"}').ok === true, "裸 JSON → ok");

  const fenced = '```json\n{"title":"x"}\n```';
  const rf = parseOutcomeJson(fenced);
  ok(rf.ok === true && rf.value.title === "x", "```json 围栏剥离");

  const bareFence = '```\n{"title":"y"}\n```';
  const rb = parseOutcomeJson(bareFence);
  ok(rb.ok === true && rb.value.title === "y", "``` 裸围栏剥离");

  const withProse = '好的，这是结果：\n{"title":"z"}\n希望有帮助！';
  const rp = parseOutcomeJson(withProse);
  ok(rp.ok === true && rp.value.title === "z", "前后解释文字 → 截取 {…}");

  const bad = parseOutcomeJson("{ not valid json ");
  ok(bad.ok === false && bad.errors.length > 0, "坏 JSON → ok:false + errors");

  ok(parseOutcomeJson("").ok === false, "空文本 → ok:false");
  ok(parseOutcomeJson("完全没有大括号").ok === false, "无 {} → ok:false");
}

/* ================================================================ [4] renderMarkdown */
console.log("\n[4] renderMarkdown");
{
  const md = renderMarkdown(sampleDoc);
  ok(md.includes("# 周报"), "含 `# 标题`");
  ok(md.includes("## 今日完成"), "含 `## 节标题`");
  ok(md.includes("- 修复登录接口空指针"), "含 `- bullet`");
  ok(md.includes("_2026-09-23_"), "含副标题斜体");

  ok(renderMarkdown(null) === "（无内容）", "renderMarkdown(null) → （无内容），不抛错");
  ok(renderMarkdown(undefined) === "（无内容）", "renderMarkdown(undefined) → （无内容）");
  ok(typeof renderMarkdown(42) === "string", "renderMarkdown(数字) → 字符串，不抛错");

  // bullet 内含换行的续行缩进
  const multi = renderMarkdown({ title: "t", sections: [{ heading: "h", bullets: ["第一行\n第二行"] }] });
  ok(multi.includes("- 第一行\n  第二行"), "bullet 内换行 → 续行缩进 2 空格");
}

/* ================================================================ [5] renderDocx 真渲染 */
console.log("\n[5] renderDocx 真渲染（关键）");
{
  let buf = null;
  let err = null;
  try {
    buf = await renderDocx(sampleDoc);
  } catch (e) {
    err = e;
  }
  ok(err === null, `renderDocx 未抛错（${err ? err.message : "OK"}）`);
  ok(Buffer.isBuffer(buf), "返回 Buffer");
  ok(buf && buf.length > 0, `Buffer 非空（${buf?.length ?? 0} 字节）`);
  // 核心证据：docx 是 ZIP 容器，前两字节必须是 PK（0x50 0x4b）
  const magic = buf && buf.length >= 2 ? buf.slice(0, 2).toString("hex") : "";
  ok(magic === "504b", `前两字节 = PK ZIP 魔数（实际 ${magic}）⇒ 不是坏文件`);
}

/* ================================================================ [6] 降级① */
console.log("\n[6] 降级①：模型返回非 JSON → 仍出 md");
{
  const svc = makeService(async () => ({ text: "这是一段自然语言的周报，不是 JSON。" }));
  const card = await svc.generate({ sessionId: "s_1", intent: "整理成周报" });
  ok(card.format === "md", `format = md（实际 ${card.format}）`);
  ok(card.degraded === true, "degraded = true");
  ok(typeof card.outcomeId === "string" && card.outcomeId.startsWith("o_"), "outcomeId 形如 o_N");
  const filePath = path.join(outbox, card.fileName);
  ok(fs.existsSync(filePath), `outbox 里真有那个 .md 文件（${card.fileName}）`);
  const content = fs.readFileSync(filePath, "utf8");
  ok(content.includes("自然语言"), "文件内容含模型原文");
}

/* ================================================================ [7] 降级② */
console.log("\n[7] 降级②：docx 渲染抛错 → 改出 md");
{
  const svc = makeService(
    async () => ({ text: JSON.stringify(sampleDoc) }),
    {
      // 注入一个「必定抛错」的 docx 渲染器（非侵入测试点）
      renderDocxFn: async () => {
        throw new Error("模拟 docx 库异常");
      },
    },
  );
  const card = await svc.generate({ sessionId: "s_1", intent: "整理成周报", format: "docx" });
  ok(card.degraded === true, "degraded = true（docx 渲染抛错被捕获）");
  ok(card.format === "md", `format 降级为 md（实际 ${card.format}）`);
  ok(fs.existsSync(path.join(outbox, card.fileName)), "md 文件仍然落盘");
}

/* ================================================================ [8] 降级③ */
console.log("\n[8] 降级③：outbox 不可写 → 不抛错 + inlineText");
{
  // Windows 下指向一个「不可能可写」的路径：盘符不存在（Z:）或系统目录。
  // 用不存在的盘符路径最稳（不依赖权限，也不真去写系统目录）。
  const badOutbox =
    process.platform === "win32"
      ? "Z:\\minipi-no-such-drive\\outbox"
      : "/proc/1/minipi-no-such-dir/outbox";

  const svc = makeService(async () => ({ text: JSON.stringify(sampleDoc) }), { outboxDir: badOutbox });
  let threw = false;
  let card = null;
  try {
    card = await svc.generate({ sessionId: "s_1", intent: "整理成周报" });
  } catch (e) {
    threw = true;
    console.log(`    （意外抛错：${e.message}）`);
  }
  ok(!threw, "generate() 未抛错（绝不空手而归）");
  ok(card && card.degraded === true, "card.degraded = true");
  ok(card && card.absPath === undefined, "card 不暴露 absPath（回渲染层版本）");
  ok(card && typeof card.inlineText === "string" && card.inlineText.length > 0, "card.inlineText 非空（供「复制」按钮）");
  // 内存表里 absPath 应为 null
  const entry = svc.getOutcomeEntry(card.outcomeId);
  ok(entry && entry.absPath === null, "内存表 absPath = null");
}

/* ================================================================ [9] 同名不覆盖 */
console.log("\n[9] 同名不覆盖");
{
  const fileA = path.join(outbox, "同名测试-2026-09-23.md");
  // 用固定标题保证两次同名。这里直接测 _writeOutbox 的语义（通过 generate）。
  const title = "同名测试";
  const svc = makeService(async () => ({ text: JSON.stringify({ title, sections: [{ heading: "h", bullets: ["b"] }] }) }), {
    renderDocxFn: async () => {
      throw new Error("强制走 md");
    },
  });
  const c1 = await svc.generate({ sessionId: "s_1", intent: title });
  const c2 = await svc.generate({ sessionId: "s_1", intent: title });
  ok(c1.fileName !== c2.fileName, `两次产出文件名不同（${c1.fileName} vs ${c2.fileName}）`);
  ok(c2.fileName.includes("-2"), `第二个带 -2 后缀（${c2.fileName}）`);
  ok(fs.existsSync(path.join(outbox, c1.fileName)), "第一个文件仍在（未被覆盖）");
  ok(fs.existsSync(path.join(outbox, c2.fileName)), "第二个文件已落盘");
  void fileA;
}

/* ================================================================ [10] open() 找不到 id */
console.log("\n[10] open() 找不到 id");
{
  const svc = makeService(async () => ({ text: JSON.stringify(sampleDoc) }), {
    shellOpener: async () => "",
  });
  let msg = "";
  try {
    await svc.open({ outcomeId: "o_does_not_exist" });
  } catch (e) {
    msg = e.message;
  }
  ok(/OUTCOME_NOT_FOUND/.test(msg), `错误消息含 OUTCOME_NOT_FOUND（实际：${msg}）`);

  // open() 找不到 id 不泄露路径
  ok(!/[A-Z]:\\/.test(msg) && !msg.includes(outbox), "错误消息不含绝对路径（脱敏）");
}

/* ================================================================ [11] list() */
console.log("\n[11] list()");
{
  const svc = makeService(async () => ({ text: JSON.stringify(sampleDoc) }));
  for (let i = 0; i < 5; i += 1) {
    await svc.generate({ sessionId: "s_1", intent: `第${i}份` });
  }
  const all = svc.list({});
  ok(all.items.length === 5, `无 limit 默认返回 5 条（实际 ${all.items.length}）`);
  ok(svc.list({ limit: 2 }).items.length === 2, "limit:2 → 2 条");
  ok(svc.list({ limit: 0 }).items.length === 1, "limit:0 → 夹到下界 1");
  ok(svc.list({ limit: -5 }).items.length === 1, "limit:-5 → 夹到 1");
  ok(svc.list({ limit: 99999 }).items.length === 5, "limit:99999 → 夹到上界 100（只有 5 条则返回 5）");
  ok(svc.list({}).items[0].createdAt >= svc.list({}).items[4].createdAt, "按 createdAt 倒序（最新在前）");
}

/* ================================================================ [12] 协议一致性 */
console.log("\n[12] 协议一致性（逐字比对方案 §3.4）");
{
  // INVOKE
  ok(INVOKE.GENERATE_OUTCOME === "minipi:generateOutcome", "INVOKE.GENERATE_OUTCOME = minipi:generateOutcome");
  ok(INVOKE.OPEN_OUTCOME === "minipi:openOutcome", "INVOKE.OPEN_OUTCOME = minipi:openOutcome");
  ok(INVOKE.SAVE_OUTCOME_AS === "minipi:saveOutcomeAs", "INVOKE.SAVE_OUTCOME_AS = minipi:saveOutcomeAs");
  ok(INVOKE.LIST_OUTCOMES === "minipi:listOutcomes", "INVOKE.LIST_OUTCOMES = minipi:listOutcomes");
  // EVENTS
  ok(EVENTS.OUTCOME === "minipi:outcome", "EVENTS.OUTCOME = minipi:outcome");
  // ERROR_CODES
  for (const [k, v] of [
    ["OUTCOME_JSON_INVALID", "OUTCOME_JSON_INVALID"],
    ["OUTCOME_RENDER_FAILED", "OUTCOME_RENDER_FAILED"],
    ["OUTCOME_WRITE_FAILED", "OUTCOME_WRITE_FAILED"],
    ["OUTCOME_NOT_FOUND", "OUTCOME_NOT_FOUND"],
    ["SANDBOX_DENIED", "SANDBOX_DENIED"],
  ]) {
    ok(ERROR_CODES[k] === v, `ERROR_CODES.${k} = ${v}`);
  }
  // LIMITS
  ok(LIMITS.OUTCOME_TITLE_MAX_CHARS === 120, "LIMITS.OUTCOME_TITLE_MAX_CHARS = 120");
  ok(LIMITS.OUTCOME_SECTIONS_MAX === 50, "LIMITS.OUTCOME_SECTIONS_MAX = 50");
  ok(LIMITS.OUTCOME_BULLET_MAX_CHARS === 2000, "LIMITS.OUTCOME_BULLET_MAX_CHARS = 2000");
  ok(LIMITS.OUTCOME_FILE_MAX_BYTES === 10 * 1024 * 1024, "LIMITS.OUTCOME_FILE_MAX_BYTES = 10MB");
  ok(LIMITS.OUTCOME_TIMEOUT_MS === 60000, "LIMITS.OUTCOME_TIMEOUT_MS = 60000");
  ok(LIMITS.OUTCOME_INTENT_MAX_CHARS === 2000, "LIMITS.OUTCOME_INTENT_MAX_CHARS = 2000");
  // FORMAT / ACTIONS
  ok(OUTCOME_FORMAT.MD === "md" && OUTCOME_FORMAT.DOCX === "docx", "OUTCOME_FORMAT = md/docx");
  ok(OUTCOME_FORMAT_IDS.includes("md") && OUTCOME_FORMAT_IDS.includes("docx"), "OUTCOME_FORMAT_IDS 含 md/docx");
  ok(OUTCOME_ACTIONS.length === 3, `OUTCOME_ACTIONS 恰好 3 项（实际 ${OUTCOME_ACTIONS.length}）`);
  ok(OUTCOME_ACTIONS.join(",") === "open,saveAs,revise", "OUTCOME_ACTIONS = open,saveAs,revise");
}

/* ================================================================ [13] 入参校验 */
console.log("\n[13] 入参校验（补充防御）");
{
  const svc = makeService(async () => ({ text: JSON.stringify(sampleDoc) }));

  let m1 = "";
  try {
    await svc.generate({ intent: "x" });
  } catch (e) {
    m1 = e.message;
  }
  ok(/INVALID_ARGUMENT/.test(m1), `缺 sessionId → INVALID_ARGUMENT（实际：${m1}）`);

  let m2 = "";
  try {
    await svc.generate({ sessionId: "s_1", intent: "   " });
  } catch (e) {
    m2 = e.message;
  }
  ok(/INVALID_ARGUMENT/.test(m2), `空 intent → INVALID_ARGUMENT`);

  let m3 = "";
  try {
    await svc.generate({ sessionId: "s_1", intent: "x", format: "pptx" });
  } catch (e) {
    m3 = e.message;
  }
  ok(/INVALID_ARGUMENT/.test(m3), `非法 format（pptx）→ INVALID_ARGUMENT`);

  let m4 = "";
  try {
    await svc.generate({ sessionId: "s_nope", intent: "x" });
  } catch (e) {
    m4 = e.message;
  }
  ok(/SESSION_NOT_FOUND/.test(m4), `不存在的 sessionId → SESSION_NOT_FOUND`);

  const longIntent = "字".repeat(LIMITS.OUTCOME_INTENT_MAX_CHARS + 1);
  let m5 = "";
  try {
    await svc.generate({ sessionId: "s_1", intent: longIntent });
  } catch (e) {
    m5 = e.message;
  }
  ok(/INVALID_ARGUMENT/.test(m5), `超长 intent → INVALID_ARGUMENT`);

  // prompt.js 的两个组装函数不抛错且含关键字段
  const p = buildOutcomePrompt({ intent: "整理成周报", sourceText: "素材内容", format: "docx" });
  ok(p.includes("只输出 JSON"), "buildOutcomePrompt 含硬约束句");
  ok(p.includes("素材内容"), "buildOutcomePrompt 嵌入了 sourceText");
  ok(p.includes("整理成周报"), "buildOutcomePrompt 嵌入了 intent");
  ok(buildRetryPrompt(["title 不能为空"]).includes("title 不能为空"), "buildRetryPrompt 回灌 errors");
}

/* ------------------------------------------------------------------ 清理 */
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n${"=".repeat(70)}`);
if (fail === 0) {
  console.log(` 全部通过：${pass} 项`);
} else {
  console.log(` 失败 ${fail} 项 / 共 ${pass + fail} 项`);
}
console.log("=".repeat(70));

process.exit(fail === 0 ? 0 : 1);
