/**
 * M4 审批闸门单测（纯 Node，不依赖 Electron / Pi SDK）。
 *
 * 对应设计：`docs/minipi-approval-gate-design.md` v1.1 §11 的 M4.1 验收六项：
 *   ① 建 pending 返回 allow / deny / terminate
 *   ② 5 分钟超时 = deny 且 reason 含 `did not respond`
 *   ③ `edit` diff 可还原（逐处对应 + diffStat 与 edits[] 行数一致）
 *   ④ 多 ask 合并进一张卡且不超 20 条
 *   ⑤ 重启**丢弃** pending（不变 allow）
 *   ⑥ 审计 summary 家目录→`~`、绝对路径→`<path:文件>`、密钥→`<redacted>`
 *
 * 另补：三个 outcome 的语义、`terminate` 批量口径、命令高危标记、fail-closed 底线。
 *
 * 用法：`node scripts/verify-approval.mjs`（退出码 0 = 全通过）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApprovalGate,
  DENY_REASON_TIMEOUT,
  DENY_REASON_USER,
  DENY_REASON_TERMINATE,
  buildAuditSummary,
  buildBatchItem,
  buildEditDiff,
  cardMeta,
  classifyCommand,
  normalizeEditInput,
  redactCommandForAudit,
  redactSecrets,
  sanitizeForAudit,
} from "../src/main/pi/approval.js";

import { sanitizeDetail } from "../src/main/pi/session.js";

import { APPROVAL_ACTIONS, APPROVAL_TOOLS, LIMITS } from "../src/shared/protocol.js";

let pass = 0;
let fail = 0;

/**
 * ⚠ keep-alive：`ApprovalGate` 的 pending 定时器带 `unref()`（生产里一个悬空审批
 * 不该拖住 App 退出）。但纯 Node 测试里若没有别的 ref'd 句柄，进程会在定时器触发前
 * 就退出（「unsettled top-level await」）。真宿主（Electron）常驻，不存在此问题；
 * 这里用一个 ref'd 定时器把事件循环撑住，等价于「App 在跑」。
 */
const KEEP_ALIVE = setInterval(() => {}, 1000);

/** @param {boolean} cond @param {string} label */
function ok(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("=".repeat(70));
console.log(" minipi M4 审批闸门验证（纯 Node）");
console.log(` Node ${process.version} · platform ${process.platform}`);
console.log("=".repeat(70));

/* ------------------------------------------------------------------ 工具 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-approval-test-"));
const home = path.join(tmp, "home");
const appDir = path.join(home, ".minipi");
fs.mkdirSync(appDir, { recursive: true });
const cwd = path.join(home, ".minipi", "repo");
fs.mkdirSync(cwd, { recursive: true });

/** 造一个带 bridge 记录器的 gate。@returns {{gate:ApprovalGate, pushed:object[], audited:object[]}} */
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

/* ================================================================== ① */
console.log("\n[1] 建 pending 返回 allow / deny / terminate");

{
  const { gate, pushed, audited } = makeGate();

  const p1 = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "npm test" }, cwd });
  ok(gate.pendingCount === 1, "request 后 pendingCount = 1");
  ok(pushed.length === 1 && pushed[0].phase === "push", "第一张卡 phase = push");
  ok(pushed[0].batch.length === 1 && pushed[0].batch[0].kind === "command", "卡内 batch[0].kind = command");
  ok(pushed[0].batch[0].command === "npm test", "command 原样展示（不脱敏）");
  ok(pushed[0].approvalId === "a_1", "approvalId 形如 a_<n>");
  ok(pushed[0].timeoutMs === LIMITS.APPROVAL_TIMEOUT_MS, "卡带 timeoutMs = APPROVAL_TIMEOUT_MS");
  ok(pushed[0].expiresAt === pushed[0].createdAt + LIMITS.APPROVAL_TIMEOUT_MS, "expiresAt = createdAt + timeout");

  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  const r1 = await p1;
  ok(r1.action === "allowOnce", "allowOnce 决策回传 action=allowOnce");
  ok(gate.pendingCount === 0, "决策后 pendingCount = 0");
  ok(pushed.some((c) => c.phase === "cancel"), "决策后推了 cancel 卡");
  ok(audited.some((a) => a.event === "allowed"), "审计记了 allowed");

  const { gate: g2 } = makeGate();
  const p2 = g2.request({ sessionId: "s_2", sceneId: "repo", toolName: "write", input: { path: "a.txt", content: "hi" }, cwd });
  g2.decide({ approvalId: "a_1", action: "deny" });
  const r2 = await p2;
  ok(r2.action === "deny", "deny 决策回传 action=deny");
  ok(typeof r2.reason === "string" && r2.reason.includes("explicitly denied"), "deny reason 用主动拒绝文案");

  const { gate: g3 } = makeGate();
  const p3 = g3.request({ sessionId: "s_3", sceneId: "repo", toolName: "edit", input: { path: "b.js", edits: [{ oldText: "a", newText: "b" }] }, cwd });
  g3.decide({ approvalId: "a_1", action: "terminate" });
  const r3 = await p3;
  ok(r3.action === "terminate", "terminate 决策回传 action=terminate");
}

/* ---- decide 的错误路径 ---- */
console.log("\n[1b] decide 的错误路径");
{
  const { gate } = makeGate();
  gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });

  let threw = null;
  try {
    gate.decide({ approvalId: "a_999", action: "allowOnce" });
  } catch (e) {
    threw = e.message;
  }
  ok(typeof threw === "string" && threw.startsWith("APPROVAL_NOT_FOUND"), "不存在的 id ⇒ APPROVAL_NOT_FOUND");

  let threw2 = null;
  try {
    gate.decide({ approvalId: "a_1", action: "sure" });
  } catch (e) {
    threw2 = e.message;
  }
  ok(typeof threw2 === "string" && threw2.startsWith("INVALID_ARGUMENT"), "非法 action ⇒ INVALID_ARGUMENT");

  gate.decide({ approvalId: "a_1", action: "deny" });

  let threw3 = null;
  try {
    gate.decide({ approvalId: "a_1", action: "allowOnce" });
  } catch (e) {
    threw3 = e.message;
  }
  ok(typeof threw3 === "string" && threw3.startsWith("APPROVAL_NOT_FOUND"), "已决 id 再 decide ⇒ APPROVAL_NOT_FOUND");

  ok(APPROVAL_ACTIONS.join(",") === "allowOnce,deny,terminate", "APPROVAL_ACTIONS 三值域");
  ok(APPROVAL_TOOLS.join(",") === "write,edit,bash,powershell", "APPROVAL_TOOLS 四个工具");
}

/* ================================================================== ② */
console.log("\n[2] 5 分钟超时 = deny 且 reason 含 did not respond");
{
  // 用极短超时模拟 5 分钟（不真等 5 分钟）
  const { gate, pushed, audited } = makeGate({ timeoutMs: 60 });
  const p = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "npm test" }, cwd });
  const r = await p;
  ok(r.action === "deny", "超时 ⇒ action = deny（fail-closed）");
  ok(typeof r.reason === "string" && r.reason.includes("did not respond"), "超时 reason 含 did not respond");
  ok(r.reason === DENY_REASON_TIMEOUT, "超时 reason 与常量逐字一致");
  ok(gate.pendingCount === 0, "超时后 pendingCount = 0");
  ok(pushed.some((c) => c.phase === "cancel"), "超时后撤卡");
  ok(audited.some((a) => a.event === "timeout"), "审计记了 timeout");
  ok(!audited.some((a) => a.event === "allowed"), "审计**没有** allowed（绝不放行）");
}

/* ================================================================== ③ */
console.log("\n[3] edit 真实 diff（可还原 + diffStat 与 edits[] 行数一致）");
{
  const input = { path: "src/x.js", edits: [{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" }] };
  const { edits } = normalizeEditInput(input);
  ok(edits.length === 1, "现行形状 edits[] 解析出 1 条");
  const { diff, diffStat } = buildEditDiff(edits);
  ok(diff.includes("@@ edit 1/1"), "diff 带 `@@ edit 1/1` 头");
  ok(diff.includes("- const b = 2;") && diff.includes("+ const b = 3;"), "diff 显示 - 旧 / + 新（前缀裁掉公共行）");
  ok(!diff.includes("const a = 1;"), "公共前缀行不重复展示");
  ok(diffStat.added === 1 && diffStat.removed === 1, "diffStat = +1 -1");

  // legacy 顶层形状
  const legacy = normalizeEditInput({ path: "x", oldText: "foo", newText: "bar" });
  ok(legacy.edits.length === 1 && legacy.edits[0].oldText === "foo", "legacy {oldText,newText} 归一为 edits[]");

  // edits 是 JSON 字符串
  const jsonStr = normalizeEditInput({ path: "x", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) });
  ok(jsonStr.edits.length === 1, "edits 为 JSON 字符串 ⇒ 解析成数组");

  // 单对象 edits
  const single = normalizeEditInput({ path: "x", edits: { oldText: "a", newText: "b" } });
  ok(single.edits.length === 1, "edits 为单对象 ⇒ 包成数组");

  // 多处 edits：diffStat 汇总
  const multi = [
    { oldText: "l1\nl2", newText: "l1\nl2\nl3" }, // +1 行
    { oldText: "a\nb\nc", newText: "a\nc" },        // -1 行
  ];
  const md = buildEditDiff(multi);
  ok(md.diffStat.added === 1 && md.diffStat.removed === 1, "多条 edits diffStat 汇总 = +1 -1");
  ok(md.diff.includes("@@ edit 1/2") && md.diff.includes("@@ edit 2/2"), "多条 edits 分别编号 1/2 2/2");

  // 纯新增 / 纯删除
  ok(buildEditDiff([{ oldText: "", newText: "new\nlines" }]).diffStat.added === 2, "纯新增：+2");
  ok(buildEditDiff([{ oldText: "old\nlines", newText: "" }]).diffStat.removed === 2, "纯删除：-2");

  // 超大片段 ⇒ tooLargeToDiff
  const big = "x".repeat(LIMITS.APPROVAL_DIFF_MAX_BYTES + 10);
  const tooLarge = buildEditDiff([{ oldText: "", newText: big }]);
  ok(tooLarge.tooLargeToDiff === true, "超 APPROVAL_DIFF_MAX_BYTES ⇒ tooLargeToDiff");
  ok(!tooLarge.diff.includes(big.slice(0, 50)), "超大片段不逐行展示");

  // 卡生成：edit item 字段
  const item = buildBatchItem({ toolName: "edit", input, cwd, home });
  ok(item.kind === "edit" && typeof item.diff === "string" && item.diffStat, "buildBatchItem(edit) 带 diff + diffStat");
}

/* ================================================================== ④ */
console.log("\n[4] 多 ask 合并进一张卡且不超 20 条");
{
  const { gate, pushed } = makeGate();
  const promises = [];
  for (let i = 0; i < 5; i += 1) {
    promises.push(gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: `echo ${i}` }, cwd }));
  }
  ok(gate.pendingCount === 1, "5 次 ask 仍只有 1 张未决卡");
  const lastPush = pushed[pushed.length - 1];
  ok(lastPush.phase === "update", "追问走 phase = update（就地更新）");
  ok(lastPush.batch.length === 5, "同一张卡 batch 累积到 5 条");
  ok(new Set(pushed.map((c) => c.approvalId)).size === 1, "5 次 ask 用同一个 approvalId");

  // 整批决策：5 个 promise 全部 allowOnce
  gate.decide({ approvalId: "a_1", action: "allowOnce" });
  const results = await Promise.all(promises);
  ok(results.every((r) => r.action === "allowOnce"), "整批一起允许（5 个都 allowOnce）");
  ok(gate.pendingCount === 0, "整批决策后 pendingCount = 0");

  // 上限：batchMax=3 时第 4 条新建卡
  const { gate: g2, pushed: p2 } = makeGate({ batchMax: 3 });
  for (let i = 0; i < 4; i += 1) {
    g2.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: `c${i}` }, cwd });
  }
  ok(g2.pendingCount === 2, "超 batchMax ⇒ 新建第二张卡");
  ok(p2.filter((c) => c.phase === "push").length === 2, "推了两张 push 卡");
  const firstBatch = p2.find((c) => c.phase === "push");
  ok(firstBatch.batch.length === 3, "第一张卡恰好 3 条（=batchMax）");

  // 跨会话不合并
  const { gate: g3 } = makeGate();
  g3.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "a" }, cwd });
  g3.request({ sessionId: "s_2", sceneId: "repo", toolName: "bash", input: { command: "b" }, cwd });
  ok(g3.pendingCount === 2, "不同 sessionId 不合并（各自一张卡）");
}

/* ================================================================== ⑤ */
console.log("\n[5] 重启丢弃 pending（不变 allow）");
{
  // 先写一个「有未决 pending」的 approvals.json（模拟崩溃前）
  const approvalsFile = path.join(appDir, "approvals.json");
  fs.writeFileSync(
    approvalsFile,
    JSON.stringify(
      { version: 1, pending: [{ approvalId: "a_7", sessionId: "s_9", kind: "command", toolName: "bash", status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 300000 }] },
      null,
      2,
    ),
    "utf8",
  );

  const audited = [];
  const gate = new ApprovalGate({
    bridge: { pushCard() {}, audit: (e) => audited.push(e) },
    logger: { info() {}, warn() {}, error() {} },
    home,
    appDir,
  });
  ok(gate.pendingCount === 0, "重启后 pendingCount = 0（不恢复）");
  ok(audited.some((a) => a.event === "lost_on_restart" && a.approvalId === "a_7"), "遗留 pending 记 lost_on_restart 审计");

  const after = JSON.parse(fs.readFileSync(approvalsFile, "utf8"));
  ok(Array.isArray(after.pending) && after.pending.length === 0, "approvals.json 的 pending 已清空重写");
  ok(!JSON.stringify(after).includes("allowOnce"), "落盘里绝无「已允许」痕迹");

  // 损坏文件 ⇒ 当空，不抛错
  fs.writeFileSync(approvalsFile, "{ 这不是合法 JSON", "utf8");
  let threw = null;
  try {
    new ApprovalGate({ bridge: { pushCard() {}, audit() {} }, logger: { warn() {}, info() {}, error() {} }, home, appDir });
  } catch (e) {
    threw = e;
  }
  ok(threw === null, "损坏的 approvals.json ⇒ 不抛错（当空启动）");
}

/* ================================================================== ⑥ */
console.log("\n[6] 审计脱敏（家目录→~ / 绝对路径→<path:文件> / 密钥→<redacted>）");
{
  const s1 = sanitizeForAudit(`写文件 ${path.join(home, ".minipi", "repo", "secret.txt")}`, 300, home);
  ok(s1.includes("~"), "家目录 → ~");
  ok(!s1.includes(home), "不含原始家目录");
  // 家目录内的路径被 ~ 化后**保留可读结构**（与 session.js:sanitizeDetail 同口径，设计 §7.2）
  ok(s1.includes("~") && s1.includes("secret.txt"), "家目录内路径 ~化后仍保留文件名");

  // 真正的「绝对路径」（既非家目录、也非 cwd 内）⇒ 退化为 <path:文件名>
  const s1b = sanitizeForAudit("读 /var/log/app/secret.txt", 300, home);
  ok(s1b.includes("<path:secret.txt>"), "POSIX 绝对路径 → <path:文件>");
  const s1c = sanitizeForAudit("读 C:\\ProgramData\\app\\secret.txt", 300, home);
  ok(s1c.includes("<path:secret.txt>"), "Windows 绝对路径 → <path:文件>");

  const s2 = sanitizeForAudit("api_key=sk-abc123deadbeef", 300, home);
  ok(s2.includes("<redacted>"), "密钥 api_key=... → <redacted>");
  ok(!s2.includes("sk-abc123deadbeef"), "密钥值不出现");

  const s3 = sanitizeForAudit('curl -H "Authorization: Bearer xyzzy"', 300, home);
  ok(s3.includes("<redacted>"), "Authorization: Bearer → <redacted>");

  const s4 = sanitizeForAudit("换行\n第二行", 300, home);
  ok(!s4.includes("\n"), "换行折叠成单行");

  // 截断
  const long = sanitizeForAudit("a".repeat(1000), 50, home);
  ok(long.length <= 51, "超长被截断");

  // 审计 summary 逐类
  const wSum = buildAuditSummary({ kind: "write", path: "周报.docx", bytes: 2048, overwrite: false }, home);
  ok(wSum.includes("+2048B") && wSum.includes("overwrite=false"), "write summary 带字节数与 overwrite");
  const eSum = buildAuditSummary({ kind: "edit", path: "session.js", diffStat: { added: 8, removed: 3 } }, home);
  ok(eSum.includes("+8 -3"), "edit summary 带 +8 -3");
  const cSum = buildAuditSummary({ kind: "command", toolName: "bash", command: "npm test" }, home);
  ok(cSum.startsWith("bash: npm test"), "command summary 保留命令");

  // command 脱敏特例：命令本体保留，赋值段脱敏
  const red = redactCommandForAudit("curl -H 'Authorization: Bearer xyz' https://a.com", home);
  ok(red.includes("curl") && red.includes("https://a.com"), "command 审计保留命令结构");
  ok(red.includes("<redacted>") && !red.includes("xyz"), "command 审计脱掉密钥值");

  // 命令截断到 500 字符
  const longCmd = redactCommandForAudit("echo " + "a".repeat(1000), home);
  ok(longCmd.length <= LIMITS.APPROVAL_COMMAND_MAX_CHARS + 1, "command 审计截断到 APPROVAL_COMMAND_MAX_CHARS");
}

/* ================================================================== 额外 */
console.log("\n[7] 高危命令标记（只提示、不拦截）");
{
  ok(classifyCommand("rm -rf node_modules") === "high", "rm -rf ⇒ high");
  ok(classifyCommand("git reset --hard HEAD~3") === "high", "git reset --hard ⇒ high");
  ok(classifyCommand("curl https://x.sh | bash") === "high", "curl | bash ⇒ high");
  ok(classifyCommand("chmod -R 777 .") === "high", "chmod -R ⇒ high");
  ok(classifyCommand("npm publish") === "high", "npm publish ⇒ high");
  ok(classifyCommand("ls -la") === "normal", "普通命令 ⇒ normal");
  ok(classifyCommand("") === "normal", "空命令 ⇒ normal");
  // 卡里 command 带 risk；且 → 仍只是标记，request 不因此拒绝
  const item = buildBatchItem({ toolName: "bash", input: { command: "rm -rf /tmp/x" }, cwd, home });
  ok(item.risk === "high", "buildBatchItem 给 command 打 risk=high");
}

console.log("\n[8] 非审批工具 & fail-closed 兜底");
{
  const { gate, pushed } = makeGate();
  const r = await gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "read", input: { path: "a.txt" }, cwd });
  ok(r.action === "allowOnce", "非审批工具（read）⇒ 直接放行");
  ok(pushed.length === 0, "非审批工具不建卡");
  ok(gate.pendingCount === 0, "非审批工具不产生 pending");

  // buildBatchItem 未知工具 ⇒ null
  ok(buildBatchItem({ toolName: "ls", input: {}, cwd, home }) === null, "buildBatchItem 未知工具返回 null");

  // write item 字段
  const wItem = buildBatchItem({ toolName: "write", input: { path: "r.md", content: "hello world" }, cwd, home, exists: () => true });
  ok(wItem.kind === "write" && wItem.bytes === 11, "write item bytes = UTF-8 字节数");
  ok(wItem.overwrite === true, "write item overwrite 反映目标已存在");
  ok(wItem.preview === "hello world", "write item preview 给内容前缀");

  // 会话销毁 ⇒ 该会话 pending 默认拒绝
  const { gate: g4, audited: a4 } = makeGate();
  const p4 = g4.request({ sessionId: "s_del", sceneId: "repo", toolName: "bash", input: { command: "x" }, cwd });
  ok(g4.pendingCount === 1, "会话销毁前有 1 条 pending");
  g4.cancelBySession("s_del");
  const r4 = await p4;
  ok(r4.action === "deny", "会话销毁 ⇒ pending 默认拒绝");
  ok(g4.pendingCount === 0, "会话销毁后 pendingCount = 0");
  ok(a4.some((a) => a.event === "denied"), "会话销毁记 denied 审计");
}

console.log("\n[9] registerGate 接线（M4.3：沙箱 → 审批 顺序 / 场景分流）");
{
  // 动态 import：session.js import 了 Pi SDK（但 SDK 可离线加载，不需 Electron）
  const { PiSessionHost } = await import("../src/main/pi/session.js");
  const { OUTBOX_DIR } = await import("../src/main/settings.js");

  /** 造一个只记录 handler 的假 pi。 */
  function fakePi() {
    const handlers = [];
    return {
      handlers,
      on(event, cb) {
        if (event === "tool_call") handlers.push(cb);
      },
    };
  }

  /** 造 host（注入 gate）+ 挂 gate 到假 pi，返回 handler。 */
  function mount(sceneId, cwd, gate) {
    const host = new PiSessionHost({
      emit() {},
      logger: { info() {}, warn() {}, error() {} },
      approval: gate,
    });
    const pi = fakePi();
    host.registerGate(pi, { sessionId: "s_t", sceneId, cwd });
    return pi.handlers[0];
  }

  const { gate, pushed } = makeGate();

  // repo：4 个审批工具都弹卡
  for (const toolName of ["write", "edit", "bash", "powershell"]) {
    const h = mount("repo", cwd, gate);
    const before = pushed.length;
    const p = h({ toolName, input: sampleInput(toolName), cwd });
    ok(pushed.length === before + 1, `repo + ${toolName} ⇒ 弹卡`);
    // 决策 allowOnce，让 promise 收口（避免泄漏 pending）
    const id = pushed[pushed.length - 1].approvalId;
    gate.decide({ approvalId: id, action: "allowOnce" });
    const r = await p;
    ok(r === undefined, `repo + ${toolName} + allowOnce ⇒ 钩子返回 undefined（放行）`);
  }

  // repo：只读工具不弹卡
  {
    const h = mount("repo", cwd, gate);
    const before = pushed.length;
    const r = await h({ toolName: "read", input: { path: "x" }, cwd });
    ok(pushed.length === before, "repo + read ⇒ 不弹卡");
    ok(r === undefined, "repo + read ⇒ 放行");
  }

  // repo + deny ⇒ { block: true, reason }
  {
    const h = mount("repo", cwd, gate);
    const p = h({ toolName: "bash", input: { command: "rm -rf /" }, cwd });
    const id = pushed[pushed.length - 1].approvalId;
    gate.decide({ approvalId: id, action: "deny" });
    const r = await p;
    ok(r && r.block === true, "repo + deny ⇒ { block: true }");
    ok(typeof r.reason === "string" && r.reason.includes("explicitly denied"), "deny 回灌 reason");
  }

  // repo + terminate ⇒ { block, terminate: true }
  {
    const h = mount("repo", cwd, gate);
    const p = h({ toolName: "bash", input: { command: "ls" }, cwd });
    const id = pushed[pushed.length - 1].approvalId;
    gate.decide({ approvalId: id, action: "terminate" });
    const r = await p;
    ok(r && r.block === true && r.terminate === true, "repo + terminate ⇒ { block, terminate:true }");
  }

  // outbox 场景（quick/note/desk）+ bash ⇒ 不弹卡（场景分流）
  for (const sceneId of ["quick", "note", "desk"]) {
    const h = mount(sceneId, OUTBOX_DIR, gate);
    const before = pushed.length;
    const r = await h({ toolName: "bash", input: { command: "ls" }, cwd: OUTBOX_DIR });
    ok(pushed.length === before, `${sceneId} + bash ⇒ 不弹卡（§8 分流）`);
    ok(r === undefined, `${sceneId} + bash ⇒ 放行`);
  }

  // 顺序：note 场景 + 越出 outbox 的 write ⇒ 沙箱 block（不是弹卡）
  {
    const h = mount("note", OUTBOX_DIR, gate);
    const before = pushed.length;
    const r = await h({ toolName: "write", input: { path: "../../evil.txt" }, cwd: OUTBOX_DIR });
    ok(r && r.block === true, "note + 越界 write ⇒ 沙箱 block");
    ok(pushed.length === before, "沙箱拦下时**不弹卡**（顺序：沙箱先于审批）");
    ok(typeof r.reason === "string" && !r.reason.includes("approval"), "沙箱 reason 用的是沙箱文案");
  }

  // 未注入 approval 时（M4 之前行为）：repo 也不弹卡、放行
  {
    const host = new PiSessionHost({ emit() {}, logger: { info() {}, warn() {}, error() {} } });
    const pi = fakePi();
    host.registerGate(pi, { sessionId: "s_t", sceneId: "repo", cwd });
    const r = await pi.handlers[0]({ toolName: "bash", input: { command: "ls" }, cwd });
    ok(r === undefined, "未注入 approval ⇒ repo 放行（退化行为）");
  }
}

/** 样例 input（按工具给合理形状）。 */
function sampleInput(toolName) {
  if (toolName === "write") return { path: "a.md", content: "hi" };
  if (toolName === "edit") return { path: "a.js", edits: [{ oldText: "a", newText: "b" }] };
  return { command: "npm test" };
}

/* ================================================================== ⑩ R3 */
console.log("\n[10] R3：terminate 文案 ≠ deny 文案（三套分开）");
{
  ok(DENY_REASON_TERMINATE !== DENY_REASON_USER, "TERMINATE ≠ USER deny");
  ok(DENY_REASON_TERMINATE !== DENY_REASON_TIMEOUT, "TERMINATE ≠ TIMEOUT");
  ok(DENY_REASON_TERMINATE.includes("stop this turn") || DENY_REASON_TERMINATE.includes("turn"),
     "TERMINATE 文案点明「整轮已停」");

  const { gate } = makeGate();
  const p = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  gate.decide({ approvalId: "a_1", action: "terminate" });
  const r = await p;
  ok(r.reason === DENY_REASON_TERMINATE, "terminate 决策回传 TERMINATE 文案");
  ok(r.reason !== DENY_REASON_USER, "terminate 不再复用 deny 文案");

  const { gate: g2 } = makeGate();
  const p2 = g2.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  g2.decide({ approvalId: "a_1", action: "deny" });
  const r2 = await p2;
  ok(r2.reason === DENY_REASON_USER, "deny 决策仍用 USER 文案");

  // 超时 / cancelBySession 文案保持不变（回归）
  const { gate: g3 } = makeGate({ timeoutMs: 40 });
  const r3 = await g3.request({ sessionId: "s_t", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  ok(r3.reason === DENY_REASON_TIMEOUT, "超时文案不受 R3 影响（仍 TIMEOUT）");
  const { gate: g4 } = makeGate();
  const p4 = g4.request({ sessionId: "s_del", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  g4.cancelBySession("s_del");
  const r4 = await p4;
  ok(r4.reason === DENY_REASON_USER, "cancelBySession 仍用 USER 文案");
}

/* ================================================================== ⑪ R4 */
console.log("\n[11] R4：审批卡补齐 6 个卡级字段 + actions 三值");
{
  const { gate, pushed } = makeGate();
  const pending = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "npm test" }, cwd });
  const push = pushed[0];
  ok(push.sessionId === "s_1", "卡带 sessionId");
  ok(push.kind === "command", "卡带 kind");
  ok(push.toolName === "bash", "卡带 toolName");
  ok(typeof push.title === "string" && push.title.length > 0, "卡带 title");
  ok(Array.isArray(push.actions) && push.actions.length === 3, "卡带 actions 且长度 3");
  ok(push.actions.join(",") === "allowOnce,deny,terminate", "actions 就是三值域");
  ok(push.alwaysAllowEligible === true, "单工具卡 alwaysAllowEligible = true");
  ok(push.phase === "push", "phase = push");

  // cancel 卡：只带 id + phase + actions，batch 为空、无 kind
  gate.decide({ approvalId: "a_1", action: "deny" });
  await pending;
  const cancel = pushed.find((c) => c.phase === "cancel");
  ok(cancel && cancel.batch.length === 0, "cancel 卡 batch 为空");
  ok(cancel && cancel.kind === undefined, "cancel 卡不带 kind");
  ok(cancel && cancel.actions.length === 3, "cancel 卡仍带 actions（方砚可复用按钮布局）");

  // update 卡（批合并）也带三个字段
  const { gate: g2, pushed: p2 } = makeGate();
  g2.request({ sessionId: "s_1", sceneId: "repo", toolName: "write", input: { path: "a.md", content: "x" }, cwd });
  g2.request({ sessionId: "s_1", sceneId: "repo", toolName: "write", input: { path: "b.md", content: "y" }, cwd });
  const upd = p2[p2.length - 1];
  ok(upd.phase === "update" && upd.kind === "write" && upd.toolName === "write", "update 卡带 kind/toolName");
  ok(upd.alwaysAllowEligible === true, "单工具合并卡 alwaysAllowEligible = true");

  // 混合 kind 批 ⇒ cardMeta 标 mixedKind 且 alwaysAllowEligible=false
  const mixedMeta = cardMeta({ items: [{ kind: "write", toolName: "write" }, { kind: "command", toolName: "bash" }] });
  ok(mixedMeta.mixedKind === true, "混合 kind 批标记 mixedKind");
  ok(mixedMeta.alwaysAllowEligible === false, "混合 kind 批 alwaysAllowEligible = false（不发明逐条 remember）");

  const { gate: g3, pushed: p3 } = makeGate();
  g3.request({ sessionId: "s_1", sceneId: "repo", toolName: "write", input: { path: "a.md", content: "x" }, cwd });
  g3.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  const mixedPush = p3[p3.length - 1];
  ok(mixedPush.alwaysAllowEligible === false, "真实混合批推卡 alwaysAllowEligible = false");
}

/* ================================================================== ⑫ R5 */
console.log("\n[12] R5：本会话总是允许（默认关 / 仅内存 / 仅 IPC remember 能开 / 审计）");
{
  // 默认关：同工具第二次仍推卡
  const { gate, pushed } = makeGate();
  const p1 = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "a" }, cwd });
  gate.decide({ approvalId: "a_1", action: "allowOnce" }); // 不带 remember
  await p1;
  ok(gate.isAlwaysAllowed("s_1", "bash") === false, "缺省 remember ⇒ 不开启 always-allow");
  const before = pushed.length;
  gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "b" }, cwd });
  ok(pushed.length === before + 1, "默认关：第二次同工具仍推卡");

  // remember:true ⇒ 开启 ⇒ 同会话同工具不再推卡
  const { gate: g2, pushed: p2, audited: a2 } = makeGate();
  const q1 = g2.request({ sessionId: "s_2", sceneId: "repo", toolName: "bash", input: { command: "a" }, cwd });
  g2.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  const r1 = await q1;
  ok(r1.action === "allowOnce", "remember:true + allowOnce ⇒ 本次放行");
  ok(g2.isAlwaysAllowed("s_2", "bash") === true, "remember:true ⇒ 该会话该工具已 always-allow");
  ok(a2.some((e) => e.event === "always_allow_enabled" && e.toolName === "bash"), "开启当刻审计记 always_allow_enabled");

  const before2 = p2.length;
  const r2 = await g2.request({ sessionId: "s_2", sceneId: "repo", toolName: "bash", input: { command: "c" }, cwd });
  ok(r2.action === "allowOnce", "always-allow 命中 ⇒ 直接放行");
  ok(p2.length === before2, "always-allow 命中 ⇒ 不再推卡");

  // 只对该工具生效：同会话另一工具仍推卡
  const before3 = p2.length;
  g2.request({ sessionId: "s_2", sceneId: "repo", toolName: "write", input: { path: "x.md", content: "y" }, cwd });
  ok(p2.length === before3 + 1, "always-allow 只对该工具生效（write 仍推卡）");

  // 跨会话不共享
  const before4 = p2.length;
  g2.request({ sessionId: "s_OTHER", sceneId: "repo", toolName: "bash", input: { command: "d" }, cwd });
  ok(p2.length === before4 + 1, "always-allow 不跨会话");

  // 只有 allowOnce 能开启（deny/terminate + remember 无效）
  const { gate: g3 } = makeGate();
  const p3 = g3.request({ sessionId: "s_3", sceneId: "repo", toolName: "bash", input: { command: "a" }, cwd });
  g3.decide({ approvalId: "a_1", action: "deny", remember: true });
  await p3;
  ok(g3.isAlwaysAllowed("s_3", "bash") === false, "deny + remember:true ⇒ 不开启");

  // 会话销毁清空记忆
  const { gate: g4 } = makeGate();
  const p4 = g4.request({ sessionId: "s_4", sceneId: "repo", toolName: "bash", input: { command: "a" }, cwd });
  g4.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  await p4;
  ok(g4.isAlwaysAllowed("s_4", "bash") === true, "开启后记忆存在");
  g4.cancelBySession("s_4");
  ok(g4.isAlwaysAllowed("s_4", "bash") === false, "会话销毁 ⇒ 清空 always-allow 记忆（仅内存）");

  // 混合批即便 remember:true 也不开启（alwaysAllowEligible=false）
  const { gate: g5 } = makeGate();
  g5.request({ sessionId: "s_5", sceneId: "repo", toolName: "write", input: { path: "a.md", content: "x" }, cwd });
  g5.request({ sessionId: "s_5", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
  g5.decide({ approvalId: "a_1", action: "allowOnce", remember: true });
  ok(g5.isAlwaysAllowed("s_5", "write") === false && g5.isAlwaysAllowed("s_5", "bash") === false,
     "混合批 remember:true ⇒ 不开启（无单一工具可归）");
}

/* ================================================================== ⑬ P3-1 T5 */
console.log("\n[13] T5：已决后旧定时器不得存活 / 不得二次推卡 / 不得误记 timeout（假时钟）");
{
  // T5 缺陷场景（设计 §11 T5）：用户在超时前批卡，旧的 5 分钟 `setTimeout` 仍在跑，
  // 到点后 `_onTimeout` 可能对**已决**卡二次点火（误推卡 / 误记 timeout 审计）。
  // 产品代码的防线：`_settle` 对所有 outcome 都 `clearTimeout` + settled 早退。
  // 但**真定时器测不到「旧定时器仍存活」**（要等 5 分钟）⇒ 必须用**假时钟**：
  // 装一个可控的 setTimeout/clearTimeout，把「推进 10s」变成同步操作，并统计存活定时器数。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  /**
   * 假时钟：记录所有未清定时器，可手动 advance。
   * ⚠ `ApprovalGate` 一次 `request()` 会起**两个**定时器：
   *   · 5 分钟**审批超时**定时器（ms == timeoutMs）← T5 关心的就是这个
   *   · 200ms **落盘去抖**定时器（`_flushTimer`）← 与 T5 无关，不参与断言
   * 所以按 `ms` 归类，`liveTimeoutTimers()` 只数审批超时定时器。
   */
  function installFakeClock(timeoutMs) {
    let now = 0;
    let seq = 0;
    /** @type {Map<number, {at:number, fn:Function, ms:number}>} */
    const live = new Map();
    globalThis.setTimeout = (fn, ms) => {
      const id = ++seq;
      live.set(id, { at: now + (Number(ms) || 0), fn, ms: Number(ms) || 0 });
      return { __fakeTimerId: id, unref() {} }; // 兼容 entry.timer?.unref?.()
    };
    globalThis.clearTimeout = (handle) => {
      const id = handle && handle.__fakeTimerId;
      if (id) live.delete(id);
    };
    return {
      /** 推进假时钟，触发所有到点定时器；返回触发条数。 */
      advance(ms) {
        now += ms;
        let fired = 0;
        for (const [id, t] of [...live.entries()]) {
          if (t.at <= now) {
            live.delete(id);
            fired += 1;
            try {
              t.fn();
            } catch {
              /* 定时器回调抛错不影响断言 */
            }
          }
        }
        return fired;
      },
      /** 存活定时器总数（含去抖）。 */
      liveCount() {
        return live.size;
      },
      /** 存活**审批超时**定时器数（T5 断言用）。 */
      liveTimeoutTimers() {
        return [...live.values()].filter((t) => t.ms === timeoutMs).length;
      },
    };
  }

  const TIMEOUT_MS = LIMITS.APPROVAL_TIMEOUT_MS;

  /** 每个 outcome 跑一遍：建卡 → 决策 → 推进假时钟 → 断言无二次推卡/无 timeout 审计。 */
  async function assertNoLeak(action) {
    const clock = installFakeClock(TIMEOUT_MS);
    try {
      const pushed = [];
      const audited = [];
      const gate = new ApprovalGate({
        bridge: { pushCard: (c) => pushed.push(c), audit: (e) => audited.push(e) },
        logger: { info() {}, warn() {}, error() {} },
        home,
        appDir,
        timeoutMs: TIMEOUT_MS, // 5 分钟
      });
      const p = gate.request({ sessionId: "s_1", sceneId: "repo", toolName: "bash", input: { command: "npm test" }, cwd });
      ok(clock.liveTimeoutTimers() === 1, `${action}：建卡后**审批超时**定时器 == 1`);

      gate.decide({ approvalId: "a_1", action });
      await p;
      ok(clock.liveTimeoutTimers() === 0, `${action}：决策后**审批超时**定时器 == 0（clearTimeout 生效）`);

      const pushedBeforeAdvance = pushed.length;
      const auditedBeforeAdvance = audited.length;
      // 推进假时钟**超过**超时点：先 10s，再推过完整 5 分钟，确保旧定时器若存在必然触发
      const fired1 = clock.advance(10_000);
      const fired2 = clock.advance(TIMEOUT_MS);

      ok(pushed.length === pushedBeforeAdvance, `${action}：推进假时钟后**无二次推卡**`);
      const newTimeouts = audited.slice(auditedBeforeAdvance).filter((e) => e.event === "timeout");
      ok(newTimeouts.length === 0, `${action}：推进假时钟后**无新的 timeout 审计**`);
      ok(fired1 + fired2 === 0 || clock.liveTimeoutTimers() === 0,
         `${action}：已决卡的审批超时定时器不存在（推进 10s + 5min 无该回调触发）`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  }

  await assertNoLeak("allowOnce");
  await assertNoLeak("deny");
  await assertNoLeak("terminate");

  // 反向对照：**不决策**时，推假时钟**应**触发超时（证明假时钟真的有效、不是空跑）
  {
    const clock = installFakeClock(TIMEOUT_MS);
    try {
      const audited = [];
      const gate = new ApprovalGate({
        bridge: { pushCard() {}, audit: (e) => audited.push(e) },
        logger: { info() {}, warn() {}, error() {} },
        home,
        appDir,
        timeoutMs: TIMEOUT_MS,
      });
      const p = gate.request({ sessionId: "s_ctl", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
      ok(clock.liveTimeoutTimers() === 1, "对照：不决策时审批超时定时器 == 1");
      const fired = clock.advance(TIMEOUT_MS);
      ok(fired >= 1, "对照：推进 5 分钟**确实触发**超时定时器（假时钟有效）");
      const r = await p;
      ok(r.action === "deny" && r.reason === DENY_REASON_TIMEOUT, "对照：超时 ⇒ deny + TIMEOUT 文案");
      ok(audited.some((e) => e.event === "timeout"), "对照：确实记了 timeout 审计");
      ok(clock.liveTimeoutTimers() === 0, "对照：超时触发后审批超时定时器 == 0");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  }

  // ── [13b] **入口守卫直测**（设计 §11 T5 的第 4 条：两处 `settled` 早退守卫）──
  // [13] 是**行为级**证明（推进假时钟看无可观测副作用）；这里再**直接调用**两个入口，
  // 断言守卫本身生效 —— 即「已决卡再被 _onTimeout / _settle 触达 ⇒ 立即早退、零副作用」。
  // 为什么两条都要：行为级证明依赖「旧定时器真被触发」这一前置；若某天守卫被误删但
  // 定时器恰被别处清掉，行为级可能假绿。直测守卫则**不依赖任何定时器**，是更硬的那层。
  {
    const pushed = [];
    const audited = [];
    const gate = new ApprovalGate({
      bridge: { pushCard: (c) => pushed.push(c), audit: (e) => audited.push(e) },
      logger: { info() {}, warn() {}, error() {} },
      home,
      appDir,
      timeoutMs: TIMEOUT_MS,
    });
    const p = gate.request({ sessionId: "s_guard", sceneId: "repo", toolName: "bash", input: { command: "npm test" }, cwd });
    // 决策落定（allowOnce）→ 卡已 settle
    gate.decide({ approvalId: "a_1", action: "allowOnce" });
    await p;

    // 取已决 entry —— 它已从 _pending 移除；直接构造一个同 id 的「已决」对象也能测守卫，
    // 但更真实的是：把 entry 从表里拿不到的路径也走一遍。此处用 _pending 里拿不到 ⇒
    // _onTimeout 走 `!entry` 分支（另一种早退）。为测 `entry.settled` 分支，需保留 entry：
    // 用 request 后**未决**卡 settle 再直接调，构造 settled=true 的 entry。
    const p2 = gate.request({ sessionId: "s_guard2", sceneId: "repo", toolName: "bash", input: { command: "npm run build" }, cwd });
    const entry2 = gate._pending.get("a_1") || [...gate._pending.values()].find((e) => e.sessionId === "s_guard2");
    // 先正常落定卡2
    const id2 = entry2 ? entry2.id : null;
    if (id2) gate.decide({ approvalId: id2, action: "deny" });
    await p2;

    // 现在 entry2 是 settled=true 且已移出 _pending。直接把「已决但仍在手上」的 entry2
    // 喂给 _settle → 命中 `if (entry.settled) return`（:811 守卫）
    const before = { pushed: pushed.length, audited: audited.length };
    if (id2) gate._settle(entry2, "allowOnce", null);
    ok(pushed.length === before.pushed && audited.length === before.audited,
       "[13b] 直测 `_settle` 入口守卫：对已决 entry 再 settle ⇒ **零副作用**（无推卡/无审计）");

    // 再直测 `_onTimeout` 入口守卫：对已决 id 调 _onTimeout ⇒ 早退（!entry 或 settled）
    const before2 = { pushed: pushed.length, audited: audited.length };
    if (id2) gate._onTimeout(id2);
    ok(pushed.length === before2.pushed && audited.length === before2.audited,
       "[13b] 直测 `_onTimeout` 入口守卫：对已决 id 再触发超时 ⇒ **零副作用**");
    ok(!audited.some((e) => e.event === "timeout"),
       "[13b] 直测守卫后**全局无任何 timeout 审计**（该会话从未超时）");

    // ── 负向对照：对**未决**卡直接 _settle ⇔ **必须**有副作用 ──
    // 没有这条，上面两个「零副作用」断言可能是「_settle/_onTimeout 根本没接进生产路径」的假绿。
    const p3 = gate.request({ sessionId: "s_ctrl", sceneId: "repo", toolName: "bash", input: { command: "ls" }, cwd });
    const entry3 = [...gate._pending.values()].find((e) => e.sessionId === "s_ctrl");
    const pushBeforeCtrl = pushed.length;
    const auditBeforeCtrl = audited.length;
    ok(!!entry3 && entry3.settled === false, "[13b] 负向对照：拿到一张**未决**卡（settled=false）");
    gate._settle(entry3, "deny", DENY_REASON_USER);
    await p3;
    ok(pushed.length > pushBeforeCtrl || audited.length > auditBeforeCtrl,
       "[13b] 负向对照：对未决卡 _settle ⇒ **确有副作用**（证明守卫不是恒真空跑）");
  }
}

/* ================================================================== ⑭ P2-1 */
console.log("\n[14] P2-1：密钥脱敏覆盖「前缀形态」（SECRET_TOKEN= / GITHUB_TOKEN= …）");
{
  const V = "VALUE-PLACEHOLDER";
  /** 前缀形态（秦戈 QA 实证的 5 例 + 小写/其它关键字）。 */
  const prefixForms = [
    "SECRET_TOKEN=" + V,
    "GITHUB_TOKEN=" + V,
    "MY_TOKEN=" + V,
    "AWS_SECRET_ACCESS_KEY=" + V,
    "DB_PASSWORD=" + V,
    "my_token=" + V,
    "npm_config_secret=" + V,
    "OPENAI_API_KEY=" + V,
    "SSH_PRIVATE_KEY=" + V,
    "PASSWD=" + V,
  ];
  let pl = 0;
  for (const c of prefixForms) {
    const out = sanitizeForAudit(c, 300, "/nohome");
    if (out.includes(V)) {
      pl += 1;
      console.log(`    LEAK: ${c} -> ${out}`);
    }
  }
  ok(pl === 0, `前缀形态 ${prefixForms.length} 例全部脱敏（0 泄漏）`);

  // 键名保留（可辨认）
  ok(sanitizeForAudit("SECRET_TOKEN=" + V, 300, "/nohome").includes("SECRET_TOKEN=<redacted>"),
     "前缀形态保留可辨认键名（SECRET_TOKEN=<redacted>）");

  // 既有独立形态回归（逐字不变）
  const plain = ["api_key=" + V, "token=" + V, "secret=" + V, "password=" + V];
  ok(plain.every((c) => !sanitizeForAudit(c, 300, "/nohome").includes(V)),
     "既有独立形态（api_key/token/secret/password）回归不变");

  // command 路径同样覆盖
  ok(!redactCommandForAudit("GITHUB_TOKEN=" + V + " npm publish", "/nohome").includes(V),
     "前缀形态在 command 审计路径也被脱敏");
  ok(redactCommandForAudit("GITHUB_TOKEN=" + V + " npm publish", "/nohome").includes("npm publish"),
     "command 审计仍保留命令结构");

  // 值必须**整个**吃掉（不留尾巴）—— 秦戈/team-lead 强调点
  const tail = redactCommandForAudit("SECRET_TOKEN=abc" + "TAIL" + " cmd", "/nohome");
  ok(!tail.includes("abcTAIL"), "前缀形态值被整个吃掉（不留尾巴）");

  // 不做前缀形态的关键字：X_AUTHORIZATION 不强制脱（team-lead 倾向不管），
  // 但带 `:` 的独立 authorization 仍脱
  ok(!sanitizeForAudit("Authorization: Bearer " + V, 300, "/nohome").includes(V),
     "独立 Authorization 仍脱敏");
}

/* ================================ [15] sanitizeDetail 口径归一（team-lead 裁定方案 a） */
console.log("\n[15] sanitizeDetail 密钥脱敏（口径归一：复用 approval.js 的 redactSecrets）");
{
  const V = "VALUE-PLACEHOLDER";

  // ① 同源：redactSecrets 是纯函数，approval 侧与 session 侧行为必须一致
  ok(redactSecrets("GITHUB_TOKEN=" + V) === sanitizeForAudit("GITHUB_TOKEN=" + V, 300, "/nohome"),
     "redactSecrets 与 sanitizeForAudit 的密钥口径**逐字一致**（同源）");
  ok(redactSecrets("GITHUB_TOKEN=" + V).includes("GITHUB_TOKEN=<redacted>"),
     "redactSecrets 保留可辨认键名");
  ok(redactSecrets("") === "" && redactSecrets(null) === "" && redactSecrets(undefined) === "",
     "redactSecrets 对空/null/undefined 返回空串（不抛）");

  // ② 必须脱敏的三类（team-lead 指定）
  ok(!sanitizeDetail("env GITHUB_TOKEN=" + V + " 失败").includes(V),
     "sanitizeDetail：GITHUB_TOKEN= 必须脱敏");
  ok(!sanitizeDetail("SECRET_TOKEN=" + V + " 无效").includes(V),
     "sanitizeDetail：SECRET_TOKEN= 必须脱敏");
  ok(!sanitizeDetail("HTTP 401 Authorization: Bearer " + V).includes(V),
     "sanitizeDetail：Authorization: Bearer 必须脱敏");
  ok(!sanitizeDetail("connect failed password=" + V + " host=x").includes(V),
     "sanitizeDetail：password= 必须脱敏");

  // ③ 反向对照：良性文本**不得被误伤**（脱敏过头会让错误信息没用）
  const benign = [
    "创建 Pi 会话失败：spawn ENOENT",
    "Pi 凭据不可用（需 ~/.pi/agent/auth.json 里至少一个可用 provider）",
    "auth.json 读取失败",
    "中断失败：AbortError: The operation was aborted",
    "结构化输出失败：JSON parse error at position 12",
    "写入失败：~/.minipi/outbox/note.txt 权限不足",
  ];
  let benignOk = true;
  for (const b of benign) {
    if (sanitizeDetail(b).includes("<redacted>")) {
      benignOk = false;
      console.log(`    ⚠ 误伤: ${b} -> ${sanitizeDetail(b)}`);
    }
  }
  ok(benignOk, `反向对照：${benign.length} 条良性文本（含 auth.json/outbox 路径）**无 <redacted>**`);
  ok(!sanitizeDetail("/a/token-cache/x.js 失败").includes("<redacted>"),
     "反向对照：目录名含 token 不误伤");

  // ④ 顺序证明：密钥脱敏必须在**截断之前**（否则跨截断点的密钥会被切一半而漏脱）
  const pad = "a".repeat(240);
  const crossing = pad + " GITHUB_TOKEN=ghp_" + "S".repeat(80);
  const out = sanitizeDetail(crossing, 300);
  ok(!out.includes("ghp_") && !out.includes("SSSS"),
     "顺序证明：跨截断点的密钥值**整段脱敏、不残留半截**");
  ok(out.includes("GITHUB_TOKEN=<redacted>"), "顺序证明：脱敏发生在路径替换之后、截断之前");

  // ⑤ 幂等：再套一次 redactSecrets 结果不变（同源函数可安全重复调用）
  const once = redactSecrets("GITHUB_TOKEN=" + V);
  ok(redactSecrets(once) === once, "redactSecrets 幂等（重复调用不二次破坏）");
}

/* ------------------------------------------------------------------ 汇总 */
console.log("\n" + "=".repeat(70));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项`);
console.log("=".repeat(70));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

clearInterval(KEEP_ALIVE);
process.exit(fail === 0 ? 0 : 1);
