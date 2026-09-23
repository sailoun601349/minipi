/**
 * M0-2 / M0-4 实测：**真实调用一次模型**，验证逐字流式。
 *
 * 跑法：`npm run verify:stream`
 * ⚠ **会真实消耗模型额度**（一次 prompt）。已获授权。
 *
 * 它直接 import 生产代码 `src/main/pi/session.js`（Pi 宿主），所以测的是真实接线，
 * 不是另写的一段 demo。跑在**纯 Node** 里（不需要 Electron）——`pi/session.js`
 * 与 `pi/scenes.js` 刻意不 import electron，就是为了这一步。
 *
 * 产物：`scripts/out/verify-stream.json` + 终端摘要。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PiSessionHost } from "../src/main/pi/session.js";
import { isTextDelta } from "../src/shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "scripts", "out");

const PROMPT = process.argv[2] || "用一句话说明什么是梯度下降";
const SCENE = process.env.MINIPI_VERIFY_SCENE || "quick";
const SETTLE_TIMEOUT_MS = 180_000;

/** @type {Array<{seq:number,ts:number,t:number,type:string,delta?:string}>} */
const events = [];
const t0 = Date.now();

const host = new PiSessionHost({
  emit: (wrapped) => {
    const ev = wrapped?.event ?? {};
    events.push({
      seq: wrapped.seq,
      ts: wrapped.ts,
      t: Date.now() - t0,
      type: String(ev.type ?? "(none)"),
      delta: isTextDelta(ev) ? String(ev.assistantMessageEvent.delta ?? "") : undefined,
    });
  },
  logger: {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  },
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("=".repeat(74));
  console.log(" minipi · 真实流式实测（会消耗一次模型额度）");
  console.log("=".repeat(74));
  console.log(` Node ${process.version} · 场景 ${SCENE}`);
  console.log(` prompt: ${PROMPT}`);
  console.log("");

  const initStart = Date.now();
  await host.init();
  console.log(` ModelRuntime 就绪：${Date.now() - initStart}ms`);

  const created = await host.createSession({ sceneId: SCENE });
  console.log(` 会话已建：${JSON.stringify(created)}`);
  console.log("");

  const promptStart = Date.now();
  const { accepted } = await host.prompt({ sessionId: created.sessionId, text: PROMPT, behavior: "steer" });
  const acceptedAt = Date.now() - t0;
  console.log(` prompt() 返回 accepted=${accepted}，耗时 ${Date.now() - promptStart}ms（相对起点 ${acceptedAt}ms）`);

  // 等本轮真正跑完：优先看 agent_settled / agent_end，其次退回「事件静默 3s」
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let settledBy = null;
  while (Date.now() < deadline) {
    const types = events.map((e) => e.type);
    if (types.includes("agent_settled")) {
      settledBy = "agent_settled";
      break;
    }
    if (types.includes("agent_end")) {
      settledBy = "agent_end";
      break;
    }
    const lastAt = events.length > 0 ? events[events.length - 1].t + t0 : t0;
    if (events.length > 0 && Date.now() - lastAt > 3000) {
      settledBy = "静默 3s（没有 agent_end/agent_settled，可能是 shell 事件缺失）";
      break;
    }
    await delay(50);
  }
  const finishedAt = Date.now() - t0;

  // 统计
  const deltas = events.filter((e) => e.type === "message_update" && e.delta !== undefined);
  const firstDelta = deltas[0] ?? null;
  const text = deltas.map((e) => e.delta).join("");
  const gaps = deltas.slice(1).map((e, i) => e.t - deltas[i].t).sort((a, b) => a - b);
  const types = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));

  const state = host.sessionState({ sessionId: created.sessionId });

  const report = {
    tool: "minipi-verify-stream",
    ranAt: new Date().toISOString(),
    node: process.version,
    scene: SCENE,
    prompt: PROMPT,
    accepted,
    promptReturnMs: acceptedAt,
    settledBy,
    finishedMs: finishedAt,
    model: state.model,
    textDeltaCount: deltas.length,
    firstDeltaLatencyMs: firstDelta ? firstDelta.t : null,
    lastDeltaAtMs: deltas.length > 0 ? deltas[deltas.length - 1].t : null,
    streamSpanMs: firstDelta && deltas.length > 0 ? deltas[deltas.length - 1].t - firstDelta.t : null,
    textLength: text.length,
    maxDeltaChars: deltas.reduce((m, e) => Math.max(m, (e.delta ?? "").length), 0),
    deltaGapMs: {
      min: gaps.length > 0 ? gaps[0] : null,
      p50: percentile(gaps, 0.5),
      p95: percentile(gaps, 0.95),
      max: gaps.length > 0 ? gaps[gaps.length - 1] : null,
      samples: gaps.length,
    },
    eventTypeHistogram: types,
    totalEvents: events.length,
    lastSeq: state.lastSeq,
    costUsd: state.costUsd,
    finalState: state,
    textPreview: text.slice(0, 400),
    textFull: text,
    firstSeqDeltaSample: deltas.slice(0, 12).map((e) => ({ seq: e.seq, t: e.t, delta: e.delta })),
  };

  fs.writeFileSync(path.join(OUT_DIR, "verify-stream.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("");
  console.log("-".repeat(74));
  console.log(` 结束依据            : ${settledBy}`);
  console.log(` 模型                : ${report.model}`);
  console.log(` text_delta 条数     : ${report.textDeltaCount}`);
  console.log(` 首字延迟            : ${report.firstDeltaLatencyMs} ms（相对 prompt 调用时刻）`);
  console.log(` 流式跨度            : ${report.streamSpanMs} ms`);
  console.log(` 组装文本长度        : ${report.textLength} 字符；单个 delta 最大 ${report.maxDeltaChars} 字符`);
  console.log(` delta 间隔 min/p50/p95/max : ${JSON.stringify(report.deltaGapMs)}`);
  console.log(` 总事件条数 / lastSeq: ${report.totalEvents} / ${report.lastSeq}`);
  console.log(` costUsd             : ${report.costUsd}`);
  console.log(` 事件类型直方图      : ${JSON.stringify(types)}`);
  console.log("-".repeat(74));
  console.log(" 回答（前 400 字符）：");
  console.log(report.textPreview.replace(/^/gm, "   "));
  console.log("-".repeat(74));
  console.log(` 报告：${path.relative(ROOT, path.join(OUT_DIR, "verify-stream.json"))}`);

  host.disposeAll();
  return report;
}

main()
  .then((r) => {
    process.exitCode = r.textDeltaCount > 0 ? 0 : 3;
  })
  .catch((err) => {
    console.error("verify:stream 失败：", err?.stack ?? err);
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OUT_DIR, "verify-stream.json"),
        `${JSON.stringify({ tool: "minipi-verify-stream", ranAt: new Date().toISOString(), failed: true, error: String(err?.message ?? err), events }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      /* ignore */
    }
    try {
      host.disposeAll();
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  });
