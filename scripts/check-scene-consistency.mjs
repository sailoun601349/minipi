/**
 * 场景名一致性静态扫描（纯 Node，零依赖，不 eval、不 import HTML）。
 *
 * 为什么需要它（impl-plan §1.4 / T0.6）：
 *   `src/shared/protocol.js` 是场景名/契约常量的**唯一来源**，但 `src/renderer/index.html`
 *   受「零依赖单文件」约束**不能 import 它**，只能手工镜像一份 `SCENE_DEFS`。
 *   手工镜像一定会漂 —— 这个脚本就是防漂移的守门人：只要两边任何一处
 *   （键名 / 顺序 / cwdTemplate / label / description / noTools / toolAllowlist /
 *     sessionManagerMode / DEFAULT_SCENE_ID / OUTBOX_SCENES / data-scene 按钮 /
 *     .chip--{sceneId} / ERROR_CODES / OUTCOME_FORMAT(_IDS) / OUTCOME_ACTIONS /
 *     LIMITS.OUTCOME_TITLE_MAX_CHARS / WINDOW_STATE(_IDS) / STREAMING_BEHAVIOR）不一致，
 *   就**非零退出并逐条指出差异**（要具体到「protocol.js 的 desk.cwdTemplate 是 X，index.html 是 Y」）。
 *
 * 守门范围分两类：
 *   · [1]~[11]：场景名相关（原名）。
 *   · [12]~[17]：契约常量镜像守卫（QA-P3-1 / QA-P3-2 补）——
 *     渲染层「契约镜像」区块逐字复制 protocol.js 的常量；只要有一处漏了/改了字，
 *     运行时会静默降级（如 SANDBOX_DENIED 缺失 → parseErrorMessage 归成 INTERNAL），
 *     必须由静态扫描在开发期拦住。
 *   ⚠ 「渲染层刻意只镜像子集」的常量，**必须**在下方 `MIRROR_WHITELIST` 里显式登记 +
 *     写清为什么不是全集；**禁止**用「跳过不查」来掩盖缺失（那样等于守门失效）。
 *
 * 做法：
 *   1. `fs.readFileSync` 读两个文件，**用正则切出** `SCENE_DEFS = { ... }` 区块；
 *   2. 对每个场景，再用正则抽出该场景对象的**花括号配对区间**（brace matching，
 *      字符串/注释感知），在其内抽字段；
 *   3. 数组类字段（toolAllowlist）用「引号 token 顺序」表示，天然能查出「集合或顺序」差异。
 *
 * ⚠ 为什么不 import protocol.js：本脚本要能验证「渲染层镜像 vs 真源」，
 *   同时保持与真源**完全解耦**（真源将来搬包 / 改结构也不会把脚本一起弄坏）。
 *   读取文本 + 正则，是最抗重构的方式。
 *
 * 用法：`node scripts/check-scene-consistency.mjs`（退出码 0 = 全绿，1 = 有漂移）
 *   挂点：`package.json` → `verify:scene`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 关于「旧场景名残留」检查（§11）的**排除规则**（刻意保留，别一刀切误报）：
 *   · 扫描范围**只有** `src/` + `scripts/` + `README.md` 三个位置。
 *     明确**不含** `vendor/`（第三方源码）、`docs/` / `spike/` / `qa/` / `prototype/`
 *     （历史文档与原型，里面的旧名是**历史记录**，本来就该在）。
 *   · 排除 `src/main/settings.js` 的 `LEGACY_SCENE_MAP` 迁移映射 —— 那是**刻意保留**的：
 *     老用户 settings.json 里躺着的 `speed/study/work` 必须能静默迁移到新名（impl-plan §4.1）。
 *     排除做法：文件名命中 settings.js 时，**整行**若形如 `key: "value"`（映射表条目）
 *     或位于 `//` 行注释里，即视为「迁移用途」，不计入残留。
 *   · 排除**注释里的历史说明**（`//` 行注释、块注释、HTML 注释、`#` 行）：
 *     例如「旧名 → 新名：speed → quick」这类解释性文字。
 *   · 排除 `README.md` 里的**迁移说明**（含「旧名」「迁移」「→」「不会主动删除」等关键词的行）。
 *   · 排除**本脚本自身**（它要引用旧名才能检查旧名，属自指）。
 *   · 排除 `scripts/verify-v04.mjs` 的**迁移测试用例** —— 那是**刻意保留**的：
 *     「旧名必须被静默迁移」这一行为需要被测试守住（impl-plan §4.1），
 *     测试断言里出现旧名是**正确用法**，不是残留。
 *   · 只认「作为**场景名**出现」：字符串字面量 `"speed"` / `'speed'`，或 `data-scene="speed"`。
 *     普通英文单词 `work`（如 `workArea` / `worktree` / `网络`）**不算** —— 不做裸词匹配。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROTOCOL_FILE = path.join(ROOT, "src", "shared", "protocol.js");
const HTML_FILE = path.join(ROOT, "src", "renderer", "index.html");

/* ==========================================================================
 * 统计与输出（照 scripts/verify-v04.mjs 的风格）
 * ========================================================================== */
let pass = 0;
let fail = 0;
const diffs = []; // 每条失败的具体差异，最后统一打出来

/**
 * 记一条断言。
 * @param {boolean} cond
 * @param {string} label 通过时展示的标题
 * @param {string} [detail] 失败时展示的具体差异（会进差异清单）
 * @returns {boolean}
 */
function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  fail  ${label}`);
    if (detail) {
      diffs.push(`· ${label}\n    ${detail}`);
    }
  }
  return cond;
}

function group(title) {
  console.log(`\n${title}`);
}

/* ==========================================================================
 * 1. 文本工具：字符串/注释感知的花括号配对 + 引号 token 提取
 * ========================================================================== */

/**
 * 从 `start` 位置的 `{` 开始，找到与之配对的 `}` 下标。
 * 跳过：单/双/反引号字符串、`//` 行注释、`/* *​/` 块注释 —— 否则字符串里的
 * 花括号会让配对跑偏（本文件里 description 是中文，含标点但无花括号，仍需防未来）。
 * @param {string} src
 * @param {number} start index of '{'
 * @returns {number} index of matching '}'；找不到返回 -1
 */
function matchBrace(src, start) {
  if (src[start] !== "{") return -1;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // 行注释
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    // 块注释
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1; // 转义
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 在源文本里找到 `const <name> = {` （或 `const <name> = Object.freeze({`）
 * 之后的对象区间，返回 `{ body, startIdx, endIdx }`。
 * @param {string} src
 * @param {string} name 变量名
 * @returns {{ body: string, startIdx: number, endIdx: number } | null}
 */
function extractObjectBody(src, name) {
  // 匹配 `const NAME =` 或 `export const NAME =`
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const braceStart = m.index + m[0].length - 1; // 指向 '{'
  const braceEnd = matchBrace(src, braceStart);
  if (braceEnd === -1) return null;
  return { body: src.slice(braceStart, braceEnd + 1), startIdx: braceStart, endIdx: braceEnd };
}

/**
 * 从对象体里抽顶层字段的键名（按出现顺序）。
 * 只认形如 `key:` 的顶层键；用简化的 brace 深度跟踪跳过嵌套。
 * @param {string} objBody 形如 `{ quick: {...}, note: {...} }`
 * @returns {string[]}
 */
function topLevelKeys(objBody) {
  // 去掉最外层花括号
  const inner = objBody.slice(1, -1);
  const keys = [];
  let depth = 0;
  let i = 0;
  let segmentStart = 0;
  // 逐字符扫，遇到顶层逗号就把 [segmentStart, i) 作为一个字段段
  const segments = [];
  while (i < inner.length) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (ch === "/" && next === "/") {
      const nl = inner.indexOf("\n", i);
      i = nl === -1 ? inner.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = inner.indexOf("*/", i + 2);
      i = end === -1 ? inner.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push(inner.slice(segmentStart, i));
      segmentStart = i + 1;
    }
    i += 1;
  }
  const tail = inner.slice(segmentStart);
  if (tail.trim()) segments.push(tail);

  for (const seg of segments) {
    // 一个字段段形如 `\n  quick: Object.freeze({ ... })`
    const m = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** 抽形如 `key: "value"` / `key: 'value'` 的字符串字段值（取第一个匹配）。 */
function fieldString(text, key) {
  const re = new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*["']([^"']*)["']`);
  const m = re.exec(text);
  return m ? m[1] : null;
}

/**
 * 抽形如 `key: <literal>` 的**裸值**（数字 / `null` / 字符串 / 布尔）。
 * 用于 noTools（可能为 `"all"` 或 `null`）与 sessionManagerMode。
 * @param {string} text
 * @param {string} key
 * @returns {string|null} 归一化后的字面量字符串（`null` 会以字面量 "null" 返回）
 */
function fieldLiteral(text, key) {
  const re = new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|null|true|false|-?\\d+)`);
  const m = re.exec(text);
  if (!m) return null;
  let v = m[1];
  // 去掉引号，方便统一比较（但 null 保持 "null" 字面量）
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * 抽数组字段里的**引号 token 顺序**，如 `['read','write']` → `["read","write"]`。
 * 用引号 token 顺序表示，既查集合也查顺序。
 * @param {string} text 该场景对象体
 * @param {string} key
 * @returns {string[]|null}
 */
function fieldStringArray(text, key) {
  const re = new RegExp(`["']?${key}["']?\\s*:\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\[`);
  const m = re.exec(text);
  if (!m) return null;
  const arrStart = m.index + m[0].length - 1;
  const arrEnd = matchBracket(text, arrStart, "[", "]");
  if (arrEnd === -1) return null;
  const inner = text.slice(arrStart + 1, arrEnd);
  const out = [];
  const tokenRe = /["']([^"']*)["']/g;
  let t;
  while ((t = tokenRe.exec(inner)) !== null) out.push(t[1]);
  return out;
}

/** 通用的配对扫描（方括号 / 圆括号）。字符串与注释感知。 */
function matchBracket(src, start, open, close) {
  if (src[start] !== open) return -1;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 抽 SCENE_DEFS 里每个场景对象的**自身对象体**（`{ sceneId: ..., ... }`）。
 * 入参是整个 SCENE_DEFS 对象体。
 * @returns {Map<string, string>} sceneId → 场景对象体文本
 */
function sceneBodies(sceneDefsBody) {
  const out = new Map();
  const inner = sceneDefsBody.slice(1, -1);
  // 逐个顶层字段段切开
  let depth = 0;
  let i = 0;
  let segStart = 0;
  const segments = [];
  while (i < inner.length) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (ch === "/" && next === "/") {
      const nl = inner.indexOf("\n", i);
      i = nl === -1 ? inner.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = inner.indexOf("*/", i + 2);
      i = end === -1 ? inner.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push(inner.slice(segStart, i));
      segStart = i + 1;
    }
    i += 1;
  }
  const tail = inner.slice(segStart);
  if (tail.trim()) segments.push(tail);

  for (const seg of segments) {
    const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
    if (!km) continue;
    const key = km[1];
    // 从 seg 里找 Object.freeze({ 后的 '{'，或直接的 '{'
    const braceIdx = seg.indexOf("{", km.index + km[0].length);
    if (braceIdx === -1) continue;
    const end = matchBrace(seg, braceIdx);
    if (end === -1) continue;
    out.set(key, seg.slice(braceIdx, end + 1));
  }
  return out;
}

/** 归一化：对比数组用（去空白）。 */
function normArr(a) {
  return a === null || a === undefined ? null : a.map((x) => String(x).trim());
}

function eqArr(a, b) {
  const na = normArr(a);
  const nb = normArr(b);
  if (na === null || nb === null) return na === nb;
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

function fmt(v) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

/* ==========================================================================
 * 1b. 契约常量镜像守卫用的小工具（QA-P3-1 补）
 * ========================================================================== */

/**
 * 把 `Object.freeze({ A: "a", B: "b" })` 形式的对象体，抽成**有序**的 `KEY=value` 列表。
 * 顺序也参与比较（键顺序变了通常意味着有人在重排，值得知道）。
 * @param {{body:string}|null} objBody extractObjectBody 的返回
 * @returns {string[]|null} 形如 `["A=a","B=b"]`
 */
function objectEntries(objBody) {
  if (!objBody) return null;
  const inner = objBody.body.slice(1, -1);
  const out = [];
  // 匹配 `KEY: "value"` / `KEY: 'value'`（值为字符串；本套常量值全是字符串）
  const re = /([A-Za-z_$][\w$]*)\s*:\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(inner)) !== null) out.push(`${m[1]}=${m[2]}`);
  return out;
}

/**
 * 抽形如 `export const NAME = Object.freeze([ "a", "b" ]);` 的字符串数组（引号 token 顺序）。
 * 亦支持 `Object.freeze(Object.values(SRC))` 写法：此时从 `SRC` 对象体的**值**推导
 * （protocol.js / index.html 的 OUTCOME_FORMAT_IDS 都用了这种写法）。
 * @param {string} src
 * @param {string} name
 * @returns {string[]|null}
 */
function extractFrozenStringArray(src, name) {
  // 形态 1：字面量数组
  const litRe = new RegExp(`${name}\\s*=\\s*Object\\.freeze\\s*\\(\\s*\\[`);
  const m = litRe.exec(src);
  if (m) {
    const arrStart = m.index + m[0].length - 1; // m[0] 以 `[` 结尾 → 指向该 `[`
    if (src[arrStart] !== "[") return null;
    const arrEnd = matchBracket(src, arrStart, "[", "]");
    if (arrEnd === -1) return null;
    const inner = src.slice(arrStart + 1, arrEnd);
    const out = [];
    const tokenRe = /["']([^"']*)["']/g;
    let t;
    while ((t = tokenRe.exec(inner)) !== null) out.push(t[1]);
    return out;
  }
  // 形态 2：Object.freeze(Object.values(SRC)) → 从 SRC 的值推导
  const valRe = new RegExp(`${name}\\s*=\\s*Object\\.freeze\\s*\\(\\s*Object\\.values\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`);
  const mv = valRe.exec(src);
  if (mv) {
    const entries = objectEntries(extractObjectBody(src, mv[1]));
    if (!entries) return null;
    return entries.map((e) => e.slice(e.indexOf("=") + 1));
  }
  return null;
}

/**
 * 从 `LIMITS` 对象体里抽某个数值字段（形如 `OUTCOME_TITLE_MAX_CHARS: 120,`）。
 * 支持 `10 * 1024 * 1024` 这类简单乘式 —— 但只用于**值比较**，统一按字面量字符串比较。
 * @param {{body:string}|null} limitsBody
 * @param {string} key
 * @returns {string|null} 归一化（去空白）后的数值字面量，如 `"120"` / `"10*1024*1024"`
 */
function limitsNumeric(limitsBody, key) {
  if (!limitsBody) return null;
  const re = new RegExp(`${key}\\s*:\\s*([0-9_\\s*]+)`);
  const m = re.exec(limitsBody.body);
  if (!m) return null;
  return m[1].replace(/[\s_]/g, "");
}

/**
 * 归一化一组 `KEY=value`（用于比较；null → null）。
 */
function normEntries(a) {
  return a === null || a === undefined ? null : a.map((x) => String(x).trim());
}

function eqEntries(a, b) {
  const na = normEntries(a);
  const nb = normEntries(b);
  if (na === null || nb === null) return na === nb;
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/* ==========================================================================
 * 2. 读取两个文件
 * ========================================================================== */
console.log("=".repeat(72));
console.log(" minipi 场景名一致性静态扫描（protocol.js 真源 ↔ index.html 镜像）");
console.log(` Node ${process.version} · 根 ${ROOT}`);
console.log("=".repeat(72));

const protocolSrc = fs.readFileSync(PROTOCOL_FILE, "utf8");
const htmlSrc = fs.readFileSync(HTML_FILE, "utf8");

/* ---- protocol.js 侧 ---- */
const pSceneDefs = extractObjectBody(protocolSrc, "SCENE_DEFS");
const pIds = pSceneDefs ? topLevelKeys(pSceneDefs.body) : [];
const pBodies = pSceneDefs ? sceneBodies(pSceneDefs.body) : new Map();

/** 抽 protocol.js 的 DEFAULT_SCENE_ID（`export const DEFAULT_SCENE_ID = "quick";`） */
function extractScalar(src, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(["'][^"']*["']|null|true|false|-?\\d+)\\s*;`);
  const m = re.exec(src);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

const pDefault = extractScalar(protocolSrc, "DEFAULT_SCENE_ID");
const pOutbox = fieldStringArray(protocolSrc, "OUTBOX_SCENES") // OUTBOX_SCENES = Object.freeze([...])
  || (() => {
    const m = /OUTBOX_SCENES\s*=\s*Object\.freeze\s*\(\s*\[([^\]]*)\]/.exec(protocolSrc);
    return m ? (m[1].match(/["']([^"']*)["']/g) || []).map((s) => s.slice(1, -1)) : null;
  })();

/* ---- index.html 侧 ---- */
const hSceneDefs = extractObjectBody(htmlSrc, "SCENE_DEFS");
const hIds = hSceneDefs ? topLevelKeys(hSceneDefs.body) : [];
const hBodies = hSceneDefs ? sceneBodies(hSceneDefs.body) : new Map();
const hDefault = extractScalar(htmlSrc, "DEFAULT_SCENE_ID");
const hOutbox = (() => {
  const m = /OUTBOX_SCENES\s*=\s*Object\.freeze\s*\(\s*\[([^\]]*)\]/.exec(htmlSrc);
  return m ? (m[1].match(/["']([^"']*)["']/g) || []).map((s) => s.slice(1, -1)) : null;
})();

/* ==========================================================================
 * 3. 逐条检查
 * ========================================================================== */

group("[1] 场景键名集合与顺序");
ok(pIds.length > 0, `protocol.js 解析出 ${pIds.length} 个场景键 [${pIds.join(", ")}]`, "protocol.js 的 SCENE_DEFS 没解析出来");
ok(hIds.length > 0, `index.html 解析出 ${hIds.length} 个场景键 [${hIds.join(", ")}]`, "index.html 的 SCENE_DEFS 没解析出来");
ok(
  pIds.join(",") === hIds.join(","),
  `键名集合与顺序一致 [${pIds.join(", ")}]`,
  `顺序/集合不一致：protocol.js = [${pIds.join(", ")}]，index.html = [${hIds.join(", ")}]`
);

group("[2] 每个场景的 cwdTemplate 一致（⚠ 重点）");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldString(pBodies.get(id), "cwdTemplate") : null;
  const hv = hBodies.has(id) ? fieldString(hBodies.get(id), "cwdTemplate") : null;
  ok(
    pv !== null && pv === hv,
    `${id.padEnd(5)} cwdTemplate = ${fmt(pv)}`,
    `protocol.js 的 ${id}.cwdTemplate 是 ${fmt(pv)}，index.html 是 ${fmt(hv)}`
  );
}

group("[3] 每个场景的 label 一致");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldString(pBodies.get(id), "label") : null;
  const hv = hBodies.has(id) ? fieldString(hBodies.get(id), "label") : null;
  ok(
    pv !== null && pv === hv,
    `${id.padEnd(5)} label = ${fmt(pv)}`,
    `protocol.js 的 ${id}.label 是 ${fmt(pv)}，index.html 是 ${fmt(hv)}`
  );
}

group("[4] 每个场景的 noTools 一致（含 \"all\" / null 区分）");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldLiteral(pBodies.get(id), "noTools") : null;
  const hv = hBodies.has(id) ? fieldLiteral(hBodies.get(id), "noTools") : null;
  ok(
    pv !== null && pv === hv,
    `${id.padEnd(5)} noTools = ${fmt(pv)}`,
    `protocol.js 的 ${id}.noTools 是 ${fmt(pv)}，index.html 是 ${fmt(hv)}`
  );
}

group("[5] 每个场景 toolAllowlist 的元素集合与顺序一致");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldStringArray(pBodies.get(id), "toolAllowlist") : null;
  const hv = hBodies.has(id) ? fieldStringArray(hBodies.get(id), "toolAllowlist") : null;
  ok(
    pv !== null && eqArr(pv, hv),
    `${id.padEnd(5)} toolAllowlist = ${fmt(pv)}`,
    `protocol.js 的 ${id}.toolAllowlist 是 ${fmt(pv)}，index.html 是 ${fmt(hv)}`
  );
}

group("[6] 每个场景 sessionManagerMode 一致");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldString(pBodies.get(id), "sessionManagerMode") : null;
  const hv = hBodies.has(id) ? fieldString(hBodies.get(id), "sessionManagerMode") : null;
  ok(
    pv !== null && pv === hv,
    `${id.padEnd(5)} sessionManagerMode = ${fmt(pv)}`,
    `protocol.js 的 ${id}.sessionManagerMode 是 ${fmt(pv)}，index.html 是 ${fmt(hv)}`
  );
}

group("[7] 每个场景 description 一致（QA-P3-2：文案漂移守卫，逐字比对）");
for (const id of pIds) {
  const pv = pBodies.has(id) ? fieldString(pBodies.get(id), "description") : null;
  const hv = hBodies.has(id) ? fieldString(hBodies.get(id), "description") : null;
  ok(
    pv !== null && pv === hv,
    `${id.padEnd(5)} description = ${pv === null ? "null" : pv.slice(0, 18) + (pv.length > 18 ? "…" : "")}`,
    `protocol.js 的 ${id}.description 是 ${JSON.stringify(pv)}，index.html 是 ${JSON.stringify(hv)}`
  );
}

group("[8] DEFAULT_SCENE_ID 一致");
ok(
  pDefault !== null && pDefault === hDefault,
  `DEFAULT_SCENE_ID = ${fmt(pDefault)}`,
  `protocol.js 的 DEFAULT_SCENE_ID 是 ${fmt(pDefault)}，index.html 是 ${fmt(hDefault)}`
);
ok(pDefault !== null && pIds.includes(pDefault), `DEFAULT_SCENE_ID 属于 SCENE_IDS`, `DEFAULT_SCENE_ID ${fmt(pDefault)} 不在 [${pIds.join(", ")}]`);

group("[9] OUTBOX_SCENES 一致");
ok(
  pOutbox !== null && eqArr(pOutbox, hOutbox),
  `OUTBOX_SCENES = ${fmt(pOutbox)}`,
  `protocol.js 的 OUTBOX_SCENES 是 ${fmt(pOutbox)}，index.html 是 ${fmt(hOutbox)}`
);

group("[10] HTML 里 data-scene 按钮取值集合与顺序 = SCENE_IDS");
const dataScenes = (() => {
  const out = [];
  const re = /data-scene\s*=\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(htmlSrc)) !== null) out.push(m[1]);
  return out;
})();
ok(
  dataScenes.length > 0,
  `HTML 找到 ${dataScenes.length} 个 data-scene 按钮 [${dataScenes.join(", ")}]`,
  "HTML 里一个 data-scene 按钮都没有"
);
ok(
  dataScenes.join(",") === pIds.join(","),
  `data-scene 顺序 = SCENE_IDS [${pIds.join(", ")}]`,
  `data-scene 顺序/集合不一致：HTML = [${dataScenes.join(", ")}]，SCENE_IDS = [${pIds.join(", ")}]`
);

group("[11] HTML 里存在 .chip--{sceneId} CSS 类（每个场景一个）");
for (const id of pIds) {
  const re = new RegExp(`\\.chip--${id}\\s*\\{`);
  ok(re.test(htmlSrc), `.chip--${id} 已定义`, `HTML 的 CSS 里缺 .chip--${id} 规则`);
}

group("[12] 全仓库无「旧场景名作为场景名」的残留（src/ + scripts/ + README.md）");
{
  const OLD_NAMES = ["speed", "study", "work"];
  const SCAN_FILES = [];
  // 递归收集 src/
  const collect = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(full);
      else if (/\.(js|mjs|cjs|html|htm)$/.test(ent.name)) SCAN_FILES.push(full);
    }
  };
  collect(path.join(ROOT, "src"));
  // scripts/ 下的 .mjs（跳过 out/ 产物目录）
  for (const ent of fs.readdirSync(path.join(ROOT, "scripts"), { withFileTypes: true })) {
    if (ent.isDirectory()) continue; // 不递归 scripts/out 等产物
    if (/\.mjs$/.test(ent.name)) SCAN_FILES.push(path.join(ROOT, "scripts", ent.name));
  }
  SCAN_FILES.push(path.join(ROOT, "README.md"));

  /**
   * 判定某一行是否是「排除项」。返回排除原因字符串，或 null（= 残留）。
   * @param {string} file 绝对路径
   * @param {string} rawLine 原始行
   */
  const excludeReason = (file, rawLine) => {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const line = rawLine.trim();

    // (a) 注释行：// · * · /* · <!-- · #
    if (/^\/\//.test(line) || /^\*/.test(line) || /^\/\*/.test(line) || /^<!--/.test(line) || /^#/.test(line)) {
      return "注释（历史说明）";
    }
    // (a2) 行内 `// ...` 注释之后的内容 —— 只对「旧名只出现在注释里」的行做排除
    const hashIdx = line.indexOf("//");
    if (hashIdx >= 0) {
      const codePart = line.slice(0, hashIdx);
      const codeHasOld = OLD_NAMES.some((n) => new RegExp(`["']${n}["']|data-scene\\s*=\\s*["']${n}["']`).test(codePart));
      if (!codeHasOld) return "行尾注释（历史说明）";
    }

    // (b) settings.js 的 LEGACY_SCENE_MAP 迁移映射（刻意保留）
    if (rel === "src/main/settings.js") {
      // 映射条目：`speed: "quick",` / `study: "note",` / `work: "repo",`
      if (OLD_NAMES.some((n) => new RegExp(`^${n}\\s*:\\s*["'][a-z]+["']\\s*,?$`).test(line))) {
        return "LEGACY_SCENE_MAP 迁移映射（刻意保留）";
      }
    }

    // (b2) 本脚本自身：它必须引用旧名才能检查旧名（自指，不算残留）
    if (rel === "scripts/check-scene-consistency.mjs") {
      return "本脚本自身（检查旧名需要引用旧名）";
    }

    // (b3) verify-v04.mjs 的迁移测试用例（刻意保留：守住「旧名被静默迁移」这一行为）
    if (rel === "scripts/verify-v04.mjs") {
      return "迁移测试用例（刻意保留）";
    }

    // (c) README.md 的迁移说明
    if (rel === "README.md") {
      if (/旧名|迁移|重命名|→|不会主动删除|老版本/.test(line)) return "README 迁移说明";
      // `speed` → `quick` 这类对照，含箭头一定已在上一条覆盖
      // 兼容写法：`speed/study/work` 出现在「老目录」说明里
      if (/scratch|study\/|work\//.test(line)) return "README 迁移说明";
    }
    return null;
  };

  // 「作为场景名出现」的判定：字符串字面量 "speed"/'speed'，或 data-scene="speed"
  // ⚠ 不做裸词匹配 —— `workArea` / `worktree` / 中文「网络」都不算。
  const sceneNameRe = OLD_NAMES.map((n) => `["']${n}["']|data-scene\\s*=\\s*["']${n}["']`).join("|");
  const lineRe = new RegExp(sceneNameRe);

  const residuals = [];
  for (const file of SCAN_FILES) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (!lineRe.test(line)) return;
      const reason = excludeReason(file, line);
      if (reason) return; // 命中排除规则 → 不算残留
      residuals.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}:${idx + 1}  ${line.trim()}`);
    });
  }

  ok(
    residuals.length === 0,
    `扫描 ${SCAN_FILES.length} 个文件，无旧场景名残留（speed/study/work 作为场景名）`,
    `发现 ${residuals.length} 处残留：\n      ${residuals.join("\n      ")}`
  );
}

/* ==========================================================================
 * 3b. 契约常量镜像守卫（QA-P3-1 / QA-P3-2 补）
 *
 * 背景：渲染层「契约镜像」区块（index.html §A）逐字复制了 protocol.js 的若干冻结常量。
 * 这些常量一旦漏抄 / 抄错一字符，**不会报错**，只会静默降级：
 *   · ERROR_CODES 少一项 → parseErrorMessage 把该错误码归成 INTERNAL，错误分类错；
 *   · OUTCOME_ACTIONS 少一项 → 卡片少画一个按钮；
 *   · OUTCOME_TITLE_MAX_CHARS 不一致 → 文件名截断长度错。
 * 因此必须由静态扫描在开发期拦住（运行期无 import 可用）。
 *
 * ⚠ 关于「有意只镜像子集」：渲染层并不需要 protocol.js 的**全部**常量。
 *   凡属「渲染层刻意不镜像」的，**必须**在 `MIRROR_WHITELIST` 里显式登记 + 写明理由，
 *   并且下方断言会**核对白名单里的项确实在渲染层不存在**（防止有人删了豁免还在名单里）。
 *   **禁止**用「这个常量干脆不查」来掩盖 —— 那就是守门失效（QA-P3-1 的原话）。
 * ========================================================================== */

/**
 * 渲染层**刻意不镜像**的 protocol.js 常量白名单：`name → 理由`。
 * 注意：这里登记的是「整条常量不镜像」，不是「镜像了个子集」。
 *   渲染层若镜像了某常量，就必须**全量**一致（下方断言按全量比对）。
 */
const MIRROR_WHITELIST = Object.freeze({
  STREAMING_BEHAVIOR:
    "渲染层目前只用 steer（当前 UI 不发起 followUp），把 behavior 字面量内联在 prompt 调用处，未镜像整个枚举。" +
    "这是刻意的子集使用；若将来 UI 要发起 followUp，必须改为镜像整条常量并由本脚本守门。",
});

group("[13] ERROR_CODES 全量一致（值集合 + 顺序；QA-P3-1：曾漏 SANDBOX_DENIED）");
{
  const pCodes = objectEntries(extractObjectBody(protocolSrc, "ERROR_CODES"));
  const hCodes = objectEntries(extractObjectBody(htmlSrc, "ERROR_CODES"));
  ok(
    pCodes !== null && pCodes.length > 0,
    `protocol.js ERROR_CODES 解析出 ${pCodes ? pCodes.length : 0} 项`,
    "protocol.js 的 ERROR_CODES 没解析出来"
  );
  ok(
    hCodes !== null && hCodes.length > 0,
    `index.html ERROR_CODES 解析出 ${hCodes ? hCodes.length : 0} 项`,
    "index.html 的 ERROR_CODES 没解析出来（渲染层【必须】全量镜像 ERROR_CODES）"
  );
  ok(
    eqEntries(pCodes, hCodes),
    `ERROR_CODES 全量一致 [${(pCodes || []).join(", ")}]`,
    `ERROR_CODES 不一致：\n      protocol.js = [${(pCodes || []).join(", ")}]\n      index.html  = [${(hCodes || []).join(", ")}]`
  );
}

group("[14] OUTCOME_FORMAT / OUTCOME_FORMAT_IDS / OUTCOME_ACTIONS 一致");
{
  const pFmt = objectEntries(extractObjectBody(protocolSrc, "OUTCOME_FORMAT"));
  const hFmt = objectEntries(extractObjectBody(htmlSrc, "OUTCOME_FORMAT"));
  ok(
    eqEntries(pFmt, hFmt),
    `OUTCOME_FORMAT 一致 [${(pFmt || []).join(", ")}]`,
    `OUTCOME_FORMAT 不一致：protocol.js = [${(pFmt || []).join(", ")}]，index.html = [${(hFmt || []).join(", ")}]`
  );

  const pFmtIds = extractFrozenStringArray(protocolSrc, "OUTCOME_FORMAT_IDS");
  const hFmtIds = extractFrozenStringArray(htmlSrc, "OUTCOME_FORMAT_IDS");
  ok(
    eqArr(pFmtIds, hFmtIds),
    `OUTCOME_FORMAT_IDS 一致 [${(pFmtIds || []).join(", ")}]`,
    `OUTCOME_FORMAT_IDS 不一致：protocol.js = [${(pFmtIds || []).join(", ")}]，index.html = [${(hFmtIds || []).join(", ")}]`
  );

  const pActs = extractFrozenStringArray(protocolSrc, "OUTCOME_ACTIONS");
  const hActs = extractFrozenStringArray(htmlSrc, "OUTCOME_ACTIONS");
  ok(
    eqArr(pActs, hActs),
    `OUTCOME_ACTIONS 一致 [${(pActs || []).join(", ")}]`,
    `OUTCOME_ACTIONS 不一致：protocol.js = [${(pActs || []).join(", ")}]，index.html = [${(hActs || []).join(", ")}]`
  );
}

group("[15] LIMITS.OUTCOME_TITLE_MAX_CHARS 一致（决定文件名截断 maxChars）");
{
  const pLimits = extractObjectBody(protocolSrc, "LIMITS");
  const hVal = (() => {
    const m = /OUTCOME_TITLE_MAX_CHARS\s*=\s*([0-9_]+)/.exec(htmlSrc);
    return m ? m[1].replace(/_/g, "") : null;
  })();
  const pVal = limitsNumeric(pLimits, "OUTCOME_TITLE_MAX_CHARS");
  ok(
    pVal !== null && pVal === hVal,
    `OUTCOME_TITLE_MAX_CHARS = ${fmt(pVal)}`,
    `OUTCOME_TITLE_MAX_CHARS 不一致：protocol.js 的 LIMITS.OUTCOME_TITLE_MAX_CHARS = ${fmt(pVal)}，index.html = ${fmt(hVal)}`
  );
}

group("[16] WINDOW_STATE / WINDOW_STATE_IDS 一致（ball/mini/full）");
{
  const pWs = objectEntries(extractObjectBody(protocolSrc, "WINDOW_STATE"));
  const hWs = objectEntries(extractObjectBody(htmlSrc, "WINDOW_STATE"));
  ok(
    eqEntries(pWs, hWs),
    `WINDOW_STATE 一致 [${(pWs || []).join(", ")}]`,
    `WINDOW_STATE 不一致：protocol.js = [${(pWs || []).join(", ")}]，index.html = [${(hWs || []).join(", ")}]`
  );

  const pIdsArr = extractFrozenStringArray(protocolSrc, "WINDOW_STATE_IDS");
  // 渲染层镜像的是 WINDOW_STATE 对象（值即 id），从对象值推导顺序 = Object.values(WINDOW_STATE)
  const hIdsFromObj = (hWs || []).map((e) => e.slice(e.indexOf("=") + 1));
  ok(
    eqArr(pIdsArr, hIdsFromObj),
    `WINDOW_STATE_IDS 顺序与镜像一致 [${(pIdsArr || []).join(", ")}]`,
    `WINDOW_STATE_IDS 不一致：protocol.js = [${(pIdsArr || []).join(", ")}]，index.html 由 WINDOW_STATE 推导 = [${hIdsFromObj.join(", ")}]`
  );
}

group("[17] STREAMING_BEHAVIOR 一致性（渲染层未镜像 → 走显式白名单，白名单必须真实）");
{
  const pBehav = objectEntries(extractObjectBody(protocolSrc, "STREAMING_BEHAVIOR"));
  const hBehav = extractObjectBody(htmlSrc, "STREAMING_BEHAVIOR");
  const whitelisted = Object.prototype.hasOwnProperty.call(MIRROR_WHITELIST, "STREAMING_BEHAVIOR");

  ok(
    pBehav !== null && pBehav.length > 0,
    `protocol.js STREAMING_BEHAVIOR = [${(pBehav || []).join(", ")}]`,
    "protocol.js 的 STREAMING_BEHAVIOR 没解析出来"
  );

  if (whitelisted) {
    // 白名单生效：渲染层**必须**确实没镜像它（否则白名单是历史残留，应删除）
    ok(
      hBehav === null,
      `渲染层刻意不镜像 STREAMING_BEHAVIOR（已登记白名单：${MIRROR_WHITELIST.STREAMING_BEHAVIOR.slice(0, 40)}…）`,
      "STREAMING_BEHAVIOR 已在渲染层出现，但白名单仍声称「不镜像」—— 请删掉白名单项并改为全量比对"
    );
  } else {
    const hBehavEntries = objectEntries(hBehav);
    ok(
      eqEntries(pBehav, hBehavEntries),
      `STREAMING_BEHAVIOR 全量一致 [${(pBehav || []).join(", ")}]`,
      `STREAMING_BEHAVIOR 不一致：protocol.js = [${(pBehav || []).join(", ")}]，index.html = [${(hBehavEntries || []).join(", ")}]`
    );
  }
}

/* ==========================================================================
 * 4. 汇总
 * ========================================================================== */
console.log(`\n${"=".repeat(72)}`);
if (fail === 0) {
  console.log(` 全部通过：${pass} 项`);
  console.log("=".repeat(72));
  process.exit(0);
}
console.log(` 失败 ${fail} 项 / 共 ${pass + fail} 项`);
console.log("\n差异明细（protocol.js 真源 ↔ index.html 镜像）：");
for (const d of diffs) console.log(`  ${d}`);
console.log("=".repeat(72));
process.exit(1);
