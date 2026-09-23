#!/usr/bin/env node
/**
 * QA · 象限 B：产出链路对抗性测试（`src/main/pi/outcome/*`）。
 *
 * 定位：工程师的 `verify-outcome.mjs`（97 项）测的是「正常路径 + 三条降级」。
 * 本脚本测的是**恶意 / 畸形输入**——模型输出不可信，必须按「敌手」对待：
 *   · JSON 炸弹 / 原型污染（`__proto__` / `constructor.prototype`）
 *   · 类型混淆（title 是数组/对象/数字；sections 是字符串…）
 *   · `buildFileName` 路径穿越（title 注入 `../` / 保留名 / NUL）
 *   · 超长输入（OOM / 截断时机）
 *   · `inlineText` 的 XSS 泄漏面（在渲染层脚本里判，这里只出原始字符）
 *   · outcomeId 猜测（Map vs 原型链）
 *   · 同名并发（TOCTOU）
 *
 * 运行：`node scripts/qa-outcome-adversarial.mjs`（纯 Node，不依赖 electron）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFileName,
  normalizeOutcome,
  validateOutcome,
  SCHEMA_LIMITS,
} from "../src/main/pi/outcome/schema.js";
import { parseOutcomeJson } from "../src/main/pi/outcome/prompt.js";
import { renderMarkdown } from "../src/main/pi/outcome/render-md.js";
import { OutcomeService } from "../src/main/pi/outcome/index.js";
import { LIMITS } from "../src/shared/protocol.js";

/* ------------------------------------------------------------------ 记账 */

let passed = 0;
let failed = 0;
const findings = [];

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);
function finding(level, id, title, detail) {
  findings.push({ level, id, title, detail });
  console.log(`  >>> [${level}] ${id} ${title}`);
}

console.log("======================================================================");
console.log(" QA · 象限 B：产出链路对抗性测试");
console.log("======================================================================");

/* ================================================================== B1 */
group("[B1] JSON 炸弹 / 原型污染（模型输出不可信）");
{
  // 原型污染经典载荷
  const pollutionPayloads = [
    '{"__proto__":{"polluted":"yes"},"title":"x","sections":[{"heading":"h","bullets":["b"]}]}',
    '{"constructor":{"prototype":{"polluted":"yes"}},"title":"x","sections":[]}',
    '{"title":"x","sections":[{"heading":"h","bullets":["b"]}],"__proto__":{"polluted":"yes"}}',
  ];
  for (let i = 0; i < pollutionPayloads.length; i += 1) {
    // 清空污染标记
    delete Object.prototype.polluted;
    const parsed = parseOutcomeJson(pollutionPayloads[i]);
    let threw = false;
    if (parsed.ok) {
      try {
        validateOutcome(parsed.value);
        normalizeOutcome(parsed.value);
      } catch (err) {
        threw = true;
        finding("P1", "B1-THROW", `原型污染载荷 ${i} 令校验抛异常`, String(err));
      }
    }
    const polluted = Object.prototype.polluted === "yes" || ({}).polluted === "yes";
    if (polluted) {
      finding("P0", "B1-POLLUTE", `原型污染载荷 ${i} 污染了 Object.prototype`, `{}.polluted=${({}).polluted}`);
    }
    ok(!threw && !polluted, `载荷 ${i}：不抛异常且未污染原型（parsed.ok=${parsed.ok}, polluted=${polluted}）`);
    delete Object.prototype.polluted;
  }

  // 超深嵌套（1000 层）——JSON.parse 本身可能栈溢出
  const deep = JSON.parse('{"a":'.repeat(1000) + "1" + "}".repeat(1000));
  let deepOk = true;
  try {
    parseOutcomeJson(JSON.stringify({ title: "x", sections: [{ heading: "h", bullets: ["b"] }], junk: deep }));
  } catch (err) {
    deepOk = false;
    finding("P1", "B1-DEEP", "超深嵌套令解析抛异常", String(err));
  }
  ok(deepOk, "超深嵌套 JSON（1000 层）不令链路抛异常");

  // 超长数组
  const bigArr = { title: "x", sections: Array.from({ length: 100000 }, (_, i) => ({ heading: `h${i}`, bullets: [`b${i}`] })) };
  let bigOk = true;
  let bigDoc = null;
  try {
    const r = validateOutcome(bigArr);
    bigDoc = r.doc;
    if (r.ok && r.doc.sections.length > LIMITS.OUTCOME_SECTIONS_MAX) {
      finding("P1", "B1-BIGARR", `sections 未被截到上限：${r.doc.sections.length} > ${LIMITS.OUTCOME_SECTIONS_MAX}`, "");
      bigOk = false;
    }
  } catch (err) {
    bigOk = false;
    finding("P1", "B1-BIGARR-THROW", "超长 sections 数组令校验抛异常", String(err));
  }
  ok(bigOk, `超长 sections（10 万项）不抛异常且被截断（结果 ${bigDoc ? bigDoc.sections.length : "n/a"} 节）`);
}

/* ================================================================== B2 */
group("[B2] 类型混淆：title / sections / bullets 各种非法类型");
{
  const cases = [
    { label: "title=数组", v: { title: ["a", "b"], sections: [{ heading: "h", bullets: ["b"] }] } },
    { label: "title=对象", v: { title: { a: 1 }, sections: [{ heading: "h", bullets: ["b"] }] } },
    { label: "title=数字", v: { title: 123, sections: [{ heading: "h", bullets: ["b"] }] } },
    { label: "title=null", v: { title: null, sections: [{ heading: "h", bullets: ["b"] }] } },
    { label: "title=NaN", v: { title: NaN, sections: [{ heading: "h", bullets: ["b"] }] } },
    { label: "sections=字符串", v: { title: "x", sections: "not-an-array" } },
    { label: "sections=数字", v: { title: "x", sections: 42 } },
    { label: "sections=null", v: { title: "x", sections: null } },
    { label: "bullets 混 null/对象/数字", v: { title: "x", sections: [{ heading: "h", bullets: [null, { a: 1 }, 42, "ok"] }] } },
    { label: "bullets 超长嵌套对象", v: { title: "x", sections: [{ heading: "h", bullets: [deepObj(50)] }] } },
    { label: "section 是数组", v: { title: "x", sections: [["a", "b"]] } },
    { label: "heading=对象", v: { title: "x", sections: [{ heading: { a: 1 }, bullets: ["b"] }] } },
  ];
  function deepObj(n) {
    let o = { v: 1 };
    for (let i = 0; i < n; i += 1) o = { child: o };
    return o;
  }
  for (const c of cases) {
    let threw = false;
    let out;
    try {
      out = normalizeOutcome(c.v);
      renderMarkdown(out);
    } catch (err) {
      threw = true;
      finding("P0", "B2-THROW", `类型混淆「${c.label}」令 normalizeOutcome/renderMarkdown 抛异常`, String(err));
    }
    ok(!threw, `「${c.label}」不抛异常（normalize 结果 ${out === null ? "null" : "doc"}）`);
  }
}

/* ================================================================== B3 */
group("[B3] buildFileName 路径穿越（本次 QA 最重要的一条）");
{
  const danger = [
    "../../evil",
    String.raw`..\..\evil`,
    String.raw`C:\Windows\evil`,
    "CON",
    "NUL",
    "AUX",
    "COM1",
    "LPT1",
    "....//....//evil",
    ". . .",
    "...",
    "..",
    ".",
    "a\u0000b",
    "a\nb",
    "a\rb",
    "a/b",
    String.raw`a\b`,
    "a:b",
    "a*b",
    "a?b",
    'a"b',
    "a<b",
    "a>b",
    "a|b",
    "  ..  ",
    String.raw`..\..\..\..\Windows\System32\evil`,
    "／／／", // 全角斜杠
    "％2e％2e", // 编码形态
    "\u202eabc", // RTL override
  ];
  const date = new Date(2026, 8, 23);
  const BASE = path.resolve(os.tmpdir(), "minipi-qa-b3-base", "outbox");
  /** 真逃逸判定：相对路径是 `..` 本身或以 `..<sep>` 开头（而不是文件名恰好以 .. 打头）。 */
  function escapesBase(abs, base) {
    const rel = path.relative(base, abs);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  }
  let anyEscape = false;
  for (const t of danger) {
    let name;
    let threw = false;
    try {
      name = buildFileName(t, "docx", date);
    } catch (err) {
      threw = true;
      finding("P2", "B3-THROW", `buildFileName(${JSON.stringify(t)}) 抛异常`, String(err));
    }
    if (threw) {
      ok(false, `buildFileName(${JSON.stringify(t)}) 不抛异常`);
      continue;
    }
    // 关键断言：文件名必须是**单段**（不含路径分隔符）、不是 `..`/`.` 这两个特殊段
    const hasSep = /[\\/]/.test(name);
    const isSpecialDot = name === ".." || name === ".";
    // 归一化后仍必须落在 outbox 内（用 path.join 模拟调用点 outcome/index.js L433）
    const joined = path.join(BASE, name);
    const resolvedInside = !escapesBase(path.resolve(joined), BASE);
    if (hasSep || isSpecialDot || !resolvedInside) {
      anyEscape = true;
      finding(
        "P0",
        "B3-TRAVERSAL",
        `buildFileName(${JSON.stringify(t)}) 产出可穿越的文件名`,
        `name=${JSON.stringify(name)} · hasSep=${hasSep} · isSpecialDot=${isSpecialDot} · path.join 结果=${joined}`,
      );
    }
    ok(!hasSep && !isSpecialDot && resolvedInside, `buildFileName(${JSON.stringify(t)}) → ${JSON.stringify(name)} 单段且不穿越`);
  }
  if (!anyEscape) {
    console.log("  （结论：全部穿越向量被清洗，文件名均为单段、无特殊 `..`/`.` 段）");
  }

  // 显式端到端：模拟 outcome/index.js 的 path.join(dir, candidate) 是否可能跳出 dir
  const dir = path.join(os.tmpdir(), "minipi-qa-b3-outbox");
  fs.mkdirSync(dir, { recursive: true });
  const evil = buildFileName("../../evil", "md", date);
  const abs = path.join(dir, evil);
  const escaped = escapesBase(path.resolve(abs), path.resolve(dir));
  if (escaped) {
    finding("P0", "B3-E2E", "端到端确认：buildFileName 输出使 path.join 跳出 outbox", `abs=${abs}`);
  }
  ok(!escaped, `端到端：title="../../evil" → 文件名「${evil}」仍落在 outbox 内`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================================================================== B4 */
group("[B4] 超长输入：OOM / 截断时机");
{
  // title 100KB
  const bigTitle = "A".repeat(100 * 1024);
  const r1 = validateOutcome({ title: bigTitle, sections: [{ heading: "h", bullets: ["b"] }] });
  ok(r1.ok && r1.doc.title.length <= LIMITS.OUTCOME_TITLE_MAX_CHARS, `title 100KB → 截到 ${r1.doc?.title?.length} 字符`);

  const n1 = buildFileName(bigTitle, "md", new Date(2026, 8, 23));
  ok(n1.length <= LIMITS.OUTCOME_TITLE_MAX_CHARS + 20, `buildFileName(100KB title) 长度=${n1.length}（≤ 上限+日期+扩展名）`);

  // 单条 bullet 1MB
  const bigBullet = "B".repeat(1024 * 1024);
  const r2 = validateOutcome({ title: "x", sections: [{ heading: "h", bullets: [bigBullet] }] });
  ok(r2.ok && r2.doc.sections[0].bullets[0].length <= LIMITS.OUTCOME_BULLET_MAX_CHARS,
    `单条 bullet 1MB → 截到 ${r2.doc?.sections?.[0]?.bullets?.[0]?.length} 字符`);

  // sections 10000 项
  const many = { title: "x", sections: Array.from({ length: 10000 }, (_, i) => ({ heading: "h" + i, bullets: ["b"] })) };
  const r3 = validateOutcome(many);
  ok(r3.ok && r3.doc.sections.length <= LIMITS.OUTCOME_SECTIONS_MAX,
    `sections 10000 项 → 截到 ${r3.doc?.sections?.length} 节`);

  // 确认截断在「拼接前」生效（否则内存会翻倍）
  const t0 = Date.now();
  const r4 = validateOutcome({ title: "x", sections: [{ heading: "h", bullets: Array.from({ length: 1000 }, () => "C".repeat(50 * 1024)) }] });
  const dt = Date.now() - t0;
  ok(r4.ok && r4.doc.sections[0].bullets.every((b) => b.length <= LIMITS.OUTCOME_BULLET_MAX_CHARS),
    `1000×50KB bullets 在 ${dt}ms 内完成且全部截断（截断先于聚合）`);
}

/* ================================================================== B5 */
group("[B5] parseOutcomeJson 垃圾输入");
{
  const garbage = [
    "",
    "   ",
    "no json here",
    "```json\n{broken\n```",
    "{}",
    "[1,2,3]",
    '{"title":"x","sections":null}',
    "{" + '"a":1,'.repeat(1000) + '"b":2}',
  ];
  for (const g of garbage) {
    let threw = false;
    try {
      const r = parseOutcomeJson(g);
      ok(typeof r.ok === "boolean", `parseOutcomeJson(${JSON.stringify(g.slice(0, 20))}…) → ok=${r.ok}`);
    } catch (err) {
      threw = true;
      finding("P0", "B5-THROW", `parseOutcomeJson 对垃圾输入抛异常`, `${JSON.stringify(g.slice(0, 30))}: ${err}`);
      ok(false, `parseOutcomeJson(${JSON.stringify(g.slice(0, 20))}…) 不抛异常`);
    }
  }
}

/* ================================================================== B6 */
group("[B6] outcomeId 猜测 / 内存表原型链");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-b6-"));
  const piHost = { hasSession: (id) => id === "s_1", generateStructured: async () => ({ text: '{"title":"t","sections":[{"heading":"h","bullets":["b"]}]}' }) };
  const svc = new OutcomeService({ piHost, logger: { warn() {}, info() {}, error() {} }, outboxDir: tmp, renderDocxFn: async (d) => Buffer.from("# " + d.title) });

  // 造一个真实产出
  const card = await svc.generate({ sessionId: "s_1", intent: "x", format: "md" });
  ok(typeof card.outcomeId === "string", `generate 产出 outcomeId=${card.outcomeId}`);

  // 猜不存在的 id
  const guess = ["o_999", "o_0", "", "o_-1", "o_1.0", "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
  for (const id of guess) {
    let threw = false;
    let msg = "";
    try {
      await svc.open({ outcomeId: id });
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    const isNotFound = threw && /OUTCOME_NOT_FOUND|INVALID_ARGUMENT/.test(msg);
    if (!isNotFound) {
      finding("P0", "B6-IDGUESS", `猜测 outcomeId="${id}" 未被正确拒绝`, `threw=${threw} msg=${msg}`);
    }
    ok(isNotFound, `outcomeId="${id}" → 正确拒绝（${msg.slice(0, 40)}）`);
  }

  // 跨会话 id：本服务只有一个会话，验证别的会话 id 拿不到产出
  const other = await (async () => {
    try {
      await svc.open({ outcomeId: "o_2" });
      return "no-throw";
    } catch (err) {
      return err.message;
    }
  })();
  ok(/OUTCOME_NOT_FOUND/.test(other), `不存在的 o_2 → OUTCOME_NOT_FOUND（${other.slice(0, 40)}）`);

  // 确认内存表是 Map（不是普通对象）⇒ 无原型链问题
  const proto = Object.getPrototypeOf(svc._outcomes);
  ok(proto === Map.prototype, `_outcomes 是 Map（原型=${proto === Map.prototype ? "Map.prototype" : proto}）`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ================================================================== B7 */
group("[B7] 同名并发（TOCTOU：wx 独占创建是否真原子）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-b7-"));
  for (let round = 0; round < 5; round += 1) {
    const piHost = { hasSession: () => true, generateStructured: async () => ({ text: '{"title":"same","sections":[{"heading":"h","bullets":["b"]}]}' }) };
    const svc = new OutcomeService({ piHost, logger: { warn() {}, info() {}, error() {} }, outboxDir: tmp, renderDocxFn: async () => Buffer.from("x") });
    // 并发 8 次，全部同 title → 应得到 8 个不重名文件
    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.generate({ sessionId: "s_1", intent: "same", format: "md" })),
    );
    const names = results.map((r) => r.fileName);
    const unique = new Set(names);
    const files = fs.readdirSync(tmp);
    if (unique.size !== names.length || files.length !== names.length) {
      finding(
        "P0",
        "B7-RACE",
        `并发同 title 产出发生覆盖/撞名（round ${round}）`,
        `names=${JSON.stringify(names)} · 磁盘文件=${JSON.stringify(files)}`,
      );
    }
    ok(unique.size === names.length && files.length === names.length,
      `round ${round}：8 并发同 title → ${unique.size} 唯一名 / 磁盘 ${files.length} 文件`);
    // 清空供下一轮
    for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ================================================================== B8 */
group("[B8] generate() 入参对抗");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-b8-"));
  const piHost = { hasSession: () => true, generateStructured: async () => ({ text: "{}" }) };
  const svc = new OutcomeService({ piHost, logger: { warn() {}, info() {}, error() {} }, outboxDir: tmp, renderDocxFn: async () => Buffer.from("x") });
  const cases = [
    { label: "generate(null)", arg: null },
    { label: "generate(undefined)", arg: undefined },
    { label: "generate({})", arg: {} },
    { label: "sessionId 为空", arg: { sessionId: "", intent: "x" } },
    { label: "sessionId 是数字", arg: { sessionId: 1, intent: "x" } },
    { label: "intent 为空", arg: { sessionId: "s_1", intent: "  " } },
    { label: "intent 超长(2001)", arg: { sessionId: "s_1", intent: "x".repeat(2001) } },
    { label: "format 非法", arg: { sessionId: "s_1", intent: "x", format: "pdf" } },
  ];
  for (const c of cases) {
    let threw = false;
    let msg = "";
    try {
      await svc.generate(c.arg);
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    ok(threw && /INVALID_ARGUMENT|SESSION_NOT_FOUND/.test(msg), `${c.label} → 抛可读错误（${msg.slice(0, 40)}）`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
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
