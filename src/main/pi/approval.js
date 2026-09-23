/**
 * M4 审批闸门（`repo` 场景护栏）—— 纯 Node 模块，**零依赖**。
 *
 * 设计依据：`docs/minipi-approval-gate-design.md` v1.1（唯一来源）。本文件按该设计实现，
 * 逐条对齐 §2（异步钩子/路径 A）、§3（三类卡 + edit 真实 diff）、§4（批合并）、
 * §5（超时默认拒绝）、§6（持久化丢弃）、§7（审计脱敏）、§8（repo 才进闸门）。
 *
 * ## 为什么本模块不 import electron / 不 import Pi SDK
 *
 * 与 `sandbox.js` / `outcome/index.js` 同款约束：要能在**纯 Node** 下被
 * `scripts/verify-approval.mjs` 离线单测（本机 Electron GPU 会崩，起不了真窗口）。
 * 所以「推卡 / 撤回卡 / 审计落盘」全部走**注入的 bridge**；`~/.minipi` 根目录也可注入
 * （测试用临时目录）。`src/main/index.js` 负责注入真实的 electron 实现。
 *
 * ## 与 sandbox.js 的关系（⚠ 刻意解耦）
 *
 * **不 import `sandbox.js`**。沙箱（规则 1）管「写路径落在哪」，审批（规则 2）管
 * 「会改系统的全部动作」。二者名单不同（`WRITE_TOOLS` vs `APPROVAL_TOOLS`）、
 * 顺序固定（沙箱先、审批后，由 `session.js` 的同一个钩子保证）。本模块只做审批。
 *
 * ## ⚠ 审批**禁止**改动 `event.input`（不是「没做」，是「不许做」）
 *
 * vendor 明示 `event.input` 可变（`types.d.ts:721-722`：*"`event.input` is mutable … No
 * re-validation is performed after mutation."*）。但**本审批闸门只用它来「看」，绝不用它来「改」**：
 * 改参会**绕过沙箱与一切校验**（vendor 原文：改动后不再重新校验），是产品级安全隐患。
 * 审批的唯一权力是「放行 / 拒绝 / 中断」，**无权改模型给的内容**。
 * ⇒ 后来者若想「顺手规范化一下路径 / 命令」，**停下来**：那是沙箱与 SDK 的职责，不是审批的。
 *
 * ## 实现路径 = A（异步钩子）
 *
 * vendor 已确证 `tool_call` 钩子可返回 Promise 且 runner `await` 它
 * （`types.d.ts:902` `ExtensionHandler = (event, ctx) => Promise<R|void> | R | void`；
 * `runner.js:753` `const handlerResult = await handler(event, ctx);`）。
 * ⇒ `session.js` 规则 2 里 `return await approval.request(...)`，「等人」就是 `await`。
 *
 * ## 三个 outcome（v1.1 / 任务 #3 拍板）
 *
 * `allowOnce`（允许一次）/ `deny`(拒绝) / `terminate`(中断整轮)。语义见 `protocol.js`
 * `APPROVAL_ACTIONS` 的 JSDoc。`terminate` 是 **every 语义**（`types.d.ts:822-826`），
 * 由 `session.js` 对整批统一带 `terminate`。
 *
 * ## 安全底线（与沙箱同款口径）
 *
 * - **超时 = 默认拒绝**（fail-closed，绝不 fail-open）。
 * - **重启一律丢弃 pending，绝不当作「已允许」**（§6.4）。
 * - **decide 的 id 若不存在或已决 ⇒ 抛 `APPROVAL_NOT_FOUND`**（不静默成功）。
 * - 审计 / 落盘内容**必须脱敏**；发给渲染层的卡里 `command` 除外（§7.3，用户判断依据）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  APPROVAL_ACTION_IDS,
  APPROVAL_TOOLS,
  ERROR_CODES,
  LIMITS,
  errorMessage,
} from "../../shared/protocol.js";

/* ========================================================================== *
 * 0. 常量（口径全部来自设计 §3 / §5 / §7）
 * ========================================================================== */

/**
 * 拒绝回灌给模型的文案（英文逐字，设计 §5.3）。
 *
 * **三套必须分开**——模型应对不同：
 *   · TIMEOUT   → 用户没响应，可再问（含 `did not respond`，是 verify 的验锚点）
 *   · USER deny → 用户明确拒绝这条，**别再试**，改问用户想怎么做
 *   · TERMINATE → 用户点了「中断整轮」，**整轮已停**，不要再继续这一轮的任何动作
 * 共用同一句会让「中断整轮」退化成「拒绝这一条」，按钮语义失效（team-lead R3 裁定）。
 */
export const DENY_REASON_TIMEOUT =
  "The user did not respond to the approval request within 5 minutes, so this action was denied by default.\nDo not retry this action automatically. Briefly tell the user the action is pending their approval.";

export const DENY_REASON_USER =
  "The user explicitly denied this action. Do not retry it. Ask the user what they want to do instead.";

/** terminate（中断整轮）专用文案：明确告知模型「整轮已停」，而非「这条不行」。 */
export const DENY_REASON_TERMINATE =
  "The user chose to stop this turn. All further actions in this turn are aborted. Do not retry any action; wait for the user's next instruction.";

/** 三类卡的 kind 取值域（与 `protocol.js` `ApprovalBatchItem.kind` 一致）。 */
export const APPROVAL_KINDS = Object.freeze(["write", "edit", "command"]);

/** 工具的 kind 归类（`powershell` 与 `bash` 同属 `command`，设计 §3.4）。 */
const TOOL_KIND = Object.freeze({
  write: "write",
  edit: "edit",
  bash: "command",
  powershell: "command",
});

/** 卡片标题（人类可读，设计 §3.1）。 */
const KIND_TITLE = Object.freeze({
  write: "写入文件",
  edit: "修改文件",
  command: "执行命令",
});

/** 审计文件名（`~/.minipi/` 下，设计 §6.1 / §7.4）。 */
const APPROVALS_FILE = "approvals.json";
const AUDIT_FILE = "approvals-audit.log";

/**
 * 高危命令模式（设计 §3.4）。**只做标记、不做拦截**（拦截会让用户困惑）。
 * 命中任一 ⇒ `risk:"high"`，UI 加重警示。大小写不敏感。
 * 注意：这些正则**不是**安全边界，是「提示用户最该警觉的地方」的启发式。
 */
const HIGH_RISK_PATTERNS = Object.freeze([
  /\brm\s+-[a-z]*r[a-z]*f?\b/i, // rm -rf / rm -r
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /Remove-Item\b[^\n]*-Recurse/i, // PowerShell 递归删除
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*[fd]/i,
  /git\s+push\b[^\n]*--force/i,
  /git\s+push\b[^\n]*\s-f\b/i,
  /git\s+checkout\s+\.\s*$/i, // 丢弃工作区
  /git\s+restore\s+\.\s*$/i,
  /(^|\s)>\s*\S+/i, // 覆盖式重定向（保守起见，> 出现即提示）
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i, // 管道执行远端脚本
  /\biwr\b[^\n|]*\|\s*iex\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*Invoke-Expression\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /:\s*\(\s*\)\s*\{.*\|\s*:\s*&/, // fork 炸弹 :(){ :|:& };:
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bnpm\s+publish\b/i,
  /git\s+push\b/i, // 对外副作用（设计建议 high，本版采纳）
]);

/* ========================================================================== *
 * 1. 脱敏（**权威定义在此**：`redactSecrets()` 是全仓唯一实现，
 *    session.js:sanitizeDetail 反过来 import 复用 —— 不是「抄 session.js」；设计 §7.2）
 * ========================================================================== */

/**
 * 密钥模式（设计 §7.2 第 4 条 / §7.3 的 `KEY=value` 形态）。**两条 pattern，只增不减。**
 *
 * **pattern A（独立关键字形态）**：`keyword <sep> value`，keyword ∈
 * {api_key, token, secret, password, authorization, bearer}。
 *
 * **pattern B（前缀形态，P2-1 修复）**：`前缀+关键字 <sep> value`，前缀 ∈ `[A-Za-z0-9_]*`，
 * 关键字 ∈ {TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, ACCESS_KEY, PRIVATE_KEY}。
 *
 * ⚠ **为什么是两条而不是把 A 的 `\b` 放宽**（team-lead 裁定，秦戈提的选项）：
 *   `\b` 在 `_` 处不成立（`_` 是词字符）⇒ `SECRET_TOKEN=` / `GITHUB_TOKEN=` / `AWS_SECRET_ACCESS_KEY=`
 *   / `DB_PASSWORD=` 里的关键字**匹配不上**，值整个明文落盘（秦戈 QA 实证 5 例泄漏）。
 *   可选修法有「把 A 的 `\b` 换成零宽后顾放宽」与「补一条 B」。**选 B**：
 *     1. 零宽后顾有兼容风险（主进程 + 纯 Node 双跑），且会**改变既有 7 形态的匹配行为**，回归面大；
 *     2. 补一条 B **只增不减**，A 的 7/7 既有形态逐字不变，风险最小；
 *     3. 前缀形态本就是**不同形态**（`_TOKEN` vs 独立 `token`），两条 pattern 比一条复杂边界更可读。
 *
 * ⚠ **两条都必须把 value 整个吃掉**——早期版本值边界吃不全，留下 `Authorization=<redacted> xyz`
 *   （token 尾巴还在）⇒ 泄漏。这是单测抓出来的真 bug（team-lead 也复核过）。
 *
 * ⚠ **`authorization` / `bearer` 刻意不做前缀形态**：`X_AUTHORIZATION=` 之类极罕见，
 *   为它加前缀分支得不偿失（team-lead 也倾向不管）。见下方 `_AUTH_KEYWORDS` 说明。
 *
 * 替换词固定为 `KEY=<redacted>`（保留键名，便于审计看出「这里曾有个密钥」）。
 */
const SECRET_KEYWORDS = "api[_-]?key|token|secret|password|authorization|bearer";
/** pattern A：独立关键字（前后是词边界）。 */
const SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEYWORDS})\\b\\s*[:=]\\s*(?:bearer\\s+)?[^\\s'";|&)]+`,
  "gi",
);
/**
 * pattern B：大写/下划线前缀 + 关键字（`\b` 在此不适用，故用「前缀可空」直接锚定）。
 * `[A-Za-z0-9_]*` 覆盖 `SECRET_TOKEN` / `GITHUB_TOKEN` / `my_token` / `AWS_SECRET_ACCESS_KEY`；
 * `(?:bearer\s+)?` 同样吃掉 `X_AUTHORIZATION: Bearer v`（顺手兼容，无副作用）。
 * ⚠ 关键字用**大写枚举**但整条带 `i` ⇒ 大小写通吃；前缀允许空是为了也能兜住 pattern A 的场景（幂等）。
 */
const SECRET_PREFIX_PATTERN =
  /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY))\s*[:=]\s*(?:bearer\s+)?[^\s'";|&)]+/gi;

/** 键名提取用：从匹配串取出可辨认的键（用于 `<redacted>` 前的标签）。 */
const KEY_EXTRACT = /^([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|access_key|private_key))/i;

/**
 * 把一处密钥匹配整体替换为 `KEY=<redacted>`（保留键名，便于审计辨认「这里曾是密钥」）。
 * @param {string} match 整个匹配（含键、分隔符、值）
 * @returns {string}
 */
function redactSecretMatch(match) {
  const trimmed = match.trim();
  const keyMatch = KEY_EXTRACT.exec(trimmed);
  // 键名可为空（极端畸形状）也不输出空的 `=<redacted>`，退回 "secret"
  const key = keyMatch && keyMatch[1] ? keyMatch[1] : "secret";
  return `${key}=<redacted>`;
}

/**
 * **密钥脱敏唯一实现（single source）**：对一段文本套用 pattern A（独立关键字）+
 * pattern B（`*_TOKEN` 等前缀形态），把值替换为 `KEY=<redacted>`。
 *
 * ⚠ 本函数是**全仓唯一**的密钥脱敏口径 —— `approval.js`（审计）与
 *   `session.js:sanitizeDetail`（错误外发）**都 import 它**，严禁任何一方另抄一份正则。
 *   历史教训：同一处被两人各抄一遍必漂移（P2-1 就是「`\b` 在 `_` 处不成立」这一处漏值）。
 *
 * 纯函数、无副作用、不依赖 home / os，可在任意位置安全调用（幂等：再套一次结果不变）。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (text == null) return "";
  let s = String(text);
  s = s.replace(SECRET_PATTERN, redactSecretMatch);
  s = s.replace(SECRET_PREFIX_PATTERN, redactSecretMatch);
  return s;
}

/**
 * 把可能含敏感信息的文本洗成可落盘 / 可外发的说明。
 *
 * 规则（设计 §7.2）：① 家目录 → `~`；② Windows / POSIX 绝对路径 → `<path:文件名>`（保留文件名）；
 *   ③ 折叠换行、截断；④ 密钥模式的值 → `<redacted>`（**第④步复用 `redactSecrets()` 唯一实现**，
 *   与 `session.js:sanitizeDetail` 同源；顺序固定为「路径替换之后、截断之前」）。
 *
 * ⚠ **不用于 `command` 本体**——命令本体在 card 里原样、在审计里只截断+赋值段脱敏（§7.3）。
 *
 * @param {unknown} input
 * @param {number} [maxLen]
 * @param {string} [home] 家目录（测试可注入；缺省取 `os.homedir()`）
 * @returns {string}
 */
export function sanitizeForAudit(input, maxLen = 300, home = os.homedir()) {
  let s = input instanceof Error ? input.message : String(input ?? "");
  s = s.replace(/\r?\n/g, " ").trim();
  if (s.length === 0) return "空";

  if (home) {
    s = s.split(home).join("~");
    s = s.split(home.replace(/\\/g, "/")).join("~");
  }
  // Windows 绝对路径 C:\a\b\c → <path:c>
  s = s.replace(/[A-Za-z]:[\\/][^\s'"，。；]*/g, (m) => `<path:${path.basename(m)}>`);
  // POSIX 绝对路径 /a/b/c → <path:c>（不碰 ~/ 开头）
  s = s.replace(/(?<![\w~])\/(?:[\w.@-]+\/)+[\w.@-]+/g, (m) => `<path:${path.basename(m)}>`);
  // 密钥值脱敏（保留键名，`KEY=<redacted>`）：复用唯一实现 redactSecrets()，勿在此处内联正则
  s = redactSecrets(s);

  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

/**
 * 审计里的 `command` 脱敏（**特例**，设计 §7.3）：命令结构保留，只对 `KEY=value` 段做替换。
 * 若把整条命令按路径/家目录脱敏，审计就废了（「执行过某命令」必须能查是哪条）。
 *
 * @param {unknown} command
 * @param {string} [home]
 * @returns {string}
 */
export function redactCommandForAudit(command, home = os.homedir()) {
  let s = String(command ?? "").replace(/\r?\n/g, " ").trim();
  if (home) {
    s = s.split(home).join("~");
    s = s.split(home.replace(/\\/g, "/")).join("~");
  }
  // 只脱 `KEY=value` / `Authorization: Bearer xxx` 这类赋值段的值，命令结构不动
  // 复用唯一实现 redactSecrets()（pattern A + B），勿在此处内联正则
  s = redactSecrets(s);
  if (s.length > LIMITS.APPROVAL_COMMAND_MAX_CHARS) {
    s = `${s.slice(0, LIMITS.APPROVAL_COMMAND_MAX_CHARS)}…`;
  }
  return s;
}

/** 展示用路径：家目录 → `~`；越出 cwd 时退化 `<path:文件名>`（设计 §3.1 第 9 行 / §7.2）。 */
export function displayPath(absPath, home = os.homedir(), cwd = null) {
  let s = String(absPath ?? "");
  if (!s) return "";
  if (home && (s === home || s.startsWith(home + path.sep) || s.startsWith(home + "/"))) {
    return "~" + s.slice(home.length).replace(/\\/g, "/");
  }
  // 越出 cwd（或本来就不是 cwd 内）⇒ 只留文件名，避免暴露上级目录结构
  if (cwd) {
    const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
    if (!norm(s).startsWith(norm(cwd) + "/") && norm(s) !== norm(cwd)) {
      return `<path:${path.basename(s)}>`;
    }
  }
  return path.basename(s);
}

/* ========================================================================== *
 * 2. edit diff（纯函数，零依赖；设计 §3.3）
 * ========================================================================== */

/**
 * 把 edit 的 `input` 归一化成 `edits[]`（口径抄 `edit.ts:103-132` 的 `prepareEditArguments`）。
 *
 * 兼容三种模型发送形状（设计 §3.3 / A2）：
 *   ① 现行 `{ path, edits:[{oldText,newText}] }`
 *   ② legacy 顶层 `{ path, oldText, newText }`（并入 `edits[]` 末位）
 *   ③ `edits` 被发成 JSON 字符串 / 单个对象
 *
 * @param {unknown} input
 * @returns {{ path: string, edits: Array<{oldText:string,newText:string}> }}
 */
export function normalizeEditInput(input) {
  const args = input && typeof input === "object" ? { ...input } : {};
  const pathValue = typeof args.path === "string" ? args.path : "";

  // ③ edits 是 JSON 字符串 / 单对象
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEdit(parsed)) args.edits = [parsed];
    } catch {
      /* 解析失败：当空，后面按无 edit 处理 */
    }
  } else if (isSingleEdit(args.edits)) {
    args.edits = [args.edits];
  }

  const edits = Array.isArray(args.edits)
    ? args.edits
        .filter((e) => e && typeof e.oldText === "string" && typeof e.newText === "string")
        .map((e) => ({ oldText: e.oldText, newText: e.newText }))
    : [];

  // ② legacy 顶层 { oldText, newText } 并入（与 SDK 一致：追加到末尾）
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldText: args.oldText, newText: args.newText });
  }

  return { path: pathValue, edits };
}

/** 是否是单个 edit 对象 `{oldText,newText}`。 */
function isSingleEdit(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    typeof v.oldText === "string" && typeof v.newText === "string";
}

/**
 * 由归一化后的 `edits[]` 生成真实 diff 文本 + 统计（设计 §3.3，**不读盘 ⇒ 无 TOCTOU**）。
 *
 * 算法（刻意简单，不为未来设计）：
 *   每条 `{oldText,newText}` 按行切，找**最长公共前缀行**（context-before）与
 *   **最长公共后缀行**（context-after，不与前缀重叠）；中段输出 `- 旧 / + 新`。
 *   多条之间用 `@@ edit i/n` 分隔。**不额外造上下文**（oldText 已是模型给的最小唯一片段）。
 *
 * 边界：单条 oldText/newText 超 `APPROVAL_DIFF_MAX_BYTES` ⇒ 该条只给 `+N -M`，置 `tooLargeToDiff`。
 *
 * @param {Array<{oldText:string,newText:string}>} edits
 * @returns {{ diff: string, diffStat: {added:number,removed:number}, tooLargeToDiff: boolean }}
 */
export function buildEditDiff(edits) {
  const list = Array.isArray(edits) ? edits : [];
  let added = 0;
  let removed = 0;
  let tooLarge = false;
  const blocks = [];

  list.forEach((edit, idx) => {
    const oldLines = splitLines(edit?.oldText ?? "");
    const newLines = splitLines(edit?.newText ?? "");
    const bytes = Buffer.byteLength(edit?.oldText ?? "") + Buffer.byteLength(edit?.newText ?? "");

    const { removedCount, addedCount } = countDiff(oldLines, newLines);
    removed += removedCount;
    added += addedCount;

    const header = `@@ edit ${idx + 1}/${list.length}`;
    if (bytes > LIMITS.APPROVAL_DIFF_MAX_BYTES) {
      tooLarge = true;
      blocks.push(`${header}  改动过大，仅统计：+${addedCount} -${removedCount}`);
      return;
    }

    const prefix = commonPrefixLen(oldLines, newLines);
    const suffix = commonSuffixLen(oldLines, newLines, prefix);
    const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
    const newMid = newLines.slice(prefix, newLines.length - suffix);

    const body = [];
    for (const l of oldMid) body.push(`- ${l}`);
    for (const l of newMid) body.push(`+ ${l}`);
    if (body.length === 0) body.push("(无变化)");

    blocks.push(`${header}\n${body.join("\n")}`);
  });

  return {
    diff: blocks.join("\n"),
    diffStat: { added, removed },
    tooLargeToDiff: tooLarge,
  };
}

/** 按行切；保留空行结构但去掉尾随空行（`\n` 结尾不产生空行元素）。 */
function splitLines(text) {
  const s = String(text ?? "");
  if (s.length === 0) return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

/** 最长公共前缀行数。 */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/** 最长公共后缀行数（不与前缀重叠）。 */
function commonSuffixLen(a, b, prefix) {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** 统计中段的 `-N +M`（用前缀/后缀裁掉没变的部分）。 */
function countDiff(oldLines, newLines) {
  const prefix = commonPrefixLen(oldLines, newLines);
  const suffix = commonSuffixLen(oldLines, newLines, prefix);
  const removedCount = Math.max(0, oldLines.length - prefix - suffix);
  const addedCount = Math.max(0, newLines.length - prefix - suffix);
  return { removedCount, addedCount };
}

/* ========================================================================== *
 * 3. 命令高危分类（纯函数；设计 §3.4）
 * ========================================================================== */

/**
 * 命令高危分类。**只返回标签、不产生 block**（设计 §3.4 明确）。
 * @param {unknown} command
 * @returns {"normal"|"high"}
 */
export function classifyCommand(command) {
  const s = String(command ?? "");
  if (s.length === 0) return "normal";
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(s)) return "high";
  }
  return "normal";
}

/* ========================================================================== *
 * 4. 卡生成（纯函数；设计 §3）
 * ========================================================================== */

/**
 * 由一次工具调用生成 `ApprovalBatchItem`（纯函数，可单测）。
 *
 * 字段来源（设计 §3.2 / §3.3 / §3.4 / §9.3）：
 *   · write   → path / bytes / preview(前 N 字符) / overwrite
 *   · edit    → path / diff / diffStat / tooLargeToDiff
 *   · command → shell / command(原样) / timeoutSec / risk
 * 非审批工具 ⇒ 返回 `null`（调用方据此跳过）。
 *
 * @param {object} call
 * @param {string} call.toolName
 * @param {unknown} call.input
 * @param {string} call.cwd 会话工作目录（用于路径展示判定）
 * @param {string} [call.home] 家目录（测试注入）
 * @param {(p: string) => boolean} [call.exists] 目标是否存在（判断 overwrite；测试注入）
 * @param {string} [call.outboxDir] 会话 cwd 的显示基准（缺省 = cwd）
 * @returns {object|null} ApprovalBatchItem
 */
export function buildBatchItem(call) {
  const toolName = String(call?.toolName ?? "");
  const kind = TOOL_KIND[toolName];
  if (!kind) return null;

  const input = call?.input && typeof call.input === "object" ? call.input : {};
  const home = call?.home ?? os.homedir();
  const cwd = call?.cwd ?? "";
  const exists = typeof call?.exists === "function" ? call.exists : null;

  const base = {
    kind,
    toolName,
    title: KIND_TITLE[kind] ?? toolName,
  };

  if (kind === "write") {
    const target = String(input.path ?? "");
    const content = typeof input.content === "string" ? input.content : "";
    const abs = resolveDisplayTarget(target, cwd, home);
    let overwrite = false;
    if (exists && abs) {
      try {
        overwrite = exists(abs) === true;
      } catch {
        overwrite = false;
      }
    }
    const preview = content.slice(0, LIMITS.APPROVAL_WRITE_PREVIEW_CHARS);
    return {
      ...base,
      path: displayPath(abs, home, cwd),
      bytes: Buffer.byteLength(content),
      preview: content.length > LIMITS.APPROVAL_WRITE_PREVIEW_CHARS ? `${preview}…` : preview,
      overwrite,
    };
  }

  if (kind === "edit") {
    const { path: target, edits } = normalizeEditInput(input);
    const abs = resolveDisplayTarget(target, cwd, home);
    const { diff, diffStat, tooLargeToDiff } = buildEditDiff(edits);
    return {
      ...base,
      path: displayPath(abs, home, cwd),
      diff,
      diffStat,
      tooLargeToDiff,
    };
  }

  // command
  const command = String(input.command ?? "");
  const timeoutSec = Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : null;
  return {
    ...base,
    shell: toolName === "powershell" ? "powershell" : "bash",
    command,
    timeoutSec,
    risk: classifyCommand(command),
  };
}

/** 把工具给的（可能相对）路径解析成绝对路径，供展示 / overwrite 判定。 */
function resolveDisplayTarget(target, cwd, home) {
  if (!target) return "";
  let s = String(target);
  if (s === "~") s = home;
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = path.join(home, s.slice(2));
  try {
    return path.isAbsolute(s) ? path.resolve(s) : path.resolve(cwd || ".", s);
  } catch {
    return target;
  }
}

/* ========================================================================== *
 * 5. 审批闸门
 * ========================================================================== */

/**
 * @typedef {object} ApprovalBridge
 * @property {(card: object) => void} pushCard  主→渲染：推 / 更新审批卡（含 phase）
 * @property {(entry: object) => void} audit    审计落盘（同步，已脱敏）
 */

/**
 * 审批闸门状态机。
 *
 * 生命周期（设计 §6.3）：
 *   · `request(call)`  → 建 pending（批合并）→ 推卡 → 起定时器 → 返回 Promise
 *   · `decide({approvalId, action})` → 唤醒 Promise → 落审计 → 撤卡
 *   · 超时 → 默认拒绝（`APPROVAL_TIMEOUT`）→ 撤卡
 *   · `cancelBySession(id)` → 该会话全部 pending 拒绝 + 撤卡（会话销毁）
 *   · 构造时读 `approvals.json` → **一律丢弃、不放行**，只记审计（§6.4）
 */
export class ApprovalGate {
  /**
   * @param {object} deps
   * @param {ApprovalBridge} deps.bridge       推卡 / 审计（由 main/index.js 注入）
   * @param {{info?:Function,warn?:Function,error?:Function}} [deps.logger]
   * @param {string} [deps.appDir]             审批文件目录（缺省 `~/.minipi`；测试注入临时目录）
   * @param {string} [deps.home]               家目录（缺省 `os.homedir()`）
   * @param {number} [deps.timeoutMs]          超时（缺省 `LIMITS.APPROVAL_TIMEOUT_MS`）
   * @param {number} [deps.batchMax]           单卡条数上限（缺省 `LIMITS.APPROVAL_BATCH_MAX_ITEMS`）
   * @param {(p:string)=>boolean} [deps.exists] 目标存在性判定（write.overwrite；测试注入）
   */
  constructor(deps = {}) {
    this._bridge = {
      pushCard: typeof deps.bridge?.pushCard === "function" ? deps.bridge.pushCard : () => {},
      audit: typeof deps.bridge?.audit === "function" ? deps.bridge.audit : () => {},
    };
    this._logger = deps.logger ?? console;
    this._home = deps.home ?? os.homedir();
    this._appDir = deps.appDir ?? path.join(this._home, ".minipi");
    this._timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : LIMITS.APPROVAL_TIMEOUT_MS;
    this._batchMax = Number.isFinite(deps.batchMax) ? deps.batchMax : LIMITS.APPROVAL_BATCH_MAX_ITEMS;
    this._exists = typeof deps.exists === "function" ? deps.exists : null;

    /** @type {Map<string, {resolve:Function, card:object, sessionId:string, timer:any, items:object[]}>} */
    this._pending = new Map();
    /** @type {Map<string, string>} sessionId → 当前未决的 approvalId（批合并用） */
    this._sessionCard = new Map();
    /**
     * R5「本会话总是允许」：`Map<sessionId, Set<toolName>>`。
     * **只在内存**——不落盘、退出即失（任务 #3 拍板：会话级、默认关、不持久化）。
     * 只能由 IPC 的 `decide({action:"allowOnce", remember:true})` 写入（模型输入到不了 decide）。
     */
    this._alwaysAllow = new Map();
    this._counter = 0;
    this._flushTimer = null;

    // 启动时读遗留 pending：一律丢弃，只记审计（§6.4）——绝不恢复、绝不放行
    this._sweepOnStart();
  }

  /* --------------------------- 对外：request --------------------------- */

  /**
   * 为一次会改系统的工具调用申请审批。**异步**——`session.js` 规则 2 里 `await` 它。
   *
   * 语义（§4.1 批合并）：
   *   · 该会话无未决卡 ⇒ 新建卡（`phase:"push"`），`batch=[item]`
   *   · 该会话已有未决卡且未达上限 ⇒ **不新建**，追加到同一卡（`phase:"update"`）
   *   · 已达上限 ⇒ 新建一张卡（上一张继续等待）
   *
   * 非审批工具 / 无 toolName ⇒ **不放行也不阻断**：返回 `{action:"allowOnce"}` 但**不建卡**
   * （调用方 `session.js` 只在 `APPROVAL_TOOLS` 内才调用本方法；这里再兜一道）。
   *
   * @param {object} call
   * @param {string} call.sessionId
   * @param {string} call.sceneId
   * @param {string} call.toolName
   * @param {unknown} call.input
   * @param {string} call.cwd
   * @returns {Promise<{action:"allowOnce"|"deny"|"terminate", reason?:string, approvalId?:string}>}
   */
  async request(call) {
    const sessionId = String(call?.sessionId ?? "");
    const toolName = String(call?.toolName ?? "");

    // 兜底：非审批工具直接放行（正常不会走到，因 session.js 已过滤）
    if (!APPROVAL_TOOLS.includes(toolName)) {
      return { action: "allowOnce" };
    }

    // R5：本会话已「总是允许」该工具 ⇒ 直接放行、不再推卡（只免审批，不免沙箱——
    // 沙箱由 session.js 规则 1 在本方法**之前**判定，这里到不了沙箱违例）
    const allowedTools = this._alwaysAllow.get(sessionId);
    if (allowedTools && allowedTools.has(toolName)) {
      return { action: "allowOnce" };
    }

    const item = buildBatchItem({
      toolName,
      input: call?.input,
      cwd: call?.cwd ?? "",
      home: this._home,
      exists: this._exists,
    });
    if (!item) return { action: "allowOnce" };

    // 批合并：同会话已有未决卡且未满 ⇒ 追加
    const existingId = this._sessionCard.get(sessionId);
    const existing = existingId ? this._pending.get(existingId) : null;
    if (existing && existing.items.length < this._batchMax) {
      existing.items.push(item);
      this._pushCard(existing, "update");
      return new Promise((resolve) => {
        existing.resolvers.push(resolve);
      });
    }

    // 新建卡
    const id = `a_${++this._counter}`;
    const now = Date.now();
    const entry = {
      id,
      sessionId,
      sceneId: String(call?.sceneId ?? ""),
      items: [item],
      createdAt: now,
      expiresAt: now + this._timeoutMs,
      /** @type {Array<Function>} 同一卡可能对应多个并发 request（批内各调用各自 await） */
      resolvers: [],
      settled: false,
      timer: null,
    };

    const promise = new Promise((resolve) => {
      entry.resolvers.push(resolve);
    });

    this._pending.set(id, entry);
    this._sessionCard.set(sessionId, id);

    entry.timer = setTimeout(() => this._onTimeout(id), this._timeoutMs);
    entry.timer?.unref?.();

    this._pushCard(entry, "push");
    this._audit("requested", entry, item);
    this._scheduleFlush();

    return promise;
  }

  /* --------------------------- 对外：decide --------------------------- */

  /**
   * 用户点了按钮（`allowOnce` / `deny` / `terminate`）。
   * 唤醒该卡所有 pending 的 Promise（整批语义，§4.1）。
   *
   * @param {{ approvalId: string, action: string }} arg
   * @returns {{ ok: true }}
   * @throws `INVALID_ARGUMENT`（action 非法）；`APPROVAL_NOT_FOUND`（id 不存在或已决）
   */
  decide(arg) {
    const approvalId = String(arg?.approvalId ?? "");
    const action = String(arg?.action ?? "");

    if (action !== "allowOnce" && action !== "deny" && action !== "terminate") {
      throw new Error(errorMessage(ERROR_CODES.INVALID_ARGUMENT, "action 必须是 allowOnce / deny / terminate"));
    }

    const entry = this._pending.get(approvalId);
    if (!entry || entry.settled) {
      throw new Error(errorMessage(ERROR_CODES.APPROVAL_NOT_FOUND, "审批不存在或已决"));
    }

    // R5：只有带 remember:true 的 IPC 决策能开「本会话总是允许」（默认关、仅内存）
    // ⚠ 模型任何输入都到不了这里（decide 只由 IPC handler 调），故 remember 不可能被模型伪造。
    if (arg?.remember === true && action === "allowOnce") {
      this._enableAlwaysAllow(entry);
    }

    // R3：按 action 分派拒绝文案（三套分开；timeout/cancelBySession 各自用各自的，见下）
    const reason =
      action === "allowOnce" ? null : action === "terminate" ? DENY_REASON_TERMINATE : DENY_REASON_USER;
    this._settle(entry, action, reason);
    return { ok: true };
  }

  /**
   * 会话销毁时清掉该会话全部 pending（**默认拒绝**，§5.4 / §6.3）。
   * 不抛错（dispose 路径不该因审批失败而中断）。
   * @param {string} sessionId
   * @returns {number} 清理条数
   */
  cancelBySession(sessionId) {
    const id = this._sessionCard.get(String(sessionId));
    // 即便没有未决卡，也要清掉该会话的 always-allow 记忆（会话没了，记忆无意义）
    this._alwaysAllow.delete(String(sessionId));
    if (!id) return 0;
    const entry = this._pending.get(id);
    if (!entry || entry.settled) {
      this._sessionCard.delete(String(sessionId));
      return 0;
    }
    this._settle(entry, "deny", DENY_REASON_USER);
    return 1;
  }

  /**
   * R5：开启「本会话总是允许」某工具。**只能由 IPC 的 `decide({remember:true})` 触发**
   * （模型输入到不了 `decide`）；**只在内存**、退出即失；开启当刻落一条 `always_allow_enabled` 审计。
   *
   * 混合工具批 / `alwaysAllowEligible:false` 的卡**不开启**（无法归一到单一工具）。
   * @param {object} entry
   */
  _enableAlwaysAllow(entry) {
    const meta = cardMeta(entry);
    if (!meta.alwaysAllowEligible || !meta.toolName) return;
    let set = this._alwaysAllow.get(entry.sessionId);
    if (!set) {
      set = new Set();
      this._alwaysAllow.set(entry.sessionId, set);
    }
    if (set.has(meta.toolName)) return;
    set.add(meta.toolName);
    // 审计：开启当刻记一笔（脱敏，无参数内容）
    try {
      this._bridge.audit({
        ts: Date.now(),
        approvalId: entry.id,
        sessionId: entry.sessionId,
        event: "always_allow_enabled",
        kind: meta.kind,
        toolName: meta.toolName,
        summary: `本会话总是允许 ${meta.toolName}（内存级，退出即失）`,
        risk: null,
      });
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 审计失败：${sanitizeForAudit(err, 300, this._home)}`);
    }
  }

  /** 查询某会话是否已「总是允许」某工具（测试用）。 */
  isAlwaysAllowed(sessionId, toolName) {
    const set = this._alwaysAllow.get(String(sessionId));
    return !!set && set.has(String(toolName));
  }

  /* --------------------------- 内部 --------------------------- */

  /** 超时 ⇒ 默认拒绝（fail-closed），reason 含 `did not respond`（§5.1 / §5.3）。 */
  _onTimeout(approvalId) {
    const entry = this._pending.get(approvalId);
    if (!entry || entry.settled) return;
    this._audit("timeout", entry, entry.items[entry.items.length - 1]);
    this._settle(entry, "deny", DENY_REASON_TIMEOUT, { auditDone: true });
  }

  /**
   * 落定一张卡：清定时器、撤卡、唤醒全部 resolve、从表里移除。
   * @param {object} entry
   * @param {string} action
   * @param {string|null} reason
   * @param {{auditDone?: boolean}} [opts]
   */
  _settle(entry, action, reason, opts = {}) {
    if (entry.settled) return;
    entry.settled = true;

    if (entry.timer) clearTimeout(entry.timer);
    this._sessionCard.delete(entry.sessionId);
    this._pending.delete(entry.id);

    // 撤卡（phase:"cancel"，batch 可为空，§9.3）
    this._pushCard(entry, "cancel");

    if (!opts.auditDone) {
      const event = action === "allowOnce" ? "allowed" : "denied";
      this._audit(event, entry, entry.items[entry.items.length - 1]);
    }

    const result = { action, approvalId: entry.id };
    if (reason) result.reason = reason;
    for (const resolve of entry.resolvers) {
      try {
        resolve(result);
      } catch {
        /* resolve 不该抛；抛了也不能拖垮其他 */
      }
    }
    entry.resolvers.length = 0;
    this._scheduleFlush();
  }

  /** 推卡（push / update → 完整卡；cancel → 只带 id + phase）。 */
  _pushCard(entry, phase) {
    // phase:"cancel" 只带 id + phase（撤回卡不需要内容，方砚据此移除；§9.3）
    if (phase === "cancel") {
      try {
        this._bridge.pushCard({
          approvalId: entry.id,
          phase,
          sessionId: entry.sessionId,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          timeoutMs: this._timeoutMs,
          actions: APPROVAL_ACTION_IDS,
          batch: [],
        });
      } catch (err) {
        this._logger.warn?.(`[minipi:approval] 推卡失败：${sanitizeForAudit(err, 300, this._home)}`);
      }
      return;
    }

    const meta = cardMeta(entry);
    const card = {
      approvalId: entry.id,
      phase,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      timeoutMs: this._timeoutMs,
      // R4：渲染层靠 actions 画按钮（三值恒发，方砚缺它画不出按钮）
      actions: APPROVAL_ACTION_IDS,
      kind: meta.kind,
      toolName: meta.toolName,
      title: meta.title,
      // 单条卡：该工具在「本会话总是允许」白名单内则可勾选；合并卡/混合 kind ⇒ false
      alwaysAllowEligible: meta.alwaysAllowEligible,
      batch: entry.items,
    };
    try {
      this._bridge.pushCard(card);
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 推卡失败：${sanitizeForAudit(err, 300, this._home)}`);
    }
  }

  /** 审计一条（已脱敏，同步落盘；写失败不阻断审批，§7.4）。 */
  _audit(event, entry, item) {
    const summary = buildAuditSummary(item, this._home, entry.sessionId);
    const auditEntry = {
      ts: Date.now(),
      approvalId: entry.id,
      sessionId: entry.sessionId,
      event,
      kind: item?.kind ?? null,
      toolName: item?.toolName ?? null,
      summary,
      risk: item?.kind === "command" ? item.risk ?? null : null,
    };
    try {
      this._bridge.audit(auditEntry);
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 审计失败：${sanitizeForAudit(err, 300, this._home)}`);
    }
  }

  /* --------------------------- 持久化（§6） --------------------------- */

  /** 启动扫描：读遗留 pending ⇒ 一律丢弃 + 记审计（绝不恢复、绝不放行）。 */
  _sweepOnStart() {
    const file = path.join(this._appDir, APPROVALS_FILE);
    let raw;
    try {
      if (!fs.existsSync(file)) return;
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 读审批文件失败（当空）：${sanitizeForAudit(err, 300, this._home)}`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this._logger.warn?.("[minipi:approval] 审批文件 JSON 非法（当空，不阻止启动）");
      this._forceEmptyApprovals();
      return;
    }

    const list = Array.isArray(parsed?.pending) ? parsed.pending : [];
    for (const p of list) {
      // 只记一条「上次有未决审批」审计，然后丢弃（脱敏：summary 只留 kind/tool）
      try {
        this._bridge.audit({
          ts: Date.now(),
          approvalId: String(p?.approvalId ?? ""),
          sessionId: String(p?.sessionId ?? ""),
          event: "lost_on_restart",
          kind: p?.kind ?? null,
          toolName: p?.toolName ?? null,
          summary: `重启丢弃未决审批（kind=${p?.kind ?? "?"}）`,
          risk: null,
        });
      } catch {
        /* 审计失败不阻断启动 */
      }
    }
    if (list.length > 0) {
      this._logger.warn?.(`[minipi:approval] 启动发现 ${list.length} 条未决审批，已一律丢弃（不恢复、不放行）`);
    }
    // 清空重写
    this._forceEmptyApprovals();
  }

  /** 把 `approvals.json` 重写成空的 pending（原子：tmp → rename）。 */
  _forceEmptyApprovals() {
    const file = path.join(this._appDir, APPROVALS_FILE);
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this._appDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pending: [] }, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 重置审批文件失败：${sanitizeForAudit(err, 300, this._home)}`);
    }
  }

  /** 去抖落盘（§6.3）：不阻塞审批热路径。 */
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, 200);
    this._flushTimer?.unref?.();
  }

  /** 落盘当前 pending（**脱敏**：绝不写完整 content / 绝对路径）。 */
  _flush() {
    const file = path.join(this._appDir, APPROVALS_FILE);
    const tmp = `${file}.tmp`;
    const pending = [...this._pending.values()].map((entry) => {
      const last = entry.items[entry.items.length - 1] ?? {};
      return {
        approvalId: entry.id,
        sessionId: entry.sessionId,
        kind: last.kind ?? null,
        toolName: last.toolName ?? null,
        batch: entry.items.map((it) => ({
          toolName: it.toolName,
          // 脱敏摘要：write/edit 给 <path:文件>，command 给截断脱敏命令
          commandRedacted: it.kind === "command" ? redactCommandForAudit(it.command, this._home) : undefined,
          pathRedacted: it.kind !== "command" ? it.path : undefined,
        })),
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        status: "pending",
      };
    });

    try {
      fs.mkdirSync(this._appDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pending }, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      this._logger.warn?.(`[minipi:approval] 落盘失败（不影响审批）：${sanitizeForAudit(err, 300, this._home)}`);
    }
  }

  /* --------------------------- 测试可观测 --------------------------- */

  /** 当前未决卡数量（测试用）。 */
  get pendingCount() {
    return this._pending.size;
  }

  /** 取一张未决卡（测试用；不存在返回 null）。 */
  peek(approvalId) {
    return this._pending.get(String(approvalId)) ?? null;
  }
}

/**
 * 卡级元信息（R4）：从 `entry.items` 提取 `kind` / `toolName` / `title` / `alwaysAllowEligible`。
 *
 * 口径（team-lead R4 裁定）：
 *   · 单条卡 ⇒ 取该条；
 *   · 合并卡 ⇒ 取**第一条**的 kind/toolName/title；
 *   · **kind 混合**时 `alwaysAllowEligible:false`（「总是允许」是按**单工具**记的，
 *     混合批无法归一到单一工具——这是 team-lead 允许的保守处理，未自行发明逐条 remember）。
 *
 * `title` 单条用 `KIND_TITLE[kind]`；混合批给「多项改动」提示（渲染层可自行按 batch 分组）。
 *
 * @param {{items: object[]}} entry
 * @returns {{kind: string|null, toolName: string|null, title: string, alwaysAllowEligible: boolean, mixedKind: boolean}}
 */
export function cardMeta(entry) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  const first = items[0] ?? null;
  const kinds = new Set(items.map((it) => it?.kind));
  const tools = new Set(items.map((it) => it?.toolName));
  const mixedKind = kinds.size > 1;
  const singleTool = tools.size === 1;

  let title;
  if (items.length <= 1) {
    title = first ? KIND_TITLE[first.kind] ?? first.toolName ?? "" : "";
  } else if (mixedKind) {
    title = `多项改动（${items.length} 项）`;
  } else {
    title = `${KIND_TITLE[first?.kind] ?? "操作"}（${items.length} 项）`;
  }

  return {
    kind: first?.kind ?? null,
    toolName: first?.toolName ?? null,
    title,
    // 只有「单工具」批才可能被「本会话总是允许」覆盖（混合工具 ⇒ 不可）
    alwaysAllowEligible: singleTool,
    mixedKind,
  };
}

/**
 * 审计 summary（脱敏，设计 §7.2）。
 * · write   → `write <path:文件> (+NB, overwrite=?)`
 * · edit    → `edit <path:文件> (+N -M)`
 * · command → `bash: <截断脱敏命令>`
 * @param {object} item
 * @param {string} home
 * @returns {string}
 */
export function buildAuditSummary(item, home = os.homedir()) {
  if (!item) return "未知";
  if (item.kind === "write") {
    return `write ${item.path ?? ""} (+${item.bytes ?? 0}B, overwrite=${item.overwrite === true})`;
  }
  if (item.kind === "edit") {
    const st = item.diffStat ?? { added: 0, removed: 0 };
    return `edit ${item.path ?? ""} (+${st.added} -${st.removed})`;
  }
  if (item.kind === "command") {
    return `${item.toolName ?? "bash"}: ${redactCommandForAudit(item.command, home)}`;
  }
  return sanitizeForAudit(JSON.stringify(item), 300, home);
}
