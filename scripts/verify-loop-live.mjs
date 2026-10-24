#!/usr/bin/env node
/**
 * **基础业务闭环 · 真机端到端**（会消耗模型额度）。
 *
 * 用户对这条链路的要求（原话）：
 *   「不同窗口输入问题，都能接入大模型从而回复展示给用户。
 *     同时能使得用户可以下载内容成 md 或者 docx 格式文档。」
 *
 * `qa:business-loop` 用 mock 证明了**界面到宿主**这一段；
 * 本脚本证明**宿主到真模型、再到真文件**那一段 —— 两段都通才算闭环成立。
 *
 * 做的四件事：
 *   ① 建真会话 → 真提问 → 断言收到逐字流且拿到非空回答；
 *   ② `generateOutcome(format: 'md')`   → 断言 outbox 里**真有**一个非空 .md，且内容像文档；
 *   ③ `generateOutcome(format: 'docx')` → 断言 outbox 里**真有**一个合法 .docx（zip 魔数 PK\x03\x04）；
 *   ④ 把它当 zip 打开，断言 `word/document.xml` 确实在包里（证明不是改名的假 docx）。
 *
 * ⚠ 会消耗模型额度（2–3 次调用）。**不进 verify:all**，与 verify-sandbox-live 同款，
 *   走 `npm run verify:loop-live` 单独跑。
 *
 * 用法：`node scripts/verify-loop-live.mjs [--keep]`
 *   · 默认跑完**保留**产出文件（你可以直接打开看质量）；
 *   · 加 `--keep=false` 则跑完删除，不留痕迹。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PiSessionHost } from "../src/main/pi/session.js";
import { OutcomeService } from "../src/main/pi/outcome/index.js";
import { OUTBOX_DIR } from "../src/main/settings.js";

const KEEP = !process.argv.includes("--keep=false");
const QUESTION = "用三句话说明「银企直联」是什么，以及它在企业资金管理里的作用。";
const INTENT = "整理成一份简短的学习笔记";

const log = console;
let pass = 0;
let fail = 0;
function ok(cond, label, extra = "") {
  if (cond) {
    pass += 1;
    log.log(`  PASS  ${label}${extra ? ` · ${extra}` : ""}`);
  } else {
    fail += 1;
    log.log(`  FAIL  ${label}${extra ? ` · ${extra}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
log.log("=".repeat(76));
log.log(" 基础业务闭环 · 真机端到端（提问 → 回答 → 导出 md/docx）");
log.log("=".repeat(76));

const events = [];
let sessionId = null;
/** 被 shellOpener 收到的绝对路径（第 ⑥ 步断言用） */
let openedWith = null;
const pi = new PiSessionHost({
  logger: { info: (...a) => log.log("  [pi]", ...a), warn: (...a) => log.log("  [pi:warn]", ...a), error: console.error },
  emit: (wrapped) => {
    if (wrapped?.sessionId === sessionId) events.push(wrapped.event);
  },
});

const outcome = new OutcomeService({
  piHost: pi,
  logger: { info: (...a) => log.log("  [outcome]", ...a), warn: (...a) => log.log("  [outcome:warn]", ...a), error: console.error },
  outboxDir: OUTBOX_DIR,
  emitOutcome: () => {},
  // 注入一个**假的** shellOpener：不真的拉起系统程序，但能拿到被解析出来的绝对路径 ——
  // 这样第 ⑥ 步验的是"路径能不能解析到真实文件"，而不是"有没有弹出一个窗口"。
  // ⚠ 不要传 null：服务层对"没注入实现"是显式报错的（fail-loud，不是静默成功），
  //   null 会让这条断言变成在测错误分支。
  shellOpener: async (absPath) => {
    openedWith = absPath;
    return "";
  },
  dialogOpener: null,
});

function waitSettled(timeoutMs = 180000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const types = events.map((e) => e?.type);
      const done =
        types.includes("agent_settled") ||
        types.lastIndexOf("agent_end") > types.lastIndexOf("agent_start");
      if (done || Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        resolve();
      }
    }, 300);
  });
}

const before = new Set(fs.existsSync(OUTBOX_DIR) ? fs.readdirSync(OUTBOX_DIR) : []);

try {
  /* ---------------------------------------------------------- ① 提问 → 回答 */
  log.log("\n[①] 真会话 → 真提问 → 真回答");
  const created = await pi.createSession({ sceneId: "chat" });
  sessionId = created.sessionId;
  log.log(`  会话=${created.sessionId} 场景=${created.sceneId} 模型=${created.model}`);

  events.length = 0;
  const t0 = Date.now();
  await pi.prompt({ sessionId, text: QUESTION, behavior: "steer" });
  await waitSettled();
  const ms = Date.now() - t0;

  const deltas = events.filter((e) => e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta");
  const answer = deltas.map((e) => String(e.assistantMessageEvent.delta ?? "")).join("");
  const thinkDeltas = events.filter((e) => e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_delta");
  const settled = events.some((e) => e?.type === "agent_settled" || e?.type === "agent_end");

  ok(Boolean(created.model), "会话解析出了模型", String(created.model));
  ok(deltas.length > 0, "★ 收到逐字流（text_delta）", `${deltas.length} 条`);
  ok(answer.trim().length > 20, "★ 拿到非空回答", `${answer.trim().length} 字`);
  ok(settled, "本轮正常收尾（agent_end / agent_settled）");
  ok(/银企|直联|资金|结算|支付|账户/.test(answer), "回答确实在讲这个主题（不是空壳回复）");
  log.log(`  耗时 ${(ms / 1000).toFixed(1)}s · 思考 ${thinkDeltas.length} 条 · 回答前 80 字：${answer.trim().slice(0, 80)}`);

  /* ---------------------------------------------------------- ② 导出 md */
  log.log("\n[②] 导出 Markdown");
  const md = await outcome.generate({ sessionId, intent: INTENT, format: "md" });
  log.log(`  卡片：${JSON.stringify({ outcomeId: md?.outcomeId, format: md?.format, degraded: md?.degraded, fileName: md?.fileName, bytes: md?.bytes })}`);
  ok(md?.format === "md", "卡片格式是 md", String(md?.format));
  ok(md?.degraded !== true, "没有降级（真落盘，不是 inlineText 兜底）");
  const mdPath = path.join(OUTBOX_DIR, String(md?.fileName ?? ""));
  ok(fs.existsSync(mdPath), "★ 文件真的落在 outbox", path.relative(os.homedir(), mdPath));
  const mdText = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : "";
  ok(mdText.trim().length > 40, "md 内容非空", `${mdText.length} 字`);
  ok(/^#\s|^##\s/m.test(mdText), "md 有标题结构（像文档，不是一段裸文本）");
  ok(/银企|直联|资金|结算|支付|账户/.test(mdText), "md 内容与主题一致");
  log.log(`  md 行数=${mdText.split("\n").length} · 前 3 行：\n${mdText.split("\n").slice(0, 3).map((l) => "    " + l).join("\n")}`);

  /* ---------------------------------------------------------- ③ 导出 docx */
  log.log("\n[③] 导出 Word (.docx)");
  const dx = await outcome.generate({ sessionId, intent: `${INTENT}（Word 版）`, format: "docx" });
  log.log(`  卡片：${JSON.stringify({ outcomeId: dx?.outcomeId, format: dx?.format, degraded: dx?.degraded, fileName: dx?.fileName, bytes: dx?.bytes })}`);
  ok(dx?.format === "docx", "卡片格式是 docx", String(dx?.format));
  ok(dx?.degraded !== true, "没有降级为 md");
  const docxPath = path.join(OUTBOX_DIR, String(dx?.fileName ?? ""));
  ok(fs.existsSync(docxPath), "★ docx 真的落在 outbox", path.relative(os.homedir(), docxPath));

  /* ---------------------------------------------------------- ④ docx 是不是真 docx */
  log.log("\n[④] 校验 docx 是真 OOXML（不是改名的 zip/txt）");
  const buf = fs.existsSync(docxPath) ? fs.readFileSync(docxPath) : Buffer.alloc(0);
  ok(buf.length > 1000, "docx 体积合理", `${buf.length} 字节`);
  ok(buf.subarray(0, 4).toString("latin1") === "PK\u0003\u0004", "首 4 字节是 zip 魔数 PK\\x03\\x04");
  const asLatin = buf.toString("latin1");
  ok(asLatin.includes("word/document.xml"), "包内含 word/document.xml（真 OOXML 结构）");
  ok(asLatin.includes("[Content_Types].xml"), "包内含 [Content_Types].xml");

  /* ---------------------------------------------------------- ⑤ 产出可被列出 */
  log.log("\n[⑤] 产出列表可见（「打开 / 另存为」的目标存在）");
  const listed = await outcome.list({ limit: 20 });
  const items = Array.isArray(listed?.items) ? listed.items : [];
  ok(items.length >= 2, "list() 能列到刚产出的文件", `${items.length} 条`);
  ok(items.some((it) => String(it.fileName || "").includes(String(md?.fileName || "@@"))), "列表里能找到那份 md");

  /* ---------------------------------------------------------- ⑥ 打开的路径 */
  log.log("\n[⑥] open() 路径解析（不真调系统程序）");
  const openRes = await outcome.open({ outcomeId: md?.outcomeId });
  ok(openRes?.ok === true, "open() 返回 ok");
  ok(openedWith === mdPath, "★ 交给系统程序的绝对路径就是刚写的那个文件", String(openedWith));
  ok(fs.existsSync(String(openedWith)), "该路径在磁盘上确实存在");

} catch (err) {
  ok(false, `执行异常：${err?.message ?? err}`);
  log.error(err);
} finally {
  try {
    pi.disposeAll();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
const after = fs.existsSync(OUTBOX_DIR) ? fs.readdirSync(OUTBOX_DIR) : [];
const produced = after.filter((f) => !before.has(f));
log.log("\n" + "=".repeat(76));
log.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
log.log(` 本次产出 ${produced.length} 个文件（${OUTBOX_DIR}）：`);
for (const f of produced) {
  const p = path.join(OUTBOX_DIR, f);
  log.log(`   · ${f}  ${fs.statSync(p).size} 字节`);
}
if (produced.length > 0 && !KEEP) {
  for (const f of produced) {
    try {
      fs.rmSync(path.join(OUTBOX_DIR, f), { force: true });
    } catch {
      /* ignore */
    }
  }
  log.log(" （--keep=false：已删除本次产出）");
} else if (produced.length > 0) {
  log.log(" 产出已保留 —— 可以直接双击打开看质量；不要时手动删掉即可。");
}
log.log("=".repeat(76));
process.exit(fail === 0 ? 0 : 1);
