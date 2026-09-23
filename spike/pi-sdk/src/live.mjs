/**
 * spike:live —— 需要凭证、**会真实调用模型并消耗额度**。
 *
 * ⚠️ 默认不执行。不带 `--run` 时只打印「问题 / 判据 / 观察项 / 该敲的命令」，一次模型都不调。
 *
 * 五个问题（与门禁序 7 的「顺带项」+ P1-13 对应）：
 *   Q1  on("tool_call") 返回 { block: true, reason } 之后的真实运行时语义
 *   Q2  terminate: true 的确切语义（同批全部为 true 才提前终止）
 *   Q3  navigateTree() 在 agent 忙时到底是抛错、reject 还是返回 cancelled
 *   Q4  流式中连发两个 prompt（steer / followUp）：preflightResult 与 queue_update 的真实形状
 *   Q5  on("tool_call") 是否覆盖「子 agent / 工具内部再起会话」的工具集
 *
 * 安全设计（别绕过）：
 *   · 不带 --run 绝不调用模型；
 *   · 全局模型调用计数上限（--max-model-calls，默认 10），超限立刻中止并写报告；
 *   · 所有被模型写盘的文件都落在 out/scratch/ 下（.gitignore 已忽略）；
 *   · 报告写盘前统一过 redactDeep()，不含本机绝对路径与凭证。
 */

import fs from "node:fs";
import path from "node:path";

import {
	OUT_DIR,
	PI_PINNED_VERSION,
	SCRATCH_DIR,
	bulletList,
	cell,
	clip,
	ensureDir,
	nowIso,
	readJsonSafe,
	redact,
	relFromRepo,
	sleep,
	table,
	verdictLabel,
	waitFor,
	writeReports,
} from "./lib/util.mjs";

const PKG_NAME = "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------
function parseArgs(argv) {
	const args = { run: false, only: null, maxModelCalls: 10, idleTimeoutMs: 180_000, planningWindowMs: 12_000 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--run") args.run = true;
		else if (a === "--plan") args.run = false;
		else if (a.startsWith("--only=")) args.only = a.slice("--only=".length).split(",").map((s) => s.trim().toLowerCase());
		else if (a.startsWith("--max-model-calls=")) args.maxModelCalls = Number(a.split("=")[1]);
		else if (a.startsWith("--idle-timeout-ms=")) args.idleTimeoutMs = Number(a.split("=")[1]);
		else if (a.startsWith("--planning-window-ms=")) args.planningWindowMs = Number(a.split("=")[1]);
		else if (a === "--help" || a === "-h") args.help = true;
		else if (a.startsWith("--")) throw new Error(`未知参数：${a}`);
	}
	return args;
}

// ---------------------------------------------------------------------------
// 五个问题的「判据 / 观察项」——--plan 与 --run 共享同一份文本，避免文档与代码走偏
// ---------------------------------------------------------------------------
const QUESTIONS = [
	{
		id: "q1",
		title: "on(\"tool_call\") 返回 { block: true, reason } 的真实运行时语义",
		mustObserve: [
			"闸门 handler 是否被调用、被调用几次、event.toolName / event.toolCallId 是什么",
			"被阻断的工具**是否真的没有执行**（检查目标文件是否被创建 / 命令是否留下副作用）",
			"reason 是否原样出现在 tool result 里（session.messages 里 role=toolResult 的那条）",
			"reason 那条 tool result 的 isError 是不是 true",
			"模型接下来做了什么：原样重试 / 换个参数重试 / 改为询问用户 / 放弃",
		],
		criteria: [
			"✅ 通过 = handler 被调用 **且** 目标文件未生成 **且** tool result 文本逐字等于我们给的 reason **且** 模型**没有**原样重试同一操作",
			"⚠️ 部分 = 前三条成立，但模型原样重试了同一条操作（⇒「拒绝要有语义」不成立，必须改用注入 user 消息的方式）",
			"❌ 不通过 = 工具竟然执行了（闸门漏）",
		],
		risk: "会真实消耗额度：1–3 次模型调用。",
	},
	{
		id: "q2",
		title: "terminate: true 的确切语义（同批是否要求全部为 true）",
		mustObserve: [
			"Case A：同批两次写操作**都**被 block 且**都**带 terminate:true → 该批之后是否还有新的模型回合（是否真的提前终止）",
			"Case B：同批两操作，一个 block+terminate、一个放行 → 是否**没有**提前终止（验证 every 语义）",
			"两次 Case 里 tool_execution_start / tool_execution_end 的条数与顺序（用来判断同批是被放行的先跑、还是等审批后才跑）",
			"闸门 handler 的到达时刻：两条 tool_call 是同时到达，还是一条等另一条（对应 F11b：钩子被串行 await）",
		],
		criteria: [
			"✅ 通过 = Case A 提前终止（该批结束后不再有新的模型回合）**且** Case B 未提前终止",
			"⚠️ 部分 = 只有一边符合 ⇒ 不能照 plan §3.3 的实现写",
			"❌ 不通过 = Case A 也没提前终止（⇒「中断整轮」必须换实现，例如直接 session.abort()）",
		],
		risk: "会真实消耗额度：2–4 次模型调用。**这是最贵的一条**，可用 --only q2 单独跑。",
	},
	{
		id: "q3",
		title: "navigateTree() 在 agent 忙时：抛错 / reject / cancelled",
		mustObserve: [
			"调用形态：是**同步 throw**（调用表达式本身抛出）还是 **rejected Promise**（await 时才抛）",
			"错误消息逐字文本",
			"忙时调用后，原流式是否还在继续（有没有被 navigateTree 打断）",
			"对照组 1（空闲 + 不存在的 id）：调用形态与错误消息",
			"对照组 2（空闲 + 合法 id + 扩展返回 { cancel: true }）：是否返回 { cancelled: true }",
		],
		criteria: [
			"✅ 通过 = 忙时**不返回** cancelled（而是抛/reject），且对照组 2 能拿到 { cancelled: true } ⇒ 方案 §3「切换前先 waitForIdle，失败则提示」成立",
			"⚠️ 部分 = 忙时返回 { cancelled: true } 而不抛 ⇒ 方案 §3 表格里「忙时抛错」要改，调用方改为判返回值",
			"❌ 不通过 = 忙时行为不一致（有时抛有时返回）⇒ 必须两路都处理",
		],
		risk: "会真实消耗额度：1–2 次模型调用（需要真的进入 streaming 才能测忙态）。",
	},
	{
		id: "q4",
		title: "流式中连发两个 prompt：preflightResult 与 queue_update 的真实形状",
		mustObserve: [
			"preflightResult 回调被调用几次、参数是 true 还是 false、分别在什么时刻",
			"queue_update 事件的**键名集合**（是否只有 type/steering/followUp；有没有 position/queued）",
			"steering 与 followUp 两个数组的长度随时间怎么变（投递后是否被移除）",
			"流式中**不带** streamingBehavior 调 prompt 时的错误 code 与消息逐字文本",
			"「排队位置」用 steering.length + followUp.length 算是否稳定（连续两次 queue_update 之间该数会不会跳）",
		],
		criteria: [
			"✅ 通过 = preflightResult 只给布尔（无第三态）**且** queue_update 键名 ⊆ {type,steering,followUp} **且** 缺 streamingBehavior 时抛错**且** steering.length+followUp.length 在同一个 queue_update 上是自洽的",
			"⚠️ 部分 = 出现 position/queued 字段（⇒ 审计 v2 的示例反而是对的，方案 §3 要改回来）",
			"❌ 不通过 = preflightResult 给了三态之外的语义或拿不到任何回调",
		],
		risk: "会真实消耗额度：1–2 次模型调用（要一个较长的回答撑住 streaming 窗口）。",
	},
	{
		id: "q5",
		title: "on(\"tool_call\") 是否覆盖「子 agent / 工具内部再起会话」的工具集",
		mustObserve: [
			"场景 A：本会话内的自定义工具（pi.registerTool）**内部**再 createAgentSession（嵌套会话，含 write 工具）→ 父会话的 tool_call handler 有没有看到嵌套会话的 write",
			"场景 B：嵌套会话的 write **是否真的写成功了**（文件是否出现）—— 出现且父会话没看到 = 闸门被绕过",
			"场景 C：自定义工具内部直接用 fs 写文件 → 父会话只看到一次自定义工具调用，看不到那次写（对应 D-06「命令级边界」）",
			"静态对照（已由 offline F20 给出）：官方 subagent 示例是 spawn 独立 pi 进程 ⇒ 父会话看不到子进程内部任何工具",
		],
		criteria: [
			"✅ 通过 = 嵌套会话的工具调用**也**进入父会话 handler（⇒ 闸门无绕过）",
			"❌ 不通过 = 嵌套会话写成功但父会话 handler 未触发（⇒ 必须把 gateFactory 同时注入所有嵌套会话，并把它写进「闸门安全边界」的显式取舍里）",
		],
		risk: "会真实消耗额度：1–2 次模型调用。",
	},
];

function printPlan(args) {
	const L = [];
	L.push("=".repeat(78));
	L.push("minipi · Pi SDK 运行时 spike（live）—— **默认不执行**，这是执行计划");
	L.push("=".repeat(78));
	L.push("");
	L.push("本文件不会调用任何模型。要真的跑，请显式加 --run：");
	L.push("");
	L.push("    cd spike/pi-sdk");
	L.push("    npm run spike:live -- --run");
	L.push("");
	L.push(`（可选）--only=q1,q2　--max-model-calls=${args.maxModelCalls}`);
	L.push("");
	for (const q of QUESTIONS) {
		L.push("-".repeat(78));
		L.push(`${q.id.toUpperCase()} · ${q.title}`);
		L.push("-".repeat(78));
		L.push("观察什么：");
		L.push(q.mustObserve.map((s) => `  · ${s}`).join("\n"));
		L.push("通过/不通过判据：");
		L.push(q.criteria.map((s) => `  · ${s}`).join("\n"));
		L.push(`代价：${q.risk}`);
		L.push("");
	}
	L.push("=".repeat(78));
	L.push("跑完产物：out/pi-sdk-live-report.json + out/pi-sdk-live-report.md");
	L.push("回填表：README.md §5 + RESULT-TEMPLATE.md");
	L.push("=".repeat(78));
	process.stdout.write(`${L.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// 事件快照：只留可读且不含隐私的字段
// ---------------------------------------------------------------------------
function snapshotEvent(event) {
	const t = event?.type;
	switch (t) {
		case "message_start":
		case "message_end": {
			const m = event.message ?? {};
			return {
				type: t,
				messageRole: m.role ?? null,
				toolCallId: m.toolCallId ?? null,
				toolName: m.toolName ?? null,
				isError: typeof m.isError === "boolean" ? m.isError : null,
				stopReason: m.stopReason ?? null,
				text: clip(extractText(m), 300),
				toolCalls: Array.isArray(m.content) ? m.content.filter((c) => c?.type === "toolCall").map((c) => ({ name: c.name, argsKeys: Object.keys(c.arguments ?? {}) })) : null,
			};
		}
		case "message_update": {
			const ame = event.assistantMessageEvent;
			return {
				type: t,
				assistantEventType: ame?.type ?? null,
				textDelta: ame?.type === "text_delta" ? clip(String(ame.delta ?? ""), 120) : null,
			};
		}
		case "tool_execution_start":
			return { type: t, toolCallId: event.toolCallId, toolName: event.toolName, argsKeys: Object.keys(event.args ?? {}), argsPreview: previewArgs(event.args) };
		case "tool_execution_update":
			return { type: t, toolCallId: event.toolCallId, toolName: event.toolName };
		case "tool_execution_end":
			return { type: t, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError ?? null };
		case "queue_update":
			return { type: t, keys: Object.keys(event).sort(), steering: [...(event.steering ?? [])].map((s) => clip(s, 80)), followUp: [...(event.followUp ?? [])].map((s) => clip(s, 80)) };
		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_settled":
		case "error":
		case "auto_retry_start":
		case "auto_retry_end":
		case "compaction_start":
		case "compaction_end":
			return { type: t, keys: Object.keys(event).sort() };
		default:
			return { type: t ?? "(unknown)", keys: Object.keys(event ?? {}).sort() };
	}
}

function extractText(message) {
	if (!message?.content) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c?.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function previewArgs(args) {
	if (!args || typeof args !== "object") return null;
	const out = {};
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === "string") out[k] = clip(v, 160);
		else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
		else out[k] = `<${typeof v}>`;
	}
	return out;
}

// ---------------------------------------------------------------------------
// 运行上下文
// ---------------------------------------------------------------------------
class LiveRun {
	constructor(args) {
		this.args = args;
		this.sdk = null;
		this.modelRuntime = null;
		this.modelCalls = 0;
		this.errors = [];
		this.notes = [];
	}

	async init() {
		this.sdk = await import(PKG_NAME);
		this.agentDir = typeof this.sdk.getAgentDir === "function" ? this.sdk.getAgentDir() : null;
		this.modelRuntime = await this.sdk.ModelRuntime.create();
	}

	async countModelCall(where) {
		this.modelCalls += 1;
		process.stdout.write(`    · 模型调用 #${this.modelCalls}（${where}）\n`);
		if (this.modelCalls > this.args.maxModelCalls) {
			throw new Error(`已达到 --max-model-calls=${this.args.maxModelCalls} 上限，主动中止（还剩的题目未跑）。`);
		}
	}

	freshDir(name) {
		const dir = path.join(SCRATCH_DIR, name);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	/**
	 * 建一个隔离的会话。
	 * @param {object} o
	 * @param {string} o.cwd
	 * @param {string[]} o.tools
	 * @param {(pi, gate) => void} o.registerExtensions 注册内联扩展
	 * @param {string} o.label
	 */
	async openSession({ cwd, tools, registerExtensions, label }) {
		const gate = {
			toolCall: [],
			toolResult: [],
			nestedToolCall: [],
			mark: {},
		};
		const sessionManager = this.sdk.SessionManager.inMemory(cwd);
		const resourceLoader = new this.sdk.DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir ?? this.sdk.getAgentDir(),
			extensionFactories: [
				{
					name: `minipi-spike-${label}`,
					factory: (pi) => {
						registerExtensions(pi, gate);
					},
				},
			],
			noExtensions: true, // 只留我们这份内联扩展，隔离用户已装的扩展
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const created = await this.sdk.createAgentSession({
			modelRuntime: this.modelRuntime,
			cwd,
			sessionManager,
			resourceLoader,
			tools,
		});

		const events = [];
		const t0 = Date.now();
		const unsub = created.session.subscribe((event) => {
			events.push({ dtMs: Date.now() - t0, ...snapshotEvent(event) });
		});

		return {
			session: created.session,
			sessionManager,
			events,
			gate,
			model: created.session.model ? `${created.session.model.provider}/${created.session.model.id}` : null,
			dispose: async () => {
				try {
					unsub?.();
				} catch {
					/* ignore */
				}
				try {
					await created.session.dispose?.();
				} catch {
					/* ignore */
				}
			},
		};
	}

	/** 发 prompt 并等到整轮结束（有超时，超时判失败而不是挂死）。 */
	async ask(h, text, { where, behavior } = {}) {
		await this.countModelCall(where ?? "prompt");
		const options = {};
		if (behavior) options.streamingBehavior = behavior;
		let timedOut = false;
		const p = h.session.prompt(text, options);
		const timer = new Promise((resolve) => setTimeout(() => {
			timedOut = true;
			resolve("timeout");
		}, this.args.idleTimeoutMs));
		let err = null;
		try {
			const r = await Promise.race([p.then(() => "done"), timer]);
			if (r === "timeout") timedOut = true;
		} catch (e) {
			err = e;
		}
		if (timedOut) {
			this.errors.push(`prompt 超时（${this.args.idleTimeoutMs} ms），已 abort：${clip(text, 60)}`);
			try {
				await h.session.abort();
			} catch {
				/* ignore */
			}
		}
		return { timedOut, error: err };
	}

	/** 取会话里 role=toolResult 的消息（判断 reason 是否原样回灌）。 */
	toolResults(h) {
		return (h.session.messages ?? [])
			.filter((m) => m?.role === "toolResult")
			.map((m) => ({
				toolCallId: m.toolCallId ?? null,
				toolName: m.toolName ?? null,
				isError: m.isError ?? null,
				text: extractText(m),
			}));
	}

	assistantTexts(h) {
		return (h.session.messages ?? [])
			.filter((m) => m?.role === "assistant")
			.map((m) => extractText(m))
			.filter((s) => s.trim().length > 0);
	}
}

// ---------------------------------------------------------------------------
// Q1
// ---------------------------------------------------------------------------
async function runQ1(run) {
	const REASON = "The user denied this action. Do not retry it; ask what to do instead.";
	const cwd = run.freshDir("q1");
	const target = path.join(cwd, "denied-by-gate.txt");

	const h = await run.openSession({
		cwd,
		tools: ["write", "read", "ls", "find", "grep"],
		label: "q1",
		registerExtensions: (pi, gate) => {
			pi.on("tool_call", async (event) => {
				gate.toolCall.push({ toolName: event.toolName, toolCallId: event.toolCallId, createdAt: Date.now(), inputPreview: previewArgs(event.input) });
				if (event.toolName === "write") return { block: true, reason: REASON };
				return undefined;
			});
		},
	});

	const asked = await run.ask(
		h,
		`请使用 write 工具，把字符串 "hello" 写入文件：${target}。只做这一件事，做完只需回复 Done。`,
		{ where: "q1 首次尝试写文件" },
	);

	const fileExists = fs.existsSync(target);
	const results = run.toolResults(h);
	const blockedResult = results.find((r) => r.toolName === "write") ?? null;
	const writeCalls = h.gate.toolCall.filter((c) => c.toolName === "write");
	const writePaths = writeCalls.map((c) => String(c.inputPreview?.file_path ?? c.inputPreview?.path ?? ""));
	const samePathRetry = writeCalls.length > 1 && writePaths.slice(1).some((p) => p === writePaths[0]);
	const otherToolRetry = h.gate.toolCall.length > 1 && !samePathRetry;
	const assistantTexts = run.assistantTexts(h);
	const finalText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";

	// 模型行为的粗分类（这是 Q1 最关键的观察）
	let modelBehavior;
	if (samePathRetry) {
		modelBehavior = `❗原样重试：write 对同一路径被调用 ${writeCalls.length} 次（reason 里的「Do not retry」没被遵守）`;
	} else if (otherToolRetry) {
		modelBehavior = `换姿势重试：reason 之后又有 ${h.gate.toolCall.length - 1} 次工具调用（参数或工具不同）`;
	} else if (finalText && /[?？]/.test(finalText)) {
		modelBehavior = "改为询问用户（最终文本里带问号，且未再调用工具）";
	} else if (finalText && /(无法|不能|不允许|cannot|unable|not allowed|permission|拒绝)/i.test(finalText)) {
		modelBehavior = "陈述限制 / 放弃（最终文本像在解释做不到，且未再调用工具）";
	} else if (finalText) {
		modelBehavior = "其它（未重试，但最终文本不像是询问——原文见下，需人读）";
	} else {
		modelBehavior = "无法判断（没有拿到 assistant 文本）";
	}

	const reasonEchoed = blockedResult ? blockedResult.text.trim() === REASON : false;

	const checks = {
		gateInvoked: h.gate.toolCall.length > 0,
		toolDidNotExecute: !fileExists,
		reasonEchoed,
		reasonIsError: blockedResult?.isError === true,
		noSamePathRetry: !samePathRetry,
	};

	let verdict = "fail";
	if (checks.gateInvoked && checks.toolDidNotExecute && checks.reasonEchoed && checks.noSamePathRetry) verdict = "pass";
	else if (checks.gateInvoked && checks.toolDidNotExecute && checks.reasonEchoed) verdict = "partial";

	await h.dispose();

	return {
		id: "q1",
		title: QUESTIONS[0].title,
		verdict,
		reasonTextUsed: REASON,
		checks,
		observation: {
			gateInvocations: h.gate.toolCall,
			targetFileCreated: fileExists,
			blockedToolResult: blockedResult,
			retry: { writeCallCount: writeCalls.length, paths: writePaths, samePathRetry, otherToolRetry },
			allToolResults: results.map((r) => ({ toolName: r.toolName, isError: r.isError, text: clip(r.text, 200) })),
			modelBehavior,
			finalAssistantText: clip(finalText, 600),
			promptResolved: !asked.timedOut,
			promptError: asked.error ? clip(String(asked.error.message ?? asked.error), 300) : null,
			sessionModel: h.model,
		},
		analysis: [
			`闸门被调用 ${h.gate.toolCall.length} 次（其中 write ${writeCalls.length} 次）`,
			`目标文件是否生成：${fileExists ? "**生成了（闸门漏了）**" : "没有（闸门有效）"}`,
			`toolResult 文本是否逐字等于 reason：${reasonEchoed ? "是" : `否（实际：${clip(blockedResult?.text ?? "（没有 toolResult）", 200)}）`}`,
			`toolResult isError：${blockedResult?.isError ?? "—"}`,
			`模型后续行为分类：${modelBehavior}`,
		],
		events: h.events,
	};
}

// ---------------------------------------------------------------------------
// Q2
// ---------------------------------------------------------------------------
async function runQ2(run) {
	const out = { id: "q2", title: QUESTIONS[1].title, cases: [], verdict: "fail" };

	// ---- Case A：两个写操作都被 block 且都带 terminate ----
	{
		const cwd = run.freshDir("q2a");
		const f1 = path.join(cwd, "a1.txt");
		const f2 = path.join(cwd, "a2.txt");
		const termination = { gateReturnedAt: [], sawToolBatch: null, eventsAfterBatch: null };
		const h = await run.openSession({
			cwd,
			tools: ["write", "read", "ls"],
			label: "q2a",
			registerExtensions: (pi, gate) => {
				pi.on("tool_call", async (event) => {
					gate.toolCall.push({ toolName: event.toolName, toolCallId: event.toolCallId, at: Date.now() });
					if (event.toolName === "write") {
						const r = { block: true, reason: "中断整轮：本条与同批其它操作一起被拒绝。", terminate: true };
						termination.gateReturnedAt.push({ toolCallId: event.toolCallId, at: Date.now() });
						return r;
					}
					return undefined;
				});
			},
		});

		await run.ask(
			h,
			`请**在一条回复里同时**发起两个 write 工具调用（不要分两次）：\n1) 把 "one" 写入 ${f1}\n2) 把 "two" 写入 ${f2}\n两个都调用完只回复 Done。`,
			{ where: "q2a 同批两个 write（都 terminate）" },
		);

		const writeCalls = h.gate.toolCall.filter((c) => c.toolName === "write");
		const starts = h.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "write");
		const assistantTurns = (h.session.messages ?? []).filter((m) => m?.role === "assistant").length;
		const toolResultTurns = (h.session.messages ?? []).filter((m) => m?.role === "toolResult").length;
		const toolResults = run.toolResults(h);

		// 提前终止的证据：blocked 的 result 是否都带 terminate，且之后没有新的 assistant 回合。
		// 我们无法直接读 result.terminate（不在消息里），所以用「toolResult 条数 == 被 block 的 write 数」
		// 与「批次后是否还有新的 write 调用」来间接判断。
		out.cases.push({
			case: "A · 同批 2 个 write，都被 block 且都 terminate:true",
			gateInvocations: writeCalls.length,
			toolExecutionStartCount: starts.length,
			gateReturnTiming: describeTiming(termination.gateReturnedAt),
			filesCreated: { [path.basename(f1)]: fs.existsSync(f1), [path.basename(f2)]: fs.existsSync(f2) },
			assistantTurns,
			toolResultTurns,
			toolResults: toolResults.map((r) => ({ toolName: r.toolName, isError: r.isError })),
			eventsTail: h.events.slice(-25),
			rawToolResultTerminateFields: "结果消息里不含 terminate 字段（它只存在于 agent 内部的 AgentToolResult，不透传到消息）",
		});

		await h.dispose();
	}

	// ---- Case B：一个 block+terminate，一个放行 ----
	{
		const cwd = run.freshDir("q2b");
		const f1 = path.join(cwd, "b1.txt");
		const f2 = path.join(cwd, "b2.txt");
		const h = await run.openSession({
			cwd,
			tools: ["write", "read", "ls"],
			label: "q2b",
			registerExtensions: (pi, gate) => {
				pi.on("tool_call", async (event) => {
					gate.toolCall.push({ toolName: event.toolName, toolCallId: event.toolCallId, at: Date.now(), inputPreview: previewArgs(event.input) });
					if (event.toolName !== "write") return undefined;
					const p = String(event.input?.file_path ?? event.input?.path ?? "");
					if (p.includes("b1")) return { block: true, reason: "只拦这一个：同批另一个放行，验证 every 语义。", terminate: true };
					return undefined; // 放行 b2
				});
			},
		});

		await run.ask(
			h,
			`请**在一条回复里同时**发起两个 write 工具调用（不要分两次）：\n1) 把 "one" 写入 ${f1}\n2) 把 "two" 写入 ${f2}\n两个都调用完只回复 Done。`,
			{ where: "q2b 同批两 write（一个 terminate、一个放行）" },
		);

		out.cases.push({
			case: "B · 同批 2 个 write，一个 block+terminate、一个放行",
			gateInvocations: h.gate.toolCall.filter((c) => c.toolName === "write").length,
			filesCreated: { [path.basename(f1)]: fs.existsSync(f1), [path.basename(f2)]: fs.existsSync(f2) },
			assistantTurns: (h.session.messages ?? []).filter((m) => m?.role === "assistant").length,
			eventsTail: h.events.slice(-25),
		});

		await h.dispose();
	}

	// ---- 判定 ----
	const a = out.cases[0];
	const b = out.cases[1];
	const aTerminated = a.gateInvocations > 0 && a.assistantTurns <= 2; // 一个 assistant 回合出工具调用，最多再来一个收尾
	const bNotTerminated = b.assistantTurns > 0;
	out.verdict = aTerminated && bNotTerminated ? "pass" : aTerminated !== bNotTerminated ? "partial" : "fail";
	out.analysis = [
		`Case A：闸门拦下 ${a.gateInvocations} 个 write；assistant 回合数 ${a.assistantTurns}；blocked 结果 ${a.toolResultTurns} 条`,
		`Case B：闸门拦下 ${b.gateInvocations} 个 write；文件 b2 是否生成 = ${b.filesCreated["b2.txt"]}；assistant 回合数 ${b.assistantTurns}`,
		"判据：A 应提前终止（回合数少）、B 不应提前终止（every 语义）",
		"⚠️ 注意：本 case 无法从消息里直接读到 result.terminate（不下发到消息），所以提前终止只能靠「回合数与事件尾部」间接判断——报告里保留了 eventsTail 供人工核对。",
	];
	return out;
}

function describeTiming(marks) {
	if (marks.length === 0) return "没有记录";
	if (marks.length === 1) return "只到达 1 次（同批第 2 个没到？）";
	const deltas = [];
	for (let i = 1; i < marks.length; i++) deltas.push(marks[i].at - marks[i - 1].at);
	return `第 ${marks.length} 次到达，间隔 ${deltas.join(" / ")} ms`;
}

// ---------------------------------------------------------------------------
// Q3
// ---------------------------------------------------------------------------
async function runQ3(run) {
	const cwd = run.freshDir("q3");
	const out = { id: "q3", title: QUESTIONS[2].title, probes: [], verdict: "fail" };

	const h = await run.openSession({
		cwd,
		tools: ["read", "ls", "find", "grep"],
		label: "q3",
		registerExtensions: (pi, gate) => {
			pi.on("session_before_tree", async () => {
				gate.mark.beforeTreeSeen = true;
				return { cancel: true };
			});
		},
	});

	// 先跑一轮，让 session tree 里有条目
	await run.ask(h, "请用一句话说明什么是二分查找。", { where: "q3 预热一轮（造出会话树条目）" });
	const entries = h.sessionManager.getEntries();
	const leaf = h.sessionManager.getLeafId();
	const legalTarget = entries.length > 1 ? entries[0].id : null;

	// 忙时探测
	let busyProbe = null;
	{
		await run.countModelCall("q3 忙态探测（异步 prompt，需要它撑住 streaming 窗口）");
		const p = h.session.prompt("请写一段 800 字以上的详细说明：什么是 HTTP 缓存。", {});
		const streaming = await waitFor(() => h.session.isStreaming === true, { timeoutMs: 20_000, intervalMs: 20 });
		if (streaming) {
			let syncThrow = false;
			let rejectedWith = null;
			let returned = "未返回";
			try {
				const maybe = h.session.navigateTree(legalTarget ?? "spike-target");
				// 能走到这里说明没有同步抛
				returned = await Promise.resolve(maybe)
					.then((v) => `返回 ${JSON.stringify(v)}`)
					.catch((e) => {
						rejectedWith = clip(String(e?.message ?? e), 300);
						return `rejected：${rejectedWith}`;
					});
			} catch (e) {
				syncThrow = true;
				rejectedWith = clip(String(e?.message ?? e), 300);
				returned = `同步 throw：${rejectedWith}`;
			}
			const stillStreaming = h.session.isStreaming;
			busyProbe = {
				isStreamingAtCall: true,
				callForm: syncThrow ? "同步 throw" : "rejected Promise",
				errorMessage: rejectedWith,
				returnValueOrError: returned,
				stillStreamingAfterCall: stillStreaming,
			};
		} else {
			busyProbe = { isStreamingAtCall: false, note: "20s 内没有进入 streaming，本项不可判定（可能首字延迟过大或模型拒绝作答）" };
		}
		out.probes.push({ probe: "忙时（isStreaming=true）调用 navigateTree", ...busyProbe });

		// 收尾：等它跑完 / 超时 abort
		try {
			await Promise.race([p, sleep(run.args.idleTimeoutMs)]);
		} catch {
			/* ignore */
		}
		try {
			await h.session.abort();
		} catch {
			/* ignore */
		}
		await waitFor(() => h.session.isIdle === true, { timeoutMs: 30_000, intervalMs: 50 });
	}

	// 对照组 1：空闲 + 不存在的 id
	{
		let callForm = "返回了值";
		let message = null;
		try {
			await h.session.navigateTree("__definitely_not_an_entry__");
		} catch (e) {
			callForm = "rejected Promise";
			message = clip(String(e?.message ?? e), 300);
		}
		out.probes.push({ probe: "空闲 + 不存在的 id", callForm, errorMessage: message });
	}

	// 对照组 2：空闲 + 合法 id + 扩展 cancel
	{
		let value = null;
		let callForm = "返回了值";
		let message = null;
		try {
			value = await h.session.navigateTree(legalTarget ?? "__none__");
		} catch (e) {
			callForm = "rejected Promise";
			message = clip(String(e?.message ?? e), 300);
		}
		out.probes.push({
			probe: "空闲 + 合法 id + session_before_tree 返回 { cancel: true }",
			callForm,
			errorMessage: message,
			returnValue: value,
			beforeTreeHandlerSeen: h.gate.mark.beforeTreeSeen === true,
			note: legalTarget ? null : "会话树里只有一个条目，legalTarget 为空，本项降级为「走了一遍不存在 id 的路径」",
		});
	}

	await h.dispose();

	const busy = out.probes[0];
	const cancelProbe = out.probes[2];
	const busyThrows = busy.callForm === "rejected Promise" || busy.callForm === "同步 throw";
	const cancelWorks = cancelProbe.returnValue && cancelProbe.returnValue.cancelled === true;
	out.verdict = busy.isStreamingAtCall === false ? "undecidable" : busyThrows && cancelWorks ? "pass" : busyThrows || cancelWorks ? "partial" : "fail";
	out.analysis = [
		`忙时调用形态：${busy.callForm}${busy.errorMessage ? `（消息逐字：${busy.errorMessage}）` : ""}`,
		`忙时调用后流式是否还在：${busy.stillStreamingAfterCall}`,
		`空闲取消路径返回 { cancelled: true }：${cancelWorks ? "是" : "否"}`,
		"源码对照（offline F6）：`if (this.isStreaming) throw new Error(...)` 位于 async 方法体内 ⇒ 预期是 rejected Promise，不可能是同步 throw。",
	];
	return out;
}

// ---------------------------------------------------------------------------
// Q4
// ---------------------------------------------------------------------------
async function runQ4(run) {
	const cwd = run.freshDir("q4");
	const out = { id: "q4", title: QUESTIONS[3].title, probes: [], verdict: "fail" };

	const h = await run.openSession({
		cwd,
		tools: ["read", "ls", "find", "grep"],
		label: "q4",
		registerExtensions: () => {
			/* Q4 不需要闸门 */
		},
	});

	const queueUpdates = [];
	h.session.subscribe((event) => {
		if (event?.type === "queue_update") {
			queueUpdates.push({
				dtMs: Date.now(),
				keys: Object.keys(event).sort(),
				steeringLen: (event.steering ?? []).length,
				followUpLen: (event.followUp ?? []).length,
				steering: [...(event.steering ?? [])].map((s) => clip(s, 60)),
				followUp: [...(event.followUp ?? [])].map((s) => clip(s, 60)),
			});
		}
	});

	// 1) 起一个长回答，撑住 streaming 窗口
	await run.countModelCall("q4 长回答（异步 prompt）");
	const longTurn = h.session.prompt("请详细解释 TCP 三次握手的每一步，写 800 字以上。", {});
	const streaming = await waitFor(() => h.session.isStreaming === true, { timeoutMs: 25_000, intervalMs: 20 });
	out.probes.push({ probe: "进入 streaming", ok: streaming });

	if (streaming) {
		// 2) steer：观察 preflightResult
		const preflightCalls = [];
		let steerError = null;
		try {
			await run.countModelCall("q4 steer 追问");
			await h.session.prompt("顺便：把第一步用一句话概括。", {
				streamingBehavior: "steer",
				preflightResult: (success) => preflightCalls.push({ success, dtMs: Date.now(), streamingAtCallback: h.session.isStreaming }),
			});
		} catch (e) {
			steerError = clip(String(e?.message ?? e), 300);
		}
		await sleep(500);
		out.probes.push({
			probe: "steer 时 preflightResult 回调",
			callCount: preflightCalls.length,
			argTypes: preflightCalls.map((c) => typeof c.success),
			args: preflightCalls.map((c) => c.success),
			error: steerError,
		});

		// 3) followUp：同样观察
		const preflightCalls2 = [];
		let followUpError = null;
		try {
			await run.countModelCall("q4 followUp 追问");
			await h.session.prompt("另外，最后补一句总结。", {
				streamingBehavior: "followUp",
				preflightResult: (success) => preflightCalls2.push({ success }),
			});
		} catch (e) {
			followUpError = clip(String(e?.message ?? e), 300);
		}
		await sleep(500);
		out.probes.push({
			probe: "followUp 时 preflightResult 回调",
			callCount: preflightCalls2.length,
			args: preflightCalls2.map((c) => c.success),
			error: followUpError,
		});

		out.probes.push({
			probe: "queue_update 观察窗口（此刻）",
			count: queueUpdates.length,
			updates: queueUpdates.map((q, i) => ({ i, keys: q.keys, steeringLen: q.steeringLen, followUpLen: q.followUpLen, sum: q.steeringLen + q.followUpLen, steering: q.steering, followUp: q.followUp })),
		});

		// 4) 不带 streamingBehavior 的负例
		let missingBehavior = null;
		if (h.session.isStreaming) {
			try {
				await h.session.prompt("这条应该被拒绝。");
				missingBehavior = { threw: false, note: "**没有抛错**（与源码 F12 不符，需复查）" };
			} catch (e) {
				missingBehavior = { threw: true, name: e?.name ?? null, code: e?.code ?? null, message: clip(String(e?.message ?? e), 300) };
			}
		} else {
			missingBehavior = { threw: null, note: "调用时已经不在 streaming，负例没做成（可调大 --planning-window-ms 再试）" };
		}
		out.probes.push({ probe: "流式中不带 streamingBehavior 调 prompt（负例）", ...missingBehavior });

		try {
			await longTurn;
		} catch {
			/* ignore */
		}
	} else {
		out.probes.push({ probe: "进入 streaming", ok: false, note: "25s 内没进入 streaming，Q4 的流式分支全部不可判定" });
	}

	await h.dispose();

	const preflightProbe = out.probes.find((p) => p.probe === "steer 时 preflightResult 回调");
	const queueProbe = out.probes.find((p) => String(p.probe).startsWith("queue_update"));
	const negProbe = out.probes.find((p) => String(p.probe).startsWith("流式中不带"));
	const onlyBoolean = preflightProbe?.argTypes?.every((t) => t === "boolean");
	const keysOk = queueProbe ? queueProbe.updates.every((u) => u.keys.every((k) => ["type", "steering", "followUp"].includes(k))) : false;
	const negativeOk = negProbe?.threw === true;

	out.verdict =
		onlyBoolean && keysOk && negativeOk ? "pass" : preflightProbe || queueProbe ? (keysOk && negativeOk ? "partial" : "fail") : "undecidable";
	out.analysis = [
		`preflightResult 只会给布尔：${onlyBoolean ? "是" : "否（见 probes）"}`,
		`queue_update 键名是否只有 type/steering/followUp：${keysOk ? "是" : "否"}`,
		`流式中缺 streamingBehavior 是否抛错：${negativeOk ? "是" : negProbe?.threw === false ? "否" : "没测到"}`,
		"排队位置口径（方案 §3）：steering.length + followUp.length。报告里每一条 queue_update 都附了 sum，供核对它是否稳定。",
		"⚠️ 语义提醒：steering/followUp 是**待投递消息的文本数组**，投递后会被移出 ⇒ 这个和在视觉上会「先升后降」，不是稳定席位；UI 显示成「排队 N 条」而不是「你是第 N 位」。",
	];
	return out;
}

// ---------------------------------------------------------------------------
// Q5
// ---------------------------------------------------------------------------
async function runQ5(run) {
	const cwd = run.freshDir("q5");
	const nestedCwd = run.freshDir("q5/nested");
	const out = { id: "q5", title: QUESTIONS[4].title, probes: [], verdict: "fail" };

	const nestedTarget = path.join(nestedCwd, "written-by-nested-session.txt");
	const directTarget = path.join(cwd, "written-internally-by-tool.txt");
	const gateSaw = { parentToolCalls: [], nestedSessionCreated: false, nestedToolCallsSeenByParent: 0 };

	const h = await run.openSession({
		cwd,
		tools: ["read", "ls"], // 父会话本身不给 write，压住干扰
		label: "q5",
		registerExtensions: (pi, gate) => {
			pi.on("tool_call", async (event) => {
				gate.toolCall.push({ toolName: event.toolName, toolCallId: event.toolCallId, inputPreview: previewArgs(event.input) });
				return undefined; // 全部放行，Q5 只看「看得见吗」
			});

			// 场景 A+B：自定义工具内部再起一个会话（含 write），让那个会话去写文件
			pi.registerTool?.({
				name: "spike_nested_session",
				label: "spike nested session",
				description: "spike 专用：内部再创建一个 Pi 会话并让它写一个文件，用来验证父会话的 tool_call 钩子是否覆盖嵌套会话。",
				parameters: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
				execute: async () => {
					gate.mark.nestedStarted = true;
					const nested = await run.openSession({
						cwd: nestedCwd,
						tools: ["write", "read"],
						label: "q5-nested",
						registerExtensions: () => {
							/* 嵌套会话故意**不**注入父闸门，模拟「子 agent 自己一套工具」 */
						},
					});
					gate.mark.nestedCreated = true;
					try {
						await nested.session.prompt(`请用 write 工具把 "nested" 写入文件 ${nestedTarget}，然后回复 Done。`);
						await nested.session.waitForIdle?.();
					} catch (e) {
						gate.mark.nestedError = clip(String(e?.message ?? e), 200);
					}
					gateSaw.nestedSessionCreated = true;
					gateSaw.nestedToolCallsSeenByParent = gate.toolCall.filter((c) => c.toolName === "write").length;
					const created = fs.existsSync(nestedTarget);
					try {
						await nested.dispose();
					} catch {
						/* ignore */
					}
					return {
						content: [{ type: "text", text: `nested done. targetCreated=${created}` }],
					};
				},
			});

			// 场景 C：自定义工具内部直接用 fs 写文件（不是 Pi 工具）
			pi.registerTool?.({
				name: "spike_direct_fs_write",
				label: "spike direct fs write",
				description: "spike 专用：工具内部直接用 fs 写文件，用来验证「工具内部副作用不进闸门」。",
				parameters: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
				execute: async () => {
					try {
						fs.writeFileSync(directTarget, "written directly by the tool\n", "utf8");
					} catch (e) {
						gate.mark.directWriteError = clip(String(e?.message ?? e), 200);
					}
					return { content: [{ type: "text", text: "direct fs write attempted" }] };
				},
			});
		},
	});

	// 先做一次「工具真的注册上了吗」的自检 —— 避免白烧一次模型调用
	let registeredTools = null;
	try {
		const all = h.session.extensionRunner?.getAllRegisteredTools?.(false) ?? h.session.extensionRunner?.getAllRegisteredTools?.();
		registeredTools = Array.isArray(all) ? all.map((t) => (typeof t === "string" ? t : (t?.name ?? "<unnamed>"))).sort() : String(all);
	} catch (e) {
		registeredTools = `getAllRegisteredTools 调用失败：${clip(String(e?.message ?? e), 160)}`;
	}
	const ourTwoTools = Array.isArray(registeredTools) && ["spike_direct_fs_write", "spike_nested_session"].every((n) => registeredTools.includes(n));
	out.probes.push({
		probe: "自检：两个 spike 自定义工具是否注册成功",
		registeredTools,
		bothPresent: ourTwoTools,
		note: ourTwoTools ? null : "注册失败 ⇒ 本题的模型回合大概率白跑（registerTool 的 parameters 需要用 typebox Schema 或合法 JSON Schema）",
	});

	await run.ask(
		h,
		`请依次调用这两个工具（都用上）：\n1) spike_nested_session\n2) spike_direct_fs_write\n然后只回复 Done。`,
		{ where: "q5 调用自定义工具" },
	);

	const parentSawWrite = h.gate.toolCall.filter((c) => c.toolName === "write");
	const parentSawNested = h.gate.toolCall.filter((c) => c.toolName === "spike_nested_session");
	const parentSawDirect = h.gate.toolCall.filter((c) => c.toolName === "spike_direct_fs_write");

	out.probes.push({
		probe: "场景 A/B：嵌套会话（内部再 createAgentSession，含 write）",
		nestedSessionCreated: gateSaw.nestedSessionCreated,
		nestedPromptError: h.gate.mark.nestedError ?? null,
		nestedTargetCreated: fs.existsSync(nestedTarget),
		parentGateSawNestedToolCall: parentSawNested.length,
		parentGateSawWriteFromNested: parentSawWrite.length,
		conclusion:
			fs.existsSync(nestedTarget) && parentSawWrite.length === 0
				? "❗**闸门被绕过**：嵌套会话写文件成功，父会话的 tool_call 钩子一次都没看到它的 write 调用。"
				: fs.existsSync(nestedTarget) && parentSawWrite.length > 0
					? "✅ 父会话钩子覆盖了嵌套会话的工具调用（无绕过）。"
					: "无法判断（嵌套会话没写成功或没跑起来）——见 nestedPromptError。",
	});

	out.probes.push({
		probe: "场景 C：自定义工具内部直接用 fs 写文件",
		directTargetCreated: fs.existsSync(directTarget),
		parentGateSawCustomToolCall: parentSawDirect.length,
		parentGateSawSeparateWrite: parentSawWrite.length,
		conclusion:
			fs.existsSync(directTarget)
				? "如预期：工具内部副作用不进闸门（闸门只拦「工具调用」这一层，equals D-06 命令级边界）。"
				: "自定义工具没写成功（可能模型没调它）——见 gate.toolCall。",
	});

	out.probes.push({
		probe: "场景 D（静态，来自 offline F20）：官方 subagent 示例",
		staticEvidence: "vendor/pi/packages/coding-agent/examples/extensions/subagent/index.ts:346 用 spawn 起独立 pi 进程",
		conclusion: "独立 pi 子进程自己加载扩展 ⇒ **父会话的 tool_call 钩子必然看不到子进程内部的工具调用**（源码级结论，不需 live）。",
	});

	out.probes.push({
		probe: "闸门实际看到的工具调用清单",
		list: h.gate.toolCall.map((c) => c.toolName),
	});

	await h.dispose();

	const ab = out.probes.find((p) => String(p.probe).startsWith("场景 A/B"));
	const listProbe = out.probes.find((p) => String(p.probe).startsWith("闸门实际看到"));
	out.verdict = ab.nestedSessionCreated === false ? "undecidable" : ab.conclusion.startsWith("❗") ? "fail" : "pass";
	out.analysis = [
		`父会话闸门看到的工具：${listProbe.list.join(" → ") || "（没有）"}`,
		ab.conclusion,
		"⇒ 若结论是「绕过」，minipi 必须在设计上承认：闸门只覆盖**本会话**的工具调用；`work` 场景若允许加载第三方扩展（如官方 subagent 示例），必须把 gateFactory 同时注入它创建的每个嵌套会话，或者干脆禁止此类扩展。",
	];
	return out;
}

const RUNNERS = { q1: runQ1, q2: runQ2, q3: runQ3, q4: runQ4, q5: runQ5 };

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function buildMarkdown(report) {
	const L = [];
	L.push("# minipi · Pi SDK 运行时 spike · **live** 报告");
	L.push("");
	L.push(`> 生成时间：${report.generatedAt}　·　命令：\`npm run spike:live -- --run\``);
	L.push(`> 模型调用次数：**${report.modelCalls}**　·　SDK：\`${PKG_NAME}@${report.sdkVersion}\`　·　会话模型：\`${report.sessionModel ?? "—"}\``);
	L.push(">");
	L.push("> ⚠️ 本报告含真实模型输出。所有路径已脱敏。");
	L.push("");

	L.push("## 结论速览");
	L.push("");
	L.push(
		table(
			["#", "问题", "判定", "一句话结论"],
			report.results.map((r) => [
				r.id.toUpperCase(),
				r.title,
				verdictLabel(r.verdict),
				(r.analysis ?? []).slice(-1)[0] ?? "—",
			]),
		),
	);
	L.push("");

	for (const r of report.results) {
		L.push(`## ${r.id.toUpperCase()} · ${r.title}`);
		L.push("");
		L.push(`**判定：${verdictLabel(r.verdict)}**`);
		L.push("");
		L.push("观察到的：");
		L.push(bulletList(r.analysis ?? []));
		L.push("");
		L.push("原始观察：");
		if (r.observation) {
			L.push("");
			L.push("```json");
			L.push(JSON.stringify(r.observation, null, 2));
			L.push("```");
		}
		if (r.probes) {
			L.push("");
			L.push("```json");
			L.push(JSON.stringify(r.probes, null, 2));
			L.push("```");
		}
		if (r.cases) {
			L.push("");
			L.push("```json");
			L.push(JSON.stringify(r.cases, null, 2));
			L.push("```");
		}
		if (r.events) {
			L.push("");
			L.push(`<details><summary>事件流快照（${r.events.length} 条）</summary>`);
			L.push("");
			L.push("```json");
			L.push(JSON.stringify(r.events, null, 2));
			L.push("```");
			L.push("");
			L.push("</details>");
		}
		L.push("");
	}

	if (report.errors.length > 0) {
		L.push("## 运行期异常 / 主动中止");
		L.push("");
		L.push(bulletList(report.errors.map((e) => `\`${e}\``)));
		L.push("");
	}

	if (report.notes.length > 0) {
		L.push("## 备注");
		L.push("");
		L.push(bulletList(report.notes));
		L.push("");
	}

	return L.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printPlan(args);
		return;
	}
	if (!args.run) {
		printPlan(args);
		return;
	}

	// 二次保险：即使带了 --run，也要求环境变量确认，防止误触
	if (process.env.MINIPI_SPIKE_LIVE_CONFIRM !== "1") {
		process.stdout.write(
			[
				"",
				"⛔ 已带 --run，但缺少确认环境变量，仍然不执行。",
				"",
				"这会真实调用模型并消耗你的额度。确认要跑请这样敲（PowerShell）：",
				"",
				'    $env:MINIPI_SPIKE_LIVE_CONFIRM="1"; npm run spike:live -- --run',
				"",
				"（或先单独跑一条： npm run spike:live -- --run --only=q1）",
				"",
			].join("\n"),
		);
		process.exitCode = 2;
		return;
	}

	ensureDir(OUT_DIR);
	ensureDir(SCRATCH_DIR);

	const run = new LiveRun(args);
	const report = {
		kind: "pi-sdk-live",
		generatedAt: nowIso(),
		node: process.version,
		sdkVersion: PI_PINNED_VERSION,
		sessionModel: null,
		only: args.only,
		maxModelCalls: args.maxModelCalls,
		modelCalls: 0,
		results: [],
		errors: run.errors,
		notes: [
			"本套件只做「运行期行为取证」，不评估模型输出质量。",
			"所有被模型写盘的文件都在 out/scratch/ 下。",
			"若某题判为 undecidable，多半是 streaming 窗口没抓住或模型没按要求调用工具，可单独重跑该题。",
		],
	};

	const ids = (args.only ?? Object.keys(RUNNERS)).filter((id) => RUNNERS[id]);
	if (ids.length === 0) throw new Error(`--only 里没有可识别的题号：${args.only}`);

	process.stdout.write(`== minipi · Pi SDK spike（live）==\n将执行：${ids.join(", ")}\n\n`);

	await run.init();
	report.agentDirRedacted = redact(run.agentDir ?? "(未解析到)");
	process.stdout.write(`agent 目录：${report.agentDirRedacted}\n\n`);

	for (const id of ids) {
		process.stdout.write(`--- ${id.toUpperCase()} ---\n`);
		try {
			const r = await RUNNERS[id](run);
			report.results.push(r);
			report.modelCalls = run.modelCalls;
			process.stdout.write(`  ⇒ ${r.verdict}\n\n`);
		} catch (err) {
			const msg = clip(String(err?.message ?? err), 400);
			run.errors.push(`${id} 崩了：${msg}`);
			report.results.push({ id, title: QUESTIONS.find((q) => q.id === id)?.title ?? id, verdict: "undecidable", analysis: [`执行失败：${msg}`] });
			report.modelCalls = run.modelCalls;
			process.stdout.write(`  ⇒ 执行失败：${msg}\n\n`);
		}
	}

	report.modelCalls = run.modelCalls;
	report.sessionModel = report.results.find((r) => r.observation?.sessionModel)?.observation.sessionModel ?? null;

	const md = buildMarkdown(report);
	const { jsonPath, mdPath } = writeReports("pi-sdk-live", report, md);

	process.stdout.write(`== 完成，共 ${run.modelCalls} 次模型调用 ==\n`);
	process.stdout.write(`报告：\n  ${redact(mdPath)}\n  ${redact(jsonPath)}\n`);
}

main().catch((err) => {
	process.stderr.write(`live spike 崩了：${err?.stack ?? err}\n`);
	process.exitCode = 1;
});
