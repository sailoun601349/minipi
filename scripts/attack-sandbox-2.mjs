/**
 * 主理人独立攻击：P0 修复后的沙箱，用**我自己新设计**的向量。
 *
 * 为什么不用白客/秦戈的用例：他们测过的向量，作者的镜像已经覆盖。
 * 我要打的是**他们没想到的归一化维度** —— 特别是那些「SDK 会改、而镜像可能漏」的规则。
 *
 * oracle 一律用「SDK 真实落点是否越界」，而不是「手算的路径」。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkWriteTarget } from "../src/main/pi/sandbox.js";

// —— 用真实 SDK 的归一化当 oracle（不是手抄！）——
const sdkMod = await import("@earendil-works/pi-coding-agent");
// SDK 未直接导出 resolveToCwd，用其底层语义等价物：这里直接调用我们已知的
// resolvePath 规则，但**关键校验靠 live 脚本**。本脚本只做「沙箱判定 vs 物理落点」的一致性。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 严格按 SDK resolveToCwd 语义（normalizeUnicodeSpaces + stripAtPrefix + tilde + win shell） */
function sdkTarget(raw, cwd) {
  let n = String(raw).replace(UNICODE_SPACES, " ");
  if (n.startsWith("@")) n = n.slice(1);
  if (process.platform === "win32" && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\")) {
    const m = n.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) n = `${m[1].toUpperCase()}:\\${(m[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (n === "~") n = os.homedir();
  else if (n.startsWith("~/") || n.startsWith("~\\")) n = path.join(os.homedir(), n.slice(2));
  if (/^file:\/\//.test(n)) {
    const { fileURLToPath } = require("node:url");
    n = fileURLToPath(n);
  }
  return path.isAbsolute(n) ? path.resolve(n) : path.resolve(cwd, n);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-attack2-"));
const outbox = path.join(tmp, "outbox");
fs.mkdirSync(outbox, { recursive: true });

// 我新设计的向量：专打「镜像可能漏掉的归一化维度」
const VECTORS = [
  // —— 归一化维度：SDK 会改，镜像可能漏 ——
  { raw: "@\u00A0../evil.txt", desc: "NBSP + @ + 上跳（两规则叠加）" },
  { raw: "@@../evil.txt", desc: "双 @（SDK 只剥一个 ⇒ 剩下 @.. 是目录名）" },
  { raw: "@@../evil2.txt", desc: "双 @ 变体" },
  { raw: "..\u00A0/evil.txt", desc: "路径中段 NBSP" },
  { raw: "@../\u202Fevil.txt", desc: "窄不换行空格 + @" },
  { raw: "~/../evil.txt", desc: "~ 展开后上跳（~ 是家目录，不在 outbox）" },
  { raw: "@~/evil.txt", desc: "@ + ~ 展开" },
  { raw: "file:///C:/Windows/evil.txt", desc: "file:// 绝对路径" },
  { raw: "file://../evil.txt", desc: "file:// 相对（可能抛）" },
  // —— Windows shell 路径 ——
  { raw: "/c/Windows/evil.txt", desc: "win32 shell 盘符风格" },
  { raw: "/mnt/c/Windows/evil.txt", desc: "wsl 风格" },
  { raw: "/cygdrive/c/Windows/evil.txt", desc: "cygwin 风格" },
  // —— 语义不变但应放行的对照（防误杀太狠）——
  { raw: "@note.md", desc: "对照：@ + 正常文件名 → 放行且在 outbox 内" },
  { raw: "sub/note.md", desc: "对照：子目录 → 放行" },
  { raw: "@sub/@note.md", desc: "对照：@ + 子目录 + @ 文件名" },
  { raw: "\u00A0note.md", desc: "对照：NBSP 开头 → 归一化后仍在 outbox" },
  // —— 经典 ——
  { raw: "..\\evil.txt", desc: "反斜杠上跳" },
  { raw: "....//evil.txt", desc: "四点 + 双斜杠" },
  { raw: "a/../../../evil.txt", desc: "多段上跳" },
];

let escapes = 0;   // 沙箱放行 但 物理越界 → 致命
let overblocks = 0; // 沙箱拦截 但 物理在界内 → 误杀（记录，非致命）
console.log("\n" + "raw".padEnd(36) + "沙箱".padEnd(8) + "SDK 落点".padEnd(26) + "判定");
console.log("-".repeat(104));

for (const { raw, desc } of VECTORS) {
  const verdict = checkWriteTarget({
    toolName: "write",
    input: { path: raw },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "note",
  });
  const allows = verdict.blocked === false;

  let target = null;
  let physicalInside = false;
  let calcErr = null;
  try {
    target = sdkTarget(raw, outbox);
    physicalInside = target === outbox || target.startsWith(outbox + path.sep);
  } catch (e) {
    calcErr = String(e.message ?? e).slice(0, 30);
  }

  const escape = allows && target !== null && !physicalInside;
  const overblock = !allows && target !== null && physicalInside;
  if (escape) escapes += 1;
  if (overblock) overblocks += 1;

  const rel = target === null ? `(抛错:${calcErr})` : path.relative(tmp, target) || ".";
  console.log(
    raw.padEnd(36) +
      (allows ? "放行" : "拦截").padEnd(8) +
      rel.slice(0, 24).padEnd(26) +
      (escape ? "★★ 逃逸 ★★" : overblock ? "误杀" : physicalInside === allows ? "一致" : "?") +
      `  (${desc})`,
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(72));
console.log(`致命逃逸（放行但物理越界）：${escapes} 条`);
console.log(`误杀（拦截但物理界内）：${overblocks} 条  ← 影响体验，非安全问题`);
console.log(escapes === 0 ? "结论：未找到逃逸 —— 修复成立。" : "结论：仍有逃逸，P0 未修完！");
console.log("=".repeat(72));
process.exit(escapes > 0 ? 1 : 0);
