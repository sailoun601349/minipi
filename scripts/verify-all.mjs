#!/usr/bin/env node
/**
 * `verify:all` —— 一键串行回归入口（M4.6 收尾）。
 *
 * 为什么用编排脚本而不是 `&&` 链：
 *   ① 串行保证 headless Chrome 脚本（qa-approval-ui / qa-renderer-edge）不并行 ——
 *      二者并行会 SIGTERM（本机 Chrome 只能串起一个）；
 *   ② 每个脚本独立打印 PASS/FAIL 摘要，最后给出聚合 EXIT 码与「失败清单」；
 *   ③ 列表显式、可读、可审计 —— 谁进了回归门、谁没进，一目了然（防脚本族漂移）。
 *
 * ⚠ 纳入原则（team-lead 裁定）：
 *   · **纯 Node、无外部依赖**的回归/QA 脚本 —— 全部纳入；
 *   · **真 Pi 会话 / 真模型**（verify-sandbox-live、verify-stream）—— 排除，另走 `verify:live`；
 *   · **qa-approval-r5** —— 已纳入（C13 证据断言已反向，2026-09-23）。
 *
 * 运行：`npm run verify:all`（退出码 0 = 全绿；非 0 = 有脚本失败，看末尾失败清单）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 回归门清单（顺序即执行顺序；headless Chrome 的放最后，避免拖慢早期快脚本的可读性）。
 *
 * ⚠ `verify:theme-live`（真机主题链路 + 版本真实性）**刻意不在本套件里**：
 *   它单独跑稳定 22/22，但作为套件里第 3 个 Electron 进程时出现 EXIT=1 且无输出
 *   （已排除「前一个是 selftest / launch-live」两种组合，未能稳定复现）。
 *   按"不稳定的门禁比没有门禁更糟"的原则摘出来，单独 `npm run verify:theme-live`。
 *   TODO(下一步)：给本脚本加 `--only` 过滤，再二分定位它与哪个脚本相冲。
 *
 * `via` 用于「不能直接用 node 跑」的脚本：不给就默认 `node <file>`；
 * 给了就用这段参数替代（宿主层自测必须在 Electron 里跑，`node` 直接跑会拿不到 BrowserWindow）。
 * @type {Array<{name:string, file:string, note?:string, via?:string[]}>}
 */
const SUITE = [
  { name: "verify:approval",        file: "verify-approval.mjs",        note: "M4 审批（195 项）" },
  { name: "verify:sandbox",         file: "verify-sandbox.mjs",         note: "沙箱（65 项）" },
  { name: "verify:v04",             file: "verify-v04.mjs",             note: "v0.4 总检（39 项）" },
  { name: "verify:outcome",         file: "verify-outcome.mjs",         note: "M5 产出（97 项）" },
  { name: "verify:launcher",        file: "verify-launcher.mjs",        note: "双击启动器（静态）" },
  { name: "verify:launch-live",     file: "verify-launch-live.mjs",     note: "双击启动器（真启动 + 存活）" },
  /* 文件日志（main.log）：打包后没有启动器、GUI 没有控制台，日志只能自己落盘。
     这条守护「日志写不进去也不能拦住启动」+ 轮转 + 级别/时间戳格式。 */
  { name: "verify:logger",          file: "verify-logger.mjs",          note: "主进程文件日志（落盘 / 轮转 / 绝不抛错）" },
  // 宿主层自测：必须在 Electron 里跑（要用真的 BrowserWindow 量 rAF 节流），所以走 start.mjs
  { name: "selftest:host",          file: "selftest/main.mjs",          note: "宿主层自测 T0–T4（真窗口）", via: ["start.mjs", "--selftest"] },
  { name: "qa:outcome-entry",       file: "qa-outcome-entry.mjs",       note: "真实产出入口" },
  { name: "verify:models",           file: "verify-models.mjs",           note: "模型配置与凭证存储" },
  { name: "verify:thought",         file: "verify-thought-markup.mjs",  note: "工具标记识别 + 镜像漂移" },
  { name: "verify:providers",       file: "verify-providers.mjs",       note: "提供方定义 / 注入 / 拉模型" },
  { name: "verify:web",             file: "verify-web-deepseek.mjs",    note: "联网能力（DeepSeek 搜索/抓取）" },
  { name: "verify:scene",           file: "check-scene-consistency.mjs", note: "场景一致性（48 项）" },
  { name: "qa:sandbox-attack",      file: "qa-sandbox-attack.mjs",      note: "沙箱攻击（66 项）" },
  { name: "qa:approval-contract",   file: "qa-approval-contract.mjs",   note: "M4 QA · 契约" },
  { name: "qa:approval-semantics",  file: "qa-approval-semantics.mjs",  note: "M4 QA · 语义" },
  { name: "qa:approval-r5",         file: "qa-approval-r5.mjs",         note: "M4 QA · R5 always-allow/C13 脱敏" },
  { name: "qa:outcome-adversarial", file: "qa-outcome-adversarial.mjs", note: "产出链路对抗（纯 Node）" },
  { name: "qa:outcome-bypass", file: "qa-outcome-bypass.mjs", note: "导出零事件旁路（completeSimple）" },
  { name: "verify:outcome-index",  file: "verify-outcome-index.mjs",  note: "产出索引 / 对账 / 回收站（D-14）" },
  { name: "verify:sessions",       file: "verify-sessions.mjs",       note: "会话索引 / 对账 / 回收站（D-09）" },
  { name: "qa:session-list",        file: "qa-session-list.mjs",        note: "会话列表 / 搜索 / 恢复（headless）" },
  { name: "qa:resume-state",        file: "qa-resume-state.mjs",        note: "恢复后状态：清场 / 场景 / 说明行 / 失败不改半截 / 流式中拒绝切换" },
  { name: "qa:contract-drift",      file: "qa-contract-drift.mjs",      note: "契约漂移（31 项）" },
  { name: "qa:renderer-edge",       file: "qa-renderer-edge.mjs",       note: "渲染边界（headless Chrome）" },
  { name: "qa:mini-continuity",     file: "qa-mini-continuity.mjs",     note: "小窗连续流 + 工具卡（headless Chrome）" },
  { name: "qa:model-panel",         file: "qa-model-panel.mjs",         note: "模型设置面板（headless Chrome）" },
  { name: "qa:business-loop",       file: "qa-business-loop.mjs",       note: "基础闭环：两态提问 → 回答 → 导出 md/docx" },
  { name: "qa:controls",            file: "qa-controls.mjs",            note: "无死入口：每个入口点下去必须有可见结果" },
  { name: "qa:theme",               file: "qa-theme.mjs",               note: "双主题：令牌 / 切换 / 对比度" },
  { name: "qa:ball-menu",           file: "qa-ball-menu.mjs",           note: "球右键菜单 + 浅/深外观（headless Chrome）" },
  { name: "qa:approval-ui",         file: "qa-approval-ui.mjs",         note: "审批卡 UI（headless Chrome）" },
  { name: "qa:prototype-v06",       file: "qa-prototype-v06.mjs",       note: "v0.6 原型交互（headless Chrome）" },
  { name: "qa:future-ui",           file: "qa-future-ui.mjs",           note: "未来感视觉硬约束（冷调仪器面板，58 项）" },
];

/** 待纳入（当前不跑，条件满足后移入 SUITE）。当前为空。 */
const PENDING = [];

console.log("=".repeat(72));
console.log(`verify:all —— 串行回归 ${SUITE.length} 个脚本（纯 Node / headless Chrome / 真 Electron 窗口，不含真 Pi 会话）`);
console.log("=".repeat(72));

const failed = [];
const startedAt = Date.now();

for (const [i, s] of SUITE.entries()) {
  const abs = path.join(__dirname, s.file);
  const args = s.via ? s.via.map((a) => (a.endsWith(".mjs") ? path.join(__dirname, a) : a)) : [abs];
  console.log(`\n▶ [${String(i + 1).padStart(2)}/${SUITE.length}] ${s.name}  ${s.note ? `（${s.note}）` : ""}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
  if (r.status === 0) {
    console.log(`  ✔ ${s.name} EXIT=0`);
  } else {
    const code = r.signal ? `SIG${r.signal}` : `EXIT=${r.status}`;
    console.log(`  ✘ ${s.name} ${code}`);
    failed.push(`${s.name}（${code}）`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log("\n" + "=".repeat(72));
if (failed.length === 0) {
  console.log(` 全部通过：${SUITE.length} 个脚本全绿（耗时 ${elapsed}s）`);
} else {
  console.log(` 失败 ${failed.length} 个：`);
  for (const f of failed) console.log(`   ✘ ${f}`);
}
if (PENDING.length) {
  console.log(`\n 待纳入（当前不跑）：`);
  for (const p of PENDING) console.log(`   · ${p.name} —— ${p.reason}`);
}
console.log("=".repeat(72));

process.exit(failed.length === 0 ? 0 : 1);
