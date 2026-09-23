/**
 * 主理人复现 QA-P0-1（沙箱 `@` 前缀逃逸）。
 *
 * 目的：**不信「报告说有漏洞」也不信「工程师说修好了」，只信自己跑出来的物理事实。**
 * 判据：同一入参分别喂给
 *   (a) 我们的 `checkWriteTarget()` —— 沙箱判定
 *   (b) SDK 的 `normalizeToolPath()` 语义 —— 真实落盘路径
 * 若 (a) 放行而 (b) 落在 outbox 之外 ⇒ 逃逸成立。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkWriteTarget } from "../src/main/pi/sandbox.js";

// —— 复刻 SDK 的真实归一化（照 chunk-VT2EHNFQ.js:1062 逐字）——
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function sdkNormalizeToolPath(p) {
  const normalized = String(p).replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}
/** SDK 的 absolutePath：resolve(归一化后的路径) */
function sdkResolve(cwd, raw) {
  return path.resolve(cwd, sdkNormalizeToolPath(raw));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-p0-"));
const outbox = path.join(tmp, "outbox");
const evilDir = path.join(tmp, "evil-outside"); // outbox 之外
fs.mkdirSync(outbox, { recursive: true });
fs.mkdirSync(evilDir, { recursive: true });

const VECTORS = [
  { raw: "note.md", desc: "正常相对路径（对照组，应放行）" },
  { raw: "../evil.txt", desc: "普通上跳（应被拦）" },
  { raw: "@../evil.txt", desc: "★ @ 前缀 + 上跳（P0 嫌疑）" },
  { raw: "@../../evil2.txt", desc: "@ 前缀 + 更远上跳" },
  { raw: "@evil-outside/pwned.txt", desc: "@ 前缀不改语义（对照，应放行且在 outbox 内）" },
];

let escapes = 0;
console.log("\n入参 raw".padEnd(34) + "沙箱判定".padEnd(12) + "SDK 实际落点".padEnd(30) + "结论");
console.log("-".repeat(110));

for (const { raw, desc } of VECTORS) {
  const cwd = outbox;
  const verdict = checkWriteTarget({
    toolName: "write",
    input: { path: raw },
    cwd,
    outboxDir: outbox,
    sceneId: "note",
  });

  const sdkTarget = sdkResolve(cwd, raw);
  const insideOutbox =
    sdkTarget === outbox || sdkTarget.startsWith(outbox + path.sep);
  const sandboxAllows = verdict.blocked === false;

  // 逃逸判据：沙箱放行，但 SDK 真实落点在 outbox 之外
  const isEscape = sandboxAllows && !insideOutbox;
  if (isEscape) escapes += 1;

  const short = (s) => path.relative(tmp, s) || ".";
  console.log(
    raw.padEnd(34) +
      (sandboxAllows ? "放行" : "拦截").padEnd(12) +
      short(sdkTarget).padEnd(30) +
      (isEscape ? "★★ 逃逸 ★★" : insideOutbox ? "在内" : "被拦") +
      `  (${desc})`,
  );
}

// —— 端到端：真按 SDK 语义写盘，看文件是否真出现在 outbox 之外 ——
console.log("\n[端到端] 按 SDK 归一化后的路径真实写盘：");
const probeRaw = "@../escaped.txt";
const sdkTarget = sdkResolve(outbox, probeRaw);
fs.writeFileSync(sdkTarget, "ESCAPED");
const landedOutside = fs.existsSync(path.join(tmp, "escaped.txt"));
const landedInOutbox = fs.existsSync(path.join(outbox, "escaped.txt"));
console.log(`  入参 raw="${probeRaw}"`);
console.log(`  SDK 落点 = ${path.relative(tmp, sdkTarget)}`);
console.log(`  outbox 外是否有 escaped.txt：${landedOutside ? "有 ⇒ 逃逸成立" : "无"}`);
console.log(`  outbox 内是否有 escaped.txt：${landedInOutbox ? "有" : "无"}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(70));
if (escapes > 0) {
  console.log(`结论：复现成功 —— ${escapes} 条入参「沙箱放行但真实落点在 outbox 之外」`);
  console.log("      QA-P0-1 属实，必须修。");
} else {
  console.log("结论：未复现 —— 沙箱判定与 SDK 归一化一致，P0 不成立。");
}
console.log("=".repeat(70));
process.exit(escapes > 0 ? 1 : 0);
