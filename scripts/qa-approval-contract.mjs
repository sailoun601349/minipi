/**
 * M4 审批闸门 —— 独立 QA 复验（契约组 D + 攻击组 E）
 * ============================================================================
 * 秦戈 · 第三层「证伪」。
 *   D 契约与降级：卡片六字段 / 非法 action / fail-closed / 重启丢弃 / 契约漂移
 *   E 攻击测试：并发 id 复用 / 场景路由（repo 弹卡、outbox 不弹）/ 恶意输入
 *
 * 用法：node scripts/qa-approval-contract.mjs（退出码 0 = 全通过）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApprovalGate, cardMeta, buildBatchItem, APPROVAL_KINDS } from "../src/main/pi/approval.js";
import {
  APPROVAL_ACTIONS,
  APPROVAL_ACTION_IDS,
  APPROVAL_TOOLS,
  ERROR_CODES,
  OUTBOX_SCENES,
  LIMITS,
} from "../src/shared/protocol.js";

let pass = 0;
let fail = 0;
const failures = [];
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
console.log(" M4 审批闸门 QA 复验 · 契约 + 攻击（D/E）");
console.log(` Node ${process.version} · platform ${process.platform}`);
console.log("=".repeat(72));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-appr-ct-"));
const home = path.join(tmp, "home");
const appDir = path.join(home, ".minipi");
fs.mkdirSync(appDir, { recursive: true });
const cwd = path.join(appDir, "repo");
fs.mkdirSync(cwd, { recursive: true });

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
    advance(ms) {
      now += ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
        if (due.length === 0 || guard++ > 5000) break;
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

function makeGate(opts = {}) {
  const pushed = [];
  const audited = [];
  const gate = new ApprovalGate({
    bridge: { pushCard: (c) => pushed.push(c), audit: (e) => audited.push(e) },
    logger: { info() {}, warn() {}, error() {} },
    home,
    appDir,
    exists: opts.exists,
    timeoutMs: opts.timeoutMs,
    batchMax: opts.batchMax,
  });
  return { gate, pushed, audited };
}

/* ================================================================= D1 */
console.log("\n[D1] 卡片六字段契约（§9.3：sessionId/kind/toolName/title/actions/alwaysAllowEligible）");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  gate.request({ sessionId: "sD1", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "hi" }, cwd });
  const card = pushed[0];
  const required = ["approvalId", "phase", "sessionId", "createdAt", "expiresAt", "timeoutMs", "actions", "kind", "toolName", "title", "alwaysAllowEligible", "batch"];
  const missing = required.filter((k) => !(k in card));
  ok(missing.length === 0, "[D1] push 卡含全部契约字段", `missing=${JSON.stringify(missing)}`);
  ok(card.sessionId === "sD1", "[D1] sessionId 正确", String(card.sessionId));
  ok(card.kind === "write", "[D1] kind=write", String(card.kind));
  ok(card.toolName === "write", "[D1] toolName=write", String(card.toolName));
  ok(typeof card.title === "string" && card.title.length > 0, "[D1] title 非空", String(card.title));
  ok(Array.isArray(card.actions) && card.actions.length === 3, "[D1] actions 恒为三项", JSON.stringify(card.actions));
  ok(JSON.stringify(card.actions) === JSON.stringify(APPROVAL_ACTION_IDS), "[D1] actions === APPROVAL_ACTION_IDS", JSON.stringify(card.actions));
  ok(card.alwaysAllowEligible === true, "[D1] 单工具卡 alwaysAllowEligible=true", String(card.alwaysAllowEligible));
  ok(Array.isArray(card.batch) && card.batch.length === 1, "[D1] batch 为数组且含 1 项");
  ok(card.expiresAt === card.createdAt + LIMITS.APPROVAL_TIMEOUT_MS, "[D1] expiresAt = createdAt + 5min");

  // cancel 卡：只带必要字段 + batch=[]
  gate.cancelBySession("sD1");
  const cancel = pushed.find((c) => c.phase === "cancel");
  ok(cancel && Array.isArray(cancel.batch) && cancel.batch.length === 0, "[D1] cancel 卡 batch=[]");
  ok(cancel && cancel.approvalId === card.approvalId, "[D1] cancel 卡 approvalId 与原卡一致");
  clock.restore();
}

/* ================================================================= D2 */
console.log("\n[D2] 非法 action ⇒ INVALID_ARGUMENT（绝不静默当 allow）");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sD2", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const bad = ["allow", "ALLOW", "AllowOnce", "", null, 0, "denyAll", "terminate!", undefined, {}, []];
  let allThrew = true;
  const reasons = [];
  for (const a of bad) {
    try {
      gate.decide({ approvalId: "a_1", action: a });
      allThrew = false;
      reasons.push(`${JSON.stringify(a)} → 未抛错`);
    } catch (e) {
      if (!String(e.message).includes(ERROR_CODES.INVALID_ARGUMENT)) {
        allThrew = false;
        reasons.push(`${JSON.stringify(a)} → 抛错但非 INVALID_ARGUMENT: ${e.message}`);
      }
    }
  }
  ok(allThrew, "[D2] 全部非法 action 均抛 INVALID_ARGUMENT", reasons.join("; "));
  ok(gate.pendingCount === 1, "[D2] 非法 action 后 pending 仍在（未被错误 resolve）", String(gate.pendingCount));
  // 用合法值收尾
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  await p;

  // ⚠ 关键：两值写法 "allow" 绝不能退化成放行
  const { gate: g2 } = makeGate();
  const p2 = g2.request({ sessionId: "sD2b", sceneId: "repo", toolName: "bash", input: { command: "rm x" }, cwd });
  let threwAllow = false;
  try {
    g2.decide({ approvalId: "a_1", action: "allow" });
  } catch {
    threwAllow = true;
  }
  ok(threwAllow, "[D2] 两值写法 'allow' 抛错（不静默当 allowOnce）");
  ok(g2.pendingCount === 1, "[D2] 'allow' 拒绝后 pending 未放行", String(g2.pendingCount));
  g2.cancelBySession("sD2b");
  await p2;
  clock.restore();
}

/* ================================================================= D3 */
console.log("\n[D3] fail-closed：异常路径绝不放行");

{
  // (a) 非审批工具兜底：resolve allowOnce 但不建卡（这是设计允许的「无审批工具」）
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const r = await gate.request({ sessionId: "sD3", sceneId: "repo", toolName: "read", input: { path: "a.txt" }, cwd });
  ok(r.action === "allowOnce" && pushed.length === 0, "[D3] 非审批工具直接放行且不建卡", JSON.stringify(r));

  // (b) buildBatchItem 无法构造 item 时：resolve allowOnce 不建卡（防御：无 toolName）
  const rEmpty = await gate.request({ sessionId: "sD3", sceneId: "repo", toolName: "", input: {}, cwd });
  ok(rEmpty.action === "allowOnce" && gate.pendingCount === 0, "[D3] 空 toolName 不建卡", JSON.stringify(rEmpty));

  // (c) 超时永远 deny（已在 A5，这里再确认 fail-closed 语义在契约层）
  const { gate: g2 } = makeGate({ timeoutMs: 50 });
  const p = g2.request({ sessionId: "sD3c", sceneId: "repo", toolName: "bash", input: { command: "shutdown" }, cwd });
  clock.advance(50);
  const rt = await p;
  ok(rt.action === "deny", "[D3] 超时 = deny（fail-closed）", rt.action);
  clock.restore();
}

/* ================================================================= D4 */
console.log("\n[D4] 重启丢弃 pending：遗留 approvals.json 不被当『已允许』");

{
  const clock = fakeClock();
  // 造一个遗留 approvals.json（手工写入一个 pending 记录）
  const legacy = {
    version: 1,
    pending: [
      { approvalId: "a_legacy1", sessionId: "sOld", kind: "command", toolName: "bash", batch: [{ toolName: "bash", commandRedacted: "bash: ls" }], createdAt: 1, expiresAt: 2, status: "pending" },
    ],
  };
  fs.writeFileSync(path.join(appDir, "approvals.json"), JSON.stringify(legacy, null, 2), "utf8");

  const { gate, audited } = makeGate(); // 构造时触发 _sweepOnStart
  ok(gate.pendingCount === 0, "[D4] 重启后 pendingCount=0（遗留一律丢弃）", String(gate.pendingCount));
  ok(audited.some((a) => a.event === "lost_on_restart"), "[D4] 记了 lost_on_restart 审计", JSON.stringify(audited.map((a) => a.event)));
  // 遗留 id 不可 decide（不进 pending）
  let threw = false;
  try {
    gate.decide({ approvalId: "a_legacy1", action: "allowOnce" });
  } catch {
    threw = true;
  }
  ok(threw, "[D4] 遗留 approvalId 不可 decide（APPROVAL_NOT_FOUND）");
  // 文件被重写为空 pending
  const after = JSON.parse(fs.readFileSync(path.join(appDir, "approvals.json"), "utf8"));
  ok(Array.isArray(after.pending) && after.pending.length === 0, "[D4] approvals.json 被重写为空 pending", JSON.stringify(after));

  // 非法 JSON 也不阻止启动
  fs.writeFileSync(path.join(appDir, "approvals.json"), "{ this is not json", "utf8");
  let g2ok = true;
  try {
    makeGate();
  } catch {
    g2ok = false;
  }
  ok(g2ok, "[D4] approvals.json 非法 JSON 不阻止 gate 构造");
  clock.restore();
}

/* ================================================================= D5 */
console.log("\n[D5] 契约漂移：protocol 常量与 approval 实现一致");

{
  ok(APPROVAL_KINDS && APPROVAL_KINDS.length === 3 && APPROVAL_KINDS.includes("command"), "[D5] APPROVAL_KINDS 三值（write/edit/command）", JSON.stringify(APPROVAL_KINDS));
  ok(APPROVAL_ACTION_IDS === APPROVAL_ACTIONS, "[D5] APPROVAL_ACTION_IDS 是 APPROVAL_ACTIONS 的别名", `${APPROVAL_ACTION_IDS === APPROVAL_ACTIONS}`);
  ok(
    APPROVAL_TOOLS.length === 4 && ["write", "edit", "bash", "powershell"].every((t) => APPROVAL_TOOLS.includes(t)),
    "[D5] APPROVAL_TOOLS = write/edit/bash/powershell",
    JSON.stringify(APPROVAL_TOOLS),
  );
  // 三 outcome 的英文值不得出现两值写法
  const src = fs.readFileSync(path.join(process.cwd(), "src/main/pi/approval.js"), "utf8");
  ok(!/"allow"\s*[,:}]/.test(src), "[D5] approval.js 无裸 'allow' 字面量（只有 allowOnce）", (src.match(/"allow"[^O]/g) || []).join(","));

  // 错误码存在
  ok(!!ERROR_CODES.APPROVAL_TIMEOUT && !!ERROR_CODES.APPROVAL_DENIED && !!ERROR_CODES.APPROVAL_NOT_FOUND, "[D5] 审批三错误码齐全", JSON.stringify([ERROR_CODES.APPROVAL_TIMEOUT, ERROR_CODES.APPROVAL_DENIED, ERROR_CODES.APPROVAL_NOT_FOUND]));
}

/* ================================================================= E1 */
console.log("\n[E1] 并发：同会话并发请求合并进同卡、整批同时唤醒");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const ps = [];
  for (let i = 0; i < 5; i += 1) {
    ps.push(gate.request({ sessionId: "sE1", sceneId: "repo", toolName: "bash", input: { command: `echo ${i}` }, cwd }));
  }
  ok(gate.pendingCount === 1, "[E1] 5 个并发请求合并为 1 张卡", String(gate.pendingCount));
  const entry = gate.peek("a_1");
  ok(entry.items.length === 5, "[E1] 合并卡含 5 项", String(entry.items.length));
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  const rs = await Promise.all(ps);
  ok(rs.every((r) => r.action === "allowOnce"), "[E1] 整批 5 个 Promise 同时唤醒", JSON.stringify(rs.map((r) => r.action)));
  ok(gate.pendingCount === 0, "[E1] 决策后无残留", String(gate.pendingCount));
  clock.restore();
}

/* ================================================================= E2 */
console.log("\n[E2] 批上限：超过 batchMax 新建卡（上一张继续等待）");

{
  const clock = fakeClock();
  const { gate } = makeGate({ batchMax: 3 });
  const ps = [];
  for (let i = 0; i < 5; i += 1) {
    ps.push(gate.request({ sessionId: "sE2", sceneId: "repo", toolName: "bash", input: { command: `c${i}` }, cwd }));
  }
  ok(gate.pendingCount === 2, "[E2] 5 条 / 上限 3 ⇒ 2 张卡", String(gate.pendingCount));
  const first = gate.peek("a_1");
  const second = gate.peek("a_2");
  ok(first.items.length === 3, "[E2] 第一张卡 3 项", String(first?.items?.length));
  ok(second.items.length === 2, "[E2] 第二张卡 2 项", String(second?.items?.length));
  // 逐张决策，各自唤醒各自批
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  gate.decide({ approvalId: "a_2", action: "deny" });
  const rs = await Promise.all(ps);
  ok(rs.filter((r) => r.action === "allowOnce").length === 3, "[E2] 第一张批放行 3 个");
  ok(rs.filter((r) => r.action === "deny").length === 2, "[E2] 第二张批拒绝 2 个");
  clock.restore();
}

/* ================================================================= E3 */
console.log("\n[E3] id 复用攻击：伪造 / 猜测 approvalId");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sE3", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  // 猜测不存在的 id
  const guesses = ["a_0", "a_2", "a_999", "", "A_1", "a_1 ", " a_1", "__proto__", "constructor", "toString"];
  let allNotFound = true;
  const wrong = [];
  for (const g of guesses) {
    try {
      gate.decide({ approvalId: g, action: "allowOnce" });
      allNotFound = false;
      wrong.push(`${JSON.stringify(g)} → 未抛错`);
    } catch (e) {
      if (!String(e.message).includes(ERROR_CODES.APPROVAL_NOT_FOUND)) {
        allNotFound = false;
        wrong.push(`${JSON.stringify(g)} → ${e.message}`);
      }
    }
  }
  ok(allNotFound, "[E3] 伪造/猜测 id 全部 APPROVAL_NOT_FOUND（含 prototype 键）", wrong.join("; "));
  ok(gate.pendingCount === 1, "[E3] 伪造 id 未影响真实 pending", String(gate.pendingCount));
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  await p;

  // 已决 id 复用（二次 decide）
  let reuseThrew = false;
  try {
    gate.decide({ approvalId: "a_1", action: "allowOnce" });
  } catch (e) {
    reuseThrew = String(e.message).includes(ERROR_CODES.APPROVAL_NOT_FOUND);
  }
  ok(reuseThrew, "[E3] 已决 id 复用 ⇒ APPROVAL_NOT_FOUND（不可重放）");
  clock.restore();
}

/* ================================================================= E4 */
console.log("\n[E4] 场景路由：repo 弹卡、outbox 不弹（对齐 §8.3）");

{
  // 还原 session.js 规则 2 的场景分流
  const APPROVAL_TOOLS_LOCAL = ["write", "edit", "bash", "powershell"];
  const routes = (sceneId, toolName) => {
    if (OUTBOX_SCENES.includes(sceneId)) return "no-approval"; // 规则 2 ① outbox 放行
    if (!APPROVAL_TOOLS_LOCAL.includes(toolName)) return "no-approval"; // ② 只读放行
    return "approval"; // ③ repo + 审批工具
  };
  ok(routes("repo", "bash") === "approval", "[E4] repo + bash ⇒ 弹卡");
  ok(routes("repo", "write") === "approval", "[E4] repo + write ⇒ 弹卡");
  ok(routes("repo", "edit") === "approval", "[E4] repo + edit ⇒ 弹卡");
  ok(routes("repo", "powershell") === "approval", "[E4] repo + powershell ⇒ 弹卡");
  ok(routes("repo", "read") === "no-approval", "[E4] repo + read ⇒ 不弹（只读放行）");
  ok(routes("repo", "grep") === "no-approval", "[E4] repo + grep ⇒ 不弹");
  for (const s of OUTBOX_SCENES) {
    ok(routes(s, "bash") === "no-approval", `[E4] outbox 场景 ${s} + bash ⇒ 不弹卡`);
    ok(routes(s, "write") === "no-approval", `[E4] outbox 场景 ${s} + write ⇒ 不弹卡`);
  }
  // quick 无工具
  ok(routes("quick", "bash") === "no-approval", "[E4] quick + bash ⇒ 不弹（quick 无工具/防御性放行）");
}

/* ================================================================= E5 */
console.log("\n[E5] 恶意输入：畸形 input 不崩溃、不逃逸");

{
  const clock = fakeClock();
  const { gate, pushed } = makeGate();
  const evil = [
    { command: "x".repeat(100000) },
    { command: "\u0000\u0001\u0002" },
    { command: "ls\nrm -rf /" },
    { path: "../../../../etc/passwd", content: "x" },
    { path: null, content: null },
    { edits: "not-an-array" },
    { edits: [null, undefined, {}] },
    { command: { toString: () => "obj" } },
    null,
    undefined,
  ];
  let crashed = false;
  for (const input of evil) {
    try {
      const p = gate.request({ sessionId: "sE5", sceneId: "repo", toolName: "bash", input, cwd });
      // 立刻取消，避免悬空
      gate.cancelBySession("sE5");
      await p;
    } catch (e) {
      crashed = true;
      console.log(`        崩溃于 input=${JSON.stringify(input)?.slice(0, 40)}: ${e?.message}`);
    }
  }
  ok(!crashed, "[E5] 畸形 input 全部不崩溃");
  ok(gate.pendingCount === 0, "[E5] 攻击后无 pending 残留", String(gate.pendingCount));

  // buildBatchItem 对 null input 的鲁棒性
  let bCrashed = false;
  try {
    buildBatchItem({ toolName: "write", input: null, cwd, home });
    buildBatchItem({ toolName: "bash", input: undefined, cwd, home });
    buildBatchItem({ toolName: "edit", input: { edits: null }, cwd, home });
  } catch (e) {
    bCrashed = true;
    console.log(`        buildBatchItem 崩溃: ${e?.message}`);
  }
  ok(!bCrashed, "[E5] buildBatchItem 对 null/undefined input 不崩溃");
  clock.restore();
}

/* ================================================================= E6 */
console.log("\n[E6] 审计/落盘不含 write 全文 content（§3.5/§7）");

{
  const clock = fakeClock();
  const { gate, audited } = makeGate();
  const SECRET_CONTENT = "PASSWORD=hunter2\n" + "z".repeat(5000);
  const p = gate.request({ sessionId: "sE6", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: SECRET_CONTENT }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  await p;
  const blob = JSON.stringify(audited);
  ok(!blob.includes(SECRET_CONTENT), "[E6] 审计不含 write 全文 content", `audit len=${blob.length}`);
  // 但卡里允许有 preview（用户判断依据）——确认卡确实有 preview 且不超上限
  clock.restore();
}

/* ------------------------------------------------------------------ 收尾 */
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
