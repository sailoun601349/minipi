/**
 * `outbox` 沙箱单测（纯 Node，不依赖 Electron / Pi SDK）。
 *
 * 对应施工方案：`docs/minipi-v0.4-impl-plan.md` §2（T0.3 验收）。
 *
 * 为什么单独一个脚本：本机 Electron GPU 进程会崩（`GPU process isn't usable`），
 * `npm run selftest` 跑不完。沙箱判定是**纯函数**，正好可以离线测。
 *
 * 覆盖：正常放行 / 逃逸拦截 / 前缀陷阱 / 新建文件 / junction 逃逸 /
 *       大小写 / 非写工具 / 场景分流。
 *
 * 用法：`node scripts/verify-sandbox.mjs`（退出码 0 = 全通过）
 *
 * ⚠ 诚实声明：junction 用例需要 Windows 权限。造不出来时脚本会打印
 *   「SKIP」并**明确标注未验证**，**不会**假装通过。详见运行输出。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isWriteAllowed,
  checkWriteTarget,
  sceneDisposition,
  normalizeToolPathLikeSdk,
  resolveToolPathLikeSdk,
  SANDBOX_DENY_REASON,
  WRITE_TOOLS,
} from "../src/main/pi/sandbox.js";

let pass = 0;
let fail = 0;
let skip = 0;
/** @type {string[]} */
const skipped = [];

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

/** 跳过（造不出环境），**如实记录**。 */
function skipCase(label, reason) {
  skip += 1;
  skipped.push(`${label} —— ${reason}`);
  console.log(`  SKIP  ${label}（未验证：${reason}）`);
}

console.log("=".repeat(70));
console.log(" minipi outbox 沙箱验证（纯 Node）");
console.log(` Node ${process.version} · platform ${process.platform}`);
console.log("=".repeat(70));

/* ------------------------------------------------------------------ 造测试沙箱 */
// 用系统临时目录造一个隔离的 outbox，避免污染真实 ~/.minipi/outbox。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-sandbox-test-"));
const outbox = path.join(tmpRoot, "outbox");
fs.mkdirSync(outbox, { recursive: true });
// 兄弟目录（前缀陷阱用）：outbox-evil，物理上在 outbox 之外，但字符串前缀相同。
const outboxEvil = path.join(tmpRoot, "outbox-evil");
fs.mkdirSync(outboxEvil, { recursive: true });
const outboxResolved = fs.realpathSync(outbox);

console.log(`\n 临时沙箱：${tmpRoot}`);
console.log(` outbox  ：${outboxResolved}`);

/** 便捷：用与 checkWriteTarget 相同的方式算 target，再判定。 */
function allowed(relOrAbs, sceneId = "note") {
  const r = checkWriteTarget({
    toolName: "write",
    input: { path: relOrAbs },
    cwd: outbox,
    outboxDir: outbox,
    sceneId,
  });
  return !r.blocked;
}

/* ================================================================ [1] 正常放行 */
console.log("\n[1] 正常放行（outbox 内）");
ok(allowed("note.md"), "相对路径 note.md → 放行");
ok(allowed("sub/a.txt"), "子目录 sub/a.txt（目录尚不存在）→ 放行");
ok(allowed(path.join(outbox, "abs.txt")), "outbox 内绝对路径 → 放行");
ok(allowed("a/b/c/deep.md"), "多层新目录 a/b/c/deep.md → 放行");
// 直接调 isWriteAllowed（核心判定）
ok(
  isWriteAllowed(path.resolve(outbox, "x.md"), outbox) === true,
  "isWriteAllowed 直调：outbox 内 → true",
);

/* ================================================================ [2] 逃逸拦截 */
console.log("\n[2] 逃逸拦截");
ok(!allowed("../x.txt"), "`../x.txt` → 拦截");
ok(!allowed("../../x.txt"), "`../../x.txt` → 拦截");
ok(!allowed("../../../../etc/passwd"), "深层逃逸 `../../../../etc/passwd` → 拦截");
ok(!allowed("sub/../../escape.txt"), "子目录里折返 `sub/../../escape.txt` → 拦截");
// 绝对路径写到 outbox 外
const absOut1 = process.platform === "win32" ? "C:\\Windows\\x.txt" : "/tmp/x.txt";
ok(!allowed(absOut1), `绝对路径 outbox 外（${absOut1}）→ 拦截`);
ok(
  !isWriteAllowed(path.join(tmpRoot, "outside.txt"), outbox),
  "兄弟目录 tmpRoot/outside.txt → 拦截",
);

/* ============================================ [2b] SDK 归一化差异（QA-P0-1 `@` 逃逸） */
console.log("\n[2b] SDK 归一化差异（先归一化再 resolve，与 SDK 同序）");
// 根因：SDK 的 resolveToCwd 会先剥前导 `@`（还会换 Unicode 空格、展开 ~）。
// 沙箱若直接 path.resolve(原串) 就会「校验 A 路径、SDK 写 B 路径」⇒ 逃逸。
// 修法：normalizeToolPathLikeSdk() 复刻 SDK 语义，且**先归一化再 resolve**。
ok(!allowed("@../evil.txt"), "`@../evil.txt` → 拦截（P0-1 回归）");
ok(!allowed("@../../evil.txt"), "`@../../evil.txt` → 拦截（P0-1 回归）");
ok(!allowed("@/tmp/x"), "`@/tmp/x`（剥 @ 后是绝对路径且越界）→ 拦截");
// 对照：`@` 只改写法、不改语义，outbox 内的仍应放行
ok(allowed("@note.md"), "`@note.md` → 放行（剥 @ 后仍在 outbox 内，未误杀）");
ok(allowed("@@note.md"), "`@@note.md` → 放行（只剥一个 @，落 outbox 内）");
// Unicode 空格归一（SDK 会把 NBSP/全角空格换成半角空格）
//
// ⚠ 这两条**不是**逃逸，别被「看着像 ../」骗了：
//   `..　/../evil` → 归一化 `".. /../evil"`：`".. "`（点+空格）在 Windows 是**普通目录名**
//       （实测 `mkdir(' ..')` 就在原地建目录，**不**折叠成 `..`），随后那个 `..` 把它抵消 ⇒ 落回 outbox 内。
//   `　../evil`    → 归一化 `" ../evil"`：同样落成 outbox 下的普通目录 `" .."` ⇒ 仍在 outbox 内。
//   两者的真正判据是「**与 SDK 同解**」，由 [11] 段落用真实 SDK 逐字对照。
ok(allowed("..\u3000/../evil"), "全角空格 `..　/../evil` → 放行（归一化后落回 outbox 内，非逃逸）");
ok(allowed("\u3000../evil"), "全角空格开头 `　../evil` → 放行（落成 outbox 内普通目录，非逃逸）");
ok(allowed("\u00A0../evil"), "NBSP 开头 `\\u00A0../evil` → 放行（同全角，非逃逸）");
// ~ 展开（SDK 默认展开；展开后若在 outbox 外 → 拦）
ok(!allowed("~/evil.txt"), "`~/evil.txt` → 拦截（~ 展开到 HOME，在 outbox 外）");

/* ================================================================ [3] 前缀陷阱 */
console.log("\n[3] 前缀陷阱（经典 bug）");
// outbox-evil 与 outbox 字符串前缀相同，但物理上在外 ⇒ 必须拦。
ok(!allowed(outboxEvil + path.sep + "x.txt"), "绝对路径 outbox-evil/x.txt → 拦截");
ok(
  isWriteAllowed(outboxEvil + path.sep + "x.txt", outbox) === false,
  "isWriteAllowed 直调：outbox-evil → false（未误判为 outbox 内）",
);
// 反向确认：真正的 outbox 内还是放行（防止前缀判定写太严）
ok(
  isWriteAllowed(path.join(outbox, "ok.txt"), outbox) === true,
  "对照：真 outbox/ok.txt → true（前缀判定未过严）",
);

/* ================================================================ [4] 新建文件 */
console.log("\n[4] 新建文件（目标/父目录均不存在）");
const newDeep = path.join(outbox, "brand-new-dir", "sub", "file.txt");
ok(fs.existsSync(newDeep) === false, "确认目标文件尚不存在");
ok(
  isWriteAllowed(newDeep, outbox) === true,
  "尚不存在的深层文件（向上取最后存在的祖先=outbox）→ 放行",
);
// 最极端：目标就是 outbox 本身（final === root）
ok(isWriteAllowed(outbox, outbox) === true, "target === outbox 本身 → 放行（final === root 分支）");

/* ================================================================ [5] junction / 符号链接逃逸 */
console.log("\n[5] junction / 符号链接逃逸");
// 造一个外部目录，再在 outbox 内建 link 指向它。
const outsideTarget = path.join(tmpRoot, "outside-secret");
fs.mkdirSync(outsideTarget, { recursive: true });

let linkMade = false;
let linkKind = "";
const linkPath = path.join(outbox, "link");
// Windows：junction 普通用户即可建（`fs.symlinkSync` 的 'junction' 类型不需要管理员）。
// 非 Windows：普通 symlink。
try {
  if (process.platform === "win32") {
    fs.symlinkSync(outsideTarget, linkPath, "junction");
    linkKind = "junction";
  } else {
    fs.symlinkSync(outsideTarget, linkPath, "dir");
    linkKind = "symlink";
  }
  linkMade = true;
} catch (err) {
  // 造不出来 → 不跳过逻辑，但要如实标注未验证。
  skipCase(
    "junction/symlink 逃逸（写 outbox/link/x.txt 必须拦）",
    `无法创建 ${process.platform === "win32" ? "junction" : "symlink"}：${err?.code ?? err?.message ?? err}`,
  );
}

if (linkMade) {
  // 确认 link 确实解到外部（防「link 建错方向」导致假通过）
  const linkReal = fs.realpathSync(linkPath);
  ok(
    linkReal === fs.realpathSync(outsideTarget),
    `已建 ${linkKind}：outbox/link → 外部目录（realpath 已解开）`,
  );
  // 关键断言：字符串上 outbox/link/x.txt 以 outbox 开头，但物理落点在外部 ⇒ 必须拦。
  ok(
    isWriteAllowed(path.join(linkPath, "x.txt"), outbox) === false,
    `${linkKind} 逃逸：写 outbox/link/x.txt → 拦截（realpath 解开后不在 outbox 内）`,
  );
  ok(
    !checkWriteTarget({
      toolName: "write",
      input: { path: path.join(linkPath, "x.txt") },
      cwd: outbox,
      outboxDir: outbox,
      sceneId: "note",
    }).blocked === false,
    `checkWriteTarget 同样拦截 ${linkKind} 逃逸`,
  );
  // 反向确认：外部目录自己直接写也拦
  ok(
    isWriteAllowed(path.join(outsideTarget, "y.txt"), outbox) === false,
    "外部目录直接写 outside-secret/y.txt → 拦截",
  );
}

/* ================================================================ [6] 大小写（Windows） */
console.log("\n[6] 大小写策略");
if (process.platform === "win32") {
  // Windows NTFS 不区分大小写：OUTBOX 与 outbox 是同一个目录，应放行（不误杀）。
  const upperOutbox = outbox.toUpperCase();
  const upperTarget = path.join(upperOutbox, "a.txt");
  ok(
    isWriteAllowed(upperTarget, outbox) === true,
    `Windows：大写 OUTBOX 路径 → 放行（不区分大小写，同目录不误杀）`,
  );
  ok(
    isWriteAllowed(path.join(outbox, "A.TXT"), outbox) === true,
    "Windows：文件名大小写不同 → 放行",
  );
  // 但 outbox-evil 用大写也仍是逃逸
  ok(
    isWriteAllowed(path.join(tmpRoot, "OUTBOX-EVIL", "x.txt"), outbox) === false,
    "Windows：OUTBOX-EVIL（大写兄弟目录）→ 仍拦截",
  );
} else {
  // 非 Windows（大小写敏感）：区分比较。这里只说明策略，用例随平台变。
  ok(
    isWriteAllowed(path.join(outbox, "a.txt"), outbox) === true,
    "非 Windows：正常小写路径 → 放行",
  );
  skipCase(
    "大小写差异用例（仅 Windows 有意义）",
    `当前平台 ${process.platform} 大小写敏感，用例不适用`,
  );
}

/* ================================================================ [7] 非写工具 */
console.log("\n[7] 非写工具（read / grep / find / ls）→ 不拦");
for (const tool of ["read", "grep", "find", "ls"]) {
  const r = checkWriteTarget({
    toolName: tool,
    input: { path: "C:\\Windows\\anything.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "note",
  });
  ok(r.blocked === false, `${tool} → 不拦（只读 allow 取舍）`);
}
// write / edit 是写工具
ok(WRITE_TOOLS.includes("write") && WRITE_TOOLS.includes("edit"), "WRITE_TOOLS = write, edit");

/* ================================================================ [8] 场景分流 */
console.log("\n[8] 场景分流");
// repo 场景：即使写到 outbox 外也**不**由沙箱拦（走审批闸门）。
const repoRes = checkWriteTarget({
  toolName: "write",
  input: { path: "C:\\Windows\\x.txt" },
  cwd: path.join(tmpRoot, "repo"),
  outboxDir: outbox,
  sceneId: "repo",
});
ok(repoRes.blocked === false, "repo 场景 → 不拦（沙箱对它无效，走审批闸门）");
// outbox 场景：同样的写入应被拦
const noteRes = checkWriteTarget({
  toolName: "write",
  input: { path: "C:\\Windows\\x.txt" },
  cwd: outbox,
  outboxDir: outbox,
  sceneId: "note",
});
ok(noteRes.blocked === true, "note 场景 → 拦截（对照，证明分流生效）");
ok(noteRes.reason === SANDBOX_DENY_REASON, "拒绝文案 === SANDBOX_DENY_REASON（逐字）");
// desk 同 note
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "../x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "desk",
  }).blocked === true,
  "desk 场景 → 拦截",
);
// quick 无工具可用，但若被调用也应拦
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "../x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "quick",
  }).blocked === true,
  "quick 场景 → 同样拦截（防御性）",
);
// 未知 sceneId → **拒绝**（fail-closed，QA-P2-2）
// 白名单语义：不在名单里的场景不让写，避免 protocol 新增场景时沙箱静默失效。
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "../x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "desk_clone",
  }).blocked === true,
  "未知 sceneId『desk_clone』→ 拒绝（fail-closed，已修 QA-P2-2）",
);
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "../x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "",
  }).blocked === true,
  "空 sceneId → 拒绝（fail-closed）",
);
// 对照：repo 仍放行（否则改代码场景全废，QA-P2-2 的修法不能把 repo 也拒了）
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "../x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "repo",
  }).blocked === false,
  "对照：repo → 仍放行（豁免场景不受影响）",
);
// sceneDisposition 三分
ok(sceneDisposition("note") === "sandbox", "sceneDisposition(note) = sandbox");
ok(sceneDisposition("repo") === "exempt", "sceneDisposition(repo) = exempt");
ok(sceneDisposition("nope") === "unknown", "sceneDisposition(nope) = unknown");
ok(sceneDisposition(undefined) === "unknown", "sceneDisposition(undefined) = unknown");

/* ================================================================ [9] 不 fail-open */
console.log("\n[9] 不 fail-open（异常一律拒绝）");
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "x.txt" },
    cwd: "",
    outboxDir: outbox,
    sceneId: "note",
  }).blocked === true,
  "缺 cwd → 拒绝（不 fail-open）",
);
ok(
  checkWriteTarget({
    toolName: "write",
    input: { path: "x.txt" },
    cwd: outbox,
    outboxDir: "",
    sceneId: "note",
  }).blocked === true,
  "缺 outboxDir → 拒绝（不 fail-open）",
);
ok(
  isWriteAllowed(path.join(outbox, "x.txt"), path.join(tmpRoot, "no-such-outbox")) === false,
  "outbox 路径不存在（realpath 失败）→ 拒绝（不 fail-open）",
);
ok(isWriteAllowed("", outbox) === false, "空 target → 拒绝");
ok(isWriteAllowed(path.join(outbox, "x.txt"), "") === false, "空 outbox → 拒绝");
ok(isWriteAllowed(null, outbox) === false, "target 非字符串（null）→ 拒绝");
// input.path 缺失 → **拒绝**（fail-closed，QA-P2-1）。
// 早先版本当空串处理、resolve 后 = cwd = outbox ⇒ 放行；那是 fail-open：
//   若 SDK 换字段名（path → file_path/target），raw 变 "" → 误判「在 outbox 内」→ 放行。
// 现在字段名取不到一律拒。沙箱宁可误杀也不能漏放。
ok(
  checkWriteTarget({
    toolName: "write",
    input: {},
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "note",
  }).blocked === true,
  "input.path 缺失 → 拒绝（fail-closed，已修 QA-P2-1）",
);
ok(
  checkWriteTarget({
    toolName: "write",
    input: { file_path: "x.txt" },
    cwd: outbox,
    outboxDir: outbox,
    sceneId: "note",
  }).blocked === true,
  "错字段名 file_path → 拒绝（fail-closed，SDK 换名即拦）",
);

/* ============================================== [10] 钩子接线形状（模拟 registerGate） */
console.log("\n[10] 钩子接线形状（模拟 session.js 的 registerGate）");
// session.js 会 import Pi SDK，纯 Node 起不来。这里**逐行复刻**registerGate 里的
// 判定顺序与返回形状，用一个假 pi 跑一遍，证明：
//   · 沙箱违例 → `{ block: true, reason }`（符合 Pi SDK 的 ToolCallEventResult 形状）
//   · 合法写入 / 非沙箱场景 → `undefined`（放行）
// ⚠ 这是**复刻**，不是直接执行 session.js。真实 session.js 的挂载仍需 Electron 环境。
const OUTBOX_SCENE_IDS = ["quick", "note", "desk"];
function simulateGate({ sceneId, cwd, outboxDir }) {
  const handlers = {};
  const fakePi = { on: (name, fn) => { handlers[name] = fn; } };
  // —— 以下 6 行与 session.js registerGate() 的规则 1 逐字对应 ——
  const sandboxed = OUTBOX_SCENE_IDS.includes(sceneId);
  fakePi.on("tool_call", (event) => {
    if (sandboxed) {
      const verdict = checkWriteTarget({
        toolName: event?.toolName,
        input: event?.input,
        cwd,
        outboxDir,
        sceneId,
      });
      if (verdict.blocked) return { block: true, reason: verdict.reason };
    }
    return undefined;
  });
  return handlers.tool_call;
}

const gate = simulateGate({ sceneId: "note", cwd: outbox, outboxDir: outbox });
const illegal = gate({ toolName: "write", input: { path: "../x.txt" } });
ok(
  illegal && illegal.block === true && typeof illegal.reason === "string",
  "沙箱违例 → { block: true, reason }（符合 ToolCallEventResult 形状）",
);
ok(illegal.reason === SANDBOX_DENY_REASON, "钩子回灌的 reason 与 SANDBOX_DENY_REASON 逐字一致");
ok(illegal.terminate === undefined, "不返回 terminate（沙箱违例是单次操作非法，非整轮停止）");
const legal = gate({ toolName: "write", input: { path: "ok.md" } });
ok(legal === undefined, "合法写入 → undefined（放行，不改参不阻断）");
const readEv = gate({ toolName: "read", input: { path: "C:\\Windows\\x" } });
ok(readEv === undefined, "read 工具 → undefined（不拦，只读 allow）");

const repoGate = simulateGate({ sceneId: "repo", cwd: path.join(tmpRoot, "repo"), outboxDir: outbox });
ok(
  repoGate({ toolName: "write", input: { path: "C:\\Windows\\x" } }) === undefined,
  "repo 场景 → undefined（沙箱不分流，走审批闸门）",
);

/* ==================================== [11] 与「真实 SDK」对照（防手抄自证自洽） */
console.log("\n[11] 镜像 vs 真实 SDK resolveToCwd（防「两人抄错同一处」）");
// 这是本文件里**唯一**直接 import SDK 的用例，且**仅测试用**（生产代码 sandbox.js 仍零依赖）。
// 目的：如果 sandbox.js 的归一化镜像与 SDK 的真实行为不一致，这两组结果会分叉。
// 若 SDK 不在（未 npm install），跳过并如实标注。
let sdkCmp = false;
try {
  const { pathToFileURL } = await import("node:url");
  const sdkMod = await import(
    pathToFileURL(path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js")).href
  );
  const { resolveToCwd } = sdkMod;
  // 用例覆盖：@ 前缀 / 剥一个 @ / Unicode 空格 / ~ 展开 / win 盘符 / absolut / 畸形 file://
  const vectors = [
    "note.md",
    "../evil.txt",
    "@../evil.txt",
    "@../../evil2.txt",
    "@note.md",
    "@@note.md",
    "@",
    "~",
    "~/x.md",
    "~/.minipi/outbox/x.md",
    "/tmp/x.md",
    "@/tmp/x",
    "/c/Windows/x",
    "/mnt/c/Windows/x",
    "/cygdrive/c/Windows/x",
    "file:///C:/Windows/x.txt",
    "sub/@x",
    "..\u3000/../evil",
    "\u00a0../evil",
    "",
    ".",
    "../",
    "C:\\\\Windows\\\\x",
  ];
  let mismatches = 0;
  for (const v of vectors) {
    const sdkTarget = resolveToCwd(v, outbox);
    let mineTarget;
    try {
      mineTarget = resolveToolPathLikeSdk(normalizeToolPathLikeSdk(v), outbox);
    } catch (err) {
      mineTarget = `THROW ${err?.code ?? err?.message}`;
    }
    if (sdkTarget !== mineTarget) {
      mismatches += 1;
      console.log(`  DIFF  ${JSON.stringify(v)} · sdk=${sdkTarget} · mine=${mineTarget}`);
    }
  }
  ok(mismatches === 0, `镜像与真实 SDK 逐字一致（${vectors.length} 个向量，差异 ${mismatches}）`);
  sdkCmp = true;
} catch (err) {
  skipCase(
    "镜像 vs 真实 SDK resolveToCwd 对照",
    `无法加载 SDK 的 path-utils：${err?.code ?? err?.message ?? err}`,
  );
}
void sdkCmp;

/* ------------------------------------------------------------------ 清理 */
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n${"=".repeat(70)}`);
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项 · 跳过（未验证）${skip} 项`);
if (skipped.length > 0) {
  console.log(" 未验证用例（如实标注，未假装通过）：");
  for (const s of skipped) console.log(`   · ${s}`);
}
console.log("=".repeat(70));

process.exit(fail === 0 ? 0 : 1);
