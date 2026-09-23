/**
 * 静态核对事实表（B.3）。
 *
 * 每一条 = 一个要回答的问题 + 若干「探针」（在 vendor/pi 源码里按行匹配的正则）。
 * 探针全部命中 ⇒ confirmed；部分命中 ⇒ partial；全不命中 ⇒ not_found。
 * 命中行的真实行号与文档引用的行号一起写进报告，便于发现「文档行号漂移」。
 *
 * 来源标注规则（硬要求）：
 *   一律以 `vendor/pi/packages/*\/src/` 为准；只有明确写 dist 的探针才读 dist。
 */

import path from "node:path";
import { VENDOR_AGENT_CORE_SRC, VENDOR_AGENT_DIR } from "./util.mjs";

const SRC = path.join(VENDOR_AGENT_DIR, "src");
const AGENT_SRC = VENDOR_AGENT_CORE_SRC;

/** 相对 vendor/pi 的路径，报告里只写这种相对路径。 */
function rel(abs) {
	return path
		.relative(path.resolve(VENDOR_AGENT_DIR, "..", ".."), abs)
		.split(path.sep)
		.join("/");
}

const F = {
	types: path.join(SRC, "core", "extensions", "types.ts"),
	agentSession: path.join(SRC, "core", "agent-session.ts"),
	agentSessionRuntime: path.join(SRC, "core", "agent-session-runtime.ts"),
	sdk: path.join(SRC, "core", "sdk.ts"),
	config: path.join(SRC, "config.ts"),
	resourceLoader: path.join(SRC, "core", "resource-loader.ts"),
	sessionManager: path.join(SRC, "core", "session-manager.ts"),
	index: path.join(SRC, "index.ts"),
	pkgJson: path.join(VENDOR_AGENT_DIR, "package.json"),
	distTypes: path.join(VENDOR_AGENT_DIR, "dist", "core", "extensions", "types.d.ts"),
	distIndex: path.join(VENDOR_AGENT_DIR, "dist", "index.d.ts"),
	agentTypes: path.join(AGENT_SRC, "types.ts"),
	agentLoop: path.join(AGENT_SRC, "agent-loop.ts"),
	permissionGate: path.join(VENDOR_AGENT_DIR, "examples", "extensions", "permission-gate.ts"),
	subagent: path.join(VENDOR_AGENT_DIR, "examples", "extensions", "subagent", "index.ts"),
	toolsDir: path.join(SRC, "core", "tools"),
};

export const STATIC_FACTS = [
	// -------------------------------------------------------------------
	{
		id: "F1",
		question: "ToolCallEvent 的字段名到底是什么",
		docClaim: "方案 §3.3：基类 { type:\"tool_call\"; toolCallId: string }（types.ts:973-976），子类带 toolName 与 input",
		probes: [
			{ file: F.types, regex: /^interface ToolCallEventBase \{$/, expectLine: 973 },
			{ file: F.types, regex: /^\ttype: "tool_call";$/, expectLine: 974 },
			{ file: F.types, regex: /^\ttoolCallId: string;$/, expectLine: 975 },
			{ file: F.types, regex: /^export type ToolCallEvent =$/, expectLine: 1029 },
			{ file: F.types, regex: /^\ttoolName: "bash";$/, expectLine: 979 },
			{ file: F.types, regex: /^\tinput: BashToolInput;$/, expectLine: 980 },
			{ file: F.types, regex: /^\tinput: Record<string, unknown>;$/, expectLine: 1020 },
			{ file: F.types, regex: /^\t\| CustomToolCallEvent;$/, expectLine: 1038 },
		],
		conclusion:
			"字段名确认：基类只有 type + toolCallId；每个具体事件另有 toolName（字面量联合）+ input。自定义工具走 CustomToolCallEvent（toolName: string, input: Record<string, unknown>）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F2",
		question: "ToolCallEventResult 的 block / reason / terminate",
		docClaim: "方案 §3.3：返回 ToolCallEventResult（types.ts:1217-1226）：block?: boolean、reason?: string、terminate?: boolean",
		probes: [
			{ file: F.types, regex: /^export interface ToolCallEventResult \{$/, expectLine: 1217 },
			{ file: F.types, regex: /^\tblock\?: boolean;$/, expectLine: 1219 },
			{ file: F.types, regex: /^\treason\?: string;$/, expectLine: 1220 },
			{ file: F.types, regex: /^\tterminate\?: boolean;$/, expectLine: 1225 },
		],
		conclusion:
			"三个字段都存在，且**全部可选**；reason 在类型上没有与 block 强绑定（单独返回 { reason } 不会阻断——阻断只看 block）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F3",
		question: "event.input 是否可变（就地改参）",
		docClaim: "方案 §3.3：官方注释 types.ts:1026 写 event.input is mutable",
		probes: [
			{ file: F.types, regex: /^ \* `event\.input` is mutable\. Mutate it in place to patch tool arguments before execution\.$/, expectLine: 1026 },
			{ file: F.types, regex: /^ \* Later `tool_call` handlers see earlier mutations\./, expectLine: 1027 },
			{ file: F.types, regex: /^ \* No re-validation is performed after mutation\.$/, expectLine: 1027 },
			{ file: F.agentTypes, regex: /^\tinput: Record<string, unknown>;$|^\targs: unknown;$/, expectLine: null, optional: true },
		],
		conclusion:
			"可变已确认；**且注释明确说改参之后不再校验**（No re-validation is performed after mutation）。minipi 若用改参降级命令，改坏形状不会被 SDK 拦住。",
	},
	// -------------------------------------------------------------------
	{
		id: "F4",
		question: "queue_update 的真实字段",
		docClaim: "方案 §3：字段是 { steering: readonly string[]; followUp: readonly string[] }（agent-session.ts:172-176）",
		probes: [
			{ file: F.agentSession, regex: /^\t\t\ttype: "queue_update";$/, expectLine: 173 },
			{ file: F.agentSession, regex: /^\t\t\tsteering: readonly string\[\];$/, expectLine: 174 },
			{ file: F.agentSession, regex: /^\t\t\tfollowUp: readonly string\[\];$/, expectLine: 175 },
			{ file: F.agentSession, regex: /^\t\t\tsteering: \[\.\.\.this\._steeringMessages\],$/, expectLine: 840 },
			{ file: F.agentSession, regex: /^\t\t\tfollowUp: \[\.\.\.this\._followUpMessages\],$/, expectLine: 841 },
		],
		negativeRegions: [
			{
				file: F.agentSession,
				fromLine: 166,
				toLine: 200,
				regex: /\b(queued|position|queuePosition)\b/,
				note: "queue_update 事件定义区间内不应出现 queued / position / queuePosition",
			},
		],
		conclusion:
			"确认：只有 steering / followUp 两个字符串数组。**审计 v2 示例里的 { queued, position } 在源码中不存在**（负向探针已核对）。排队位置只能自己算（steering.length + followUp.length），且这个数是「尚未投递的消息条数」，不是稳定席位。",
	},
	// -------------------------------------------------------------------
	{
		id: "F5",
		question: "preflightResult 的真实签名与注释性质",
		docClaim: "方案 §3：签名 (success: boolean) => void，注释标 Internal（RPC 模式专用）（agent-session.ts:273-274）",
		probes: [
			{ file: F.agentSession, regex: /^\tpreflightResult\?: \(success: boolean\) => void;$/, expectLine: 274 },
			{ file: F.agentSession, regex: /^\/\*\* Internal hook used by RPC mode to observe prompt preflight acceptance or rejection\. \*\/$/, expectLine: 273 },
			{ file: F.agentSession, regex: /^\t\tpreflightResult\?\.\(false\);$/, expectLine: 1751 },
			{ file: F.agentSession, regex: /^\t\tpreflightResult\?\.\(true\);$/, expectLine: 1759 },
		],
		conclusion:
			"确认：**只有一个 boolean**，且注释写明是 RPC 模式内部钩子。语义是「prompt 被受理 / 被拒」，不是「本轮跑完」；拿不到「接受 / 排队 / 被拒」三态。排队态必须走 queue_update。",
	},
	// -------------------------------------------------------------------
	{
		id: "F6",
		question: "navigateTree 在 agent 忙时是抛错还是返回 cancelled",
		docClaim: "方案 §3：忙时抛错（agent-session.ts:3585-3587），正常路径返回含 cancelled（:3584）",
		probes: [
			{ file: F.agentSession, regex: /^\tasync navigateTree\($/, expectLine: 3581 },
			{ file: F.agentSession, regex: /^:\ Promise<\{ editorText\?: string; cancelled: boolean; aborted\?: boolean; summaryEntry\?: BranchSummaryEntry \}> \{$/, expectLine: 3584 },
			{ file: F.agentSession, regex: /^\t\tif \(this\.isStreaming\) \{$/, expectLine: 3585 },
			{ file: F.agentSession, regex: /^\t\t\tthrow new Error\("Wait for the current response to finish before navigating the session tree\."\);$/, expectLine: 3586 },
			{ file: F.agentSession, regex: /^\t\t\treturn \{ cancelled: false \};$/, expectLine: 3598 },
		],
		conclusion:
			"源码确认：**忙（isStreaming）时抛 Error**，压缩中也抛；两条 throw 都在 `async` 方法体内 ⇒ 调用方拿到的是 **rejected Promise，而不是同步 throw**。`cancelled` 只出现在正常返回路径（无-op 返回 cancelled:false；被扩展取消返回 cancelled:true）。→ 调用方必须 try/catch await，不能只判断返回值。",
	},
	// -------------------------------------------------------------------
	{
		id: "F7",
		question: "tool_execution_start 的参数字段名：args 还是 input",
		docClaim: "方案未断言（§3.1 数据帧示例里没有该事件的字段）。审计 M3-2 要求小窗显示「⚙ 工具名 参数」",
		probes: [
			{ file: F.agentTypes, regex: /\{ type: "tool_execution_start"; toolCallId: string; toolName: string; args: any \}/, expectLine: 498 },
			{ file: F.agentLoop, regex: /^\t\t\targs: toolCall\.arguments,$/, expectLine: 543 },
			{ file: F.agentSession, regex: /^\t\t\t\ttype: "tool_execution_start",$/, expectLine: 1114 },
			{ file: F.agentSession, regex: /^\t\t\t\targs: event\.args,$/, expectLine: 1117 },
		],
		conclusion:
			"**是 `args`，不是 `input`。** 事件流侧（session.subscribe）用 `args`；扩展侧（pi.on(\"tool_call\")）用 `input`。两者同名不同字段，minipi 的 protocol 映射必须显式改名，否则 M3-2 的参数行会永远是空。",
	},
	// -------------------------------------------------------------------
	{
		id: "F8",
		question: "on(\"tool_call\") 的返回类型：src 与 dist 是否真的不一致",
		docClaim: "方案 §3 源码复核说明：dist 声明返回 void，src 返回 () => void，一律以 src 为准",
		probes: [
			{ file: F.types, regex: /^\ton\(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>\): \(\) => void;$/, expectLine: 1416 },
			{ file: F.distTypes, regex: /^\s*on\(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>\): void;$/, expectLine: 939 },
		],
		conclusion:
			"**不一致已被实测确认**：src 是 `() => void`（可注销），dist 是 `void`。⇒ 以 src 为准，但**npm 安装到的就是这份旧 dist 声明**，所以类型层面 `.on()` 的返回值不可用；运行期是否有返回值要由 live 实测（登记为 F8-live）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F9",
		question: "block 之后 reason 是否作为 tool result 回灌模型",
		docClaim: "方案 §3.3 要点 4：未在源码中找到 reason 是否原样作为 tool result 文本回灌模型的证据 → 列为 spike 项",
		probes: [
			{ file: F.agentLoop, regex: /^\t\t\tif \(beforeResult\?\.block\) \{$/, expectLine: 739 },
			{ file: F.agentLoop, regex: /^\t\t\t\tconst result = createErrorToolResult\(beforeResult\.reason \|\| "Tool execution was blocked"\);$/, expectLine: 740 },
			{ file: F.agentLoop, regex: /^\t\t\t\t\tkind: "immediate",$/, expectLine: 745 },
			{ file: F.agentLoop, regex: /^\t\t\t\t\tisError: true,$/, expectLine: 747 },
			{ file: F.agentTypes, regex: /^ \* `reason` becomes the text shown in that error result\. If omitted, a default blocked message is used\.$/, expectLine: 64 },
			{ file: F.agentTypes, regex: /^ \* Returning `\{ block: true \}` prevents the tool from executing\. The loop emits an error tool result instead\.$/, expectLine: 63 },
		],
		conclusion:
			"**源码层面已能找到证据**（比方案 §3.3 的「未找到」更进一步）：reason 原样成为那条 error tool result 的文本，`isError: true`。⇒「reason 是否回灌」不再是未知；**仍然未知的是「模型看到一条 error 结果后会换姿势还是原样重试」**——那才是 live Q1 要答的。",
	},
	// -------------------------------------------------------------------
	{
		id: "F10",
		question: "terminate: true 的聚合规则（是否要求同批全部为 true）",
		docClaim: "方案 §3.3 要点 5：只有当同一批里每个被阻断的调用都带 terminate: true 才会提前终止",
		probes: [
			{ file: F.agentLoop, regex: /^function shouldTerminateToolBatch\(finalizedCalls: FinalizedToolCallOutcome\[\]\): boolean \{$/, expectLine: 685 },
			{ file: F.agentLoop, regex: /^\treturn finalizedCalls\.length > 0 && finalizedCalls\.every\(\(finalized\) => finalized\.result\.terminate === true\);$/, expectLine: 686 },
			{ file: F.agentLoop, regex: /^\t\t\thasMoreToolCalls = !executedToolBatch\.terminate;$/, expectLine: 271 },
			{ file: F.types, regex: /^\t \* Early termination only happens when every finalized tool result in the batch sets this to true\.$/, expectLine: 1223 },
		],
		conclusion:
			"确认：`every(...)` + `finalizedCalls.length > 0`。**注意「finalized result」不等于「被 block 的 result」**——同批里被放行并执行成功的工具也会计入 finalized，而它们的 result.terminate 是 undefined ⇒ 只要有一项被放行，整批就不会提前终止。⇒ 用户点「中断整轮」时，minipi **必须**把 terminate 传播给同批其它 pending 审批，否则退化为普通拒绝（与方案 §3.3 一致，且有源码依据）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F11a",
		question: "一个 turn 内多个工具调用是并发还是串行（P1-12）",
		docClaim: "审计 P1-12：未验证；v2 建议「spike 验证并发行为」",
		probes: [
			{ file: F.agentLoop, regex: /^async function executeToolCalls\($/, expectLine: 505 },
			{ file: F.agentLoop, regex: /^\t\t\(tc\) => currentContext\.tools\?\.find\(\(t\) => t\.name === tc\.name\)\?\.executionMode === "sequential",$/, expectLine: 514 },
			{ file: F.agentLoop, regex: /^\tif \(config\.toolExecution === "sequential" \|\| hasSequentialToolCall\) \{$/, expectLine: 516 },
			{ file: F.agentLoop, regex: /^\t\treturn executeToolCallsSequential\(currentContext, assistantMessage, toolCalls, config, signal, emit\);$/, expectLine: 517 },
			{ file: F.agentLoop, regex: /^\treturn executeToolCallsParallel\(currentContext, assistantMessage, toolCalls, config, signal, emit\);$/, expectLine: 519 },
		],
		conclusion:
			"**默认是并发**（落到 executeToolCallsParallel），只有 `config.toolExecution === \"sequential\"` 或批内任一工具声明 `executionMode === \"sequential\"` 才串行。⇒ 一个 turn 内确实会同时存在多个工具调用 → 审批要按批聚合（P1-12 有答案了）。",
	},
	{
		id: "F11b",
		question: "并发批里，tool_call 钩子本身是并发触发还是被串行 await",
		docClaim: "方案 §3.3：多个 ask 合并成一张卡（M4-3 要求一个 turn 内 3 个写操作只产生 1 张卡）",
		probes: [
			{ file: F.agentLoop, regex: /^\t\tconst preparation = await prepareToolCall\(currentContext, assistantMessage, toolCall, config, signal\);$/, expectLine: 601 },
			{ file: F.agentLoop, regex: /^\t\tfinalizedCalls\.push\(async \(\) => \{$/, expectLine: 616 },
			{ file: F.agentLoop, regex: /^\tconst orderedFinalizedCalls = await Promise\.all\($/, expectLine: 643 },
			{ file: F.agentLoop, regex: /^\t\t\tconst beforeResult = await config\.beforeToolCall\($/, expectLine: 723 },
		],
		conclusion:
			"**钩子是被串行 await 的**：`prepareToolCall`（内部 await beforeToolCall）在 for 循环里逐条 await，只有**工具执行**才进 Promise.all。⇒ 闸门**不可能**「同时收到 3 个 ask」，第 2 个审批请求要等第 1 个决定完才发出。**M4-3 的「合并成一张卡」因此无法靠 tool_call 钩子的到达时序实现**，必须从 assistant message 的 toolCall 列表（message_end）预先知道本批有几个 ask。这是方案里没写、但会直接决定 M4 实现的一条。",
	},
	// -------------------------------------------------------------------
	{
		id: "F12",
		question: "流式中不带 streamingBehavior 是否真的抛错",
		docClaim: "方案 §3：agent-session.ts:1654-1658",
		probes: [
			{ file: F.agentSession, regex: /^\t\t\tif \(!options\?\.streamingBehavior\) \{$/, expectLine: 1655 },
			{ file: F.agentSession, regex: /^\t\t\t\t\t"Agent is already processing\. Specify streamingBehavior \('steer' or 'followUp'\) to queue the message\.",$/, expectLine: 1657 },
			{ file: F.agentSession, regex: /^\t\t\tif \(options\.streamingBehavior === "followUp"\) \{$/, expectLine: 1660 },
			{ file: F.agentSession, regex: /^\t\t\t\t\tawait this\._queueSteer\(expandedText, currentImages\);$/, expectLine: 1663 },
		],
		conclusion: "确认：流式中缺 streamingBehavior 会 throw（消息文本逐字如上）。steer/followUp 分别落到 _queueSteer / _queueFollowUp。",
	},
	// -------------------------------------------------------------------
	{
		id: "F13",
		question: "prompt() 的 Promise 是否直到整轮跑完才 resolve",
		docClaim: "方案 §3：agent-session.ts:1760，await this._runAgentPrompt(...)",
		probes: [
			{ file: F.agentSession, regex: /^\t\tpreflightResult\?\.\(true\);$/, expectLine: 1759 },
			{ file: F.agentSession, regex: /^\t\tawait this\._runAgentPrompt\(messages\);$/, expectLine: 1760 },
		],
		conclusion:
			"确认：preflightResult(true) 在 _runAgentPrompt 之前触发 ⇒ 回调是「已受理」信号，await prompt() 才是「整轮结束」。所以 `POST /prompt` 的 `{ accepted }` 只能来自 preflightResult，不能来自 await。",
	},
	// -------------------------------------------------------------------
	{
		id: "F14",
		question: "SessionManager.create / inMemory 的真实签名",
		docClaim: "方案 §3 代码：SessionManager.inMemory()；§3.2：SessionManager.create(cwd, dir)（session-manager.ts:1752）",
		probes: [
			{ file: F.sessionManager, regex: /^\tstatic create\(cwd: string, sessionDir\?: string, options\?: NewSessionOptions\): SessionManager \{$/, expectLine: 1752 },
			{ file: F.sessionManager, regex: /^\tstatic inMemory\(cwd: string = process\.cwd\(\), options\?: NewSessionOptions, entries\?: FileEntry\[\]\): SessionManager \{$/, expectLine: 1801 },
		],
		conclusion:
			"两个都存在，但与方案写法有细微差别：**`inMemory()` 接受 cwd 参数（默认 process.cwd()）**。speed 场景若不带 cwd，会落在宿主进程的当前目录——Electron 主进程里那是应用安装目录，不是 `~/.minipi/scratch`。必须显式传 cwd。",
	},
	// -------------------------------------------------------------------
	{
		id: "F15",
		question: "凭证目录到底在哪（与 piConfig.configDir 的关系）",
		docClaim: "方案 §11：~/.pi/agent/auth.json；package.json 的 piConfig.configDir",
		probes: [
			{ file: F.pkgJson, regex: /^\t\t"configDir": "\.pi"$/, expectLine: 7 },
			{ file: F.config, regex: /^export const CONFIG_DIR_NAME: string = pkg\.piConfig\?\.configDir \|\| "\.pi";$/, expectLine: 504 },
			{ file: F.config, regex: /^\treturn join\(homedir\(\), CONFIG_DIR_NAME, "agent"\);$/, expectLine: 533 },
			{ file: F.sdk, regex: /^\t\/\*\* Global config directory\. Default: ~\/\.pi\/agent \*\/$/, expectLine: 44 },
			{ file: F.sdk, regex: /^\tconst authPath = options\.agentDir \? join\(agentDir, "auth\.json"\) : undefined;$/, expectLine: 180 },
			{ file: F.sdk, regex: /^\tconst modelRuntime = options\.modelRuntime \?\? \(await ModelRuntime\.create\(\{ authPath, modelsPath \}\)\);$/, expectLine: 182 },
		],
		conclusion:
			"确认链路：package.json `piConfig.configDir = \".pi\"` → `CONFIG_DIR_NAME` → `getAgentDir() = join(homedir(), \".pi\", \"agent\")` ⇒ 默认凭证文件 `~/.pi/agent/auth.json`。**注意一个坑**：`createAgentSession()` 只有在你显式传 `agentDir` 时才把 `auth.json` 传给 `ModelRuntime.create`；不传则交给 `ModelRuntime.create()` 的默认解析（等价路径，但分支不同）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F16",
		question: "内置工具名清单（8 个）",
		docClaim: "方案 §3.2：read / bash / powershell / edit / write / grep / find / ls",
		probes: [
			{ file: path.join(F.toolsDir, "bash.ts"), regex: /^\tname: "bash",$/, expectLine: 384 },
			{ file: path.join(F.toolsDir, "powershell.ts"), regex: /^\tname: "powershell",$/, expectLine: 40 },
			{ file: path.join(F.toolsDir, "read.ts"), regex: /^\t\tname: "read",$/, expectLine: 74 },
			{ file: path.join(F.toolsDir, "edit.ts"), regex: /^\t\tname: "edit",$/, expectLine: 149 },
			{ file: path.join(F.toolsDir, "write.ts"), regex: /^\t\tname: "write",$/, expectLine: 50 },
			{ file: path.join(F.toolsDir, "grep.ts"), regex: /^\t\tname: "grep",$/, expectLine: 76 },
			{ file: path.join(F.toolsDir, "find.ts"), regex: /^\t\tname: "find",$/, expectLine: 76 },
			{ file: path.join(F.toolsDir, "ls.ts"), regex: /^\t\tname: "ls",$/, expectLine: 60 },
		],
		conclusion: "8/8 一致，方案 §3.2 的工具名清单与源码相同；这也是 ToolCallEvent 的 toolName 联合（CustomToolCallEvent 例外）。",
	},
	// -------------------------------------------------------------------
	{
		id: "F17",
		question: "内联扩展（纯进程内、无文件）的注册入口",
		docClaim: "方案 §3.3：DefaultResourceLoader({ extensionFactories })（resource-loader.ts:168, 254, 957）",
		probes: [
			{ file: F.resourceLoader, regex: /^export interface DefaultResourceLoaderOptions \{$/, expectLine: 159 },
			{ file: F.resourceLoader, regex: /^\textensionFactories\?: InlineExtension\[\];$/, expectLine: 168 },
			{ file: F.resourceLoader, regex: /^export class DefaultResourceLoader implements ResourceLoader \{$/, expectLine: 196 },
			{ file: F.resourceLoader, regex: /^\t\tthis\.extensionFactories = options\.extensionFactories \?\? \[\];$/, expectLine: 268 },
			{ file: F.resourceLoader, regex: /^\t\tfor \(const \[index, input\] of this\.extensionFactories\.entries\(\)\) \{$/, expectLine: 957 },
		],
		conclusion:
			"确认存在。小修正：`extensionFactories` 的声明在第 168 行（方案写 168 正确），但**赋值在 268 行、真正加载在 957 行附近**，方案引用的「254」未命中——属行号漂移，不影响结论。",
	},
	// -------------------------------------------------------------------
	{
		id: "F18",
		question: "AgentSessionRuntime 负责替换会话（switchSession / newSession / fork）",
		docClaim: "方案 §3：agent-session-runtime.ts:74，方法 switchSession/newSession/fork",
		probes: [
			{ file: F.agentSessionRuntime, regex: /^export class AgentSessionRuntime \{$/, expectLine: 74 },
			{ file: F.agentSessionRuntime, regex: /^\tasync switchSession\($/, expectLine: 196 },
			{ file: F.agentSessionRuntime, regex: /^\tasync newSession\(options\?: \{$/, expectLine: 226 },
			{ file: F.agentSessionRuntime, regex: /^\tasync fork\($/, expectLine: 262 },
		],
		conclusion: "确认：类在第 74 行，三个替换方法都在。",
	},
	// -------------------------------------------------------------------
	{
		id: "F19",
		question: "订阅 / 重订阅 / 忙闲判断的接口位置",
		docClaim: "方案 §3：session.subscribe（agent-session.ts:1146）、waitForIdle（:2087）、extensionRunner.setUIContext（:4020）",
		probes: [
			{ file: F.agentSession, regex: /^\tsubscribe\(listener: AgentSessionEventListener\): \(\) => void \{$/, expectLine: 1146 },
			{ file: F.agentSession, regex: /^\tasync waitForIdle\(\): Promise<void> \{$/, expectLine: 2087 },
			{ file: F.agentSession, regex: /^\tget isStreaming\(\): boolean \{$/, expectLine: 1229 },
			{ file: F.agentSession, regex: /^\tget isIdle\(\): boolean \{$/, expectLine: 1234 },
			{ file: F.agentSession, regex: /^\tget extensionRunner\(\): ExtensionRunner \{$/, expectLine: 4020 },
		],
		conclusion:
			"全部命中。小修正：`setUIContext` 这个名字不在 agent-session.ts（只在同文件的 2997 行以 `runner.setUIContext(...)` 出现）；4020 行是 `get extensionRunner()` 访问器，「通过 session.extensionRunner.setUIContext(...)」这条写法因此成立，但**方案引的 4020 是访问器行,不是 setUIContext 定义行**。",
	},
	// -------------------------------------------------------------------
	{
		id: "F20",
		question: "闸门能否覆盖「工具内部再起会话」——官方 subagent 示例的做法",
		docClaim: "方案 §3.3 要点 4 / P1-13：tool_call 钩子是否覆盖子 agent 的工具集，未验证",
		probes: [
			{ file: F.subagent, regex: /^ \* Spawns a separate `pi` process for each subagent invocation,$/, expectLine: 4 },
			{ file: F.subagent, regex: /^\t\tconst proc = spawn\(invocation\.command, invocation\.args, \{$/, expectLine: 346 },
			{ file: F.subagent, regex: /^\t\t\targs: \["--mode", "json", "-p", "--no-session"\];$/, expectLine: 300 },
			{ file: F.permissionGate, regex: /^\t\t\tconst choice = await ctx\.ui\.select\(`⚠️ Dangerous command:\\n\\n  \$\{command\}\\n\\nAllow\?`, \["Yes", "No"\]\);$/, expectLine: 25 },
			{ file: F.permissionGate, regex: /^\t\t\t\treturn \{ block: true, reason: "Blocked by user" \};$/, expectLine: 28 },
		],
		conclusion:
			"**官方 subagent 示例用 `spawn` 起独立 `pi` 进程（第 346 行）**：子进程自己加载扩展、自己装闸门 ⇒ **父会话的 tool_call 钩子看不到子进程内部的任何工具调用**。父会话只会看到一次 `subagent` 工具调用（参数字符串）。⇒ 若 work 场景加载了这类扩展，闸门对它的内部工具是**失效**的（只剩「批准整条 subagent 调用」这一次机会）。同一条也说明官方 permission-gate 的写法（await ctx.ui.select 后 return { block: true, reason }）确实是官方背书用法。",
	},
	// -------------------------------------------------------------------
	{
		id: "F21",
		question: "C17 的预览自算依赖：generateUnifiedPatch / generateDiffString 是否真的导出",
		docClaim: "方案 §3.3 / C17：SDK 已导出 generateUnifiedPatch / generateDiffString（dist/index.d.ts）",
		probes: [
			{ file: F.index, regex: /^export \{ type EditDiffResult, generateDiffString, generateUnifiedPatch \} from "\.\/core\/tools\/edit-diff\.ts";$/, expectLine: 318 },
			{ file: F.distIndex, regex: /^export \{ type EditDiffResult, generateDiffString, generateUnifiedPatch \} from "\.\/core\/tools\/edit-diff\.ts";$/, expectLine: 23 },
		],
		conclusion: "确认：src 与 dist 都导出，C17「预览在放行前由 params 自算 diff」这条方向可行。",
	},
	// -------------------------------------------------------------------
	{
		id: "F22",
		question: "defineTool 是否存在（自建包装层已删除，但确认它不再作为主路线）",
		docClaim: "方案 §3.3：defineTool 虽存在（core/extensions/types.ts:515），但不再作为主路线",
		probes: [
			{ file: F.types, regex: /^export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>\($/, expectLine: 515 },
			{ file: F.index, regex: /^\tdefineTool,$/, expectLine: 189 },
		],
		conclusion: "确认存在并导出（第 515 / index 189 行）。仅作事实核对，minipi 不作为主路线。",
	},
];

export { rel };
