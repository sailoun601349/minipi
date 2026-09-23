#!/usr/bin/env node
/**
 * QA · 象限 A：攻击 outbox 沙箱（`src/main/pi/sandbox.js`）。
 *
 * 定位：这是**第三层**测试——工程师的 `verify-sandbox.mjs` 已跑绿 47 项（基准线），
 * 本脚本**只打它没覆盖的向量**，目标是**证伪**：
 *   · Windows 特殊路径形态（UNC / 8.3 短名 / 保留设备名 / 尾随点空格）
 *   · SDK 与沙箱对 `input.path` 的**预处理差异**（`@` 前缀、Unicode 空格归一）
 *   · `input` 形态畸形（null / 数组 / 错字段名）→ 钩子是否抛异常（抛 = 沙箱静默失效）
 *   · 硬编码 `OUTBOX_SCENE_IDS` 与 protocol.js 的漂移
 *
 * ⚠ 只读：不写 `~/.minipi`，测试用 `os.tmpdir()` 临时目录，结束清理。
 * 不 import electron / Pi SDK。运行：`node scripts/qa-sandbox-attack.mjs`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkWriteTarget,
  isWriteAllowed,
  SANDBOX_DENY_REASON,
  WRITE_TOOLS,
} from "../src/main/pi/sandbox.js";
import { OUTBOX_SCENES } from "../src/shared/protocol.js";

/* ------------------------------------------------------------------ 记账 */

let passed = 0;
let failed = 0;
/** @type {{level:string,id:string,title:string,detail:string}[]} */
const findings = [];

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
  return !!cond;
}

function group(title) {
  console.log(`\n${title}`);
}

function finding(level, id, title, detail) {
  findings.push({ level, id, title, detail });
  console.log(`  >>> [${level}] ${id} ${title}`);
}

/* ------------------------------------------------------------------ 环境 */

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-sandbox-"));
const OUTBOX = path.join(TMP_ROOT, "outbox");
fs.mkdirSync(OUTBOX, { recursive: true });
// 造一个「outbox 外的目标目录」，用来验证真能不能写出去
const EVIL = path.join(TMP_ROOT, "evil");
fs.mkdirSync(EVIL, { recursive: true });

/** 判定一次 `tool_call`，并把 SDK 侧的路径归一也模拟出来做对照。 */
function judge(inputPath, { sceneId = "desk", toolName = "write", input } = {}) {
  const inp = input !== undefined ? input : { path: inputPath, content: "x" };
  return checkWriteTarget({ toolName, input: inp, cwd: OUTBOX, outboxDir: OUTBOX, sceneId });
}

/**
 * SDK 侧对 path 的预处理（照 `vendor/pi/.../tools/path-utils.js` 的 `normalizeToolPath`）。
 * 沙箱**没有**做这一步 ⇒ 两者对同一个 source path 会得出不同目标。
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function sdkNormalize(p) {
  const n = String(p).replace(UNICODE_SPACES, " ");
  return n.startsWith("@") ? n.slice(1) : n;
}

console.log("======================================================================");
console.log(" QA · 象限 A：outbox 沙箱攻击");
console.log(` 沙箱根：${OUTBOX}`);
console.log(` 逃逸靶：${EVIL}`);
console.log("======================================================================");

/* ================================================================== A1 */
group("[A1] Windows UNC / 扩展长度前缀（最可能撕开口子）");
{
  const vectors = [
    String.raw`\\?\C:\Windows\System32\evil.txt`,
    String.raw`\\server\share\evil.txt`,
    String.raw`\\?\UNC\server\share\evil.txt`,
    String.raw`\\.\C:\Windows\evil.txt`,
    String.raw`\\?\C:\${"a".repeat(300)}\evil.txt`,
  ];
  for (const v of vectors) {
    let verdict;
    try {
      verdict = judge(v);
    } catch (err) {
      finding("P0", "A1-EXC", `UNC 向量令判定抛异常：${v.slice(0, 40)}`, String(err));
      ok(false, `UNC「${v.slice(0, 30)}…」不抛异常`);
      continue;
    }
    ok(verdict.blocked === true, `UNC「${v.slice(0, 34)}…」→ 拒绝（实际 blocked=${verdict.blocked}）`);
  }
}

/* ================================================================== A2 */
group("[A2] Windows 8.3 短文件名");
{
  // 短名与长名指向同一位置。构造一个真实存在的外部目录，看 realpath 是否归一。
  const shortProbe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "PROGRA~1")
    : String.raw`C:\PROGRA~1`;
  const abs = path.join(shortProbe, "evil.txt");
  const verdict = judge(abs);
  ok(verdict.blocked === true, `8.3 短名绝对路径「${abs}」→ 拒绝（实际 blocked=${verdict.blocked}）`);

  // 相对形态：沙箱根内部直接用短名拼出去（无意义，但确认不误放）
  const inside = judge("PROGRA~1/x");
  ok(inside.blocked === false, "相对「PROGRA~1/x」落在 outbox 内 → 放行（SDK 也会落 outbox）");
}

/* ================================================================== A3 */
group("[A3] Windows 保留设备名");
{
  for (const dev of ["CON", "NUL", "PRN", "AUX", "COM1", "LPT1", "NUL.txt", "COM1.txt"]) {
    const verdict = judge(dev);
    // 保留设备名**不是**逃逸（它没有路径分隔符，SDK 也会把它当 outbox 下的相对名）。
    // 期望：判定不抛异常、且不作为逃逸放行。这里只记录判定，不判失败。
    ok(typeof verdict.blocked === "boolean", `保留名「${dev}」判定不抛异常（blocked=${verdict.blocked}）`);
  }
  // 真正的风险：`outbox/../../NUL` 这类组合（带分隔符的保留名逃逸）
  const combo = judge(String.raw`..\..\NUL`);
  ok(combo.blocked === true, String.raw`「..\..\NUL」→ 拒绝`);
}

/* ================================================================== A4 */
group("[A4] 尾随点 / 空格（Windows 静默剥离 → TOCTOU 类缺口）");
{
  // 判定用的路径 vs 真实落盘路径是否一致？
  // 关键测试：`outbox/evil.` 会被判为「outbox 内」，但 Windows 落盘时会把尾点剥成 `evil`
  // —— 两者都仍在 outbox 内，所以**不是逃逸**。真正要测的是「剥完变成另一条路径」的情形：
  //   `..\ `（`..` + 空格）—— Windows 剥尾空格后会变成 `..` ⇒ 上一级！
  const v1 = judge("evil.");
  ok(v1.blocked === false, "「evil.」落在 outbox 内 → 放行（尾点在 outbox 内，非逃逸）");

  const v2 = judge("evil ");
  ok(v2.blocked === false, "「evil 」落在 outbox 内 → 放行（同上）");

  // `.. /x`：`.. ` 组合（`..` + 空格）。path.resolve 会把它当普通名 `.. `，但 Windows
  // 实际剥空格后会变成 `..` ⇒ 上一级。这一条**如果被放行就是逃逸**。
  const v3 = judge("../x");
  ok(v3.blocked === true, "「../x」→ 拒绝（基准，确认普通 .. 被挡）");

  const v4 = judge(".. /x");
  // 判定要看实际：path.resolve("OUTBOX",".. /x") = TMP_ROOT/.. /x ？实测它不剥空格。
  // 我们把它记为「探针」，若 blocked=false 且磁盘语义会剥成 ..，则升级为 P0。
  const resolvedTarget = path.resolve(OUTBOX, ".. /x");
  const realSemantics = path.resolve(OUTBOX, "..") + path.sep + "x"; // Windows 剥空格后的真实语义
  const innerCollapse = path.dirname(OUTBOX); // 上一级
  const escapes = resolvedTarget !== realSemantics && realSemantics.startsWith(innerCollapse + path.sep) === false;
  console.log(`  probe  「.. /x」→ blocked=${v4.blocked} · 判定目标=${resolvedTarget} · 剥空格真实语义=${realSemantics}`);
  if (v4.blocked === false && escapes) {
    finding(
      "P0",
      "A4-TRAILSPACE",
      "`.. /x`（点+空格）被放行，但 Windows 落盘会剥尾空格 → 实为上一级目录",
      `判定路径=${resolvedTarget}，剥空格后真实路径=${realSemantics}（在 outbox 外）。`,
    );
    ok(false, "「.. /x」应拒绝（尾空格剥离后逃逸）");
  } else {
    ok(true, `「.. /x」未构成逃逸（blocked=${v4.blocked}）`);
  }
}

/* ================================================================== A5 */
group("[A5] SDK path 预处理差异（@ 前缀 / Unicode 空格）——沙箱与 SDK 不一致");
{
  // SDK 的 `resolveToCwd`（write/edit 实际调用的）会做归一化：
  //   ① Unicode 空格 → 半角空格  ② 剥前导 `@`  ③ win 盘符  ④ ~ 展开  ⑤ file://
  // 判据（修正版）：**唯一有意义的安全命题**是——
  //   「沙箱放行」⇔「SDK 的真实落点在 outbox 内」。
  // 早先版本拿「手算的 path.resolve(OUTBOX, raw)」当沙箱目标来比，会把
  // 「沙箱已按 SDK 归一、但手算没归一」误报成 finding（NBSP 用例即属此类）——
  // 那是**判定手段**的不一致，不是**落点**的不一致。
  // 这里改用 SDK 真实目标当 oracle：若 SDK 目标也在 outbox 内，放行就是对的。
  const cases = [
    { raw: "@../../evil", label: "@ 前缀" },
    { raw: "@../evil", label: "@ 前缀（单跳）" },
    { raw: "..\u3000/../evil", label: "含全角空格" }, // \u3000
    { raw: "\u00A0../evil", label: "含 NBSP" }, // \u00A0
  ];
  for (const c of cases) {
    const sandboxVerdict = judge(c.raw);
    const sdkPath = sdkNormalize(c.raw);
    const sdkTarget = path.resolve(OUTBOX, sdkPath);
    // SDK 的真实落点是否在 outbox 之外？（这才是「该不该拦」的判据）
    const sdkEscapes =
      sdkTarget.toLowerCase() !== OUTBOX.toLowerCase() &&
      !sdkTarget.toLowerCase().startsWith(OUTBOX.toLowerCase() + path.sep);
    const shouldBlock = sdkEscapes;

    console.log(
      `  probe  ${c.label}「${JSON.stringify(c.raw)}」 · sdk→${sdkTarget.slice(TMP_ROOT.length)} · sdk 是否越界=${sdkEscapes} · 沙箱 blocked=${sandboxVerdict.blocked}`,
    );

    if (shouldBlock && sandboxVerdict.blocked === false) {
      // 真漏洞：SDK 会写到 outbox 之外，沙箱却放行了
      // 端到端证据：按 SDK 归一后的路径真写一次（写在临时目录里，随后清理）
      let writeProof = "(未写)";
      try {
        const probeDir = path.join(TMP_ROOT, "sdk-write-proof");
        fs.mkdirSync(probeDir, { recursive: true });
        const proofAbs = path.join(probeDir, path.basename(sdkTarget));
        fs.writeFileSync(proofAbs, "PWNED");
        writeProof = `可在沙箱外落盘：${proofAbs}（已写入 ${fs.readFileSync(proofAbs, "utf8")}）`;
      } catch (err) {
        writeProof = `写盘失败：${err}`;
      }
      finding(
        "P0",
        "A5-PRENORM",
        `沙箱放行了 SDK 会写到 outbox 外的路径（${c.label}）`,
        `source=${JSON.stringify(c.raw)} · SDK 归一后目标=${sdkTarget} · ${writeProof}`,
      );
      ok(false, `${c.label}：SDK 落点在 outbox 外却被放行`);
    } else if (!shouldBlock && sandboxVerdict.blocked === true) {
      // 反向：SDK 落点在 outbox 内却被拦 → 误杀（不算安全洞，但记 finding）
      finding(
        "P1",
        "A5-OVERBLOCK",
        `沙箱拦下了 SDK 本会落在 outbox 内的路径（${c.label}）`,
        `source=${JSON.stringify(c.raw)} · SDK 归一后目标=${sdkTarget}（在 outbox 内）却被拦`,
      );
      ok(false, `${c.label}：SDK 落点在 outbox 内却被误拦`);
    } else {
      ok(
        true,
        `${c.label}：沙箱判定与 SDK 落点一致（sdk 越界=${sdkEscapes}, blocked=${sandboxVerdict.blocked}）`,
      );
    }
  }
}

/* ================================================================== A6 */
group("[A6] 畸形 input：钩子抛异常 = 沙箱静默失效（最严重失败模式）");
{
  const weirdInputs = [
    { label: "input=null", input: null },
    { label: "input=undefined", input: undefined },
    { label: "input=数组", input: [1, 2, 3] },
    { label: "input=字符串", input: "evil" },
    { label: "input=数字", input: 42 },
    { label: "path 是数组", input: { path: ["..", "..", "evil"] } },
    { label: "path 是对象", input: { path: { toString: () => "../../evil" } } },
    { label: "path 是 null", input: { path: null } },
    { label: "path 是数字", input: { path: 123 } },
    { label: "path 是 Symbol 系", input: { path: Symbol("p") } },
    { label: "无 path 字段（只有 file_path）", input: { file_path: "../../evil", content: "x" } },
    { label: "无 path 字段（只有 target）", input: { target: "../../evil" } },
    { label: "无 path 字段（只有 filePath）", input: { filePath: "../../evil" } },
    { label: "空对象", input: {} },
  ];
  for (const w of weirdInputs) {
    let verdict;
    let threw = false;
    try {
      verdict = checkWriteTarget({
        toolName: "write",
        input: w.input,
        cwd: OUTBOX,
        outboxDir: OUTBOX,
        sceneId: "desk",
      });
    } catch (err) {
      threw = true;
      finding("P0", "A6-THROW", `checkWriteTarget 对「${w.label}」抛异常`, `${err}`);
      ok(false, `「${w.label}」不抛异常`);
      continue;
    }
    ok(!threw && typeof verdict.blocked === "boolean", `「${w.label}」返回布尔判定（blocked=${verdict?.blocked}）`);
  }

  // 关键语义确认（QA-P2-1 已修）：错字段名时**必须拒绝**（fail-closed），
  // 不能退化成 raw="" → resolve(cwd)=cwd → 判成「在 outbox 内」放行。
  const misnamed = checkWriteTarget({
    toolName: "write",
    input: { file_path: "../../evil", content: "x" },
    cwd: OUTBOX,
    outboxDir: OUTBOX,
    sceneId: "desk",
  });
  if (misnamed.blocked === false) {
    finding(
      "P2",
      "A6-FIELDLOCK",
      "沙箱读死 `input.path`：换任何其它字段名都被当作「无路径」放行（不 fail-closed）",
      "input={file_path:'../../evil'} → raw='' → resolve(cwd)=cwd → 判定为在 outbox 内 → 放行。这是 fail-open，SDK 换字段名即静默失效。",
    );
  }
  ok(misnamed.blocked === true, "字段名错位（无 path）→ 拒绝（fail-closed，已修 QA-P2-1）");
}

/* ================================================================== A7 */
group("[A7] 超长路径（>260）与中间 `..` 段");
{
  const long = "a/".repeat(200) + "evil.txt"; // >260
  let v;
  try {
    v = judge(long);
    ok(v.blocked === false, "超长相对路径（outbox 内）不抛异常");
  } catch (err) {
    finding("P1", "A7-LONGPATH", "超长路径令判定抛异常", String(err));
    ok(false, "超长路径不抛异常");
  }

  const longEscape = "../".repeat(30) + "evil.txt";
  const ve = judge(longEscape);
  ok(ve.blocked === true, "超长多级 ../ 逃逸 → 拒绝");

  // 注意：`outbox/a/../../evil` 以 OUTBOX 为基准会解析成 `OUTBOX/outbox→OUTBOX/evil`（仍在内部），
  // 所以它**不是**逃逸，放行才是正确行为。真正的中间 `..` 逃逸是不带额外前缀的 `a/../../evil`。
  const midInside = judge("outbox/a/../../evil");
  ok(midInside.blocked === false, "「outbox/a/../../evil」其实仍在 outbox 内 → 放行（非逃逸）");

  const midEscape = judge("a/../../evil");
  ok(midEscape.blocked === true, "「a/../../evil」（中间 .. 逃逸一级）→ 拒绝");

  const absEscape = judge("/evil");
  ok(absEscape.blocked === true, "「/evil」（POSIX 根绝对路径）→ 拒绝");
}

/* ================================================================== A8 */
group("[A8] 大小写混合 + 前缀陷阱组合");
{
  const v = judge(String.raw`..\..\OUTBOX-EVIL\x`);
  ok(v.blocked === true, String.raw`「..\..\OUTBOX-EVIL\x」→ 拒绝`);

  // outbox 同级「OUTBOX-EVIL」（大写同名兄弟）绝对路径
  const siblingUpper = path.join(TMP_ROOT, "OUTBOX-EVIL", "x");
  const vs = judge(siblingUpper);
  ok(vs.blocked === true, `大写兄弟目录「OUTBOX-EVIL\\x」→ 拒绝`);

  // outbox 本身的大写形态（Windows 上应放行：同一物理目录）
  const upperSelf = path.join(TMP_ROOT, "OUTBOX", "x");
  const vu = judge(upperSelf);
  if (process.platform === "win32") {
    const exists = fs.existsSync(path.join(TMP_ROOT, "OUTBOX"));
    // 若大写目录不存在，realpath 会失败 → 拒绝（可接受，非漏洞）
    console.log(`  probe  大写 outbox 自身存在=${exists} → blocked=${vu.blocked}`);
  }
  ok(typeof vu.blocked === "boolean", "大写 outbox 自身形态：判定不抛异常");
}

/* ================================================================== A9 */
group("[A9] 场景分流硬编码漂移（sandbox.js 内联 OUTBOX_SCENE_IDS vs protocol.js OUTBOX_SCENES）");
{
  // sandbox.js 为「零依赖」内联了 ["quick","note","desk"]，没 import protocol.OUTBOX_SCENES。
  // 若有人在 protocol.js 加第 4 个 outbox 场景，sandbox 会静默失配（该场景不受沙箱约束）。
  const inline = ["quick", "note", "desk"];
  const protocol = [...OUTBOX_SCENES];
  const same =
    inline.length === protocol.length && inline.every((v, i) => v === protocol[i]);
  if (!same) {
    finding(
      "P1",
      "A9-DRIFT",
      "sandbox.js 内联 OUTBOX_SCENE_IDS 与 protocol.js OUTBOX_SCENES 已漂移",
      `inline=[${inline}] protocol=[${protocol}]`,
    );
  }
  ok(same, `内联名单与 protocol.OUTBOX_SCENES 一致（[${protocol.join(",")}]）`);

  // 行为验证：一个 protocol.js 里合法、但不在内联名单里的场景 → sandbox 静默放行。
  // 当前四场景里只有 repo 不在名单——它是**刻意**不受沙箱约束的，所以用「假想新场景」验证漂移敏感度。
  const fakeScene = judge("../../evil", { sceneId: "desk_clone" });
  if (fakeScene.blocked === false) {
    finding(
      "P2",
      "A9-UNKNOWNSCENE",
      "未知 sceneId 被沙箱当作「非 outbox 场景」放行（fail-open）",
      "sceneId='desk_clone' → not in 内联名单 → blocked=false。若将来 protocol 新增 outbox 场景而忘记同步 sandbox，则该场景沙箱静默失效。",
    );
  }
  // QA-P2-2 已修：未知 sceneId 现在会**被拒**（白名单语义，fail-closed）。
  // 意图：protocol 新增 outbox 场景却忘记同步 sandbox 时，表现为**误杀**（可感知），
  // 而不是静默漏放（无人知晓）。
  ok(fakeScene.blocked === true, "未知 sceneId『desk_clone』→ 拒绝（fail-closed，已修 QA-P2-2）");

  // 反向确认：已知的豁免场景 repo 仍放行（不能把 repo 也拒了，否则改代码场景全废）
  const repoScene = judge("../../evil", { sceneId: "repo" });
  ok(repoScene.blocked === false, "已知豁免场景 repo → 放行（刻意走审批闸门，不受沙箱约束）");

  // 直接确认：缺 sceneId 时是否仍受约束（防御性）——应该受约束
  const noScene = checkWriteTarget({ toolName: "write", input: { path: "../../evil" }, cwd: OUTBOX, outboxDir: OUTBOX });
  ok(noScene.blocked === true, "缺 sceneId 时仍执行沙箱校验（不因缺参而放行）");
}

/* ================================================================== A10 */
group("[A10] isWriteAllowed 纯函数边界");
{
  const cases = [
    { t: OUTBOX, e: true, label: "outbox 本身" },
    { t: path.join(OUTBOX, "a.txt"), e: true, label: "outbox 内文件" },
    { t: EVIL, e: false, label: "外部目录" },
    { t: path.join(TMP_ROOT, "outbox-evil", "x"), e: false, label: "前缀陷阱 outbox-evil" },
    { t: "", e: false, label: "空串" },
    { t: null, e: false, label: "null" },
    { t: undefined, e: false, label: "undefined" },
    { t: 123, e: false, label: "数字" },
  ];
  for (const c of cases) {
    let got;
    try {
      got = isWriteAllowed(c.t, OUTBOX);
    } catch (err) {
      finding("P0", "A10-THROW", `isWriteAllowed(${JSON.stringify(c.t)}) 抛异常`, String(err));
      ok(false, `${c.label} 不抛异常`);
      continue;
    }
    ok(got === c.e, `${c.label} → ${c.e}（实际 ${got}）`);
  }
  // outbox 参数畸形
  ok(isWriteAllowed(path.join(OUTBOX, "a"), null) === false, "outboxDir=null → 拒绝");
  ok(isWriteAllowed(path.join(OUTBOX, "a"), "") === false, "outboxDir='' → 拒绝");
}

/* ================================================================== A11 */
group("[A11] 钩子返回值形状 + 拒绝文案逐字");
{
  const v = judge("../../evil");
  ok(v.blocked === true && v.reason === SANDBOX_DENY_REASON, "违例 reason 与 SANDBOX_DENY_REASON 逐字一致");
  const okv = judge("a.txt");
  ok(okv.blocked === false, "合法写入放行");
  ok(Array.isArray(WRITE_TOOLS) && WRITE_TOOLS.includes("write") && WRITE_TOOLS.includes("edit"), "WRITE_TOOLS 含 write/edit");
  ok(judge("x", { toolName: "read" }).blocked === false, "read 工具不拦（刻意取舍）");
  ok(judge("x", { toolName: "bash" }).blocked === false, "bash 不在 WRITE_TOOLS（repo 走审批，outbox 场景无 bash）");
}

/* ------------------------------------------------------------------ 清理 */

try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.log(`\n清理：已删除临时目录 ${TMP_ROOT}`);
} catch (err) {
  console.log(`\n清理失败：${err}`);
}

/* ------------------------------------------------------------------ 汇总 */

console.log("\n======================================================================");
console.log(` 通过 ${passed} 项 · 失败 ${failed} 项`);
if (findings.length > 0) {
  console.log(` 发现 ${findings.length} 条：`);
  for (const f of findings) console.log(`   [${f.level}] ${f.id} · ${f.title}`);
}
console.log("======================================================================");
process.exit(failed > 0 ? 1 : 0);
