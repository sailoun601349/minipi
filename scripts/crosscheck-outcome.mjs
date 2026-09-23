/**
 * 交叉检查（主理人独立复验，非工程师自测）：证明「产出链路真的产出可用文件」。
 *
 * 与 `verify-outcome.mjs` 的区别（刻意不同，避免只是重跑同一套断言）：
 *   1. 把 `.docx` 真的**解包**，验证 `word/document.xml` 里含我们的文字、标题用 Heading1 样式、
 *      bullet 走编号列表 —— 「不是坏文件」的强证据（只验 PK 魔数太弱）。
 *   2. 直接对 **降级①** 的输入形态（模型回自然语言）做判定。
 *   3. `buildFileName` 的边界用「结果本身是否合法」判定，而非固定期望值。
 *   4. `renderMarkdown` 喂垃圾输入，验证「永远不抛错」这个兜底承诺。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderDocx } from "../src/main/pi/outcome/render-docx.js";
import { renderMarkdown } from "../src/main/pi/outcome/render-md.js";
import {
  buildFileName,
  normalizeOutcome,
} from "../src/main/pi/outcome/schema.js";
import { parseOutcomeJson } from "../src/main/pi/outcome/prompt.js";

let failed = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed += 1;
};

const sample = {
  title: "周报",
  subtitle: ["2026 年第 38 周"],
  sections: [
    {
      heading: "本周进展",
      bullets: ["完成产出链路设计与实现", "沙箱逃逸测试全部通过"],
    },
    { heading: "下周计划", bullets: ["Electron 真机联调", "QA 独立复验"] },
  ],
};

console.log("\n[1] 真实 docx 产物解包验证（强证据：内容真的写进去了）");
const buf = await renderDocx(sample);
ok(Buffer.isBuffer(buf) && buf.length > 0, `renderDocx 返回 Buffer（${buf.length} 字节）`);
ok(buf[0] === 0x50 && buf[1] === 0x4b, "ZIP 魔数 PK");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-crosscheck-"));
const docxPath = path.join(tmp, "sample.docx");
fs.writeFileSync(docxPath, buf);

const { default: JSZip } = await import("jszip");
const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
const names = Object.keys(zip.files);
ok(names.includes("[Content_Types].xml"), "含 [Content_Types].xml");
ok(names.includes("word/document.xml"), "含 word/document.xml");
ok(names.includes("word/_rels/document.xml.rels"), "含关系表（结构完整）");
const xml = await zip.file("word/document.xml").async("string");
ok(xml.includes("周报"), "document.xml 含标题「周报」");
ok(xml.includes("本周进展") && xml.includes("下周计划"), "含两个节标题");
ok(xml.includes("完成产出链路设计与实现"), "含 bullet 正文");
ok(/w:pStyle\s+w:val="Heading1"/.test(xml), "标题用 Heading1 样式（真排版）");
ok(/Heading2/.test(xml), "节标题用 Heading2 样式");
ok(/w:numPr|w:numId/.test(xml), "bullet 走编号列表（真项目符号）");
console.log(`  → document.xml ${xml.length} 字符`);

console.log("\n[2] 降级① 输入形态（模型回自然语言而非 JSON）");
const natural = "抱歉，我直接说结论吧：这周主要做了产出链路。";
ok(parseOutcomeJson(natural).ok === false, "非 JSON → parse 失败（触发降级①）");
ok(parseOutcomeJson("```json\n{\"title\":\"T\"}\n```").ok === true, "带 json 围栏 → 剥壳成功");

console.log("\n[3] buildFileName 边界（按结果合法性判定）");
ok(buildFileName("周报", "docx", new Date(2026, 8, 23)) === "周报-2026-09-23.docx", "常规路径");
const evil = buildFileName('a/b:c*d?e"f<g>h|i', "md");
ok(!/[\\/:*?"<>|]/.test(evil), `非法字符清除（${evil}）`);
ok(buildFileName("", "md").startsWith("未命名-"), "空标题兜底");
ok(buildFileName("   ", "md").startsWith("未命名-"), "纯空白标题兜底");
const longName = buildFileName("长".repeat(500), "md");
ok(longName.length < 160, `超长标题被截断（${longName.length} 字符）`);
ok(buildFileName("a", "docx").endsWith(".docx"), "扩展名按 format 走");

console.log("\n[4] renderMarkdown 对垃圾输入永不抛错（兜底承诺）");
for (const junk of [null, undefined, {}, { sections: null }, { sections: [] }, 12345, "str"]) {
  let threw = false;
  let out = "";
  try {
    out = renderMarkdown(junk);
  } catch {
    threw = true;
  }
  ok(!threw && typeof out === "string" && out.length > 0, `renderMarkdown(${JSON.stringify(junk) ?? "undefined"}) 有输出且不抛错`);
}

console.log("\n[5] 宽容归一化（模型输出形态漂移时的兜底）");
const n1 = normalizeOutcome({ title: "T", sections: [{ heading: "H", items: ["a", "b"] }] });
ok(n1 && n1.sections[0].bullets.length === 2, "items 别名 → bullets（2 条）");
const n2 = normalizeOutcome({
  title: "T",
  sections: [{ heading: "H", content: "第一点\n第二点；第三点" }],
});
ok(n2 && n2.sections[0].bullets.length === 3, "content 字符串按换行/分号 → 3 条");
const n3 = normalizeOutcome({ title: "T", sections: Array.from({ length: 80 }, (_, i) => ({ heading: `H${i}`, bullets: ["x"] })) });
ok(n3 && n3.sections.length === 50, "80 节 → 截断到 50（不报错）");

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(70));
console.log(failed === 0 ? "  交叉检查全部通过" : `  交叉检查失败 ${failed} 项`);
console.log("=".repeat(70));
process.exit(failed ? 1 : 0);
