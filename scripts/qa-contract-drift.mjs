#!/usr/bin/env node
/**
 * QA · 象限 D：契约与一致性。
 *
 * 三个子任务：
 *   D1. **契约漂移检查**：`src/renderer/index.html` 内联镜像的
 *       `OUTCOME_FORMAT_IDS` / `OUTCOME_ACTIONS` / `OUTCOME_TITLE_MAX_CHARS` /
 *       `ERROR_CODES` 与 `src/shared/protocol.js` 是否**逐字一致**。
 *       （方砚说她补齐了 4 个错误码——本脚本核对是否真的逐字一致。）
 *   D2. **契约的"用得上"检查**：主进程真会发出的错误码（如 `SANDBOX_DENIED`）
 *       若不在渲染层镜像里，`parseErrorMessage` 会把它降级成 `INTERNAL`——实测这一点。
 *   D3. **守门脚本有效性**：故意改错 `check-scene-consistency.mjs` 覆盖的两个方向
 *       （改 protocol.js 场景名 / 改 index.html 场景名），确认它真能抓，
 *       且**改回后能还原**（`RESTORED-EXIT=0`）。
 *
 * ⚠ 临时改文件时必须还原并断言还原成功；不改 `~/.minipi`；不新增依赖。
 * 运行：`node scripts/qa-contract-drift.mjs`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = path.join(ROOT, "src", "shared", "protocol.js");
const HTML = path.join(ROOT, "src", "renderer", "index.html");
const CONSISTENCY = path.join(ROOT, "scripts", "check-scene-consistency.mjs");

let passed = 0;
let failed = 0;
const findings = [];
function ok(cond, label, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `  · ${detail}` : ""}`); }
  return !!cond;
}
const group = (t) => console.log(`\n${t}`);
function finding(level, id, title, detail) {
  findings.push({ level, id, title, detail });
  console.log(`  >>> [${level}] ${id} ${title}`);
}

console.log("======================================================================");
console.log(" QA · 象限 D：契约与一致性");
console.log("======================================================================");

const protocolSrc = fs.readFileSync(PROTOCOL, "utf8");
const htmlSrc = fs.readFileSync(HTML, "utf8");

/* ---------------------------------------------------- 从两文件抽常量 */

/** 从一段源码的 `NAME = Object.freeze({ ... })` / `NAME = Object.freeze([...])` 里抽字面量。 */
function extractFrozen(source, name) {
  // 匹配 NAME = Object.freeze( ... )，用括号配对切出内层
  const idx = source.indexOf(name + " = Object.freeze(");
  if (idx === -1) return null;
  let i = source.indexOf("(", idx);
  let depth = 0;
  let start = -1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") { depth += 1; if (depth === 1) start = i + 1; }
    else if (ch === ")") { depth -= 1; if (depth === 0) return source.slice(start, i); }
  }
  return null;
}
/** 从 `const NAME = 120;` 抽数字。 */
function extractNumber(source, name) {
  const m = source.match(new RegExp(`${name}\\s*=\\s*(-?\\d+)`));
  return m ? Number(m[1]) : null;
}
/** 从 Object.freeze({...}) 体内抽所有 `KEY: "value"` 的值为字符串数组。 */
function objectValues(body) {
  if (!body) return null;
  const vals = [];
  const re = /["']?([A-Z0-9_]+)["']?\s*:\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(body))) vals.push(m[2]);
  return vals;
}
/** 从 Object.freeze([...]) 体内抽字符串 token（保序）。 */
function arrayTokens(body) {
  if (!body) return null;
  const vals = [];
  const re = /["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(body))) vals.push(m[1]);
  return vals;
}
/**
 * 抽 `OUTCOME_FORMAT_IDS`：两文件都用 `Object.values(OUTCOME_FORMAT)` 派生。
 * 所以真正要比的是各自的 `OUTCOME_FORMAT = Object.freeze({...})` 的值集合。
 */
function outcomeFormatIds(source) {
  return objectValues(extractFrozen(source, "OUTCOME_FORMAT"));
}
/** `LIMITS` 里的数字字段（protocol 侧）；renderer 是顶层 const。两处都覆盖。 */
function limitsNumber(source, name) {
  const lim = extractFrozen(source, "LIMITS");
  if (lim) {
    const m = lim.match(new RegExp(`${name}\\s*:\\s*(-?\\d+)`));
    if (m) return Number(m[1]);
  }
  return extractNumber(source, name);
}
/** 用 `fork` 跑一个 node 脚本并**异步**等待退出码（本机 spawnSync 被沙箱挡 EBUSY，fork 可用）。 */
function runNode(scriptAbs, cwd) {
  return new Promise((resolve) => {
    const child = fork(scriptAbs, [], { cwd, silent: true });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    let done = false;
    const finish = (status, error) => {
      if (done) return;
      done = true;
      resolve({ status, stdout: out, stderr: "", error });
    };
    child.on("exit", (code) => finish(code, null));
    child.on("error", (e) => finish(null, e));
    setTimeout(() => { if (!done) { try { child.kill(); } catch { /* ignore */ } finish(null, new Error("timeout")); } }, 30000);
  });
}

/* ================================================================== D1 */
group("[D1] 渲染层内联镜像 vs protocol.js（逐字一致）");
{
  const checks = [
    {
      name: "OUTCOME_FORMAT_IDS",
      proto: outcomeFormatIds(protocolSrc),
      html: outcomeFormatIds(htmlSrc),
      note: "产出格式取值域（两边均由 OUTCOME_FORMAT 派生）",
    },
    {
      name: "OUTCOME_ACTIONS",
      proto: arrayTokens(extractFrozen(protocolSrc, "OUTCOME_ACTIONS")),
      html: arrayTokens(extractFrozen(htmlSrc, "OUTCOME_ACTIONS")),
      note: "卡片三按钮",
    },
    {
      name: "OUTBOX_SCENES",
      proto: arrayTokens(extractFrozen(protocolSrc, "OUTBOX_SCENES")),
      html: arrayTokens(extractFrozen(htmlSrc, "OUTBOX_SCENES")),
      note: "outbox 沙箱场景",
    },
  ];
  for (const c of checks) {
    const p = JSON.stringify(c.proto);
    const h = JSON.stringify(c.html);
    const same = p === h;
    if (!same) {
      finding("P3", "D1-MIRROR", `${c.name} 镜像漂移（${c.note}）`, `protocol=${p} · renderer=${h}`);
    }
    ok(same, `${c.name} 逐字一致`, `proto=${p} html=${h}`);
  }

  // 数字常量
  const protoTitleMax = limitsNumber(protocolSrc, "OUTCOME_TITLE_MAX_CHARS");
  const htmlTitleMax = limitsNumber(htmlSrc, "OUTCOME_TITLE_MAX_CHARS");
  const titleSame = protoTitleMax === htmlTitleMax;
  if (!titleSame) finding("P3", "D1-MIRROR", "OUTCOME_TITLE_MAX_CHARS 镜像漂移", `protocol=${protoTitleMax} renderer=${htmlTitleMax}`);
  ok(titleSame, `OUTCOME_TITLE_MAX_CHARS 一致（${protoTitleMax}）`, `proto=${protoTitleMax} html=${htmlTitleMax}`);

  // ERROR_CODES：逐个集合比较
  const protoCodes = objectValues(extractFrozen(protocolSrc, "ERROR_CODES")) || [];
  const htmlCodes = objectValues(extractFrozen(htmlSrc, "ERROR_CODES")) || [];
  const protoSet = new Set(protoCodes);
  const htmlSet = new Set(htmlCodes);
  const missingInHtml = protoCodes.filter((c) => !htmlSet.has(c));
  const extraInHtml = htmlCodes.filter((c) => !protoSet.has(c));
  const codesSame = missingInHtml.length === 0 && extraInHtml.length === 0;

  console.log(`  protocol ERROR_CODES (${protoCodes.length}): ${protoCodes.join(", ")}`);
  console.log(`  renderer ERROR_CODES (${htmlCodes.length}): ${htmlCodes.join(", ")}`);
  if (!codesSame) {
    finding(
      "P3",
      "D1-ERRORCODES",
      "ERROR_CODES 镜像漂移（渲染层缺码 / 多码）",
      `渲染层缺失=[${missingInHtml}] · 渲染层多出=[${extraInHtml}]`,
    );
  }
  ok(missingInHtml.length === 0, `渲染层未缺失任何 ERROR_CODES`, `缺失=[${missingInHtml}]`);
  ok(extraInHtml.length === 0, `渲染层无多余 ERROR_CODES`, `多出=[${extraInHtml}]`);
}

/* --------------------------------------------------------- D1b: description */
group("[D1b] 场景 description 文案两侧对比（守门脚本不覆盖此字段）");
{
  const protoDescs = (protocolSrc.match(/description:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^description:\s*"|"$/g, ""));
  const htmlDescs = (htmlSrc.match(/description:\s*'([^']*)'/g) || []).map((s) => s.replace(/^description:\s*'|'$/g, ""));
  console.log(`  protocol: ${protoDescs.length} 条 · renderer: ${htmlDescs.length} 条`);
  let mismatches = 0;
  const n = Math.min(protoDescs.length, htmlDescs.length);
  for (let i = 0; i < n; i += 1) {
    if (protoDescs[i] !== htmlDescs[i]) {
      mismatches += 1;
      console.log(`    第 ${i + 1} 条不一致：`);
      console.log(`      protocol: ${protoDescs[i]}`);
      console.log(`      renderer: ${htmlDescs[i]}`);
    }
  }
  if (mismatches > 0) {
    finding(
      "P3",
      "D1b-DESC",
      `场景 description 文案两侧不一致（${mismatches} 条），且守门脚本不覆盖`,
      `如 protocol「只写得进 outbox」vs renderer「只写得进产出抽屉」。文案漂移不影响功能，但会让用户看到的说明与契约注释不符。`,
    );
  }
  ok(mismatches === 0, `4 条场景 description 文案两侧逐字一致`, `不一致 ${mismatches} 条`);
}

/* ================================================================== D2 */
group("[D2] 缺失错误码的实际后果：parseErrorMessage 降级为 INTERNAL");
{
  const protoCodes = objectValues(extractFrozen(protocolSrc, "ERROR_CODES")) || [];
  const htmlCodes = objectValues(extractFrozen(htmlSrc, "ERROR_CODES")) || [];
  const htmlSet = new Set(htmlCodes);
  const missing = protoCodes.filter((c) => !htmlSet.has(c));

  if (missing.length > 0) {
    // 复刻渲染层 parseErrorMessage 的逻辑，验证缺失码会被降级
    function rendererParseErrorMessage(input, knownCodes) {
      const raw = input instanceof Error ? input.message : String(input ?? "");
      const tail = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
      const idx = tail.indexOf(": ");
      if (idx > 0) {
        const code = tail.slice(0, idx);
        if (knownCodes.includes(code)) return { code, detail: tail.slice(idx + 2) };
      }
      return { code: "INTERNAL", detail: tail };
    }
    for (const code of missing) {
      const msg = `${code}: 沙箱拒绝写入`;
      const parsed = rendererParseErrorMessage(msg, htmlCodes);
      const degraded = parsed.code === "INTERNAL";
      if (degraded) {
        finding(
          "P3",
          "D2-DEGRADE",
          `主进程会发 ${code}，但渲染层不认识 → 被降级成 INTERNAL`,
          `输入="${msg}" → 渲染层解析结果 code=${parsed.code}`,
        );
      }
      ok(degraded === false, `${code} 能被渲染层 parseErrorMessage 正确识别`, `解析结果 code=${parsed.code}`);
    }

    // 关键：SANDBOX_DENIED 是否真的会被主进程发出？grep 源码。
    for (const code of missing) {
      const usedInSrc = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === "vendor") continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(js|mjs)$/.test(e.name) && p !== PROTOCOL) {
            const s = fs.readFileSync(p, "utf8");
            if (s.includes(`ERROR_CODES.${code}`) || s.includes(`"${code}"`) || s.includes(`'${code}'`)) {
              usedInSrc.push(path.relative(ROOT, p));
            }
          }
        }
      };
      walk(path.join(ROOT, "src"));
      console.log(`  使用点 ${code}: ${usedInSrc.length ? usedInSrc.join(", ") : "（src/ 内暂无使用点）"}`);
    }
  } else {
    ok(true, "ERROR_CODES 无缺失，无需验证降级后果");
  }
}

/* ================================================================== D3 */
group("[D3] 守门脚本 check-scene-consistency.mjs 有效性（改错→能抓→还原）");
await (async () => {
  // 先跑基线
  const baseline = await runNode(CONSISTENCY, ROOT);
  ok(baseline.status === 0, `基线：check-scene-consistency.mjs 退出码 ${baseline.status}`, (baseline.stdout || "").split("\n").slice(-3).join(" | "));

  const protocolBackup = fs.readFileSync(PROTOCOL, "utf8");
  const htmlBackup = fs.readFileSync(HTML, "utf8");

  function restoreAll() {
    fs.writeFileSync(PROTOCOL, protocolBackup, "utf8");
    fs.writeFileSync(HTML, htmlBackup, "utf8");
  }
  async function assertRestored() {
    const pOk = fs.readFileSync(PROTOCOL, "utf8") === protocolBackup;
    const hOk = fs.readFileSync(HTML, "utf8") === htmlBackup;
    const rerun = await runNode(CONSISTENCY, ROOT);
    console.log(`  RESTORED-EXIT=${rerun.status} (protocol restored=${pOk}, html restored=${hOk})`);
    return pOk && hOk && rerun.status === 0;
  }

  try {
    // --- 方向 1：改 protocol.js 的 scene **description**（守门脚本的覆盖边界探针） ---
    // 事实：check-scene-consistency.mjs 只比 cwdTemplate/label/noTools/toolAllowlist/
    // sessionManagerMode 五字段，**不比 description**。所以这条会被「漏抓」——
    // 这不是脚本 bug，而是覆盖边界；但因为两侧 description 已经实际漂移（见 D1b），
    // 记录下来作为「守门盲区」的证据。
    const mutatedProtocol = protocolBackup.replace(
      'description: "随手一问：概念、报错、翻译、改写。无工具可用、不落盘。"',
      'description: "QA-MUTATION-PROTOCOL 随手一问"',
    );
    if (mutatedProtocol === protocolBackup) {
      ok(false, "方向1：protocol.js 改写未生效（锚点未命中）");
    } else {
      fs.writeFileSync(PROTOCOL, mutatedProtocol, "utf8");
      const r1 = await runNode(CONSISTENCY, ROOT);
      // 期望：非零退出（应该抓）。若 0 → 说明 description 不在守门范围（盲区）。
      if (r1.status === 0) {
        finding(
          "P3",
          "D3-DESC-BLIND",
          "守门脚本不覆盖 scene.description 字段（已实际漂移，见 D1b）",
          "改 protocol.js 的 quick.description 后 check-scene-consistency.mjs 仍退出 0 ⇒ description 漂移无守门。",
        );
      }
      ok(r1.status !== 0, `方向1：改 protocol.js 场景描述 → 守门脚本非零退出（实际 ${r1.status}；0 表示 description 不在守门范围）`);
      restoreAll();
      ok(await assertRestored(), "方向1：已还原并复绿");
    }

    // --- 方向 2：改 index.html 的场景 label（应被抓到） ---
    const mutatedHtml = htmlBackup.replace(
      "    sceneId: 'quick', label: 'quick',",
      "    sceneId: 'quick', label: 'QA-MUTATION-HTML',",
    );
    if (mutatedHtml === htmlBackup) {
      ok(false, "方向2：index.html 改写未生效（锚点未命中）");
    } else {
      fs.writeFileSync(HTML, mutatedHtml, "utf8");
      const r2 = await runNode(CONSISTENCY, ROOT);
      ok(r2.status !== 0, `方向2：改 index.html 场景 label → 守门脚本非零退出（实际 ${r2.status}）`);
      if (r2.status === 0) finding("P2", "D3-BLIND2", "守门脚本漏抓 index.html 侧 label 改动", "改 label 后仍退出 0");
      restoreAll();
      ok(await assertRestored(), "方向2：已还原并复绿");
    }

    // --- 方向 3：删一个场景（结构性差异，应被抓到） ---
    const mutatedDel = protocolBackup.replace(
      /  desk: Object\.freeze\(\{[\s\S]*?\}\),\n/,
      "",
    );
    if (mutatedDel !== protocolBackup) {
      fs.writeFileSync(PROTOCOL, mutatedDel, "utf8");
      const r3 = await runNode(CONSISTENCY, ROOT);
      ok(r3.status !== 0, `方向3：删 protocol.js 的 desk 场景 → 守门脚本非零退出（实际 ${r3.status}）`);
      if (r3.status === 0) finding("P2", "D3-BLIND3", "守门脚本漏抓场景整体缺失", "删 desk 后仍退出 0");
      restoreAll();
      ok(await assertRestored(), "方向3：已还原并复绿");
    } else {
      ok(false, "方向3：删场景改写未生效（锚点未命中）");
    }

    // --- 方向 4：改 protocol.js 的 OUTBOX_SCENES（应是守门范围） ---
    const mutatedOutbox = protocolBackup.replace(
      'export const OUTBOX_SCENES = Object.freeze(["quick", "note", "desk"]);',
      'export const OUTBOX_SCENES = Object.freeze(["quick", "note", "desk", "repo"]);',
    );
    if (mutatedOutbox !== protocolBackup) {
      fs.writeFileSync(PROTOCOL, mutatedOutbox, "utf8");
      const r4 = await runNode(CONSISTENCY, ROOT);
      ok(r4.status !== 0, `方向4：改 protocol.js 的 OUTBOX_SCENES → 守门脚本非零退出（实际 ${r4.status}）`);
      if (r4.status === 0) finding("P2", "D3-BLIND4", "守门脚本漏抓 OUTBOX_SCENES 改动（该常量未被守）", "改 OUTBOX_SCENES 后仍退出 0");
      restoreAll();
      ok(await assertRestored(), "方向4：已还原并复绿");
    } else {
      ok(false, "方向4：OUTBOX_SCENES 改写未生效（锚点未命中）");
    }
  } finally {
    restoreAll();
    // 最终断言：文件与备份逐字一致
    ok(fs.readFileSync(PROTOCOL, "utf8") === protocolBackup, "收尾：protocol.js 已还原（逐字一致）");
    ok(fs.readFileSync(HTML, "utf8") === htmlBackup, "收尾：index.html 已还原（逐字一致）");
  }
})();

/* ================================================================== D4 */
group("[D4] preload 透传完整性");
{
  const preload = fs.readFileSync(path.join(ROOT, "src", "preload", "index.js"), "utf8");
  const required = ["generateOutcome", "openOutcome", "saveOutcomeAs", "listOutcomes", "onOutcome"];
  for (const m of required) {
    ok(new RegExp(`${m}\\s*:`).test(preload), `preload 暴露 ${m}()`);
  }
  // 通道名对齐
  const protoChannels = (protocolSrc.match(/(GENERATE_OUTCOME|OPEN_OUTCOME|SAVE_OUTCOME_AS|LIST_OUTCOMES|OUTCOME)\s*:\s*"([^"]+)"/g) || []);
  console.log(`  protocol 产出通道：${protoChannels.map((s) => s.split("\n")[0].trim()).join(" · ")}`);
  ok(/INVOKE\.GENERATE_OUTCOME/.test(preload) && /INVOKE\.OPEN_OUTCOME/.test(preload) &&
     /INVOKE\.SAVE_OUTCOME_AS/.test(preload) && /INVOKE\.LIST_OUTCOMES/.test(preload),
     "preload 用 INVOKE.* 常量引用通道（非硬编码字符串）");
  ok(/EVENTS\.OUTCOME/.test(preload), "preload 用 EVENTS.OUTCOME 订阅");
  // toPlainArg 对产出入参的安全处理（模拟）
  function toPlainArg(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "object") return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  }
  const cases = [
    [{ sessionId: "s_1", intent: "周报", format: "docx" }, "完全合法"],
    [{ sessionId: "s_1", intent: "x", format: undefined }, "format=undefined"],
    [{ outcomeId: "o_1" }, "open 入参"],
    [{}, "空对象"],
  ];
  for (const [arg, label] of cases) {
    const plain = toPlainArg(arg);
    ok(plain !== undefined || arg === undefined, `toPlainArg(${label}) 不抛异常`, JSON.stringify(plain));
  }
  // 危险入参：循环引用 / 带函数
  const cyc = { a: 1 }; cyc.self = cyc;
  const cycOut = toPlainArg(cyc);
  ok(cycOut === null || typeof cycOut === "object", `toPlainArg(循环引用) 不抛异常（${cycOut === null ? "null" : "已转" }）`);
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
