#!/usr/bin/env node
/**
 * QA · 导出旁路（`generateStructured` = `completeSimple` 一次性调用）契约测试。
 *
 * ## 这个脚本守的是什么契约
 *
 * 导出（`OutcomeService#generate`）过去走 `session.prompt()`，会在用户不知情的情况下
 * **真的发起一轮对话**：会话记录被追加、事件被编号外发、卡片/计时/费用都会动。
 * 修复后导出改走 `runtime.completeSimple()` 一次性旁路 —— 它的核心承诺是：
 *
 *   > **导出过程中，进程里不新增任何对话轮次。**
 *
 * 具体钉成五组可执行断言：
 *
 *   [A] 零事件 / 零轮次（**最重要**）：`emit` 一次没调、`rec.seq` 不变、RingLog 不增长、
 *       `session.prompt` / `subscribe` / `abort` 全 0 次。
 *       ⚠ 谁把 `generateStructured` 写回 `rec.session.prompt(...)`，[A] 立刻红。
 *   [B] 一次性调用的入参与错误映射：prompt 只有一个 user text 块、model 传的是
 *       `session.model` 对象本身；`errorMessage` / reject / 超时 / 空文本 / 非法入参
 *       各归到哪个错误码。
 *   [C] `recentTranscript()`：只取 user / assistant 的 **text**，从末尾截断 + 省略标记，
 *       读历史失败不抛错（返回空串）。
 *   [D] 素材真的进了提示词：宿主有 `recentTranscript` ⇒ instruction 里有对话原文；
 *       没有 / 抛错 ⇒ 退化为「（无额外素材」且**导出不失败**。
 *   [E] `buildRetryPrompt(errors, prevText, context?)`：不传 prevText / context 时与旧输出逐字兼容；
 *       传了则带「你上一次的输出」区块，只贴**头部**，且整体不超 `MAX_PROMPT_CHARS` 硬顶
 *       （具体常量会调，所以断言写的是不变量，不锁死 6000 / 20000 这类数字）。
 *       另守一条 Round 3 硬不变量：**任意合法入参下总长 ≤ `LIMITS.PROMPT_MAX_CHARS`**
 *       ——超顶会被 `generateStructured` 硬抛 `INVALID_ARGUMENT`，而 `generate()` 的
 *       retry 调用没有 try/catch ⇒ 降级①不执行 ⇒ 用户空手而归。
 *
 * ## 不验证什么
 *
 *   · **不验真实模型质量**（不联网、不需要凭据）：`completeSimple` 全是桩。
 *   · 不验 docx 二进制内容 / 落盘细节（那是 `verify-outcome.mjs` 的职责）。
 *   · 不验渲染层卡片 UI（那要 headless Chrome）。
 *   · 不验 `init()` 真建 `ModelRuntime`（会读真实 `~/.pi` 凭据；桩直接塞 `_modelRuntime`）。
 *
 * ## 运行
 *
 * `node scripts/qa-outcome-bypass.mjs` —— 纯 Node、零外部依赖、不联网，
 * **不碰真实 `~/.minipi`**（`OutcomeService` 的 outbox 一律指到 `os.tmpdir()` 临时目录）。
 * 退出码 0 = 全绿；非 0 = 有失败。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ERROR_CODES, LIMITS } from "../src/shared/protocol.js";
import { buildRetryPrompt } from "../src/main/pi/outcome/prompt.js";
import { validateOutcome } from "../src/main/pi/outcome/schema.js";
import { OutcomeService } from "../src/main/pi/outcome/index.js";

/* ------------------------------------------------------------------ 记账 */

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 记一条断言。
 * @param {unknown} cond 真值即通过
 * @param {string} label 人话用例名
 * @param {unknown} [extra] 失败时打印的现场
 */
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    if (extra !== undefined) console.log(`        现场：${typeof extra === "string" ? extra : JSON.stringify(extra)}`);
  }
  return !!cond;
}
const group = (title) => console.log(`\n${title}`);

/**
 * 跑一段可能抛错的准备动作；它自己记**一条**断言，失败也不影响后面的断言。
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<{ pass: boolean, value: T | undefined, error: Error | undefined }>}
 */
async function attempt(label, fn) {
  try {
    const value = await fn();
    ok(true, label);
    return { pass: true, value, error: undefined };
  } catch (err) {
    ok(false, label, err instanceof Error ? err.message : String(err));
    return { pass: false, value: undefined, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * 跑一段**预期抛错**的动作：抛了记通过，没抛记失败。
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} fn
 * @returns {Promise<Error | undefined>} 实际抛出的错误（没抛就是 undefined）
 */
async function expectThrow(label, fn) {
  try {
    await fn();
    ok(false, label, "预期抛错，实际正常返回");
    return undefined;
  } catch (err) {
    ok(true, label);
    return err instanceof Error ? err : new Error(String(err));
  }
}

const msgOf = (err) => (err instanceof Error ? err.message : String(err ?? ""));
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ 保活 */

/**
 * ⚠ 事件循环必须**全程**有 ref 着的 handle（Ray 2026-10-21 审查实测，非理论风险）。
 *
 * `generateStructured` 的超时定时器是 `timer.unref()` 的。若本进程里没有任何 ref 的 handle，
 * 那个 30ms 定时器**根本不会触发** ⇒ `generateStructured` 的 promise 永不 settle
 * ⇒ Node 直接以 **exit code 0** 静默退出，只打一行
 * `Warning: Detected unsettled top-level await`。
 *
 * 结局最坏：门禁**看起来是绿的**（EXIT=0），实际后面一条断言都没跑。
 * 所以在 import 之前就挂一个 ref 的 interval，汇总前 clearInterval —— 这样任何一处
 * 意外挂住都会变成「测试自己超时失败」，而不是「静默绿灯」。
 */
const keepAlive = setInterval(() => {}, 1000);

console.log("======================================================================");
console.log(" QA · 导出旁路契约（generateStructured / recentTranscript / buildRetryPrompt）");
console.log(" 守的契约：导出过程中不新增任何对话轮次");
console.log("======================================================================");

// `session.js` import 了 Pi SDK，但 SDK 可离线加载（verify-approval.mjs 同款做法）。
// 用动态 import 以免 SDK 加载问题连带整个脚本起不来时连一个断言都跑不到。
const loadHost = await attempt("PiSessionHost 可在纯 Node 里加载（不需要 Electron）", async () => {
  const mod = await import("../src/main/pi/session.js");
  return mod.PiSessionHost;
});
const PiSessionHost = loadHost.value;

if (typeof PiSessionHost !== "function") {
  console.log("\n  ⚠ 拿不到 PiSessionHost，[A]–[C] 无法执行（[D][E] 仍会跑）。");
}

/* ================================================================ 夹具 */

const quietLogger = { info() {}, warn() {}, error() {} };

/** 造一条 `[用户] …` 形态的假消息。 */
const userMsg = (text) => ({ role: "user", content: text });
const assistantMsg = (parts) => ({ role: "assistant", content: parts });

/**
 * 造一个「不参与对话」的假 Pi 会话。
 *
 * ⚠ 三个方法**必须**记录调用并返回 Promise：真实代码若调用它们，我们需要看到「被调了」，
 *   而不是一个改变流程的 TypeError —— 后者会把「有人把 prompt 写回去了」这个真因掩盖掉。
 * @param {unknown[]} messages
 */
function makeFakeSession(messages = []) {
  /** @type {unknown[][]} */
  const promptCalls = [];
  /** @type {unknown[][]} */
  const subscribeCalls = [];
  /** @type {unknown[][]} */
  const abortCalls = [];
  return {
    // `generateStructured` 要的是这个 **Model 对象**本身（不是字符串）。
    model: { provider: "p", id: "m", api: "openai-completions" },
    messages,
    promptCalls,
    subscribeCalls,
    abortCalls,
    prompt(...args) {
      promptCalls.push(args);
      return Promise.resolve();
    },
    subscribe(...args) {
      subscribeCalls.push(args);
      return () => {};
    },
    abort(...args) {
      abortCalls.push(args);
      return Promise.resolve();
    },
  };
}

/**
 * 造 host + 一条假 record + 一个 `completeSimple` 桩。
 *
 * 先塞 `_modelRuntime` 再调用：`init()` 在 `_modelRuntime` 非空时直接返回它，
 * 所以永远走不到「真建 ModelRuntime / 读真实凭据」那条路。
 */
function makeHost(completeSimple, { messages = [], sessionId = "s_1" } = {}) {
  /** @type {unknown[]} */
  const emitted = [];
  const host = new PiSessionHost({ emit: (w) => emitted.push(w), logger: quietLogger });
  const fakeSession = makeFakeSession(messages);
  /** 简易 RingLog 形状：只关心「有没有东西被 push 进来」。 */
  const log = {
    items: [],
    push(w) {
      this.items.push(w);
    },
    since() {
      return [];
    },
    tail() {
      return [];
    },
    clear() {
      this.items.length = 0;
    },
  };
  const rec = {
    sessionId,
    session: fakeSession,
    seq: 0,
    log,
    status: "idle", // 真实代码若走 prompt，会把它改成 streaming
    model: "p/m", // 字符串（返回给调用方的那个）
    sceneId: "work",
    cwd: os.tmpdir(),
    disposed: false,
  };
  host._records.set(sessionId, rec);
  host._modelRuntime = { completeSimple };
  return { host, rec, fakeSession, emitted, log, sessionId };
}

/** 一个「总是成功」的 `completeSimple` 桩，顺便把收到的参数记下来。 */
function recordingCompleteSimple(content = [{ type: "text", text: '{"a":1}' }]) {
  const calls = [];
  const fn = async (model, context, options) => {
    calls.push({ model, context, options });
    return { role: "assistant", content, provider: "p", model: "m", api: "openai-completions", usage: {}, stopReason: "stop" };
  };
  fn.calls = calls;
  return fn;
}

/* ================================================================== A */
group("[A] 零事件 / 零轮次（导出不能发起对话）—— 本次修复的命门");
if (typeof PiSessionHost === "function") {
  {
    const stub = recordingCompleteSimple([
      { type: "text", text: '{"title":' },
      { type: "thinking", text: "先想想标题怎么起" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      { type: "text", text: '"周报"}' },
    ]);
    const fx = makeHost(stub);
    const r = await attempt("generateStructured 正常完成不抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );

    ok(fx.emitted.length === 0, "A1 成功后 emit 一次都没被调用（emitted.length === 0）", fx.emitted.length);
    ok(fx.rec.seq === 0, "A2 成功后 rec.seq 仍为 0（没有事件被编号）", fx.rec.seq);
    ok(fx.log.items.length === 0, "A3 成功后 RingLog 没有增长（log.items.length === 0）", fx.log.items.length);
    ok(fx.fakeSession.promptCalls.length === 0, "A4 成功后 session.prompt 从未被调用", fx.fakeSession.promptCalls.length);
    ok(fx.fakeSession.subscribeCalls.length === 0, "A5 成功后 session.subscribe 从未被调用", fx.fakeSession.subscribeCalls.length);
    ok(fx.fakeSession.abortCalls.length === 0, "A6 正常完成不该 abort 会话（abortCalls === 0）", fx.fakeSession.abortCalls.length);
    ok(fx.rec.status === "idle", "A7 会话状态没有被改成 streaming/done", fx.rec.status);

    ok(r.value?.text === '{"title":"周报"}', "A8 只拼 type:text 片段（thinking / toolCall 不混入 text）", r.value?.text);
    ok(r.value?.model === "p/m", "A9 返回的 model 是 rec.model 字符串（不是 Model 对象）", r.value?.model);
    ok(deepEqual(Object.keys(r.value ?? {}).sort(), ["model", "text"]), "A10 返回结构就是 { text, model } 两个键", Object.keys(r.value ?? {}));
  }

  {
    // 失败路径同样一个事件都不许漏出去：错误映射里若顺手 emit 了错误卡片，也算破坏契约。
    const fx = makeHost(async () => ({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "401 invalid api key",
    }));
    await expectThrow("A11 模型报错时 generateStructured 抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(fx.emitted.length === 0, "A12 失败路径也不 emit（emitted.length === 0）", fx.emitted.length);
    ok(fx.rec.seq === 0 && fx.log.items.length === 0, "A13 失败路径也不动 seq / RingLog", { seq: fx.rec.seq, log: fx.log.items.length });
    ok(fx.fakeSession.promptCalls.length === 0, "A14 失败路径也没有退回去调 session.prompt", fx.fakeSession.promptCalls.length);
  }
}

/* ================================================================== B */
group("[B] 一次性调用的入参与错误映射");
if (typeof PiSessionHost === "function") {
  {
    const stub = recordingCompleteSimple();
    const fx = makeHost(stub);
    await attempt("B1 正常调用成功", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    const call = stub.calls[0];
    const messages = call?.context?.messages;
    ok(Array.isArray(messages) && messages.length === 1, "B2 completeSimple 只收到 1 条消息（一次性调用，没有历史）", messages?.length);
    ok(
      messages?.[0]?.role === "user" && deepEqual(messages?.[0]?.content, [{ type: "text", text: "整理成周报" }]),
      "B3 消息形态是 { role:'user', content:[{type:'text',text:instruction}] }",
      messages?.[0],
    );
    ok(typeof messages?.[0]?.timestamp === "number", "B4 消息带 timestamp 数字", messages?.[0]?.timestamp);
    ok(call?.model === fx.fakeSession.model, "B5 model 参数是 rec.session.model 同一个对象引用", call?.model === fx.fakeSession.model);
    ok(call?.context?.systemPrompt === undefined, "B6 不传 systemPrompt（角色约束全在 instruction 里）", call?.context?.systemPrompt);
    ok(call?.options?.signal instanceof AbortSignal, "B7 传了 AbortSignal 供超时收口", String(call?.options?.signal));
  }

  {
    const fx = makeHost(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "{}" }],
      stopReason: "error",
      errorMessage: "provider 401 Unauthorized",
    }));
    const err = await expectThrow("B8 msg.errorMessage 非空时抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(msgOf(err).includes(ERROR_CODES.PI_UNAVAILABLE), `B9 errorMessage ⇒ ${ERROR_CODES.PI_UNAVAILABLE}`, msgOf(err));
  }

  {
    const leaky = new Error(
      "connect ECONNREFUSED /home/alice/.config/minipi/auth.json\n    at fetchModels (/home/alice/minipi/src/main/pi/session.js:12:3)",
    );
    const fx = makeHost(async () => {
      throw leaky;
    });
    const err = await expectThrow("B10 completeSimple reject 普通 Error 时抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    const m = msgOf(err);
    ok(m.includes(ERROR_CODES.PI_UNAVAILABLE), `B11 普通失败 ⇒ ${ERROR_CODES.PI_UNAVAILABLE}`, m);
    ok(!m.includes("\n"), "B12 错误信息被压成单行（不带多行堆栈）", JSON.stringify(m));
    ok(!m.includes("/home/alice") && !/\/home\//.test(m), "B13 错误信息不含绝对路径（家目录已脱敏）", m);
    ok(!m.includes("session.js:12:3"), "B14 错误信息不含堆栈行列号", m);
  }

  {
    const fx = makeHost(async () => ({ role: "assistant", content: [{ type: "thinking", text: "我想想" }], stopReason: "stop" }));
    const r = await attempt("B15 content 里没有 text 块也不抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(r.value?.text === "", "B16 无 text 块 ⇒ text 为空串（交给 outcome 层降级①）", r.value?.text);
  }

  {
    const fx = makeHost(async () => ({ role: "assistant", content: [], stopReason: "stop" }));
    const r = await attempt("B17 content 是空数组不抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(r.value?.text === "", "B18 空 content ⇒ text 为空串", r.value?.text);
  }

  {
    // 超时相关用例：保活由脚本顶部的 keepAlive 负责（超时定时器是 unref 的，见顶部说明）。
    /** 兜底：万一实现真的挂住，测试自己要在 5s 内失败而不是把门禁挂死。**必须 ref**。 */
    let watchdog = null;
    try {
      let capturedSignal = null;
      let aborted = false;
      const stub = (model, context, options) => {
        capturedSignal = options.signal;
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted by signal"), { name: "AbortError" }));
          });
        });
      };
      const fx = makeHost(stub);
      const startedAt = Date.now();
      const r = await expectThrow("B19 timeoutMs 到点后 generateStructured 会返回（不挂死）", () =>
        Promise.race([
          fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报", timeoutMs: 30 }),
          new Promise((_, rej) => {
            // ⚠ 这里**不能** unref：它和被测定时器都 unref 的话，就没有任何 ref 的 handle 了
            //   （Ray 实测：Node 会以 exit code 0 静默退出，断言一条都不跑）。
            watchdog = setTimeout(() => rej(new Error("测试自身超时：5s 内未返回")), 5000);
          }),
        ]),
      );
      const elapsed = Date.now() - startedAt;
      ok(msgOf(r).includes("结构化输出超时"), "B20 超时 ⇒ 报「结构化输出超时」", msgOf(r));
      ok(msgOf(r).includes(ERROR_CODES.INTERNAL), `B21 超时归到 ${ERROR_CODES.INTERNAL}`, msgOf(r));
      ok(capturedSignal !== null && capturedSignal.aborted === true, "B22 超时真的 abort 了 signal（不是只丢一个 reject）", String(capturedSignal?.aborted));
      ok(aborted === true, "B23 桩收到 abort 事件（signal 真的传下去且被触发）", aborted);
      ok(elapsed < 2000, "B24 30ms 超时在 2s 内收口（没有等到默认 60s）", `${elapsed}ms`);
      ok(fx.fakeSession.promptCalls.length === 0 && fx.emitted.length === 0, "B25 超时路径同样零 prompt / 零事件", {
        prompt: fx.fakeSession.promptCalls.length,
        emitted: fx.emitted.length,
      });
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  {
    // 真实 provider 形态（Ray 实测 openai-compat / anthropic）：中止时**不 reject**，
    //   abort 之后在**稍后的宏任务里 resolve** 一个 `{ stopReason:"aborted", errorMessage:"Request was aborted" }`。
    //   实现必须把它归成「超时 / INTERNAL」，**不能**漂成 PI_UNAVAILABLE（否则用户看到英文技术串，
    //   且错误码与「超时」语义不符）。
    let watchdog = null;
    try {
      let capturedSignal = null;
      const stub = (model, context, options) => {
        capturedSignal = options.signal;
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            setTimeout(() => {
              resolve({
                role: "assistant",
                content: [],
                stopReason: "aborted",
                errorMessage: "Request was aborted",
              });
            }, 10); // 故意晚于实现自己的 reject，模拟真实 provider 的收口顺序
          });
        });
      };
      const fx = makeHost(stub);
      const err = await expectThrow("B26 abort 后「稍后 resolve stopReason:aborted」形态会抛错", () =>
        Promise.race([
          fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报", timeoutMs: 30 }),
          new Promise((_, rej) => {
            watchdog = setTimeout(() => rej(new Error("测试自身超时：5s 内未返回")), 5000);
          }),
        ]),
      );
      ok(msgOf(err).includes("结构化输出超时"), "B27 真实 provider 的中止形态 ⇒ 归成「结构化输出超时」", msgOf(err));
      ok(msgOf(err).includes(ERROR_CODES.INTERNAL), `B28 真实中止形态的错误码是 ${ERROR_CODES.INTERNAL}（不是 PI_UNAVAILABLE）`, msgOf(err));
      ok(!msgOf(err).includes(ERROR_CODES.PI_UNAVAILABLE) && !msgOf(err).includes("Request was aborted"), "B29 不把英文技术串与错误码漏给用户", msgOf(err));
      ok(capturedSignal?.aborted === true, "B30 该形态下 signal 同样被真的 abort", String(capturedSignal?.aborted));
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  {
    // 凭据缺失 / 未知 provider：`completeSimple` 会**同步抛**（不是 reject）。
    // 这条路径与 async reject 不同（同步抛发生在 `Promise.race` 数组求值阶段）。
    const fx = makeHost(() => {
      throw new Error("no credentials for provider p");
    });
    const err = await expectThrow("B31 completeSimple 同步抛时 generateStructured 抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(msgOf(err).includes(ERROR_CODES.PI_UNAVAILABLE), `B32 同步抛 ⇒ ${ERROR_CODES.PI_UNAVAILABLE}`, msgOf(err));
    ok(fx.emitted.length === 0 && fx.fakeSession.promptCalls.length === 0, "B33 同步抛路径同样零事件 / 零 prompt", {
      emitted: fx.emitted.length,
      prompt: fx.fakeSession.promptCalls.length,
    });
  }

  {
    // SDK 的 setup 失败真实形态：既不抛也不 reject，而是 resolve 出 stopReason:"error" + errorMessage。
    const fx = makeHost(async () => ({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Unknown provider: p",
    }));
    const err = await expectThrow("B34 resolve 出 stopReason:error + errorMessage 时抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(msgOf(err).includes(ERROR_CODES.PI_UNAVAILABLE), `B35 SDK setup 失败形态 ⇒ ${ERROR_CODES.PI_UNAVAILABLE}`, msgOf(err));
    ok(!msgOf(err).includes("\n"), "B36 该形态的错误信息同样是单行", JSON.stringify(msgOf(err)));
  }

  {
    const cases = [
      { label: "B37 instruction 为空字符串 ⇒ INVALID_ARGUMENT", input: { instruction: "" }, code: ERROR_CODES.INVALID_ARGUMENT },
      { label: "B38 instruction 纯空白 ⇒ INVALID_ARGUMENT", input: { instruction: "   \n\t " }, code: ERROR_CODES.INVALID_ARGUMENT },
      { label: "B39 instruction 不是字符串 ⇒ INVALID_ARGUMENT", input: { instruction: 42 }, code: ERROR_CODES.INVALID_ARGUMENT },
      { label: "B40 sessionId 不存在 ⇒ SESSION_NOT_FOUND", input: { sessionId: "s_missing", instruction: "x" }, code: ERROR_CODES.SESSION_NOT_FOUND },
      { label: "B41 sessionId 是数字 ⇒ INVALID_ARGUMENT", input: { sessionId: 7, instruction: "x" }, code: ERROR_CODES.INVALID_ARGUMENT },
    ];
    for (const c of cases) {
      const fx = makeHost(recordingCompleteSimple());
      const err = await expectThrow(`${c.label}（抛错）`, () =>
        fx.host.generateStructured({ sessionId: fx.sessionId, ...c.input }),
      );
      ok(msgOf(err).includes(c.code), `${c.label} · 错误码为 ${c.code}`, msgOf(err));
    }
  }

  {
    const fx = makeHost(recordingCompleteSimple());
    delete fx.fakeSession.model; // 会话还没有可用模型
    const err = await expectThrow("B42 会话缺 model 时抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    ok(msgOf(err).includes(ERROR_CODES.PI_UNAVAILABLE), `B43 缺 model ⇒ ${ERROR_CODES.PI_UNAVAILABLE}`, msgOf(err));
  }

  {
    // M2 的「否则」分支（`plan.md` · 「额定错误文案」段）：
    //   被中断且 `signal.aborted` 为真 ⇒「结构化输出超时」
    //   **否则**（上游自己回了 aborted、我们没超时）⇒「结构化输出已中断」
    //
    // 为什么这必须区分：两者对用户是**完全不同的处置** —— 前者该重试/查网络，
    // 后者该查配置或换个模型。拍平成一律「超时」等于把用户指错方向。
    //
    // 这条分支在生产里真实存在：`completeSimple` 正常 resolve 也可能带
    // `stopReason:"aborted"`（上游主动中止），此时 `controller.signal.aborted` 是 false。
    const fx = makeHost(async () => ({
      role: "assistant",
      content: [],
      stopReason: "aborted", // 上游自己中止，不是我们超时
      // 不给 errorMessage：走 stopReason 分支
    }));
    const err = await expectThrow("B44 stopReason:aborted 但未超时时抛错", () =>
      fx.host.generateStructured({ sessionId: fx.sessionId, instruction: "整理成周报" }),
    );
    const m = msgOf(err);
    ok(m.includes(ERROR_CODES.INTERNAL), `B45 上游主动中止 ⇒ ${ERROR_CODES.INTERNAL}`, m);
    ok(m.includes("结构化输出已中断"), "B46 文案是「结构化输出已中断」（不是「超时」）", m);
    // ⚠ 只断言「含『已中断』」不够：万一文案是「超时已中断」也能过。反向断言才是哨兵。
    ok(!m.includes("结构化输出超时"), "B47 不得误导成「超时」（否则用户会去查网络）", m);
    ok(!/aborted/i.test(m) && !m.includes("Request was aborted"), "B48 不透英文框架原文（aborted / Request was aborted）", m);
    ok(fx.emitted.length === 0 && fx.fakeSession.promptCalls.length === 0, "B49 该分支同样零事件 / 零 prompt", {
      emitted: fx.emitted.length,
      prompt: fx.fakeSession.promptCalls.length,
    });
  }
}

/* ================================================================== C */
group("[C] recentTranscript()：只取 user/assistant 的 text，从末尾截断");
if (typeof PiSessionHost === "function") {
  {
    const messages = [
      userMsg("今天修了登录接口的空指针"),
      { role: "system", content: "SYSTEM_SECRET_内部提示词" },
      assistantMsg([
        { type: "thinking", text: "THINKING_不该进素材" },
        { type: "text", text: "好的，我记下了" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "TOOLCALL_不该进素材" } },
      ]),
      { role: "toolResult", content: [{ type: "text", text: "TOOLRESULT_不该进素材" }] },
      userMsg([
        { type: "text", text: "截图看这里：" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ];
    const fx = makeHost(recordingCompleteSimple(), { messages });
    const r = await attempt("C1 recentTranscript 不抛错", () => fx.host.recentTranscript(fx.sessionId));
    const out = r.value ?? "";
    ok(out.includes("[用户] 今天修了登录接口的空指针"), "C2 字符串 content 原样收（带 [用户] 前缀）", out);
    ok(out.includes("[助手] 好的，我记下了"), "C3 assistant 的 text 被收（带 [助手] 前缀）", out);
    ok(!out.includes("THINKING_不该进素材"), "C4 assistant 的 thinking 不进 transcript", out);
    ok(!out.includes("TOOLCALL_不该进素材"), "C5 assistant 的 toolCall 不进 transcript", out);
    ok(!out.includes("SYSTEM_SECRET_内部提示词"), "C6 role:system 的内容不进 transcript", out);
    ok(!out.includes("TOOLRESULT_不该进素材"), "C7 role:toolResult 的内容不进 transcript", out);
    ok(out.includes("截图看这里：") && !out.includes("AAAA"), "C8 数组 content 只取 type:text（image 忽略）", out);
    ok(out.includes("\n\n"), "C9 块之间用空行分隔", JSON.stringify(out.slice(0, 60)));
  }

  {
    // 截断：预算 200，10 条各约 70 字 ⇒ 必须丢头保尾。
    const messages = [];
    for (let i = 1; i <= 10; i += 1) messages.push(userMsg(`第${i}条 ` + "内容".repeat(30)));
    const fx = makeHost(recordingCompleteSimple(), { messages });
    const r = await attempt("C10 recentTranscript(maxChars=200) 不抛错", () => fx.host.recentTranscript(fx.sessionId, 200));
    const out = r.value ?? "";
    ok(out.length <= 200, "C11 截断后总长不超过预算 200", out.length);
    ok(out.startsWith("（更早的对话已省略）"), "C12 被截断时头部有「更早的对话已省略」标记", out.slice(0, 24));
    ok(out.includes("第10条"), "C13 保留的是**最近的**内容（第10条在）", out.slice(-40));
    ok(!out.includes("第1条"), "C14 最早那条被砍掉（第1条不在）", out.slice(0, 60));
    ok(!out.includes("第5条"), "C15 中段同样被砍（第5条不在）", "");
  }

  {
    // 单块自己就超预算 ⇒ 取该块的**尾部**。
    const fx = makeHost(recordingCompleteSimple(), { messages: [userMsg("HEADMARK" + "填".repeat(400) + "TAILMARK")] });
    const r = await attempt("C16 单块超预算时不抛错", () => fx.host.recentTranscript(fx.sessionId, 120));
    const out = r.value ?? "";
    ok(out.length <= 120, "C17 单块超预算时总长仍不超过预算", out.length);
    ok(out.includes("TAILMARK"), "C18 单块超预算时保留块尾部（最新内容）", out.slice(-20));
    ok(!out.includes("HEADMARK"), "C19 单块超预算时丢掉块头部", out.slice(0, 40));
  }

  {
    const fx = makeHost(recordingCompleteSimple(), {
      messages: [userMsg("这条其实读不到")],
    });
    // 读历史抛错（真实 SessionRecord 的 messages 是 getter，可能抛）
    Object.defineProperty(fx.fakeSession, "messages", {
      get() {
        throw new Error("session 已被释放");
      },
    });
    const warns = [];
    fx.host._logger = { info() {}, warn: (m) => warns.push(String(m)), error() {} };
    const r = await attempt("C20 读历史抛错时 recentTranscript 不抛错", () => fx.host.recentTranscript(fx.sessionId));
    ok(r.value === "", "C21 读历史失败 ⇒ 返回空串（导出不该因此失败）", JSON.stringify(r.value));
    ok(warns.length === 1, "C22 读历史失败记了一条 warn", warns.length);
  }

  {
    const fx = makeHost(recordingCompleteSimple(), { messages: [{ role: "user", content: "  " }] });
    ok(fx.host.recentTranscript(fx.sessionId) === "", "C23 全是空白内容 ⇒ 返回空串（不产生空的 [用户] 块）");
  }

  {
    const fx = makeHost(recordingCompleteSimple());
    const err = await expectThrow("C24 sessionId 不存在时 recentTranscript 抛错", () => fx.host.recentTranscript("s_nope"));
    ok(msgOf(err).includes(ERROR_CODES.SESSION_NOT_FOUND), `C25 会话不存在 ⇒ ${ERROR_CODES.SESSION_NOT_FOUND}`, msgOf(err));
  }

  {
    // `maxChars` 非法值 ⇒ 退回缺省预算（8000），不抛错、也不静默给空串。
    // ⚠ `0` **刻意不在**这里：`0 → 8000` 的语义偏反直觉，审查员已提 MINOR 待队长裁定。
    //   在裁定之前锁死它会挡住一次合理的语义修正，所以只断言没有争议的那几个值。
    const fx = makeHost(recordingCompleteSimple(), { messages: [userMsg(`HEAD${"填".repeat(400)}TAIL`)] });
    const base = fx.host.recentTranscript(fx.sessionId); // 缺省预算
    const badValues = [Number.NaN, -5, "8000", null, undefined];
    for (const [i, bad] of badValues.entries()) {
      let out = null;
      let threw = false;
      try {
        out = fx.host.recentTranscript(fx.sessionId, bad);
      } catch {
        threw = true;
      }
      ok(
        !threw && out === base,
        `C2${6 + i} 非法 maxChars=${String(bad)} ⇒ 不抛错且等同缺省预算（${base.length} 字）`,
        threw ? "抛错了" : `len=${out?.length}`,
      );
    }
  }

  {
    // 极小额预算（1/5/10）：不抛错即可。
    // ⚠ 实测此时只返回「（更早的对话已省略）」而**零正文**（预算扣掉标记后剩 0），
    //   属于退化行为（审查员已记 MINOR）。这里**不锁死**该形态，否则将来修好反而红。
    const fx = makeHost(recordingCompleteSimple(), { messages: [userMsg("一段正文")] });
    let threw = false;
    let out = "";
    try {
      out = fx.host.recentTranscript(fx.sessionId, 5);
    } catch {
      threw = true;
    }
    ok(!threw && typeof out === "string", "C31 极小额预算 maxChars=5 ⇒ 不抛错、仍返回字符串", threw ? "抛错了" : `len=${out.length}`);
  }
}

/* ================================================================== D */
group("[D] 素材真的进了提示词（OutcomeService._collectSourceText + buildOutcomePrompt）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-qa-bypass-d-"));
  const validJson = '{"title":"周报","sections":[{"heading":"今日完成","bullets":["修复登录接口的空指针"]}]}';
  try {
    {
      // 旧 mock 形态：宿主**没有** recentTranscript
      const instructions = [];
      const piHost = {
        hasSession: () => true,
        generateStructured: async ({ instruction }) => {
          instructions.push(instruction);
          return { text: validJson, model: "p/m" };
        },
      };
      const svc = new OutcomeService({
        piHost,
        logger: quietLogger,
        outboxDir: tmp,
        renderDocxFn: async () => Buffer.from("PK\u0003\u0004fake"),
      });
      const r = await attempt("D1 宿主没有 recentTranscript 时导出仍成功（兼容旧 mock）", () =>
        svc.generate({ sessionId: "s_1", intent: "整理成周报" }),
      );
      ok(r.pass, "D2 导出没有因为缺 recentTranscript 而抛错");
      ok(instructions[0]?.includes("（无额外素材"), "D3 instruction 里出现「（无额外素材」兜底块", instructions[0]?.slice(0, 40));
      ok(!instructions[0]?.includes("[用户]"), "D4 无素材时不该凭空造出对话块", "");
    }

    {
      // 正常形态：宿主有 recentTranscript
      const seen = [];
      const transcript = "[用户] 今天修了登录接口的空指针\n\n[助手] 好的，我记下了";
      const piHost = {
        hasSession: () => true,
        recentTranscript: (...args) => {
          seen.push(args);
          return transcript;
        },
        generateStructured: async ({ instruction }) => ({ text: validJson, model: "p/m", instruction }),
      };
      const svc = new OutcomeService({ piHost, logger: quietLogger, outboxDir: tmp, renderDocxFn: async () => Buffer.from("PK\u0003\u0004fake") });
      let captured = null;
      const orig = piHost.generateStructured;
      piHost.generateStructured = async (input) => {
        captured = input.instruction;
        return orig(input);
      };
      const r = await attempt("D5 宿主有 recentTranscript 时导出成功", () => svc.generate({ sessionId: "s_1", intent: "整理成周报" }));
      ok(r.pass, "D6 有素材的导出路径不抛错");
      ok(captured?.includes("[用户] 今天修了登录接口的空指针"), "D7 素材原文进了 instruction（含 [用户] 块）", captured?.slice(-200));
      ok(captured?.includes("[助手] 好的，我记下了"), "D8 助手的内容同样进了 instruction", "");
      ok(!captured?.includes("（无额外素材"), "D9 有素材时不该再出现「无额外素材」兜底块", "");
      ok(seen.length >= 1 && seen[0][0] === "s_1" && seen[0][1] === 8000, "D10 recentTranscript 被以 (sessionId, 8000) 调用", seen[0]);
    }

    {
      // recentTranscript 抛错 ⇒ 退化为无素材，导出仍然成功
      const piHost = {
        hasSession: () => true,
        recentTranscript: () => {
          throw new Error("session 已释放");
        },
        generateStructured: async ({ instruction }) => ({ text: validJson, model: "p/m", instruction }),
      };
      let captured = null;
      const orig = piHost.generateStructured;
      piHost.generateStructured = async (input) => {
        captured = input.instruction;
        return orig(input);
      };
      const warns = [];
      const svc = new OutcomeService({
        piHost,
        logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
        outboxDir: tmp,
        renderDocxFn: async () => Buffer.from("PK\u0003\u0004fake"),
      });
      const r = await attempt("D11 recentTranscript 抛错时导出不失败", () => svc.generate({ sessionId: "s_1", intent: "整理成周报" }));
      ok(r.pass, "D12 取素材失败按无素材继续（不抛给用户）");
      ok(captured?.includes("（无额外素材"), "D13 取素材失败后 instruction 走「无额外素材」兜底", captured?.slice(0, 40));
      ok(warns.some((w) => w.includes("取会话素材失败")), "D14 取素材失败记了一条 warn", warns.length);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ================================================================== E */
group("[E] buildRetryPrompt：旧行为逐字兼容 + 上一次输出只贴头部且不超硬顶");
{
  const plain = buildRetryPrompt(["title 不能为空"]);
  // ⚠ 不能用 includes("你上一次的输出") 判「有没有插区块」——开头那句
  //   「你上一次的输出不符合要求」本身就含这个子串，会永远匹配上。
  //   区块的判据只能是区块**表头**（`===== 你上一次的输出…`）与它的说明句。
  const hasPrevBlock = (s) => s.includes("===== 你上一次的输出（可能已截断） =====");
  ok(plain.includes("  - title 不能为空"), "E1 不传 prevText 时错误列表被回灌", plain);
  ok(!hasPrevBlock(plain), "E2 不传 prevText 时不插「你上一次的输出」段（旧行为不变）", "");
  ok(!plain.includes("这是一次独立调用"), "E3 不传 prevText 时不插独立调用说明", "");
  ok(plain.startsWith("你上一次的输出不符合要求"), "E4 开头文案与旧版逐字一致", plain.slice(0, 20));
  ok(plain.includes("只输出修正后的**完整** JSON"), "E5 硬约束段仍在", "");

  ok(!hasPrevBlock(buildRetryPrompt(["x"], "")), "E6 prevText 是空串 ⇒ 不插该段", "");
  ok(!hasPrevBlock(buildRetryPrompt(["x"], "    \n ")), "E7 prevText 是纯空白 ⇒ 不插该段（trim 后为空）", "");
  ok(!hasPrevBlock(buildRetryPrompt(["x"], null)), "E8 prevText 是 null ⇒ 不插该段", "");
  ok(buildRetryPrompt([]).includes("JSON 结构不符合契约"), "E9 errors 为空数组 ⇒ 用默认错误文案", "");

  const prev = '{"title":"周报","sections":[{"heading":"今日完成"}]}';
  const withPrev = buildRetryPrompt(["sections 第 1 项的 bullets 不是数组"], prev);
  ok(hasPrevBlock(withPrev), "E10 传 prevText ⇒ 出现「你上一次的输出」区块", "");
  ok(withPrev.includes(prev), "E11 短 prevText 不截断、原文完整贴回", "");
  ok(withPrev.includes("这是一次独立调用"), "E12 明确告诉模型这是独立调用（看不到上一轮对话）", "");
  ok(withPrev.includes("  - sections 第 1 项的 bullets 不是数组"), "E13 errors 与 prevText 同时存在", "");

  // ⚠⚠ 契约在 Phase 3 期间被改过：任务书原写「只带头部 6000 字」，实现当前是
  //    `PREV_OUTPUT_MAX_CHARS = 20000`，而且还要被 `room = 32000 − base − 1200` 挤压，
  //    并且多了第三个参数 `context`（用来重贴「意图 + 素材」）。
  //    所以下面断言的是**不变量**：只带头部 / 不超 32000 硬顶 / 不整段塞。
  //    常量调大调小都不该红；「整段塞进去」「突破硬顶」「半截内容冒充完整」才该红。
  const HARD = 32000; // = prompt.js 的 MAX_PROMPT_CHARS
  const long = `HEADMARK${"x".repeat(30000)}TAILMARK`;
  const cut = buildRetryPrompt(["x"], long);
  ok(cut.includes("HEADMARK"), "E14 超长 prevText 保留**头部**（HEADMARK 在）", "");
  ok(!cut.includes("TAILMARK"), "E15 超长 prevText 的尾部被切掉（TAILMARK 不在）", "");
  ok(cut.length <= HARD, `E16 修正提示词不超过 MAX_PROMPT_CHARS 硬顶（实测 ${cut.length} ≤ ${HARD}）`, cut.length);
  ok((cut.match(/x/g) ?? []).length < 30000, "E17 没有把整段 3 万字原样塞进提示词", (cut.match(/x/g) ?? []).length);

  // 三参数形态：修正重试必须重贴「意图 + 素材」——一次性调用下模型看不到上一轮，
  // 只回灌 errors 它不知道要修什么。
  const ctx = { intent: "整理成周报", sourceText: `素材正文${"y".repeat(20000)}`, format: "docx" };
  const withCtx = buildRetryPrompt(["x"], long, ctx);
  ok(withCtx.includes("===== 修正要求 ====="), "E18 传 context ⇒ 前置产出要求块（含「修正要求」分隔）", "");
  ok(withCtx.includes("===== 用户意图 =====") && withCtx.includes("整理成周报"), "E19 修正提示词重贴了用户意图", "");
  ok(withCtx.includes("素材正文"), "E20 修正提示词重贴了素材", "");
  ok(withCtx.length <= HARD, `E21 带 context + 超长 prev 仍不超硬顶（实测 ${withCtx.length} ≤ ${HARD}）`, withCtx.length);
  ok(!withCtx.includes("TAILMARK"), "E22 带 context 时 prev 仍只带头部", "");
  ok(
    (withCtx.match(/x/g) ?? []).length < (cut.match(/x/g) ?? []).length,
    "E23 base 占额度后 prev 被挤得更短（room 预算真的生效）",
    { withCtx: (withCtx.match(/x/g) ?? []).length, noCtx: (cut.match(/x/g) ?? []).length },
  );

  // 极端的额度耗尽形态（**非法入参**：sourceText 远超 SOURCE_TEXT_MAX_CHARS=8000）。
  //
  // 【为什么这里只断言「不超顶 / 不抛错」，不断言文案】
  //   · 合法入参下 `room` 恒 ≥ 19817（base 上限 10983），**永远走不到额度为 0**；
  //   · 非法超大 sourceText 下，Round 3 的最后一道硬闸会把整串切到恰好 cap，
  //     「上一次输出过长，已省略」这句连同 errors 列表一起被切掉 —— 那是**有意的取舍**：
  //     超顶会让整次导出失败，切掉一句话的代价小得多。
  //   → 所以「整段省略并说明」这句的文案既在生产不可达、在非法入参下也不保证存在，
  //     断言它等于把测试钉在一个刀刃上（Round 2→3 我就因此误红了一次）。
  //     这里改为断言**真契约**：绝不返回超顶字符串、绝不抛错。
  const oversized = buildRetryPrompt(["x"], long, { intent: "整理成周报", sourceText: "z".repeat(30000), format: "docx" });
  ok(
    oversized.length <= HARD,
    `E24【防御性·非法入参】超大素材下仍绝不超顶（实测 ${oversized.length} ≤ ${HARD}，超顶会让整次导出失败）`,
    oversized.length,
  );
  ok(!oversized.includes("TAILMARK"), "E25【防御性·非法入参】额度耗尽时也不塞上一轮输出的尾部残片", "");
  // 正着钉一遍「生产路径不会出现这句文案」：合法满额入参下 room 一定够，不该触发省略说明。
  const legalMax = buildRetryPrompt(
    ["x"],
    long,
    { intent: "啊".repeat(LIMITS.OUTCOME_INTENT_MAX_CHARS), sourceText: "y".repeat(8000), format: "docx" },
  );
  ok(
    !legalMax.includes("上一次输出过长，已省略") && legalMax.includes("HEADMARK"),
    "E26 合法满额入参下不会触发「整段省略」（room 恒 ≥ 19817 ⇒ 生产路径看不到这句）",
    { len: legalMax.length },
  );
  ok(!buildRetryPrompt(["x"], undefined, {}).includes("===== 修正要求 ====="), "E27 context 里没有 intent ⇒ 不插 base（旧调用点逐字不变）", "");

  /* ---------------------------------------------------------------- *
   * E28+ · Round 3 硬不变量（plan.md「Round 3 · 契约补强」）
   *
   * > 对任意合法入参，`buildRetryPrompt(...)` 返回长度**必须** ≤
   * > `LIMITS.PROMPT_MAX_CHARS`；额度不够时**优先砍上一轮输出**，
   * > 绝不返回超顶字符串。
   *
   * 为什么这条是底线而不是洁癖：超顶会被 `generateStructured` **硬抛**
   * `INVALID_ARGUMENT`，而 `outcome.generate()` 的两次 retry 调用**不在
   * try/catch 里**（首个 `try` 在写盘段）⇒ 异常冒出 `generate()` ⇒
   * **降级①（把模型原文写成 md）根本不会执行** ⇒ 用户既没 docx 也没 md，**空手而归**。
   * 而超顶恰好发生在「修正重试」这条**本来用来救场**的路径上。
   *
   * 下面用**生产可达的最坏组合**打，不用手搓假错误串：
   *   · errors：真正喂 `sections: [50 个字符串]` 给 `validateOutcome` 得到的 51 条（实测 956 字）；
   *   · intent 打满 2000 字（`OUTCOME_INTENT_MAX_CHARS`）；
   *   · sourceText 打满 8000 字（`SOURCE_TEXT_MAX_CHARS`）；
   *   · prev 取 20000（模型上一轮的长输出）。
   *
   * ⚠ 右侧引用 `LIMITS.PROMPT_MAX_CHARS`（与 qa-contract-drift.mjs 的 D1c
   *   常量漂移检查同源），**不硬编码 32000** —— 否则常量一改，这里就成了新的漂移源。
   * ---------------------------------------------------------------- */
  const PROMPT_CAP = LIMITS.PROMPT_MAX_CHARS;
  const realErrors = validateOutcome({ title: "周报", sections: Array.from({ length: 50 }, () => "今日完成") }).errors;
  ok(
    realErrors.length >= 50,
    `E28 真实校验错误条数达 50+（实测 ${realErrors.length} 条 / ${realErrors.join("").length} 字，这是生产可达的错误量）`,
    realErrors.length,
  );
  const worstCase = buildRetryPrompt(
    realErrors,
    "x".repeat(20000),
    { intent: "啊".repeat(2000), sourceText: "y".repeat(8000), format: "docx" },
  );
  ok(
    worstCase.length <= PROMPT_CAP,
    `E29【Round 3 硬不变量】最坏合法入参下 buildRetryPrompt 不得超顶（实测 ${worstCase.length} ≤ ${PROMPT_CAP}）`,
    { 实测: worstCase.length, 上限: PROMPT_CAP, 超出: worstCase.length - PROMPT_CAP },
  );
  ok(
    worstCase.includes("  - ") || worstCase.includes("上一次输出过长"),
    "E30 超顶压力下仍保留了「错误列表」或「省略说明」（不许为了压长度把提示词掏空）",
    worstCase.slice(0, 80),
  );
}

/* ---------------------------------------------------------------- 汇总 */
clearInterval(keepAlive); // 断言全跑完，放事件循环走
console.log("\n======================================================================");
console.log(` 通过 ${passed} 项 · 失败 ${failed} 项 · 共 ${passed + failed} 项断言`);
if (failed > 0) {
  console.log(" 失败清单：");
  for (const f of failures) console.log(`   ✘ ${f}`);
}
console.log(` 结果：${failed === 0 ? "PASS" : "FAIL"}`);
console.log("======================================================================");
process.exitCode = failed === 0 ? 0 : 1;
