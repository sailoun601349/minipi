/**
 * 主理人独立复验：`middleTruncate` 的字素簇截断（QA-P2-3 修复）。
 *
 * 为什么我自己再测一遍：方砚的用例表里 4/6 条输出都是 `"….docx"` ——
 * 这虽然是「没劈开 emoji」的合法结果，但**实用上是退化的**（用户只看到省略号 + 扩展名）。
 * 我要确认：① 不劈代理对（核心修复）② 输出是否仍**有用**（能看出原名的样子）。
 */

// 从 index.html 抽出这两个纯函数（不 eval 整个文件）
import fs from "node:fs";
const html = fs.readFileSync("src/renderer/index.html", "utf8");

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let i = html.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < html.length; j += 1) {
    if (html[j] === "{") depth += 1;
    else if (html[j] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  throw new Error(`${name} 括号不配对`);
}

const src = `${extractFn("splitGraphemes")}\n${extractFn("middleTruncate")}\n`;
const mod = new Function(`${src}; return { splitGraphemes, middleTruncate };`)();
const { middleTruncate, splitGraphemes } = mod;

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasLone = (s) => LONE.test(s);

let bad = 0;
const ok = (c, l) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}`);
  if (!c) bad += 1;
};

console.log("\n[A] 核心修复：不劈字素（孤立代理项 = 乱码）");
const graphemeCases = [
  ["👍👍👍👍.docx", 6],
  ["👨‍👩‍👧‍👦.md", 6],
  ["ééé.docx", 6],          // NFC
  ["e\u0301e\u0301e\u0301.docx", 6], // NFD 组合字符
  ["🇨🇳🇯🇵.docx", 6],
  ["🎉🎊🎈🎁🎂.docx", 8],
];
for (const [input, max] of graphemeCases) {
  for (const form of [input, input.normalize("NFD")]) {
    const out = middleTruncate(form, max);
    const verdict = !hasLone(out);
    ok(verdict, `middleTruncate(${JSON.stringify(form).slice(0, 34)}, ${max}) → ${JSON.stringify(out)} 无孤立代理项`);
  }
}

console.log("\n[B] 实用性：输出是否还看得出原名（不只是「….docx」）");
// 这一组是**我的补充判据**，方砚的表里没体现：截断结果应保留有意义的头部
const usefulCases = [
  ["周报-2026-09-23-最终版.docx", 20, ["周报", ".docx"]],
  ["季度汇报-产品部-2026Q3-终稿.docx", 20, ["季度", ".docx"]],
  ["lecture03-泰勒展开-完整笔记.md", 20, ["lecture", ".md"]],
];
for (const [input, max, mustHave] of usefulCases) {
  const out = middleTruncate(input, max);
  for (const frag of mustHave) {
    ok(out.includes(frag), `「${input}」@${max} → ${JSON.stringify(out)} 含「${frag}」`);
  }
}

console.log("\n[C] 回归：中文/ASCII 混合行为不许变（对照 v1 已知期望值）");
ok(middleTruncate("周报-2026-09-23.docx", 20) === "周报-2026-09-23.docx", "19 字符 @20 → 原样");
ok(middleTruncate("x.veryveryverylongextension", 12) === "x.veryveryv…", "极长扩展名 @12 → 尾部截断（与 v1 一致）");
ok(middleTruncate("周报-2026-09-23-最终版.docx", 20) === "周报-2026…-23-最终版.docx", "中文混合 @20 → 中间省略 + .docx 保留");

console.log("\n[D] 边界输入不抛错");
for (const v of ["", " ", ".", "..", "...", "a", ".docx", "a.", null, undefined, 12345]) {
  let threw = false;
  let out = "";
  try {
    out = middleTruncate(v, 8);
  } catch {
    threw = true;
  }
  ok(!threw && typeof out === "string", `middleTruncate(${JSON.stringify(v)}, 8) → ${JSON.stringify(out)} 不抛错`);
}

console.log("\n[E] Intl.Segmenter 可用性与降级路径");
console.log(`  Intl.Segmenter 可用：${typeof Intl?.Segmenter === "function"}`);
const zwj = "👨‍👩‍👧‍👦";
console.log(`  ZWJ 家庭字素簇数（Segmenter）: ${splitGraphemes(zwj).length}（码点数 ${zwj.length}）`);
ok(splitGraphemes(zwj).length === 1, "ZWJ 序列被当作 1 个字素簇");

console.log("\n" + "=".repeat(70));
console.log(bad === 0 ? "  独立复验全部通过" : `  独立复验失败 ${bad} 项`);
console.log("=".repeat(70));
process.exit(bad ? 1 : 0);
