#!/usr/bin/env node
/**
 * QA · 未来感视觉方案（冷调仪器面板）· 机械门禁
 *
 * 把 `ui-optimization/future-ui/` 规格里的硬约束编码成**会咬人**的断言。
 * 与 `qa-theme.mjs` 的分工：
 *   · qa-theme 守 T1 双主题底座；本脚本守**方案层** —— 新令牌命名空间、
 *     透明窗裁剪铁律、品牌亮度规则、网格纪律、零外链。
 *   · 令牌名单**运行时从 `ui-optimization/future-ui/02-令牌规格.md` 解析表格提取**，
 *     绝不硬编码；解析不出来就明确报错，不静默跳过。
 *
 * 落地态门控：
 *   · `:root` 里没有 `--fx-*` → 方案未落地：只提示，退出码 0。
 *   · `:root` 里出现 `--fx-*` → 方案已落地：全量断言，任何一条被破坏 = 退出码 1。
 *
 * 运行：`node scripts/qa-future-ui.mjs [目标 html 路径]`
 *   （可选路径参数供变异验证用：对临时副本跑，绝不碰真文件）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "ui-optimization", "future-ui", "02-令牌规格.md");
const DEFAULT_HTML = path.join(ROOT, "src", "renderer", "index.html");
const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_HTML;

/* ------------------------------------------------------------------ 输出器 */
let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}${extra ? `  · ${extra}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${label}${extra ? ` · ${extra}` : ""}`);
    console.log(`  FAIL  ${label}${extra ? `  · ${extra}` : ""}`);
  }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);
const fatal = (msg) => {
  console.error(`\n[FATAL] ${msg}`);
  process.exit(2);
};

console.log("======================================================================");
console.log(" QA · 未来感视觉（冷调仪器面板）机械门禁");
console.log("======================================================================");
console.log(`  目标文件 : ${TARGET}`);
console.log(`  规格真源 : ${path.relative(ROOT, SPEC_PATH)}`);

/* ------------------------------------------------------- 1. 规格：解析令牌名单 */
if (!fs.existsSync(SPEC_PATH)) fatal(`规格文件不存在：${SPEC_PATH}`);
if (!fs.existsSync(TARGET)) fatal(`目标文件不存在：${TARGET}`);
const specMd = fs.readFileSync(SPEC_PATH, "utf8");

/**
 * 从规格 Markdown 的表格首列提取 `--token`。
 * 只认表格行（以 | 开头），正文散落的反引号不算 —— 避免把散文里的举例当成令牌定义。
 */
function parseSpecTokens(md) {
  const names = new Set();
  for (const row of md.split(/\r?\n/)) {
    if (!/^\s*\|/.test(row)) continue;
    const first = row.split("|")[1];
    if (first === undefined || /^\s*[-: ]+\s*$/.test(first)) continue;
    for (const m of first.matchAll(/`(--[a-z0-9][a-z0-9-]*)`/g)) names.add(m[1]);
  }
  return [...names].sort();
}

const specTokens = parseSpecTokens(specMd);
const FX = specTokens.filter((t) => t.startsWith("--fx-"));
const BALL = specTokens.filter((t) => t.startsWith("--ball-"));
const NEW_TOKENS = [...FX, ...BALL];

/* 主题无关复合值：只在 :root 定义一次（规格 §1.6） */
const THEME_INDEPENDENT = ["--fx-grid-size", "--fx-grid"];
const THEME_DEPENDENT = NEW_TOKENS.filter((t) => !THEME_INDEPENDENT.includes(t));

if (FX.length < 10 || BALL.length < 10) {
  fatal(
    `规格令牌解析失败：只解析到 fx=${FX.length} / ball=${BALL.length} 个令牌，期望远超这个数。` +
      `检查 ${path.relative(ROOT, SPEC_PATH)} 的表格格式是否变了。`,
  );
}
console.log(
  `  规格解析 : --fx-* ${FX.length} 个 + --ball-* ${BALL.length} 个 = 新令牌 ${NEW_TOKENS.length} 个` +
    `（主题相关 ${THEME_DEPENDENT.length} + 主题无关 ${THEME_INDEPENDENT.length}）`,
);

/* ---------------------------------------------------------- 2. 目标文件解析 */
const htmlRaw = fs.readFileSync(TARGET, "utf8");
/** 去掉 HTML 注释 —— 否则注释里的 "<style>" / "<script>" 字样会污染下面的提取 */
const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));

const styleMatch = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html);
if (!styleMatch) fatal("目标文件里找不到 <style> 块（渲染层结构变了？）");
const css = styleMatch[1];
/** 脚本段：只取真正的 <script> 体，不含 HTML 标记 */
const js = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");

/** 花括号深度配平：返回 [start, end)（end 指向闭合 `}` 之后） */
function blockRange(src, from) {
  const i = src.indexOf(from);
  if (i < 0) return null;
  const open = src.indexOf("{", i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") {
      depth -= 1;
      if (depth === 0) return [i, k + 1];
    }
  }
  return null;
}

/** 四个令牌块：暗 :root / @media light 的 :root / html[data-theme=light] / html[data-theme=dark] */
function findTokenBlocks(src) {
  const root = blockRange(src, ":root{");
  const media = blockRange(src, "@media (prefers-color-scheme: light)");
  let mediaInner = null;
  if (media) {
    const inner = blockRange(src.slice(media[0]), ":root{");
    if (inner) mediaInner = [media[0] + inner[0], media[0] + inner[1]];
  }
  return {
    dark: root,
    mediaLight: mediaInner,
    dataLight: blockRange(src, 'html[data-theme="light"]{'),
    dataDark: blockRange(src, 'html[data-theme="dark"]{'),
  };
}

const blocks = findTokenBlocks(css);
for (const [k, v] of Object.entries(blocks)) {
  if (!v) fatal(`找不到令牌块：${k}（渲染层结构变了？）`);
}

/** 块内取 `--name: value;`（value 可跨行） */
function tokensIn(src, range) {
  const body = src.slice(range[0], range[1]);
  const map = new Map();
  for (const m of body.matchAll(/(--[a-z0-9][a-z0-9-]*)\s*:\s*([^;]*);/g)) {
    map.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return map;
}

const TOK = {
  dark: tokensIn(css, blocks.dark),
  mediaLight: tokensIn(css, blocks.mediaLight),
  dataLight: tokensIn(css, blocks.dataLight),
  dataDark: tokensIn(css, blocks.dataDark),
};

/** 组件区 CSS = 去掉 4 个令牌块（含 @media 外壳）之后剩下的 */
function stripTokenBlocks(src) {
  const cuts = [blocks.dark, blocks.mediaLight, blocks.dataLight, blocks.dataDark];
  const mediaOuter = blockRange(src, "@media (prefers-color-scheme: light)");
  if (mediaOuter) cuts.push(mediaOuter);
  const sorted = cuts.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e] of sorted) out = out.slice(0, s) + out.slice(e);
  return out;
}
const componentCss = stripTokenBlocks(css);

/** 去掉 CSS 注释（保留换行以便定位） */
function stripComments(cssText) {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
const componentCssNoComment = stripComments(componentCss);
const cssNoComment = stripComments(css);

/** 组件区 CSS → [选择器, 声明体] 规则列表 */
function parseRules(src) {
  const rules = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const sel = src.slice(i, open).trim();
    let depth = 0;
    let end = -1;
    for (let k = open; k < src.length; k += 1) {
      if (src[k] === "{") depth += 1;
      else if (src[k] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end < 0) break;
    rules.push({ sel, body: src.slice(open + 1, end) });
    i = end + 1;
  }
  return rules;
}
const rules = parseRules(componentCssNoComment);

/** 规则体的声明 */
function decls(body) {
  const out = new Map();
  for (const m of body.matchAll(/([-a-zA-Z]+)\s*:\s*([^;]+);/g)) out.set(m[1].toLowerCase(), m[2].trim());
  return out;
}

/* --------------------------------------------------------- 3. 通用小工具 */
/** 选择器里是否出现独立的类 token（`.mini` 不匹配 `.mini__body`） */
function hasClass(sel, cls) {
  return new RegExp(`\\.${cls}(?![-\\w])`).test(sel);
}
/** 规则主体（最后一个简单选择器）里的类 */
function subjectClasses(sel) {
  const last = sel.split(",").pop().trim();
  const out = new Set();
  for (const m of last.matchAll(/\.([a-zA-Z][-\w]*)/g)) out.add(m[1]);
  return out;
}

/** 阴影层拆分（不切 var(...) 内部的逗号） */
function shadowLayers(value) {
  const layers = [];
  let depth = 0;
  let cur = "";
  for (const c of value) {
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      layers.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) layers.push(cur.trim());
  return layers;
}

/** sRGB → 线性 → 相对亮度（不引依赖）；非 hex 返回 null */
function relLum(hex) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex ?? "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 取 rgba()/rgb() 的 alpha 分量；无 alpha 返回 null */
function alphaOf(value) {
  const v = String(value ?? "");
  const rgba = /rgba?\(\s*[^)]*?,\s*([\d.]+)\s*\)/i.exec(v);
  if (!rgba) return null;
  const parts = v.slice(v.indexOf("(") + 1, v.indexOf(")")).split(",").map((s) => s.trim());
  if (parts.length < 4) return null;
  return parseFloat(parts[3]);
}

/* ============================================================ 落地态判定 */
const landed = [...TOK.dark.keys()].some((t) => t.startsWith("--fx-"));
if (!landed) {
  console.log("\n[未落地] 渲染层的 :root 里没有任何 --fx-* 令牌 —— 未来感视觉方案尚未落地。");
  console.log("[未落地] 本门禁只对满足方案特征的代码断言，当前跳过全量断言（退出码 0）。");
  console.log("[未落地] 落地后本脚本自动进入严格模式，任何方案约束被破坏都会红。");
  process.exit(0);
}
console.log("\n[已落地] 检测到 --fx-* 令牌 —— 进入严格模式（任何约束被破坏 = 退出码 1）");

/* ================================================================= A. 令牌 */
group("[A] 令牌齐备与四处一致");

const BLOCK_KEYS = ["dark", "mediaLight", "dataLight", "dataDark"];
const BLOCK_LABEL = {
  dark: ":root(暗)",
  mediaLight: "@media light",
  dataLight: "data-theme=light",
  dataDark: "data-theme=dark",
};

/* A1 主题相关新令牌在 4 个块都有定义 */
for (const key of BLOCK_KEYS) {
  const missing = THEME_DEPENDENT.filter((t) => !TOK[key].has(t));
  ok(missing.length === 0, `A1 ${BLOCK_LABEL[key]} 定义了全部 ${THEME_DEPENDENT.length} 个主题相关新令牌`, missing.join(","));
}

/* A2 4 块的新令牌名集合完全相同（--fx-* / --ball-* 各自比对）
   注：主题无关复合值按 A3 只在 :root 定义，不参与四块集合比对。 */
function namesIn(map, prefix) {
  return [...map.keys()].filter((t) => t.startsWith(prefix) && !THEME_INDEPENDENT.includes(t)).sort();
}
for (const prefix of ["--fx-", "--ball-"]) {
  const base = namesIn(TOK.dark, prefix);
  for (const key of BLOCK_KEYS.filter((k) => k !== "dark")) {
    const other = namesIn(TOK[key], prefix);
    const onlyBase = base.filter((t) => !other.includes(t));
    const onlyOther = other.filter((t) => !base.includes(t));
    ok(
      onlyBase.length === 0 && onlyOther.length === 0,
      `A2 ${prefix}* 令牌名集合在 ${BLOCK_LABEL[key]} 与 :root(暗) 完全一致`,
      onlyBase.length || onlyOther.length ? `缺:${onlyBase.join(",")} 多:${onlyOther.join(",")}` : `${base.length} 个`,
    );
  }
}

/* A3 主题无关复合值只在 :root 定义一次，且内部引用颜色令牌而非硬编码色值 */
for (const t of THEME_INDEPENDENT) {
  const others = BLOCK_KEYS.filter((k) => k !== "dark").filter((k) => TOK[k].has(t));
  ok(others.length === 0, `A3 主题无关令牌 ${t} 只在 :root 定义一次`, others.map((k) => BLOCK_LABEL[k]).join(","));
}
for (const t of THEME_INDEPENDENT) {
  const v = TOK.dark.get(t) || "";
  const refs = [...v.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)].map((m) => m[1]);
  const hasHardColor = /#[0-9a-fA-F]{3,8}\b/.test(v) || /rgba?\(/i.test(v);
  ok(v !== "", `A3 ${t} 在 :root 有值`, v.slice(0, 60));
  if (/gradient/i.test(v)) {
    ok(refs.length > 0, `A3 ${t} 内部引用颜色令牌（跟随主题）`, refs.join(",") || v.slice(0, 60));
  }
  ok(!hasHardColor, `A3 ${t} 内部没有硬编码色值`, v.slice(0, 60));
}

/* A4 既有 T1 令牌值未被破坏 */
function specTableValues(md) {
  /* 逐表解析：靠**表格结构**识别表头，而不是靠「含令牌二字」。
     理由（2026-10-22 实测踩坑）：`02-令牌规格.md` 的 §4 是「对比度实测表」，
     表头是「前景 | 背景 | 比值 | 要求 | 结论」，**不含「令牌」** →
     若只靠关键词判定表头，它不会重置列映射，会**沿用上一张表的列位置**去读，
     于是把「背景列」当成「浅色列」，得出「--text 的期望值 = --surface-2 #fafafa」
     这种根本不是颜色的值 —— 这是门禁误报产品代码，不是产品代码坏了。

     判定规则：
       ① `|---|` 分隔行之后的**第一行**是表头 → 必须重置 cols；
       ② 只有表头**同时**具备「名称列 + 暗色列 + 浅色列」时才进入令牌值表模式，否则 cols=null（跳过该表）；
       ③ 解析出的值若**不像颜色值**，视为解析失败 → 跳过并记 INFO（不判 FAIL）；
       ④ 期望值集合里若有**任何一条**不像颜色值 → 直接 fatal（保护：宁可门禁报错，也不要用错期望值去红产品代码）。 */
  const out = new Map();
  const rows = md.split(/\r?\n/);
  let cols = null;
  /* 合法值形态：颜色（hex/rgba）**或阴影**（`0 1px 2px rgba(...)` 这类 box-shadow 值）。
     `--shadow-1` / `--shadow-2` 就是阴影值，不是颜色 —— 把它们排除在外会导致
     解析器把它们记成「不像颜色值」而误判解析失败。
     判定方式：整串里若**不含** rgba()/hex 就是非法；含 rgba() 则允许前面带阴影偏移量。 */
  const COLORISH = (v) => {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true;                 // 纯 hex
    if (/^[0-9a-fA-F]{3,8}$/.test(s)) return true;                   // 裸 hex（无 #）
    if (!/rgba?\(/i.test(s)) return false;                            // 必须含颜色函数
    // 允许：rgba(...) / rgb(...) / <偏移> <模糊> <扩散> rgba(...)
    // 偏移可以是「0」这种**无单位**写法（CSS 里 `0 1px 2px rgba(...)` 的首段就是 0）
    return /^(?:-?(?:[\d.]+px|0)\s+)*rgba?\([^)]*\)$/i.test(s);
  };
  const nonColor = [];
  const isSep = (r) => /^\s*\|[\s\-:|]+\|?\s*$/.test(r);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!/^\s*\|/.test(row)) { cols = null; continue; }
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    if (isSep(row)) continue;   // 分隔行本身不携带信息

    /* markdown 表格的结构是「表头行 → 分隔行 → 数据行」，
       所以**表头在分隔行之前**。判据 = 「下一行是分隔行」。
       （曾误写成「分隔行之后是表头」，导致所有表都没被识别 → 读到 0 条。） */
    const nextIsSep = i + 1 < rows.length && isSep(rows[i + 1]);
    if (nextIsSep) {
      const head = cells.slice(1, -1);
      const di = head.findIndex((h) => /暗色/.test(h));
      const li = head.findIndex((h) => /浅色/.test(h));
      const nameCol = head.findIndex((h) => /令牌|属性|名称|项/.test(h));
      cols = (nameCol >= 0 && di >= 0 && li >= 0 && nameCol !== di && nameCol !== li)
        ? { name: nameCol, dark: di, light: li }
        : null;
      continue;
    }

    if (!cols) continue;
    const rawName = cells[cols.name + 1] || "";
    const names = [...rawName.matchAll(/`(--[a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]);
    if (names.length !== 1) continue;
    const name = names[0];
    if (name.startsWith("--fx-")) continue; // 新令牌，值由方案另定
    const strip = (s) => String(s || "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
    const dark = strip(cells[cols.dark + 1]);
    const light = strip(cells[cols.light + 1]);
    if (!dark || !light || /^[一-龥]/.test(dark) || /^[一-龥]/.test(light)) continue;
    // 值必须像颜色值，否则说明列映射又错了 → 跳过并记账
    if (!COLORISH(dark) || !COLORISH(light)) { nonColor.push(`${name}: ${dark} / ${light}`); continue; }
    out.set(name, { dark, light });
  }
  out.__nonColor = nonColor;
  return out;
}
const T1 = specTableValues(specMd);
if (T1.size < 30) fatal(`规格 §1.x 既有令牌表解析失败：只读到 ${T1.size} 个（期望 ≥30）`);
/* ④ 保护：期望值里有任何一条不像颜色值 → 解析器一定错了，直接 fatal，
   而不是拿错期望值去红产品代码。 */
if (T1.__nonColor && T1.__nonColor.length) {
  fatal(`规格令牌表解析出错：${T1.__nonColor.length} 条期望值不像颜色值（解析器列映射有误）：${T1.__nonColor.slice(0, 4).join(" | ")}`);
}

const t1Broken = [];
for (const [name, exp] of T1) {
  for (const [key, want] of [["dark", exp.dark], ["dataDark", exp.dark], ["mediaLight", exp.light], ["dataLight", exp.light]]) {
    const actual = TOK[key].get(name);
    if (actual === undefined) {
      t1Broken.push(`${name} 在 ${BLOCK_LABEL[key]} 缺失`);
      continue;
    }
    const norm = (v) => String(v).replace(/\s+/g, "").toLowerCase();
    if (norm(actual) !== norm(want)) t1Broken.push(`${name}@${BLOCK_LABEL[key]}=${actual}（规格 ${want}）`);
  }
}
ok(
  t1Broken.length === 0,
  `A4 ${T1.size} 个既有 T1 令牌在 4 块的值与规格一致（唯一允许变更的是 --ball-ink）`,
  t1Broken.slice(0, 6).join(" | "),
);

ok(TOK.dark.get("--bg") === "#181818", "A4 锚点 --bg 暗 = #181818", TOK.dark.get("--bg"));
ok(TOK.dark.get("--accent") === "#4c9aff", "A4 锚点 --accent 暗 = #4c9aff", TOK.dark.get("--accent"));
ok(TOK.mediaLight.get("--accent") === "#1f6feb", "A4 锚点 --accent 浅 = #1f6feb", TOK.mediaLight.get("--accent"));
ok(TOK.dark.get("--text") === "#ededed", "A4 锚点 --text 暗 = #ededed", TOK.dark.get("--text"));
ok(TOK.mediaLight.get("--text") === "#1a1a1a", "A4 锚点 --text 浅 = #1a1a1a", TOK.mediaLight.get("--text"));
ok(TOK.dark.get("--ball-ink") === "#0b1220", "A4 --ball-ink 暗 = #0b1220（唯一允许变更的既有令牌）", TOK.dark.get("--ball-ink"));
ok(TOK.mediaLight.get("--ball-ink") === "#1557c0", "A4 --ball-ink 浅 = #1557c0", TOK.mediaLight.get("--ball-ink"));

/* A5 新令牌在 4 块都有有效值（非空 / 非 undefined / 引用可解析） */
const badValues = [];
for (const key of BLOCK_KEYS) {
  for (const t of THEME_DEPENDENT) {
    const v = TOK[key].get(t);
    if (v === undefined) continue; // A1 已报
    if (!v || /undefined/i.test(v)) {
      badValues.push(`${t}@${BLOCK_LABEL[key]}=${JSON.stringify(v)}`);
      continue;
    }
    for (const m of v.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
      if (!TOK[key].has(m[1])) badValues.push(`${t}@${BLOCK_LABEL[key]} 引用未定义令牌 ${m[1]}`);
    }
    if (/var\(\s*var\(/i.test(v)) badValues.push(`${t}@${BLOCK_LABEL[key]} 是未替换的 var(...) 嵌套`);
  }
}
ok(badValues.length === 0, "A5 新令牌在 4 块都是有效值（非空 / 非 undefined / 引用可解析）", badValues.slice(0, 6).join(" | "));

/* ========================================================== B. 组件区零硬编码 */
group("[B] 组件区零硬编码颜色");
{
  const hexes = [...new Set((componentCssNoComment.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((x) => x.toLowerCase()))];
  const rgbas = [...new Set((componentCssNoComment.match(/rgba?\([^)]*\)/g) || []).map((x) => x.replace(/\s+/g, "")))];
  ok(hexes.length === 0, "B1 组件区没有硬编码 hex", hexes.slice(0, 8).join(","));
  ok(rgbas.length === 0, "B2 组件区没有硬编码 rgb()/rgba()", rgbas.slice(0, 8).join(","));

  // B3 加严：新令牌命名空间不得在组件区以裸值形式出现（即在组件区重新定义令牌）
  const redefs = [];
  for (const r of rules) {
    for (const m of r.body.matchAll(/(--(?:fx|ball)-[a-z0-9-]+)\s*:/g)) redefs.push(`${m[1]} @ ${r.sel.slice(0, 40)}`);
  }
  ok(redefs.length === 0, "B3 组件区没有重新定义 --fx-* / --ball-* 令牌（令牌只在 4 个块里定义）", redefs.slice(0, 6).join(" | "));
}

/* =============================================== C. 零外扩阴影 / 零放大 */
group("[C] 透明窗裁剪铁律（零外扩阴影 / 零 scale）");
{
  const WINDOW_SEL = ["ball", "ball--sphere", "mini", "full"];
  const outerViolations = [];
  for (const r of rules) {
    const bs = decls(r.body).get("box-shadow");
    if (!bs || bs === "none") continue;
    for (const cls of WINDOW_SEL) {
      if (!hasClass(r.sel, cls)) continue;
      for (const layer of shadowLayers(bs)) {
        if (!/\binset\b/i.test(layer)) outerViolations.push(`.${cls} · ${r.sel.slice(0, 40)} → ${layer}`);
      }
    }
  }
  ok(
    outerViolations.length === 0,
    "C1 窗口级元素（.ball/.ball--sphere/.mini/.full）的 box-shadow 每层都 inset",
    outerViolations.slice(0, 6).join(" | "),
  );

  const scaleHits = [...cssNoComment.matchAll(/transform\s*:[^;{}]*\bscale\s*\(/gi)].map((m) => m[0].trim());
  ok(scaleHits.length === 0, "C2 全文没有 transform: scale(...)（任何值、任何选择器）", scaleHits.slice(0, 4).join(" | "));

  const shadowTargets = [];
  for (const r of rules) {
    const d = decls(r.body);
    const text = `${d.get("filter") || ""} ${d.get("text-shadow") || ""}`;
    if (!/drop-shadow|text-shadow/i.test(text)) continue;
    const hit = WINDOW_SEL.some((c) => hasClass(r.sel, c)) || /#(?:miniRoot|fullRoot|ballRoot)\b/.test(r.sel);
    if (hit) shadowTargets.push(`${r.sel.slice(0, 50)} → ${text.trim()}`);
  }
  ok(
    shadowTargets.length === 0,
    "C3 球/窗口元素上没有 drop-shadow / text-shadow（π mark 内部滤镜允许，但不得落在球壳上）",
    shadowTargets.slice(0, 6).join(" | "),
  );
}

/* ====================================================== D. 球的状态与徽标 */
group("[D] 球的状态与徽标");
{
  const ballActive = rules.filter((r) => /^\.ball:active/.test(r.sel.trim()));
  const badActive = ballActive.filter((r) => decls(r.body).has("transform"));
  ok(badActive.length === 0, "D1 .ball:active 没有 transform（按下不缩放）", badActive.map((r) => r.sel).join(" | "));

  const badgeRules = rules.filter((r) => hasClass(r.sel, "ball__badge"));
  const neg = [];
  for (const r of badgeRules) {
    const d = decls(r.body);
    for (const prop of ["right", "top", "bottom", "left"]) {
      const v = d.get(prop);
      if (v && /^-[\d.]/.test(v.trim())) neg.push(`${r.sel.slice(0, 40)} ${prop}:${v}`);
    }
  }
  ok(neg.length === 0, "D2 徽标 right/top 不为负（负值会被窗口裁掉）", neg.join(" | "));

  // 任何 keyframes 里的 box-shadow 层都不许外扩（0 0 0 Npx，N>0）
  const kfViolations = [];
  for (const m of cssNoComment.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const name = m[1];
    let depth = 0;
    let end = -1;
    for (let k = cssNoComment.indexOf("{", m.index); k < cssNoComment.length; k += 1) {
      if (cssNoComment[k] === "{") depth += 1;
      else if (cssNoComment[k] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end < 0) continue;
    for (const bm of cssNoComment.slice(m.index, end).matchAll(/box-shadow\s*:\s*([^;}]+)/g)) {
      for (const layer of shadowLayers(bm[1])) {
        if (/\binset\b/i.test(layer)) continue;
        const spread = /(^|\s)0\s+0\s+0\s+([\d.]+)px/.exec(layer);
        if (spread && parseFloat(spread[2]) > 0) kfViolations.push(`@keyframes ${name} → ${layer}`);
      }
    }
  }
  ok(
    kfViolations.length === 0,
    "D3 keyframes 里没有外扩光环（0 0 0 Npx, N>0）；只允许向内发光的替代 keyframes",
    kfViolations.slice(0, 6).join(" | "),
  );

  const thinking = rules.filter((r) => /data-ball="thinking"/.test(r.sel));
  const thinkingOuter = [];
  for (const r of thinking) {
    const bs = decls(r.body).get("box-shadow");
    if (bs && bs !== "none") {
      for (const layer of shadowLayers(bs)) if (!/\binset\b/i.test(layer)) thinkingOuter.push(`${r.sel.slice(0, 46)} → ${layer}`);
    }
  }
  ok(thinkingOuter.length === 0, "D4 thinking 状态环不产生外扩（inset 定位 / 内环）", thinkingOuter.join(" | "));
}

/* ================================================ E. 品牌规则：π 必须比气泡亮 */
group("[E] 品牌规则：π 必须比气泡亮");
{
  const piTokens = ["--ball-pi-hi", "--ball-pi-mid", "--ball-pi-lo"];
  for (const t of piTokens) {
    const dark = TOK.dark.get(t);
    const light = TOK.mediaLight.get(t);
    ok(specTokens.includes(t) && dark && light, `E1 ${t} 在规格中存在，且暗/浅两块都有值`, `dark=${dark} light=${light}`);
  }

  for (const [key, label] of [["dark", "暗色"], ["mediaLight", "浅色"]]) {
    const bubble = [TOK[key].get("--accent"), TOK[key].get("--accent-2")].map(relLum);
    if (bubble.some((b) => b === null)) {
      ok(false, `E2 ${label}：气泡底色（--accent / --accent-2）取不到亮度值`);
      continue;
    }
    const bubbleMax = Math.max(...bubble);
    const pi = piTokens.map((t) => ({ t, l: relLum(TOK[key].get(t)) }));
    const bad = pi.filter((p) => p.l === null || p.l <= bubbleMax);
    ok(
      bad.length === 0,
      `E2 ${label}：π 三端亮度都高于气泡底色（实测 sRGB 相对亮度）`,
      bad.length
        ? bad.map((p) => `${p.t}=${p.l}`).join(",")
        : `气泡 ${bubbleMax.toFixed(4)} / π ${pi.map((p) => (p.l ?? NaN).toFixed(4)).join(",")}`,
    );
  }

  const inkLum = relLum(TOK.dark.get("--ball-ink"));
  const refLum = relLum("#0b1220");
  ok(
    inkLum !== null && refLum !== null && inkLum >= refLum,
    "E3 --ball-ink 暗色相对亮度不低于规格 #0b1220（π 不是挖空的洞）",
    `ink=${inkLum?.toFixed(5)} ref=${refLum?.toFixed(5)}`,
  );
}

/* ==================================================== F. 网格纹理使用纪律 */
group("[F] 网格纹理使用纪律");
{
  for (const key of ["dark", "mediaLight"]) {
    const v = TOK[key].get("--fx-grid-line") || "";
    const alpha = alphaOf(v);
    ok(alpha !== null && alpha <= 0.05, `F1 ${BLOCK_LABEL[key]} --fx-grid-line 透明度 ≤ 0.05`, `alpha=${alpha}`);
  }

  const MSG_CLASSES = ["msg", "pibody"];
  const solidBg = [];
  for (const r of rules) {
    const subjects = subjectClasses(r.sel);
    if (!MSG_CLASSES.some((c) => subjects.has(c))) continue;
    const d = decls(r.body);
    const bg = d.get("background") || d.get("background-color");
    if (!bg) continue;
    if (/transparent|none|inherit/i.test(bg)) continue;
    if (/color-mix\([^)]*transparent/i.test(bg)) continue;
    if (/var\(\s*--(?:surface|bg|code-bg)/i.test(bg)) solidBg.push(`${r.sel.slice(0, 46)} → ${bg}`);
  }
  ok(solidBg.length === 0, "F2 消息元素（.msg / .pibody）不铺实底色（网格要在行间空隙露出）", solidBg.slice(0, 6).join(" | "));

  // F3 扫描线不得常驻：只能在「生成中」态下出现
  const BUSY_SEL = /data-busy|data-generating|data-state\s*=\s*["']generating["']|is-generating|\bbusy\b|\bgenerating\b/;
  const scanRules = rules.filter((r) => hasClass(r.sel, "scan"));
  const scanStaticInHtml = /class\s*=\s*["'][^"']*\bscan\b[^"']*["']/i.test(html);
  ok(!scanStaticInHtml, "F3a 扫描线元素不在静态 HTML 里（不常驻）", scanStaticInHtml ? "HTML 里存在 .scan" : "");
  const jsScan = [...js.matchAll(/[^\n]*\bscan\b[^\n]*/gi)].map((m) => m[0].trim());
  const busyGated = scanRules.filter((r) => BUSY_SEL.test(r.sel));
  const wired = scanStaticInHtml || jsScan.length > 0;
  if (wired) {
    // 扫描线已接线 → 必须有「生成中」态门控
    ok(busyGated.length > 0, "F3b 扫描线只挂大窗「生成中」态选择器下（data-busy / generating）", busyGated.map((r) => r.sel.slice(0, 46)).join(" | ") || `现有 .scan 规则：${scanRules.map((r) => r.sel.slice(0, 30)).join(" | ")}`);
    const ungated = scanRules.filter((r) => !BUSY_SEL.test(r.sel) && !/display\s*:\s*none/i.test(r.body));
    ok(ungated.length === 0, "F3c 非生成中态的 .scan 规则必须显式隐藏（display:none），不得常驻可见", ungated.map((r) => r.sel.slice(0, 46)).join(" | "));
  } else {
    ok(
      true,
      "F3b/F3c 扫描线未接线（HTML/JS 里都没有 .scan 元素，不存在常驻风险）",
      `CSS 里 .scan 规则 ${scanRules.length} 条${busyGated.length ? `（其中生成中门控 ${busyGated.length} 条）` : ""}`,
    );
  }

  const gridInCode = [];
  for (const r of rules) {
    if (!/var\(\s*--fx-grid(?![-\w])/.test(r.body)) continue;
    if (/codeblock|\bpre\b|diff|approval__code/i.test(r.sel)) gridInCode.push(r.sel.slice(0, 46));
  }
  ok(gridInCode.length === 0, "F4 网格不用于代码块 / diff 内部", gridInCode.join(" | "));
}

/* ==================================================== G. 聊天流零 <svg> */
group("[G] 聊天流零 <svg>（沿用 qa-renderer-edge C5 口径）");
{
  // 口径：真实 DOM 里 #miniBody 内不允许存在 <svg> 元素（C5 数 querySelectorAll('svg')）。
  // 静态等价：#miniBody 子树零 <svg>，且脚本不往 DOM 注入 svg 节点。
  const miniAt = html.search(/id\s*=\s*"miniBody"/);
  let subtree = "";
  if (miniAt >= 0) {
    const open = html.lastIndexOf("<div", miniAt);
    let depth = 0;
    let end = -1;
    const tagRe = /<(\/?)div\b[^>]*?(\/?)>/g;
    tagRe.lastIndex = open;
    let t;
    while ((t = tagRe.exec(html)) !== null) {
      if (t[1] === "/") {
        depth -= 1;
        if (depth === 0) {
          end = t.index;
          break;
        }
      } else if (!t[2]) depth += 1;
    }
    subtree = end > 0 ? html.slice(open, end) : html.slice(open, miniAt + 400);
  }
  const svgInMini = (subtree.match(/<svg[\s>]/gi) || []).length;
  ok(miniAt >= 0 && svgInMini === 0, "G1 #miniBody 容器内 HTML 零 <svg> 元素", `found=${svgInMini}`);

  const jsNoComment = js
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
  // 脚本里的 <svg> 字面量只允许两种：独立 SVG 文档（data-URI mask 模板，带 xmlns）。
  // 其余（无 xmlns 的裸 svg 串）就是会进 DOM 的 svg 节点 → 违反 C5 口径。
  const svgLiterals = [...jsNoComment.matchAll(/<svg[\s>][^`]{0,240}/g)].map((m) => m[0]);
  const badLiterals = svgLiterals.filter((s) => !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(s));
  ok(badLiterals.length === 0, "G2 脚本里不生成裸 <svg> 节点（图标走 CSS mask data-URI）", badLiterals.slice(0, 4).join(" | "));
  ok(
    !/data:image\/svg\+xml/.test(jsNoComment) || svgLiterals.length === 0 || svgLiterals.every((s) => /xmlns\s*=/.test(s)),
    "G2b svg 字面量只作为 data-URI 独立文档使用",
  );

  const innerSvg = [...jsNoComment.matchAll(/\.innerHTML\s*=\s*[^;]*<svg/gi)].map((m) => m[0].slice(0, 60));
  ok(innerSvg.length === 0, "G3 没有把 <svg> 通过 innerHTML 注入页面", innerSvg.slice(0, 4).join(" | "));

  const iconElFn = /function\s+iconEl\s*\([^)]*\)\s*\{[\s\S]{0,800}?\n\}/.exec(js);
  ok(!iconElFn || !/<svg/i.test(iconElFn[0]), "G4 iconEl() 返回的不是 svg 元素（是 span + mask）");
}

/* ==================================================== H. 零外链 / 零构建 */
group("[H] 零外链 / 零构建");
{
  const links = [...html.matchAll(/<link\b[^>]*href\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]).filter((u) => /^https?:|^\/\//i.test(u));
  ok(links.length === 0, "H1 没有外链 stylesheet", links.join(","));

  const urlHttp = [...cssNoComment.matchAll(/url\(\s*["']?(https?:)?\/\/[^)]*\)/gi)].map((m) => m[0]);
  ok(urlHttp.length === 0, "H2 CSS 里没有 url(http...) 外链资源", urlHttp.slice(0, 4).join(","));

  const imports = [...cssNoComment.matchAll(/@import\b[^;]*/gi)].map((m) => m[0]);
  ok(imports.length === 0, "H3 没有 @import", imports.slice(0, 4).join(","));

  const fonts = [...cssNoComment.matchAll(/@font-face\b/gi)].map((m) => m[0]);
  ok(fonts.length === 0, "H4 没有 @font-face（不引外部字体）", fonts.join(","));

  const scriptSrc = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]).filter((u) => /^https?:|^\/\//i.test(u));
  ok(scriptSrc.length === 0, "H5 没有外链脚本", scriptSrc.join(","));
}

/* ------------------------------------------------------------------ 汇总 */
console.log("\n======================================================================");
console.log(` 结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 条断言，8 组）`);
if (failed) {
  console.log("\n 失败清单：");
  for (const f of failures) console.log(`   · ${f}`);
  console.log("\n 结论：未来感视觉方案**已被破坏** —— 上面每一条都是方案硬约束。");
} else {
  console.log(" 结论：未来感视觉方案全部硬约束满足。");
}
console.log("======================================================================");
process.exit(failed ? 1 : 0);
