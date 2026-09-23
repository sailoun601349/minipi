/**
 * `outbox` 沙箱路径校验（方案 §2）。
 *
 * ## 这个模块解决什么问题
 *
 * minipi 的定位是「用户感觉不到文件系统」：用户**永远不选目录**，所有随手产出
 * 都落进 `~/.minipi/outbox/`。但「cwd 设成 outbox」**不等于**「写不出去」——
 *
 *   · `write` 的实现在 SDK 里是 `resolveToCwd(path, cwd)`
 *     （`vendor/pi/.../dist/core/tools/path-utils.js`），语义是：
 *       相对路径拼到 cwd；绝对路径原样；**且会做若干路径归一化**（见 §归一化）。
 *   · 所以 `../x.txt` 会 `path.resolve` 出去；`C:\Windows\x` / `/tmp/x` 直接绕过 cwd。
 *
 * ⇒ **cwd 只是「默认落点」，边界必须靠 `tool_call` 钩子硬拦。** 本模块就是那条判定。
 *
 * ## ⚠ 核心不变量：**判定路径必须与 SDK 的真实落盘路径逐字一致**
 *
 * 这是本文件最容易被写坏的地方，也是 P0 级逃逸（QA-P0-1，`@` 前缀）的根因。
 * 校验的是 A 路径、SDK 写的却是 B 路径 ⇒ 沙箱形同虚设。所以：
 *
 *   **凡 SDK 在 resolve 之前对 `input.path` 做的任何变换，这里都必须先做一遍。**
 *
 * 详见 `normalizeToolPathLikeSdk()` 的注释与文件末「与 SDK 的隐性耦合」。
 *
 * ## 设计约束（务必遵守，别改坏）
 *
 *   1. **纯 Node 模块**：只 import `node:fs` / `node:path` / `node:os` / `node:url`。
 *      **不 import electron、不 import Pi SDK** ⇒ 可以 `node scripts/verify-sandbox.mjs`
 *      离线单测，不受本机 Electron GPU 崩溃的影响。
 *      （也**不能**直接 import SDK 的 `resolveToCwd` 来复用——那会破坏
 *       「`session.js` 是唯一 import SDK 的文件」这条团队约定。）
 *   2. **全部是纯函数**：不读全局状态、不写盘、不改入参。同输入同输出。
 *   3. **realpath 时机 = 校验时**（写之前）。写之后再校验等于事后取证，文件已落盘。
 *   4. **一律 fail-closed**：任何「算不出来 / 认不出 / 不确定」的情况**一律拒绝**。
 *      沙箱宁可误杀也不能漏放。本文件里**没有**任何 fail-open 分支。
 *
 * ## 一个明确的取舍：本模块**不拦 `read`**
 *
 * 沙箱保的是「**不往外面写**」，**不承诺**「不往外面读」。
 * `note` / `desk` 的 `read` 用于读 PDF / 长文，用户可能就是让它读 outbox 外的资料，
 * 这是产品刻意保留的能力（方案 §2.3）。
 * 将来若要收口「读取面」，**加同一个 `isWriteAllowed` 判定即可**（钩子已就位），
 * 不需要另起一套机制。这是取舍，不是遗漏——写在这里防后人误以为「read 漏了」。
 *
 * 方案出处：`docs/minipi-v0.4-impl-plan.md` §2.1–§2.5。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 沙箱拒绝文案（**英文、逐字回灌给模型**，不要改措辞）。
 *
 * 为什么是英文且要这么具体：spike live 实测——`reason` 会原样变成 tool result
 * 回灌给模型。看到这段措辞后，模型**不重试**该路径，而是改用相对路径或反问用户；
 * 换成含糊的中文它反而会换个绝对路径继续试。三句话各有用处：
 *   ① 说清「为什么被拒」（outside the allowed output folder）
 *   ② 给出**可行的替代**（use a path relative to the working directory）
 *   ③ 堵掉「换个绝对路径再试」的循环（Do not retry other absolute paths）
 *
 * 出处：方案 §2.5 第 3 条（plan §3.3 要点 4 的实测结论）。
 */
export const SANDBOX_DENY_REASON =
  "The target path is outside the allowed output folder. You may only write inside it;\n" +
  "use a path relative to the working directory. Do not retry other absolute paths.";

/** 会改动文件系统、且路径来自模型 `input` 的工具。 */
export const WRITE_TOOLS = Object.freeze(["write", "edit"]);

/**
 * 会改动文件系统、且路径来自模型 `input` 的工具**所接受的路径字段名**（白名单）。
 *
 * 当前 SDK（`@earendil-works/pi-coding-agent` 0.87.0）的 `write` / `edit` schema
 * 都用 **`path`**：
 *   · `dist/core/tools/write.js` 的 `writeSchema = { path, content }`
 *   · `dist/core/tools/edit.js` 的 `editSchema = { path, edits }`
 * （注：`read` 也用 `path`，但 `read` 不在沙箱范围内。）
 *
 * ⚠ 取不到这些字段时**一律拒绝**（fail-closed），不要退化成 `path.resolve(cwd, "")`
 * = cwd 本身 → 会被误判成「在 outbox 内」。见 `resolveWriteTarget()`。
 */
export const WRITE_PATH_FIELDS = Object.freeze(["path"]);

/**
 * 受沙箱约束的场景（outbox 场景）——**白名单语义**，与 `protocol.OUTBOX_SCENES` 保持一致。
 *
 * 为什么内联而不 import `protocol.js`：本模块要求「零业务依赖、可离线单测」
 * （见文件头约束 1）。代价是这份名单可能与 `protocol.js` 漂移——
 * `scripts/qa-sandbox-attack.mjs` 的 A9 就是专门盯这个的。
 *
 * ⚠ **未知 sceneId 一律拒绝**（见 `sceneDisposition()`），不做「不在名单就放行」。
 */
const OUTBOX_SCENE_IDS = Object.freeze(["quick", "note", "desk"]);

/**
 * **已知的、刻意不受沙箱约束**的场景 —— 走审批闸门，沙箱放行。
 *
 * `repo` 是唯一一个：它要动真仓库（`toolAllowlist` 含 `bash`/`edit`），
 * 沙箱对它物理上无效（bash 能 `cd /`），防线是审批（方案 §2.4）。
 *
 * ⚠ **只有显式列在这里的场景才放行**。其他任何 sceneId（含拼错、含将来新增的）
 * 都当作「未知」→ **拒绝**（fail-closed）。这样 `protocol.js` 新增 outbox 场景
 * 而忘记同步本文件时，表现为**误杀**（用户可感知、可上报），而不是**静默漏放**（无人知晓）。
 */
const SANDBOX_EXEMPT_SCENE_IDS = Object.freeze(["repo"]);

/**
 * SDK 会把这些「Unicode 空格类字符」归一成半角空格。
 * 照抄 `vendor/pi/.../dist/utils/paths.js` 的 `UNICODE_SPACES`（与 `chunk-*.js` 同值）。
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 复刻 SDK 的 `normalizeWindowsShellPath()`（`vendor/pi/.../src/utils/paths.ts:67`）。
 *
 * 把 Git Bash / MSYS / Cygwin / WSL 风格的盘符路径转成 Windows 原生形态：
 *   `/c/Windows/x` → `C:\Windows\x`；`/mnt/c/Windows/x`、`/cygdrive/c/Windows/x` 同理。
 *
 * 只在 win32 下生效（与 SDK 一致：SDK 里这一步被 `process.platform === "win32"` 包着）。
 *
 * ⚠ 手工镜像，见文件末「与 SDK 的隐性耦合」。
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * **复刻 SDK 对 `input.path` 的完整归一化** —— 本文件与 SDK 的**关键对齐点**。
 *
 * ### 出处（已逐条核对 vendor）
 *
 * SDK 的 `write` / `edit` 工具最终调的是：
 *   `dist/core/tools/write.js:147`  → `resolveToCwd(path, cwd)`
 *   `dist/core/tools/edit.js`        → 同款 `resolveToCwd`
 * 而 `resolveToCwd`（`dist/core/tools/path-utils.js:33`）是：
 *   ```js
 *   export function resolveToCwd(filePath, cwd) {
 *     return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
 *   }
 *   ```
 * 再往下 `resolvePath` → `normalizePath(input, options)`
 * （`src/utils/paths.ts:75`，已核对与 `dist/utils/paths.js` 一致）。
 *
 * ### 复刻的规则（顺序与 SDK 一致）
 *
 *   | # | 规则 | SDK 位置 | 本函数实现 |
 *   |---|---|---|---|
 *   | 1 | `normalizeUnicodeSpaces`：Unicode 空格 → 半角空格 | `paths.ts:77-79` | `.replace(UNICODE_SPACES, " ")` |
 *   | 2 | `stripAtPrefix`：剥掉**一个**前导 `@` | `paths.ts:80-82` | `.startsWith("@") → .slice(1)` |
 *   | 3 | `normalizeWindowsShellPath`（仅 win32） | `paths.ts:83-85` | `normalizeWindowsShellPath()` |
 *   | 4 | `expandTilde`（**默认 true**）：`~` / `~/…` / `~\…` 展开 | `paths.ts:87-93` | 见下 |
 *   | 5 | `file://` → `fileURLToPath` | `paths.ts:95-97` | `fileURLToPath()` |
 *
 * 注意规则 2 是**剥一个**而不是「剥到不剩」：`@@a` → `@a`（与 SDK 实测一致）。
 *
 * ### ⚠ 三条必须记住的警告
 *
 *   1. **这是 SDK 行为的「手工镜像」，不是复用。** SDK 升级后必须**重新逐条核对**上表；
 *      对不上的地方就是新的逃逸口。建议每次升级 SDK 后跑
 *      `node scripts/verify-sandbox-live.mjs`（真实会话验证，见该脚本头注释）。
 *   2. **本函数是 sandbox.js 与 SDK 的「第二处」隐性耦合**（第一处是
 *      `resolveToCwd` 的「相对拼 cwd / 绝对原样」语义）。两处都要跟着 SDK 走。
 *   3. **`fileURLToPath` 可能抛**（如 `file:///tmp/x` 在 Windows 上非绝对路径）。
 *      抛了**不能吞**——调用方 `resolveWriteTarget()` 会把它当成「算不出来」而**拒绝**
 *      （fail-closed）。若这里静默返回原串，就会退化成 fail-open。
 *
 * @param {unknown} raw `input.path` 原始值
 * @returns {string} 归一化后的路径串（**未必是绝对路径**，仍需 `path.resolve(cwd, …)`）
 * @throws {TypeError} `fileURLToPath` 失败时抛出（由调用方转成拒绝）
 */
export function normalizeToolPathLikeSdk(raw) {
  // SDK 的入参是 string；非字符串先转成 string（SDK 侧由 schema 保证，这里兜底）。
  let normalized = String(raw);

  // 1. Unicode 空格 → 半角空格
  normalized = normalized.replace(UNICODE_SPACES, " ");

  // 2. 剥前导 `@`（只剥一个）
  if (normalized.startsWith("@")) normalized = normalized.slice(1);

  // 3. Windows shell 风格盘符路径
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }

  // 4. 展开 `~`（SDK 的 expandTilde 默认开启）
  const home = os.homedir();
  if (normalized === "~") return home;
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return path.join(home, normalized.slice(2));
  }

  // 5. `file://` → 本地路径（可能抛，交给调用方 fail-closed）
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

/**
 * 安全版 `realpathSync`：失败返回 `null`，**不抛、不 fail-open**。
 * 调用方必须把 `null` 当成「拒绝」，不能当成「放行」。
 *
 * @param {string} p
 * @returns {string|null} 解析后的物理路径；失败返回 `null`
 */
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 沿路径向上去到**最深的已存在祖先**。
 *
 * 为什么需要：模型 `write` 一个**尚不存在**的文件（新建是常态），
 * 对它直接 `realpathSync` 会 ENOENT。此时不能放行（否则「先建 junction 目录、
 * 再往里写」的绕过就成立了），而是对**已存在的最深祖先**求 realpath，
 * 再把还没创建的路径段拼回去。这样 junction / symlink 会在祖先这一层被解开。
 *
 * @param {string} absPath 已 `path.resolve` 过的绝对路径
 * @returns {string} 最深的已存在祖先（至少是文件系统根）
 */
function deepestExistingAncestor(absPath) {
  let probe = absPath;
  // 循环上限兜底：`path.dirname` 到根后 `parent === probe` 会 break，
  // 这里再给一个硬上限，防止意外的死循环把主进程挂住。
  for (let i = 0; i < 4096; i += 1) {
    if (fs.existsSync(probe)) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) return probe; // 已到根
    probe = parent;
  }
  return probe;
}

/**
 * **核心判定**：`targetAbsPath` 是否允许被写入（严格落在 `outboxAbsPath` 内）。
 *
 * 算法（方案 §2.2 伪码，逐条对应）：
 *   1. `root = realpath(outbox)` —— 失败 → **直接拒绝**（不 fail-open）。
 *   2. 求 target 的「最可靠的物理路径」：
 *      若 target 不存在 → 向上去到**最深已存在祖先**再 realpath；
 *      把 target 剩余（未创建）的段拼回去。
 *   3. 前缀判定**必须带 `path.sep`**：`final === root || final.startsWith(root + sep)`。
 *      否则 `~/.minipi/outbox-evil/x` 会被误判成「在 outbox 内」（经典前缀陷阱）。
 *
 * ⚠ 一定是**物理路径**前缀比较，不是字符串前缀。`outbox/link/x`（link 是 junction）
 *   字符串上以 outbox 开头，但 realpath 后 `link` 会解开成外部目录 ⇒ 必须拒绝。
 *
 * **本函数是纯函数**（只有只读 fs 调用，无副作用），可重复调用。
 *
 * @param {string} targetAbsPath 已 `path.resolve(cwd, 归一化后的 input.path)` 的目标绝对路径
 * @param {string} outboxAbsPath outbox 绝对路径（`~/.minipi/outbox`，ensureAppDirs 已建）
 * @returns {boolean} `true` = 允许写；`false` = 拒绝
 */
export function isWriteAllowed(targetAbsPath, outboxAbsPath) {
  // 入参校验：非字符串 / 空串一律拒绝（不 fail-open）。
  if (typeof targetAbsPath !== "string" || targetAbsPath.length === 0) return false;
  if (typeof outboxAbsPath !== "string" || outboxAbsPath.length === 0) return false;

  // 1. outbox 一定存在（ensureAppDirs 已建）。求不出 realpath → 拒绝。
  const root = realpathOrNull(outboxAbsPath);
  if (!root) return false;
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;

  // 2. 求 target 的物理路径：不存在就向上去到最深已存在祖先，再拼回未创建段。
  const probe = deepestExistingAncestor(targetAbsPath);
  const realProbe = realpathOrNull(probe);
  if (!realProbe) return false; // 连祖先都求不出来 → 拒绝（不 fail-open）

  let final;
  if (probe === targetAbsPath) {
    // target 本身已存在：realpath 结果就是物理路径
    final = realProbe;
  } else {
    // 把 target 剩余（尚未创建）的段拼回去
    const tail = path.relative(probe, targetAbsPath);
    final = tail === "" ? realProbe : path.join(realProbe, tail);
  }

  // 3. 前缀判定（**必须带分隔符**，防 outbox-evil 误判）。
  //    大小写策略：Windows 文件系统不区分大小写，这里**不区分**比较（见文件末说明）。
  const norm = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  return norm(final) === norm(root) || norm(final).startsWith(norm(rootSep));
}

/**
 * 场景三分：这个场景该怎么处置？
 *
 *   · `"sandbox"` —— outbox 场景，**必须**过沙箱校验（quick / note / desk）
 *   · `"exempt"`  —— 已知的豁免场景，**刻意**不过沙箱（repo → 走审批闸门）
 *   · `"unknown"` —— 未知 sceneId → **拒绝**（fail-closed，白名单语义）
 *
 * 为什么未知要拒：若把「不在沙箱名单」一律当「不用管」放行，
 * 则 `protocol.js` 将来新增一个 outbox 场景而忘记同步本文件时，
 * 该场景的沙箱会**静默失效**（QA A9-UNKNOWNSCENE 的 fail-open）。
 * 白名单语义下同样疏忽的后果是**误杀**（用户能感知、能上报），可接受得多。
 *
 * @param {unknown} sceneId
 * @returns {"sandbox"|"exempt"|"unknown"}
 */
export function sceneDisposition(sceneId) {
  if (typeof sceneId !== "string" || sceneId.length === 0) return "unknown";
  if (OUTBOX_SCENE_IDS.includes(sceneId)) return "sandbox";
  if (SANDBOX_EXEMPT_SCENE_IDS.includes(sceneId)) return "exempt";
  return "unknown";
}

/**
 * 按 **SDK 的 `resolvePath` 语义**把归一化后的路径算成绝对路径。
 *
 * 对应 `src/utils/paths.ts:102-106`：
 *   ```js
 *   export function resolvePath(input, baseDir = process.cwd(), options = {}) {
 *     const normalized = normalizePath(input, options);
 *     const normalizedBaseDir = normalizePath(baseDir);
 *     return isAbsolute(normalized)
 *       ? nodeResolvePath(normalized)               // ← 绝对路径：不带 baseDir
 *       : nodeResolvePath(normalizedBaseDir, normalized);  // ← 相对路径：拼 baseDir
 *   }
 *   ```
 *
 * ⚠ 为什么不能简单写成 `path.resolve(cwd, normalized)`：
 *   `path.resolve(cwd, abs)` 与 `path.resolve(abs)` 在 **Windows 盘符** 下不同——
 *   前者会把「无盘符的 rooted 路径」（如 `/tmp/x`）挂到 **cwd 所在盘**，
 *   后者挂到 **`process.cwd()` 所在盘**（SDK 用的是后者）。
 *   实测差异：SDK `resolveToCwd('/tmp/x', 'C:\\…\\outbox')` = `D:\tmp\x`（当前进程盘），
 *   而 `path.resolve(cwd, '/tmp/x')` = `C:\tmp\x`。
 *   两者都**在 outbox 之外**（都被拦，不构成逃逸），但为保证「判定路径 === 落盘路径」
 *   这条核心不变量，这里按 SDK 原样分叉。
 *
 * @param {string} normalized 已过 `normalizeToolPathLikeSdk()` 的路径
 * @param {string} cwd baseDir（相对路径的落点）
 * @returns {string} 绝对路径
 */
export function resolveToolPathLikeSdk(normalized, cwd) {
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

/**
 * 从 `input` 里取写工具的路径字段（白名单），并复刻 SDK 的归一化。
 *
 * **取不到 = 拒绝**（fail-closed）。不要退化成 `""`：
 * `path.resolve(cwd, "")` = cwd 本身 → 会被误判成「在 outbox 内」→ 放行（fail-open）。
 * 这正是 QA A6-FIELDLOCK 指出的问题。
 *
 * @param {object} input `event.input`
 * @returns {{ ok: true, raw: string, normalized: string } | { ok: false, why: string }}
 */
function resolveWriteTarget(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, why: "input 不是对象" };
  }
  /** @type {string|undefined} */
  let raw;
  for (const field of WRITE_PATH_FIELDS) {
    const v = /** @type {Record<string,unknown>} */ (input)[field];
    if (typeof v === "string") {
      raw = v;
      break;
    }
  }
  if (typeof raw !== "string") {
    // 字段名对不上 / 类型不对 → 拒绝。这是「SDK 换字段名」时的安全网。
    return { ok: false, why: "input 缺少可识别的路径字段" };
  }
  try {
    return { ok: true, raw, normalized: normalizeToolPathLikeSdk(raw) };
  } catch (err) {
    // 归一化本身抛（如畸形 file://）→ 拒绝。**绝不**回退到未归一化的 raw。
    return { ok: false, why: `路径归一化失败：${err?.code ?? err?.message ?? err}` };
  }
}

/**
 * 把 `tool_call` 事件翻成「拦不拦」的判定。**纯函数、可单测**，不读全局状态。
 *
 * 调用方（`session.js` 的 `registerGate`）负责：
 *   1. 用 `OUTBOX_SCENES.includes(sceneId)` 先做场景分流；
 *   2. 拿到 `{ blocked: true }` 后**直接返回 `{ block: true, reason }`**，
 *      **不弹审批卡**（沙箱违例不给用户「允许」的选项，见方案 §2.5）。
 *
 * 判定顺序（每一步都在前面失败即拒，不往下走）：
 *   ① 非写工具 → 放行（`read`/`grep`/… 属只读 allow）
 *   ② 场景三分：`exempt`（repo）→ 放行；`unknown` → **拒绝**；`sandbox` → 继续
 *   ③ 缺 `cwd` / `outboxDir` → 拒绝
 *   ④ 取/归一化路径失败 → 拒绝
 *   ⑤ **先 `normalizeToolPathLikeSdk()` 再 `path.resolve(cwd, …)`**（与 SDK 同序！）
 *   ⑥ `isWriteAllowed()` 物理判定
 *
 * @param {object} params
 * @param {string} params.toolName   `event.toolName`（如 `write` / `edit` / `read`）
 * @param {object} [params.input]    `event.input`（扩展侧字段名是 `input`，不是 `args`）
 * @param {string} [params.cwd]      该会话的 cwd（outbox 场景下就是 `OUTBOX_DIR`）
 * @param {string} [params.outboxDir] outbox 绝对路径（`OUTBOX_DIR`）
 * @param {string} [params.sceneId]  该会话的场景 id
 * @returns {{ blocked: boolean, reason?: string }} `blocked:true` 时 `reason` 为拒绝文案
 */
export function checkWriteTarget({ toolName, input, cwd, outboxDir, sceneId } = {}) {
  const deny = () => ({ blocked: true, reason: SANDBOX_DENY_REASON });

  // ① 非写工具：不拦。`read` / `grep` / `find` / `ls` 属「只读 allow」——
  // 这是**刻意取舍**：沙箱保「不往外面写」，不承诺「不往外面读」（见文件头说明）。
  if (typeof toolName !== "string" || !WRITE_TOOLS.includes(toolName)) {
    return { blocked: false };
  }

  // ② 场景三分（白名单语义）：未知场景 → 拒绝，不是放行。
  const disposition = sceneDisposition(sceneId);
  if (disposition === "exempt") return { blocked: false }; // repo：走审批闸门
  if (disposition === "unknown") return deny(); // 未知 → fail-closed

  // ③ 缺 cwd / outbox：无法判定 → 拒绝（不 fail-open，安全底线）。
  if (typeof cwd !== "string" || cwd.length === 0) return deny();
  if (typeof outboxDir !== "string" || outboxDir.length === 0) return deny();

  // ④ 取路径 + 复刻 SDK 归一化；取不到 / 抛 → 拒绝。
  const resolved = resolveWriteTarget(input);
  if (resolved.ok !== true) return deny();

  // ⑤ **顺序关键**：先归一化（SDK 语义），再 resolve。
  //    与 SDK 的 `resolveToCwd(path, cwd)` = `resolvePath(normalizePath(path,…), cwd)` 同序。
  //    先 resolve 再归一化是错的——那正是 `@` 逃逸的成因。
  const target = resolveToolPathLikeSdk(resolved.normalized, cwd);

  // ⑥ 物理边界判定
  if (isWriteAllowed(target, outboxDir)) return { blocked: false };
  return deny();
}

/* ============================================================================
 * 与 SDK 的隐性耦合（SDK 升级后**必须**回来核对这里）
 *
 * 本文件为守住「零业务依赖」不能 import SDK，因此有两处**手工镜像**。
 * 任何一处与 SDK 漂移，都可能造成沙箱逃逸（校验路径 ≠ 落盘路径）。
 *
 *   耦合点 A：`resolveToCwd` 的「相对拼 cwd / 绝对原样」语义
 *             —— 对应本文件 `checkWriteTarget()` 第 ⑤ 步的 `path.resolve(cwd, …)`
 *   耦合点 B：`normalizeToolPathLikeSdk()` —— 复刻 `normalizePath`
 *             的 5 条规则（Unicode 空格 / 剥 @ / win shell 盘符 / ~ 展开 / file://）
 *
 * **SDK 升级核对清单**（改了 SDK 版本就逐条走一遍）：
 *   1. 打开 `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js`，
 *      确认 `resolveToCwd` 的 options 仍是 `{ normalizeUnicodeSpaces: true, stripAtPrefix: true }`；
 *   2. 打开 `dist/utils/paths.js`，逐行比对 `normalizePath()`，
 *      确认规则集与顺序未变（尤其 `expandTilde` 的默认值、`normalizeWindowsShellPath`）；
 *   3. 确认 `write` / `edit` schema 的路径字段名仍是 `path`
 *      （`dist/core/tools/write.js` / `edit.js`）；
 *   4. 跑 `node scripts/verify-sandbox-live.mjs` —— **真实 Pi 会话**验证
 *      （唯一能证明「镜像与 SDK 真的对齐」的手段，不是自证自洽）。
 *
 * ⚠ 一个已知的**残留差异（不做，因为不影响安全）**：
 *   SDK 的 `read` 用 `resolveReadPath`，会额外尝试 macOS 的 AM/PM 变体、NFD 变体、
 *   弯引号变体（`path-utils.js:36-80`）。本沙箱**不拦 read**，所以**无需**复刻。
 *   若将来要收口 read，必须把这几个变体一并复刻，否则又是一条 TOCTOU。
 * ========================================================================== */

/* ============================================================================
 * Windows 大小写策略（明确说明，避免后人反复纠结）
 *
 * **策略：Windows 上不区分大小写比较；非 Windows 上区分。**
 *
 * 理由：
 *   · Windows 的 NTFS 默认不区分大小写 ⇒ `C:\Users\x\.minipi\OUTBOX\a.txt` 与
 *     `...\outbox\a.txt` **物理上是同一个目录**（NTFS 保留创建时的大小写，但查找不区分）。
 *   · 若比较时区分大小写，则模型传 `OUTBOX` 会被判成「不在 outbox 内」而拒绝——
 *     这是**误杀**（用户会莫名其妙被拦），且不提供任何安全收益（因为它是同一个目录）。
 *   · 反过来，对**非 Windows**（Linux/macOS 大小写敏感）必须区分，否则 `/Outbox` 会被误放行。
 *   · 实测风险：macOS 默认 APFS 也是大小写不敏感的，但为保守起见仍走区分分支
 *     （收紧比放松安全；macOS 上拒绝一次大写路径也不至于造成安全洞）。
 *
 * 注意：`path.resolve` / `realpathSync` 返回的是**真实磁盘大小写**（NTFS 下会归一到
 * 文件创建时的名字），所以大小写比较主要影响「模型手打了一个大小写不同的 outbox 路径」
 * 这一种边缘情况。上面实现了归一化（win32 下 `toLowerCase`）。
 * ========================================================================== */
