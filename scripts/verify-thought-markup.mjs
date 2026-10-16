#!/usr/bin/env node
/**
 * 思考段 / 正文里的「模型吐出工具调用标记」识别 —— 纯 Node 验证 + **镜像漂移门禁**。
 *
 * 背景：`quick` 场景 `noTools: "all"`，模型手里没工具，却会把 Anthropic 风格的工具调用
 * 语法**当正文写出来**（真实事件流取证见 protocol.js §8b 注释）。渲染层把它折叠成
 * 「模型尝试调用工具 · 当前场景未启用」提示卡，靠的就是 `splitToolMarkup()`。
 *
 * 这个脚本守两件事：
 *   A. **语义**：识别得准（只认 `<invoke name="…">…</invoke>`，别的标签一律不碰）、
 *      边界不吞内容（超块数 / 超长一律退回原文）、不崩（undefined / 数字 / 嵌套垃圾）。
 *   B. **漂移**：`src/renderer/index.html` 里那份**内联镜像**必须与 protocol.js 行为一致
 *      —— 渲染层不能 import protocol.js（单文件零依赖），所以只能靠这个门禁对齐。
 *      做法不是比字符串，而是**把镜像源码抽出来真跑一遍同样的用例**，逐例比对输出。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitToolMarkup, hasToolMarkup, LIMITS } from "../src/shared/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");

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

/* ================================================================== A */
console.log("=".repeat(74));
console.log(" A. splitToolMarkup 语义与边界（protocol.js）");
console.log("=".repeat(74));

const INVOKE = (name, params) =>
  `<invoke name="${name}">${params.map(([k, v]) => `<parameter name="${k}">${v}</parameter>`).join(" ")}</invoke>`;

{
  const plain = "就是一段普通回答，没有工具标记。";
  ok(JSON.stringify(splitToolMarkup(plain)) === JSON.stringify([{ kind: "text", text: plain }]), "无标记 ⇒ 单段文本，原样返回");

  ok(JSON.stringify(splitToolMarkup("")) === "[]", "空串 ⇒ []");
  ok(JSON.stringify(splitToolMarkup(undefined)) === "[]", "undefined ⇒ []（不崩）");
  ok(JSON.stringify(splitToolMarkup(12345)) === "[]", "数字 ⇒ []（不崩）");
  ok(JSON.stringify(splitToolMarkup(null)) === "[]", "null ⇒ []（不崩）");
}

{
  const src = `先把模型确认一下。${INVOKE("cmd", [["cmd", "dir /a"], ["justification", "看看目录"]])}然后继续。`;
  const parts = splitToolMarkup(src);
  ok(parts.length === 3, "前文 + 工具块 + 后文 ⇒ 3 段", `实得 ${parts.length}`);
  ok(parts[0].kind === "text" && parts[0].text === "先把模型确认一下。", "第 1 段是前文原文");
  ok(parts[1].kind === "tool" && parts[1].name === "cmd", "第 2 段是工具块，name=cmd");
  ok(parts[1].params.length === 2, "解析出 2 个 parameter", `实得 ${parts[1].params.length}`);
  ok(parts[1].params[0].name === "cmd" && parts[1].params[0].value === "dir /a", "第 1 个 parameter 名值正确");
  ok(parts[1].params[1].name === "justification" && parts[1].params[1].value === "看看目录", "第 2 个 parameter 名值正确");
  ok(parts[2].kind === "text" && parts[2].text === "然后继续。", "第 3 段是后文原文");
  ok(parts[1].raw.startsWith("<invoke") && parts[1].raw.endsWith("</invoke>"), "raw 是整块原文（供「原文」兜底展示）");
}

{
  const parts = splitToolMarkup(`${INVOKE("a", [])}${INVOKE("b", [])}`);
  ok(parts.filter((p) => p.kind === "tool").length === 2, "相邻两个工具块都被识别");
  ok(parts.filter((p) => p.kind === "text").length === 0, "中间没有文本段时不会塞空段");
}

{
  const parts = splitToolMarkup(INVOKE("noParams", []));
  ok(parts.length === 1 && parts[0].kind === "tool" && parts[0].params.length === 0, "无 parameter 的工具块依然被识别");
}

/* ---- 边界：不该碰的东西一律不碰 ---- */
{
  const cases = [
    ["<img src=x onerror=alert(1)>", "HTML 标签"],
    ["<div>hello</div>", "普通标签"],
    ["<invoke>没有 name 属性</invoke>", "invoke 但没有 name"],
    ["<invoke name='单引号'></invoke>", "单引号 name（不属于该协议）"],
    ["<invoke name=\"a\">没闭合", "只有开标签、未闭合"],
  ];
  for (const [src, label] of cases) {
    const parts = splitToolMarkup(src);
    ok(parts.length === 1 && parts[0].kind === "text" && parts[0].text === src, `不误吞：${label}`);
  }
}

{
  // 超块数 ⇒ 超出部分原样当正文（不能把整段吞掉）
  const many = Array.from({ length: LIMITS.TOOL_INVOKE_MAX_BLOCKS + 5 }, (_, i) => INVOKE(`t${i}`, [])).join("");
  const parts = splitToolMarkup(many);
  const tools = parts.filter((p) => p.kind === "tool").length;
  ok(tools === LIMITS.TOOL_INVOKE_MAX_BLOCKS, `超块数被截到上限 ${LIMITS.TOOL_INVOKE_MAX_BLOCKS}`, `实得 ${tools}`);
  const tail = parts[parts.length - 1];
  ok(tail.kind === "text" && tail.text.includes("<invoke"), "超出的块退回原文（仍可在正文里看到）");
}

{
  // 单块超长 ⇒ 整块不识别，原样返回
  const huge = INVOKE("big", [["x", "y".repeat(LIMITS.TOOL_INVOKE_MAX_CHARS + 10)]]);
  const parts = splitToolMarkup(huge);
  ok(parts.length === 1 && parts[0].kind === "text", `单块超 ${LIMITS.TOOL_INVOKE_MAX_CHARS} 字 ⇒ 不识别（返回原文）`);
}

{
  // 单个 value 超长 ⇒ 截断到上限
  const longVal = "z".repeat(LIMITS.TOOL_PARAM_MAX_CHARS + 500);
  const parts = splitToolMarkup(INVOKE("cmd", [["cmd", longVal]]));
  ok(parts[0].kind === "tool", "value 超长不影响识别");
  ok(parts[0].params[0].value.length === LIMITS.TOOL_PARAM_MAX_CHARS, `value 被截到 ${LIMITS.TOOL_PARAM_MAX_CHARS}`);
}

{
  // parameter 数量超上限
  const many = Array.from({ length: LIMITS.TOOL_PARAM_MAX_ITEMS + 4 }, (_, i) => [`p${i}`, "v"]);
  const parts = splitToolMarkup(INVOKE("cmd", many));
  ok(parts[0].params.length === LIMITS.TOOL_PARAM_MAX_ITEMS, `parameter 数被截到 ${LIMITS.TOOL_PARAM_MAX_ITEMS}`);
}

{
  // 嵌套/畸形内容不崩，且 value 会被 trim
  const parts = splitToolMarkup(INVOKE("cmd", [["a", "  \n 值 \n "], ["b", "<script>alert(1)</script>"]]));
  ok(parts[0].params[0].value === "值", "value 做 trim");
  ok(parts[0].params[1].value === "<script>alert(1)</script>", "value 原样保留（转义是渲染层的责任，不是这里的）");
}

{
  ok(hasToolMarkup(INVOKE("a", [])) === true, "hasToolMarkup：完整块 ⇒ true");
  ok(hasToolMarkup("<invoke name=\"a\">流到一半") === false, "hasToolMarkup：只有开标签 ⇒ false");
  ok(hasToolMarkup("普通文本") === false, "hasToolMarkup：普通文本 ⇒ false");
  ok(hasToolMarkup(undefined) === false, "hasToolMarkup：undefined ⇒ false（不崩）");
}

/* ================================================================== B */
console.log("\n" + "=".repeat(74));
console.log(" B. 渲染层内联镜像 vs protocol.js —— 同样的用例，逐例比对输出");
console.log("=".repeat(74));

/** 把 index.html 里那段镜像源码抽出来，真跑一遍。 */
function loadRendererMirror() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const start = html.indexOf("const TOOL_INVOKE_MAX_BLOCKS");
  if (start === -1) return null;
  const anchor = html.indexOf("function hasToolMarkup", start);
  if (anchor === -1) return null;
  const end = html.indexOf("\n}", anchor);
  if (end === -1) return null;
  const snippet = html.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${snippet}\nreturn { splitToolMarkup, parseToolParams, hasToolMarkup };`);
  return factory();
}

const mirror = loadRendererMirror();
ok(mirror !== null, "渲染层里能找到镜像源码（常量块 + 三个函数）");

if (mirror) {
  const CASES = [
    "",
    "普通文本",
    INVOKE("cmd", [["cmd", "dir /a"], ["justification", "看看目录"]]),
    `前${INVOKE("a", [])}后`,
    `${INVOKE("a", [])}${INVOKE("b", [])}`,
    INVOKE("noParams", []),
    "<img src=x onerror=alert(1)>",
    "<invoke name=\"a\">没闭合",
    "<invoke>没有 name</invoke>",
    INVOKE("cmd", [["a", "  \n 值 \n "], ["b", "<script>x</script>"]]),
    INVOKE("big", [["x", "y".repeat(LIMITS.TOOL_INVOKE_MAX_CHARS + 10)]]),
    Array.from({ length: LIMITS.TOOL_INVOKE_MAX_BLOCKS + 5 }, (_, i) => INVOKE(`t${i}`, [])).join(""),
    INVOKE("many", Array.from({ length: LIMITS.TOOL_PARAM_MAX_ITEMS + 4 }, (_, i) => [`p${i}`, "v"])),
  ];

  let mismatch = 0;
  for (const [i, src] of CASES.entries()) {
    const a = JSON.stringify(splitToolMarkup(src));
    const b = JSON.stringify(mirror.splitToolMarkup(src));
    if (a !== b) {
      mismatch += 1;
      console.log(`    ✘ 用例 ${i} 输出不一致：\n      protocol = ${a.slice(0, 220)}\n      renderer = ${b.slice(0, 220)}`);
    }
  }
  ok(mismatch === 0, `镜像与 protocol 逐例一致（${CASES.length} 个用例）`);

  let flagMismatch = 0;
  for (const src of CASES) {
    if (hasToolMarkup(src) !== mirror.hasToolMarkup(src)) flagMismatch += 1;
  }
  ok(flagMismatch === 0, "hasToolMarkup 镜像一致");
}

console.log("\n" + "=".repeat(74));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
console.log("=".repeat(74));
process.exit(fail === 0 ? 0 : 1);
