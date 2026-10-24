#!/usr/bin/env node
/**
 * QA · 真实导出入口（静态审查）
 *
 * 背景：旧链路是「底部产出按钮 → 独立面板 #outcomeComposer → 写意图 + 选格式」。
 * 用户明确反对把导出做成另一个窗口/面板，Phase 3 改成：
 *   回答操作行 `.msgacts` →（导出钮，export 图标）→ 锚定 popover `#exportPop`
 *   → 选 Word / Markdown（或自定义整理要求）→ 真调 `host.generateOutcome`
 *   → 会话流里占位卡 → 产出卡。
 *
 * 本脚本守的就是这条新链路的**静态骨架**：
 *   ① 三个「文档」快捷入口还在（mini / full 侧栏 / full 输入区）；
 *   ② 每条回答都有 `.msgacts`，导出钮用的是 export 图标（D-3.3，不是 download）；
 *   ③ popover 是单例、两个格式项都在、自定义输入 2000 字上限；
 *   ④ 真的调用宿主，参数形态正确；
 *   ⑤ 旧面板与它的四个函数**彻底删干净**（不能留死引用）。
 *
 * 运行：`node scripts/qa-outcome-entry.mjs`（纯 Node，不需要 Chrome）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
const checks = [];
function check(label, ok) { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${label}`); }

/* ---- 入口：三个「文档」按钮都还在（作用于最后一条已完成回答） ---- */
check("mini 文档入口存在", /id="btnOutcome"/.test(html));
check("full 侧栏文档入口存在", /id="btnOutcomeFull"/.test(html));
check("full 输入区文档入口存在", /id="btnOutcomeFullFoot"/.test(html));

/* ---- 回答操作行：每条 AI 回答底部都有「复制 / 导出」 ---- */
check("存在 buildMsgActs()（回答操作行）", /function buildMsgActs\(turn\)/.test(html));
check("操作行挂在轮次上（data-turn-msgacts，重绘不丢）", /data-turn-msgacts/.test(html));
check("有「复制这条回答」按钮", /data-msg-copy/.test(html));
check("有「导出这条回答」按钮", /data-msg-export/.test(html));
check("导出钮用 export 图标（D-3.3，非 download）", /iconEl\('export'\)/.test(html) && !/iconEl\('download', 16, 'popmenu__i'\)/.test(html));
check("流式中不渲染导出（只留复制）", /canExport = hasAns && turn\.status !== 'streaming'/.test(html));

/* ---- 导出 popover（单例，锚定触发钮） ---- */
check("popover 单例 #exportPop", /pop\.id = 'exportPop'/.test(html));
check("popover 有 Word 文档项", /buildPopFormatItem\('docx', 'Word 文档'/.test(html));
check("popover 有 Markdown 笔记项", /buildPopFormatItem\('md', 'Markdown 笔记'/.test(html));
check("popover 有自定义整理要求入口", /data-adv-confirm/.test(html) && /自定义整理要求…/.test(html));
check("自定义输入 2000 字上限", /input\.maxLength = 2000/.test(html));
check("popover 键盘可用（↑↓/Esc/Enter）", /movePopoverFocus\(1\)/.test(html) && /closeExportPopover\(true\)/.test(html) && /confirmCustomExport\(\)/.test(html));

/* ---- 真调用宿主：参数形态与旧面板一致（sessionId / intent / format） ---- */
check("调用 generateOutcome（新参数形态）", /host\.generateOutcome\(\{ sessionId: store\.session\.sessionId, intent: text, format: fmt \}\)/.test(html));
check("默认 intent：最后一条（docx）", /把刚才这轮回答整理成一份结构化的文档/.test(html));
check("默认 intent：最后一条（md）", /把刚才这轮回答整理成一份 Markdown 笔记/.test(html));
check("默认 intent：旧回答点名该轮提问（截断 60 字）", /把关于「\$\{q\}」的这轮回答整理成一份结构化的文档/.test(html) && /firstUserQuestion\(turn\)\.slice\(0, 60\)/.test(html));

/* ---- 后台导出（用户 2026-10-20）：过程不进会话流 ---- */
check("状态挂在 turn.pendingOutcome 上（防重复点 / 重绘不丢）", /turn\.pendingOutcome = \{ format: fmt, intent: text, phase: 'generating'/.test(html));
check("失败走 toast，不在会话流插错误卡", /文档生成失败：/.test(html) && !/gencard--error'/.test(html) && !/class', 'gencard gencard--error/.test(html) && !/gencard gencard--error/.test(html));
check("占位卡/错误卡不渲染（buildGenCard 恒 null）", /function buildGenCard\(\) \{\s*return null;/.test(html));
check("「取消 / 重试」按钮已随占位卡一并移除", !/data-gen-retry/.test(html) && !/data-gen-cancel/.test(html));
check("OUTCOME 到达清 pending 状态", /t\.pendingOutcome = null;[\s\S]{0,60}break;/.test(html));
check("导出钮在生成中转 loading（唯一过程反馈）", /exp\.setAttribute\('aria-busy', 'true'\)/.test(html));

/* ---- 旧链路彻底删除（不留死引用） ---- */
check("旧产出面板 DOM 已删除", !/id="outcomeComposer"/.test(html));
check("旧产出面板 CSS 已删除", !/\.outcomeComposer/.test(html));
check("旧四个 composer 函数已删除", !/openOutcomeComposer|closeOutcomeComposer|generateOutcomeFromComposer|updateOutcomeComposerState/.test(html));
check("旧格式二选一绑定已删除", !/data-outcome-format/.test(html));

console.log(`qa:outcome-entry: ${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
