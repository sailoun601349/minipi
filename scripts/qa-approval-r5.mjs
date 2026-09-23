/**
 * M4 审批闸门 —— 独立 QA 复验（R5 组 C：会话级 always-allow + 沙箱优先）
 * ============================================================================
 * 秦戈 · 第三层「证伪」。核心是两条**安全红线**：
 *   🔴 #9 沙箱优先于 always-allow —— 即便用户开了「本会话总是允许 write」，
 *        沙箱违例（写 outbox 之外）**必须仍被拦**，绝不能因 always-allow 放行。
 *   🔴 #12 remember 透传 —— 已读码确认 index.js:428 透传；此处补行为验证「模型
 *        输入无法打开 always-allow」（decide 只由 IPC 调；request 无 remember 参数）。
 *
 * 覆盖：
 *   C1 默认关：未 remember 时 isAlwaysAllowed=false
 *   C2 remember:true + allowOnce ⇒ 该工具在本会话内后续 request 直接放行（不再推卡）
 *   C3 作用域：只对**该会话**；换会话（新 sessionId）不放行
 *   C4 作用域：只对**该工具**；同会话其他审批工具仍弹卡
 *   C5 仅内存：不落盘（approvals.json 不含 always-allow 记录）
 *   C6 退出即失：新建 gate 实例（模拟重启）后 isAlwaysAllowed=false
 *   C7 cancelBySession 清记忆：清后同会话同工具重新弹卡
 *   C8 审计：开启当刻落 always_allow_enabled 事件
 *   C9 混合工具批不开启（alwaysAllowEligible=false ⇒ 不写记忆）
 *   C10 remember 仅对 allowOnce 生效：deny/terminate + remember 不开启
 *   🔴 C11 沙箱优先：always-allow 开启后，sandbox 违例仍 block（端到端 registerGate 形状）
 *   🔴 C12 request() 无 remember 入口：模型无法经 request 打开 always-allow
 *
 * 用法：node scripts/qa-approval-semantics.mjs 之外单独跑本文件，退出码 0 = 全通过。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApprovalGate, cardMeta, redactCommandForAudit } from "../src/main/pi/approval.js";
import { checkWriteTarget } from "../src/main/pi/sandbox.js";
import { OUTBOX_SCENES } from "../src/shared/protocol.js";

let pass = 0;
let fail = 0;
const failures = [];

/** @param {boolean} cond */
function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label + (detail ? ` :: ${detail}` : ""));
    console.log(`  FAIL  ${label}${detail ? `\n        ↳ ${detail}` : ""}`);
  }
}

console.log("=".repeat(72));
console.log(" M4 审批闸门 QA 复验 · R5 always-allow + 沙箱优先（C，含安全红线 #9/#12）");
console.log(` Node ${process.version} · platform ${process.platform}`);
console.log("=".repeat(72));

/* ---------------------------------------------------------------- 夹具 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-appr-r5-"));
const home = path.join(tmp, "home");
const appDir = path.join(home, ".minipi");
fs.mkdirSync(appDir, { recursive: true });
const cwd = path.join(home, ".minipi", "repo");
fs.mkdirSync(cwd, { recursive: true });

// 沙箱用的 outbox 目录（模拟真实 outbox）
const outboxDir = path.join(appDir, "outbox");
fs.mkdirSync(outboxDir, { recursive: true });

/** 假时钟（见 semantics 脚本说明）。 */
function fakeClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let id = 1;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms = 0) => {
    const t = { at: now + Number(ms || 0), fn, id: id++ };
    timers.set(t.id, t);
    return t;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object" && timers.has(handle.id)) timers.delete(handle.id);
  };
  return {
    liveTimers: () => timers.size,
    advance(ms) {
      now += ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
        if (due.length === 0 || guard++ > 1000) break;
        for (const t of due) {
          timers.delete(t.id);
          try {
            t.fn();
          } catch {
            /* ignore */
          }
        }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** @returns {{gate:ApprovalGate, pushed:object[], audited:object[]}} */
function makeGate(opts = {}) {
  const pushed = [];
  const audited = [];
  const gate = new ApprovalGate({
    bridge: {
      pushCard: (card) => pushed.push(card),
      audit: (entry) => audited.push(entry),
    },
    logger: { info() {}, warn() {}, error() {} },
    home,
    appDir,
    exists: opts.exists,
    timeoutMs: opts.timeoutMs,
    batchMax: opts.batchMax,
  });
  return { gate, pushed, audited };
}

/* ================================================================= C1 */
console.log("\n[C1] 默认关：未 remember 时 isAlwaysAllowed=false");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sC1", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  ok(gate.isAlwaysAllowed("sC1", "write") === false, "[C1] 建卡后默认未开启 always-allow");
  gate.decide({ approvalId: "a_1", action: "allowOnce" }); // 无 remember
  await p;
  ok(gate.isAlwaysAllowed("sC1", "write") === false, "[C1] allowOnce（无 remember）后仍为 false —— remember 是开启的唯一钥匙");
  clock.restore();
}

/* ================================================================= C2 */
console.log("\n[C2] remember:true + allowOnce ⇒ 本会话该工具后续直接放行（不再推卡）");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const p = gate.request({ sessionId: "sC2", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  ok(gate.isAlwaysAllowed("sC2", "write") === true, "[C2] remember:true ⇒ isAlwaysAllowed=true");

  const before = pushed.length;
  const p2 = gate.request({ sessionId: "sC2", sceneId: "repo", toolName: "write", input: { path: "b.txt", content: "y" }, cwd });
  const r2 = await p2;
  ok(r2.action === "allowOnce", "[C2] 第二次同工具 request 直接 resolve allowOnce（免审批）", r2.action);
  ok(pushed.length === before, "[C2] 第二次未推任何卡（pushed 数不变）", `before=${before} after=${pushed.length}`);
  ok(gate.pendingCount === 0, "[C2] 直接放行后无 pending 残留", String(gate.pendingCount));
  clock.restore();
}

/* ================================================================= C3 */
console.log("\n[C3] 作用域 · 会话隔离：只对该会话放行");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const p = gate.request({ sessionId: "sC3a", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  ok(gate.isAlwaysAllowed("sC3a", "write") === true, "[C3] 会话 A 已开启");

  const before = pushed.length;
  const pB = gate.request({ sessionId: "sC3b", sceneId: "repo", toolName: "write", input: { path: "c.txt", content: "z" }, cwd });
  ok(gate.pendingCount === 1, "[C3] 换会话 B 同工具 ⇒ 仍建 pending（未放行）", String(gate.pendingCount));
  ok(pushed.length === before + 1 && pushed[pushed.length - 1].phase === "push", "[C3] 会话 B 推了新卡");
  gate.cancelBySession("sC3b");
  await pB;
  clock.restore();
}

/* ================================================================= C4 */
console.log("\n[C4] 作用域 · 工具隔离：只对该工具放行");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const p = gate.request({ sessionId: "sC4", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  ok(gate.isAlwaysAllowed("sC4", "write") === true, "[C4] write 已开启");
  ok(gate.isAlwaysAllowed("sC4", "bash") === false, "[C4] 同会话 bash 仍未开启");

  const before = pushed.length;
  const pBash = gate.request({ sessionId: "sC4", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  ok(gate.pendingCount === 1, "[C4] 同会话 bash ⇒ 仍弹卡（工具隔离）", String(gate.pendingCount));
  ok(pushed.length === before + 1, "[C4] bash 推了新卡");
  gate.cancelBySession("sC4");
  await pBash;
  clock.restore();
}

/* ================================================================= C5 */
console.log("\n[C5] 仅内存：always-allow 不落盘");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sC5", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  // 推进假时钟越过 200ms 去抖 ⇒ 触发 _flush() 落盘
  clock.advance(500);

  const file = path.join(appDir, "approvals.json");
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  ok(raw.length > 0, "[C5] approvals.json 已生成（去抖 flush 生效）", `len=${raw.length}`);
  ok(!/alwaysAllow|always_allow|remember/i.test(raw), "[C5] 落盘文件不含 any always-allow / remember 痕迹", raw.slice(0, 200));
  clock.restore();
}

/* ================================================================= C6 */
console.log("\n[C6] 退出即失：重启（新实例）后记忆清空");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sC6", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  ok(gate.isAlwaysAllowed("sC6", "write") === true, "[C6] 实例 1 已开启");

  // 模拟重启：新 ApprovalGate 实例（同 appDir），内存态归零
  const { gate: gate2 } = makeGate();
  ok(gate2.isAlwaysAllowed("sC6", "write") === false, "[C6] 新实例（重启）后 isAlwaysAllowed=false —— 仅内存、不持久化");

  // 且新实例里同会话同工具会重新弹卡
  const p2 = gate2.request({ sessionId: "sC6", sceneId: "repo", toolName: "write", input: { path: "b.txt", content: "y" }, cwd });
  ok(gate2.pendingCount === 1, "[C6] 重启后同工具重新弹卡（记忆未跨实例）", String(gate2.pendingCount));
  gate2.cancelBySession("sC6");
  await p2;
  clock.restore();
}

/* ================================================================= C7 */
console.log("\n[C7] cancelBySession 清记忆：清后同会话同工具重新弹卡");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const p = gate.request({ sessionId: "sC7", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  ok(gate.isAlwaysAllowed("sC7", "write") === true, "[C7] 开启后为 true");
  gate.cancelBySession("sC7"); // 会话销毁（即便无未决卡，也应清记忆）
  ok(gate.isAlwaysAllowed("sC7", "write") === false, "[C7] cancelBySession 后记忆被清（即便无 pending）");

  const before = pushed.length;
  const p2 = gate.request({ sessionId: "sC7", sceneId: "repo", toolName: "write", input: { path: "c.txt", content: "z" }, cwd });
  ok(gate.pendingCount === 1, "[C7] 清记忆后同工具重新弹卡", String(gate.pendingCount));
  ok(pushed.length === before + 1, "[C7] 重新推卡（phase=push）", pushed[pushed.length - 1]?.phase);
  gate.cancelBySession("sC7");
  await p2;
  clock.restore();
}

/* ================================================================= C8 */
console.log("\n[C8] 审计：开启当刻落 always_allow_enabled 事件（脱敏、无参数内容）");

{
  const clock = fakeClock();
  const { gate, audited } = makeGate();
  const p = gate.request({ sessionId: "sC8", sceneId: "repo", toolName: "bash", input: { command: "SECRET_TOKEN=abc curl -H 'Authorization: Bearer xyz' http://h" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p;
  const ev = audited.find((a) => a.event === "always_allow_enabled");
  ok(!!ev, "[C8] 审计含 always_allow_enabled 事件", JSON.stringify(audited.map((a) => a.event)));
  ok(ev && ev.toolName === "bash", "[C8] 事件 toolName=bash", String(ev?.toolName));
  // R5 审计事件本身不含命令内容（只记 kind/toolName/summary 文案）——这是 R5 事件的质量点。
  ok(ev && !/curl|http:\/\/h/.test(String(ev.summary ?? "")), "[C8] always_allow_enabled 事件不含命令原文（只记工具名与固定文案）", String(ev?.summary));
  clock.restore();
}

/* ================================================================= C9 */
console.log("\n[C9] 混合工具批不开启（alwaysAllowEligible=false ⇒ 不写记忆）");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  // 同会话混合：write + bash ⇒ 一张卡、kind 混合 ⇒ alwaysAllowEligible=false
  const p1 = gate.request({ sessionId: "sC9", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  const p2 = gate.request({ sessionId: "sC9", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const meta = cardMeta(gate.peek("a_1"));
  ok(meta.alwaysAllowEligible === false, "[C9] 混合批 alwaysAllowEligible=false", JSON.stringify(meta));
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await Promise.all([p1, p2]);
  ok(gate.isAlwaysAllowed("sC9", "write") === false, "[C9] 混合批 remember 不写 write 记忆");
  ok(gate.isAlwaysAllowed("sC9", "bash") === false, "[C9] 混合批 remember 不写 bash 记忆");
  clock.restore();
}

/* ================================================================= C10 */
console.log("\n[C10] remember 仅对 allowOnce 生效：deny / terminate + remember 不开启");

{
  for (const action of ["deny", "terminate"]) {
    const clock = fakeClock();
    const { gate } = makeGate();
    const p = gate.request({ sessionId: `sC10_${action}`, sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
    gate.decide({ approvalId: "a_1", action, remember: true });
    await p;
    ok(gate.isAlwaysAllowed(`sC10_${action}`, "write") === false, `[C10] ${action} + remember:true ⇒ 不开启 always-allow（仅 allowOnce 有效）`);
    clock.restore();
  }
}

/* ================================================================= C11 🔴 沙箱优先 */
console.log("\n[C11] 🔴 安全红线 #9：沙箱优先于 always-allow（端到端 registerGate 形状）");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();

  // 先开 always-allow：本会话总是允许 write
  const pOpen = gate.request({ sessionId: "sC11", sceneId: "repo", toolName: "write", input: { path: "ok.txt", content: "x" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await pOpen;
  ok(gate.isAlwaysAllowed("sC11", "write") === true, "[C11] 前置：本会话已总是允许 write");

  // 还原 session.js 规则 1 + 规则 2 的**顺序**（沙箱在前，审批在后），并以 outbox 场景验证：
  // 规则 1 命中 ⇒ 直接 block{ sandbox reason }，**根本不调用 approval.request**
  // 规则 2（outbox 场景）⇒ return undefined，根本不进审批
  const sandboxed = OUTBOX_SCENES.includes("note"); // note 是 outbox 场景
  ok(sandboxed === true, "[C11] note 属 OUTBOX_SCENES（受沙箱约束）");

  // 构造一个越界的写：目标在 outbox 之外（cwd 之外）
  const escapeInput = { path: path.join(home, "outside.txt"), content: "pwned" };
  const verdict = checkWriteTarget({
    toolName: "write",
    input: escapeInput,
    cwd: outboxDir, // note 场景 cwd 落在 outbox
    outboxDir,
    sceneId: "note",
  });
  ok(verdict.blocked === true, "[C11] 沙箱对越界写判定 blocked=true", JSON.stringify(verdict));

  // 模拟 registerGate：规则 1 命中 ⇒ return {block, reason}，**审批 request 不被调用**
  let approvalCalled = false;
  const registerGateSim = async (sceneId, toolName, input) => {
    // 规则 1
    if (OUTBOX_SCENES.includes(sceneId)) {
      const v = checkWriteTarget({ toolName, input, cwd: outboxDir, outboxDir, sceneId });
      if (v.blocked) return { block: true, reason: v.reason };
    }
    // 规则 2
    if (OUTBOX_SCENES.includes(sceneId)) return undefined;
    if (!["write", "edit", "bash", "powershell"].includes(toolName)) return undefined;
    approvalCalled = true;
    const d = await gate.request({ sessionId: "sC11", sceneId, toolName, input, cwd: outboxDir });
    if (!d || d.action === "allowOnce") return undefined;
    return d.action === "terminate" ? { block: true, reason: d.reason, terminate: true } : { block: true, reason: d.reason };
  };

  const before = pushed.length;
  const gateResult = await registerGateSim("note", "write", escapeInput);
  ok(gateResult && gateResult.block === true, "[C11] 🔴 越界写被 block（即便 always-allow 已开）", JSON.stringify(gateResult));
  ok(approvalCalled === false, "[C11] 🔴 沙箱违例**根本没有进审批**（approval.request 未被调用）");
  ok(pushed.length === before, "[C11] 🔴 沙箱违例未推任何审批卡（不给用户『允许』的机会）", `pushed ${before}→${pushed.length}`);
  ok(gate.pendingCount === 0, "[C11] 🔴 沙箱违例后无 pending 残留", String(gate.pendingCount));

  // 对照：outbox 场景内**合法**写 ⇒ 沙箱通过 + 不进审批（放行）
  const okInput = { path: path.join(outboxDir, "legit.md"), content: "hi" };
  const okVerdict = checkWriteTarget({ toolName: "write", input: okInput, cwd: outboxDir, outboxDir, sceneId: "note" });
  ok(okVerdict.blocked === false, "[C11] 对照：outbox 内合法写沙箱放行", JSON.stringify(okVerdict));
  const okResult = await registerGateSim("note", "write", okInput);
  ok(okResult === undefined, "[C11] 对照：outbox 内合法写不进审批、直接放行");
  clock.restore();
}

/* ================================================================= C12 🔴 remember 入口 */
console.log("\n[C12] 🔴 安全红线 #12：模型输入无路径可打开 always-allow");

{
  const clock = fakeClock();
  const { gate } = makeGate();

  // (a) request() 签名不含 remember —— 即便调用方硬塞 remember，request 也不读它
  //     模型能控制的只有 tool_call 的 input；input 里塞 remember 不影响审批记忆
  const p = gate.request({
    sessionId: "sC12",
    sceneId: "repo",
    toolName: "write",
    input: { path: "a.txt", content: "x", remember: true, _remember: true, alwaysAllow: true }, // 模型在 input 里伪造
    cwd,
  });
  ok(gate.isAlwaysAllowed("sC12", "write") === false, "[C12] 🔴 input 里伪造 remember/alwaysAllow ⇒ **不**开记忆（request 不读 input 里的标记）");
  gate.decide({ approvalId: "a_1", action: "allowOnce" }); // 无 remember
  await p;
  ok(gate.isAlwaysAllowed("sC12", "write") === false, "[C12] 🔴 模型侧无路径可开 always-allow（只有 IPC 的 decide 能）");

  // (b) 读码交叉验证：index.js 的 APPROVAL_DECIDE handler 必须透传 remember
  //     此处用静态读取确认（行为层已由 C2/C7 覆盖）
  const idx = fs.readFileSync(path.join(process.cwd(), "src/main/index.js"), "utf8");
  ok(/remember:\s*arg\.remember/.test(idx), "[C12] 读码：main/index.js 的 APPROVAL_DECIDE handler 透传 remember: arg.remember", idx.match(/APPROVAL_DECIDE[\s\S]{0,220}/)?.[0]?.slice(0, 200));
  clock.restore();
}

/* ================================================================= C13 ⚠ 发现 */
console.log("\n[C13] ⚠ 审计密钥脱敏覆盖度（设计 §7.2/§7.3 的 KEY=value 形态）—— 记录型");
{
  // 本块为「发现记录」，不改变脚本退出码；根因见报告 P2-1。
  const covered = [
    ["token=abc cmd", true],
    ["API_KEY=sk-1 cmd", true],
    ["secret=hunter2 node x", true],
    ["password=pw ssh x", true],
    ["--token=ghp_x npm x", true],
    ["curl -H \"Authorization: Bearer xyz\" h", true],
    ["export API_KEY=sk-1 && node x", true],
  ];
  const leaked = [
    "SECRET_TOKEN=abc curl x",
    "GITHUB_TOKEN=ghp_x npm x",
    "MY_TOKEN=abc cmd",
    "DB_PASSWORD=p@ss cmd",
    "AWS_SECRET_ACCESS_KEY=AKIAxxx aws s3 ls",
    "pg_password=pw1 psql x",
  ];
  let covOk = 0;
  for (const [c, expect] of covered) {
    const red = redactCommandForAudit(c, "C:/h");
    const isRedacted = /<redacted>/.test(red);
    if (isRedacted === expect) covOk += 1;
  }
  console.log(`  · 已覆盖（单关键字独立形态）：${covOk}/${covered.length} 通过脱敏`);
  const leakedList = leaked.filter((c) => !/<redacted>/.test(redactCommandForAudit(c, "C:/h")));
  console.log(`  · ⚠ 遗漏（关键字作长标识符后缀、以 _ 连接）：${leakedList.length}/${leaked.length} 泄漏明文`);
  for (const c of leakedList) console.log(`      LEAK  ${JSON.stringify(c)} → ${JSON.stringify(redactCommandForAudit(c, "C:/h"))}`);
  // 只断言「设计自己给的例子被覆盖」，不因遗漏项 fail（遗漏项进报告 P2-1）
  ok(covOk === covered.length, "[C13] 设计 §7.3 明列的例子（Authorization: Bearer / export KEY=）均被脱敏", `covOk=${covOk}/${covered.length}`);

  // 端到端：确认遗漏是否已修复（此断言**原为 P2-1 取证**，曾断言「明文 ghp_REALSECRET123 落进审计」；
  // 白客修复后输出为 <redacted>，故**反向**：现在必须断言明文不再落盘、且出现 <redacted>）。
  const clock = fakeClock();
  const { gate, audited } = makeGate();
  const p = gate.request({ sessionId: "sC13", sceneId: "repo", toolName: "bash", input: { command: "GITHUB_TOKEN=ghp_REALSECRET123 npm publish" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  await p;
  const auditJson = JSON.stringify(audited);
  ok(
    !auditJson.includes("ghp_REALSECRET123"),
    "[C13] GITHUB_TOKEN=... 明文 token 已不再落进审计条目（P2-1 已修复）",
    audited.map((a) => `${a.event}: ${a.summary}`).join(" | "),
  );
  ok(
    auditJson.includes("<redacted>"),
    "[C13] 审计条目已含 <redacted> 占位（脱敏生效）",
    audited.map((a) => `${a.event}: ${a.summary}`).join(" | "),
  );
  clock.restore();
}

/* ---------------------------------------------------------------- 收尾 */
console.log("\n" + "=".repeat(72));
console.log(` 结果：PASS ${pass} · FAIL ${fail}`);
if (fail > 0) {
  console.log(" 失败项：");
  for (const f of failures) console.log("   ✗ " + f);
}
console.log("=".repeat(72));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(fail === 0 ? 0 : 1);
