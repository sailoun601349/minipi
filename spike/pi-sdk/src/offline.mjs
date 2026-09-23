/**
 * spike:offline —— 不调用任何模型的离线 spike。
 *
 * 四件事，逐条给结论：
 *   A. ESM 可行性（import / require / engines / exports 条件）
 *   B. 导出面核对（真 import，运行时逐个验证）
 *   C. 静态核对（回 vendor/pi 源码读，给 文件:行号）
 *   D. 凭证探测（只报存在性与 provider 名称，绝不打印任何值）
 *
 * 产物：out/pi-sdk-offline-report.json + out/pi-sdk-offline-report.md
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
	OUT_DIR,
	PI_PINNED_VERSION,
	REPO_ROOT,
	VENDOR_AGENT_DIR,
	VENDOR_SRC_DIR,
	bulletList,
	cell,
	clip,
	ensureDir,
	nowIso,
	readJsonSafe,
	readTextSafe,
	redact,
	relFromRepo,
	scanFileLines,
	table,
	verdictLabel,
	writeReports,
} from "./lib/util.mjs";
import { runStaticScan } from "./lib/scan.mjs";

const PKG_NAME = "@earendil-works/pi-coding-agent";
const INSTALLED_DIR = path.join(REPO_ROOT, "spike", "pi-sdk", "node_modules", ...PKG_NAME.split("/"));
const INSTALLED_PKG_JSON = path.join(INSTALLED_DIR, "package.json");
const INSTALLED_DTS = path.join(INSTALLED_DIR, "dist", "index.d.ts");

const errors = [];

function log(line) {
	process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// 语义版本：只支持 engines 里最常见的 ">=x.y.z" / ">=x.y.z <a.b.c"
// ---------------------------------------------------------------------------
function parseVersion(v) {
	const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

export function satisfiesNode(current, range) {
	const cur = parseVersion(current);
	if (!cur) return { ok: null, reason: "无法解析当前 Node 版本" };
	const parts = String(range).trim().split(/\s+/);
	for (const part of parts) {
		const m = part.match(/^(>=|>|<=|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)$/);
		if (!m) return { ok: null, reason: `无法解析 engines 片段：${part}` };
		const op = m[1] ?? "=";
		const target = [Number(m[2]), Number(m[3]), Number(m[4])];
		const c = cmp(cur, target);
		if (op === ">=" && c < 0) return { ok: false, reason: `当前 ${current} < ${part.slice(1)}` };
		if (op === ">" && c <= 0) return { ok: false, reason: `当前 ${current} 不大于 ${part.slice(1)}` };
		if (op === "<=" && c > 0) return { ok: false, reason: `当前 ${current} > ${part.slice(1)}` };
		if (op === "<" && c >= 0) return { ok: false, reason: `当前 ${current} 不小于 ${part.slice(1)}` };
		if (op === "=" && c !== 0) return { ok: false, reason: `当前 ${current} ≠ ${part.slice(1)}` };
	}
	return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// 0. 环境
// ---------------------------------------------------------------------------
function envSection() {
	const installedPkg = readJsonSafe(INSTALLED_PKG_JSON);
	const vendorPkg = readJsonSafe(path.join(VENDOR_AGENT_DIR, "package.json"));
	const enginesNode = installedPkg?.engines?.node ?? vendorPkg?.engines?.node ?? null;
	const engineCheck = enginesNode ? satisfiesNode(process.version, enginesNode) : { ok: null, reason: "未读到 engines" };

	return {
		time: nowIso(),
		node: process.version,
		nodeEngineRequirement: enginesNode,
		nodeEngineOk: engineCheck.ok,
		nodeEngineReason: engineCheck.reason,
		npm: process.env.npm_config_user_agent ?? null,
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		pinnedVersion: PI_PINNED_VERSION,
		installedPackageVersion: installedPkg?.version ?? null,
		vendorPackageVersion: vendorPkg?.version ?? null,
		pinMatchesVendor: vendorPkg?.version === PI_PINNED_VERSION,
		vendorSrcPresent: fs.existsSync(VENDOR_SRC_DIR),
		vendorFileCount: countFiles(VENDOR_AGENT_DIR),
		outDir: relFromRepo(OUT_DIR),
	};
}

function countFiles(dir) {
	let n = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) stack.push(path.join(cur, e.name));
			else n++;
		}
	}
	return n;
}

// ---------------------------------------------------------------------------
// A. ESM 可行性
// ---------------------------------------------------------------------------
async function esmSection() {
	const result = {
		packageName: PKG_NAME,
		dynamicImport: { ok: false, errorName: null, errorCode: null, errorMessage: null, ms: null },
		requireAttempt: { ok: false, errorName: null, errorCode: null, errorMessage: null },
		resolvedUrl: null,
		exportsMap: null,
		hasRequireCondition: null,
		hasImportCondition: null,
		packageType: null,
		runtimeBrand: null,
		runUnderElectronMain: null,
		conclusion: "",
	};

	let mod = null;
	const t0 = performance.now();
	try {
		mod = await import(PKG_NAME);
		result.dynamicImport.ok = true;
		result.dynamicImport.ms = Math.round((performance.now() - t0) * 10) / 10;
		result.runtimeBrand = mod.VERSION ?? null;
	} catch (err) {
		result.dynamicImport.errorName = err?.name ?? null;
		result.dynamicImport.errorCode = err?.code ?? null;
		result.dynamicImport.errorMessage = clip(String(err?.message ?? err), 300);
		errors.push(`import("${PKG_NAME}") 失败：${result.dynamicImport.errorCode} ${result.dynamicImport.errorMessage}`);
	}

	// import.meta.resolve：确认解析到哪个文件（路径会脱敏）
	try {
		const u = import.meta.resolve(PKG_NAME);
		result.resolvedUrl = redact(String(u));
	} catch (err) {
		result.resolvedUrl = `解析失败：${clip(String(err?.message ?? err), 160)}`;
	}

	// require()：Node 22.12+ 的 require(esm) 可能反而成功，如实记录
	try {
		const req = createRequire(import.meta.url);
		const required = req(PKG_NAME);
		result.requireAttempt.ok = true;
		result.requireAttempt.note = "require() **成功**（Node 22.12+ 的 require(esm) 已默认开启）";
		result.requireAttempt.exportedKeys = Object.keys(required).length;
	} catch (err) {
		result.requireAttempt.ok = false;
		result.requireAttempt.errorName = err?.name ?? null;
		result.requireAttempt.errorCode = err?.code ?? null;
		result.requireAttempt.errorMessage = clip(String(err?.message ?? err), 300);
	}

	const pkg = readJsonSafe(INSTALLED_PKG_JSON);
	result.packageType = pkg?.type ?? null;
	result.exportsMap = pkg?.exports ?? null;
	const rootExport = pkg?.exports?.["."] ?? {};
	result.hasImportCondition = Object.prototype.hasOwnProperty.call(rootExport, "import");
	result.hasRequireCondition = Object.prototype.hasOwnProperty.call(rootExport, "require");

	const bits = [];
	bits.push(result.dynamicImport.ok ? `import 成功（${result.dynamicImport.ms} ms）` : "import 失败");
	bits.push(result.hasRequireCondition ? "exports 里有 require 条件" : "exports 只有 import/types，无 require 条件");
	bits.push(result.requireAttempt.ok ? "require() 在本机 Node 上竟然成功" : `require() 失败（${result.requireAttempt.errorCode ?? "无 code"}）`);
	bits.push("Electron 主进程能否 ESM 无法在纯 Node 下验证，属另一条 spike（spike/electron-window 已交付 main.mjs）");
	result.conclusion = bits.join("；");

	return { section: result, mod };
}

// ---------------------------------------------------------------------------
// B. 导出面核对
// ---------------------------------------------------------------------------
const RUNTIME_EXPORTS = [
	{ name: "createAgentSession", kind: "value", srcHint: "core/sdk.ts:175" },
	{ name: "createAgentSessionRuntime", kind: "value", srcHint: "index.ts:248" },
	{ name: "ModelRuntime", kind: "value", srcHint: "core/model-runtime.ts（class，静态 create 在 :173）" },
	{ name: "SessionManager", kind: "value", srcHint: "core/session-manager.ts:987（create :1752 / inMemory :1801）" },
	{ name: "AgentSessionRuntime", kind: "value", srcHint: "core/agent-session-runtime.ts:74" },
	{ name: "AgentSession", kind: "value", srcHint: "core/agent-session.ts（class）" },
	{ name: "DefaultResourceLoader", kind: "value", srcHint: "core/resource-loader.ts:196" },
	{ name: "defineTool", kind: "value", srcHint: "core/extensions/types.ts:515" },
	{ name: "ExtensionRunner", kind: "value", srcHint: "core/extensions/runner.ts" },
	{ name: "generateUnifiedPatch", kind: "value", srcHint: "core/tools/edit-diff.ts（index.ts:318 导出）" },
	{ name: "generateDiffString", kind: "value", srcHint: "core/tools/edit-diff.ts（index.ts:318 导出）" },
	{ name: "isToolCallEventType", kind: "value", srcHint: "core/extensions/types.ts（index.ts:199 导出）" },
	{ name: "CONFIG_DIR_NAME", kind: "value", srcHint: "config.ts:504" },
	{ name: "getAgentDir", kind: "value", srcHint: "config.ts:533" },
	{ name: "getSessionsDir", kind: "value", srcHint: "config.ts" },
	{ name: "VERSION", kind: "value", srcHint: "config.ts" },
	{ name: "readStoredCredential", kind: "value", srcHint: "core/auth-storage.ts" },
];

const TYPE_ONLY_EXPORTS = [
	{ name: "ToolCallEvent", srcHint: "core/extensions/types.ts:1029" },
	{ name: "ToolCallEventResult", srcHint: "core/extensions/types.ts:1217" },
	{ name: "ExtensionAPI", srcHint: "core/extensions/types.ts" },
	{ name: "ExtensionFactory", srcHint: "core/extensions/types.ts" },
	{ name: "InlineExtension", srcHint: "core/extensions/types.ts" },
	{ name: "PromptOptions", srcHint: "core/agent-session.ts:264" },
	{ name: "AgentSessionEvent", srcHint: "core/agent-session.ts:164" },
	{ name: "Message", srcHint: "@earendil-works/pi-ai（再导出）" },
	{ name: "ThinkingLevel", srcHint: "@earendil-works/pi-ai（再导出）" },
	{ name: "ToolDefinition", srcHint: "core/extensions/types.ts" },
];

function exportSection(mod) {
	const rows = [];
	for (const e of RUNTIME_EXPORTS) {
		let present = false;
		let type = null;
		if (mod) {
			present = Object.prototype.hasOwnProperty.call(mod, e.name);
			if (present) {
				const v = mod[e.name];
				type = typeof v;
				if (type === "function" && v.prototype) type = "class";
				else if (type === "function") type = "function";
				else if (type === "object" && v !== null) type = "object";
			}
		}
		rows.push({ name: e.name, present, type, srcHint: e.srcHint });
	}

	const dtsText = readTextSafe(INSTALLED_DTS);
	const dtsRows = [];
	for (const e of TYPE_ONLY_EXPORTS) {
		let dtsHit = null;
		if (dtsText) {
			const lines = dtsText.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				if (new RegExp(`\\b${e.name}\\b`).test(lines[i])) {
					dtsHit = { line: i + 1, text: clip(lines[i].trim(), 180) };
					break;
				}
			}
		}
		// 运行时不该出现（纯类型）
		const inRuntimeNamespace = mod ? Object.prototype.hasOwnProperty.call(mod, e.name) : null;
		dtsRows.push({ name: e.name, inInstalledDts: dtsHit !== null, dtsLine: dtsHit?.line ?? null, inRuntimeNamespace, srcHint: e.srcHint });
	}

	const runtimeMissing = rows.filter((r) => !r.present).map((r) => r.name);
	const dtsMissing = dtsRows.filter((r) => !r.inInstalledDts).map((r) => r.name);

	// 对「没拿到」的名字逐个补一条定性说明——区分「源码里根本没有」与
	// 「源码里有但公开入口没再导出」。避免报告被读成「这个 API 不存在」。
	const MISSING_EXPLAIN = {
		getSessionsDir:
			"⚠️ 不是「不存在」：它确实定义在 `vendor/pi/packages/coding-agent/src/config.ts:572`，但**没有**被包的公开入口再导出（`src/index.ts` 只再导出了 `CONFIG_DIR_NAME` 与 `getAgentDir`；安装到的 `dist/index.d.ts` 里也搜不到）。⇒ 若 minipi 要用它，只能走子路径导入，不能从包根 import；且 `docs/` 里**没有**任何引用（已核对），所以不阻塞方案。",
	};
	const notes = runtimeMissing.map((n) => `${n}：${MISSING_EXPLAIN[n] ?? "（无补充说明）"}`);

	return {
		installedPackageDir: relFromRepo(INSTALLED_DIR),
		installedPackageJsonPresent: readJsonSafe(INSTALLED_PKG_JSON) !== null,
		runtimeRows: rows,
		typeRows: dtsRows,
		runtimeMissing,
		dtsMissing,
		notes,
		conclusion:
			runtimeMissing.length === 0
				? "方案 §3 及 §3.3 用到的运行时导出全部真实可 import（逐名验证通过）。"
				: `有 ${runtimeMissing.length} 个运行时导出没拿到：${runtimeMissing.join("、")}。`,
	};
}

// ---------------------------------------------------------------------------
// D. 凭证探测（只报存在性与 provider 名称）
// ---------------------------------------------------------------------------
function credentialSection(mod) {
	const configDirName = typeof mod?.CONFIG_DIR_NAME === "string" ? mod.CONFIG_DIR_NAME : null;

	let agentDir = null;
	let agentDirSource = null;
	if (typeof mod?.getAgentDir === "function") {
		try {
			agentDir = mod.getAgentDir();
			agentDirSource = "SDK getAgentDir()（真 import 后调用）";
		} catch (err) {
			agentDirSource = `SDK getAgentDir() 抛错：${clip(String(err?.message ?? err), 120)}`;
		}
	}
	if (!agentDir) {
		const dirName = configDirName ?? ".pi";
		agentDir = path.join(os.homedir(), dirName, "agent");
		agentDirSource =
			configDirName === null
				? `os.homedir() + 回退常量 ".pi"（SDK 未成功 import，拿不到 CONFIG_DIR_NAME）`
				: "os.homedir() + SDK CONFIG_DIR_NAME（getAgentDir() 不可用时的回退）";
	}

	const out = {
		configDirName,
		agentDir: agentDir ? redact(agentDir) : null,
		agentDirResolvedVia: agentDirSource,
		authJsonExists: false,
		authJsonParsed: null,
		providers: [],
		providerCount: 0,
		providerFieldNames: {},
		configRootExists: false,
		configRootEntries: [],
		liveRunnable: false,
		liveRunnableReason: "",
		privacyNote: "本节只输出「文件是否存在 / provider 名称 / 字段名」，不读取、不输出任何凭证值。",
	};

	if (!agentDir) {
		out.liveRunnableReason = "无法解析 agent 目录，无法判断。";
		return out;
	}

	const authPath = path.join(agentDir, "auth.json");
	if (!fs.existsSync(authPath)) {
		out.authJsonExists = false;
		out.liveRunnable = false;
		out.liveRunnableReason = "auth.json 不存在 ⇒ live 测试跑不起来（需要先 `pi` 登录一次，或手工放好凭证）。";
	} else {
		out.authJsonExists = true;
		const parsed = readJsonSafe(authPath);
		if (parsed === undefined) {
			out.authJsonParsed = false;
			out.liveRunnable = false;
			out.liveRunnableReason = "auth.json 存在但不是合法 JSON，未能判断 provider。";
		} else if (parsed === null) {
			out.authJsonParsed = false;
			out.liveRunnableReason = "auth.json 读取失败（权限？）。";
		} else {
			out.authJsonParsed = true;
			for (const [provider, value] of Object.entries(parsed)) {
				out.providers.push(provider);
				if (value && typeof value === "object" && !Array.isArray(value)) {
					out.providerFieldNames[provider] = Object.keys(value);
				} else {
					out.providerFieldNames[provider] = [`<${typeof value}>`];
				}
			}
			out.providerCount = out.providers.length;
			out.liveRunnable = out.providerCount > 0;
			out.liveRunnableReason =
				out.providerCount > 0
					? `auth.json 里配置了 ${out.providerCount} 个 provider ⇒ live 测试**可以**跑（真调模型、会消耗额度）。`
					: "auth.json 是空对象 ⇒ 没有可用 provider，live 测试跑不起来。";
		}
	}

	const configRoot = path.join(os.homedir(), configDirName ?? ".pi");
	out.configRootExists = fs.existsSync(configRoot);
	if (out.configRootExists) {
		try {
			out.configRootEntries = fs.readdirSync(configRoot, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
		} catch {
			out.configRootEntries = [];
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Markdown 报告
// ---------------------------------------------------------------------------
function buildMarkdown({ env, esm, exports_, statics, creds }) {
	const L = [];
	L.push("# minipi · Pi SDK 运行时 spike · **offline** 报告");
	L.push("");
	L.push(`> 生成时间：${env.time}　·　套件：\`spike/pi-sdk/\`　·　命令：\`npm run spike:offline\``);
	L.push(">");
	L.push("> 本报告由 `spike:offline` 真实跑出。**未调用任何模型**，不消耗额度。");
	L.push("> 所有路径已脱敏（`~` = 用户主目录，`<repo>` = 仓库根，`<kit>` = 本套件根）。");
	L.push("");

	L.push("## 0. 运行环境");
	L.push("");
	L.push(
		table(
			["项", "值"],
			[
				["Node", `${env.node}（engines 要求 \`${env.nodeEngineRequirement}\`，满足：${env.nodeEngineOk === true ? "是" : env.nodeEngineOk === false ? "**否**" : "无法判断"}）`],
				["npm（来自 npm_config_user_agent）", env.npm ?? "—（不是通过 npm run 启动）"],
				["平台", `${env.platform} ${env.arch}　OS release ${env.osRelease}`],
				["pin 的 SDK 版本", `${env.pinnedVersion}（vendor 实际：${env.vendorPackageVersion}，一致：${env.pinMatchesVendor ? "是" : "**否**"}）`],
				["安装到的版本", env.installedPackageVersion ?? "**未安装成功**"],
				["vendor/pi 源码", env.vendorSrcPresent ? `在（${env.vendorFileCount} 个文件）` : "**不在**"],
			],
		),
	);
	L.push("");

	L.push("## 1. 结论速览（可直接回填门禁表）");
	L.push("");
	L.push(
		table(
			["#", "问题", "结论", "证据"],
			[
				[
					"B1",
					"ESM 可行性：import / require / engines",
					cell(esm.conclusion),
					`命令输出见 §2；\`${PKG_NAME}\` 的 \`type\`/\`exports\` 读自其 package.json`,
				],
				[
					"B2",
					"导出面核对",
					cell(exports_.conclusion),
					`§3 表（逐名 \`import\` 验证）+ \`dist/index.d.ts\` 行号`,
				],
				[
					"B3",
					"静态核对（源码 文件:行号）",
					cell(
						`${statics.summary.confirmed}/${statics.summary.total} 条完全命中；${statics.summary.partial} 条部分命中；${statics.summary.notFound} 条未命中。` +
							(statics.summary.negativeViolations > 0
								? `负向探针有 ${statics.summary.negativeViolations} 条被违反。`
								: "负向探针全部干净（不存在被否认的字段）。"),
					),
					`§4 逐条明细（含行号漂移与放宽缩进标注）`,
				],
				[
					"B4",
					"凭证探测（只看存在性与 provider 名）",
					cell(`${creds.authJsonExists ? "auth.json 存在" : "auth.json 不存在"}；provider ${creds.providerCount} 个：${creds.providers.join("、") || "无"}`),
					`§5`,
				],
				["B4b", "因此 spike:live 能不能跑", cell(creds.liveRunnableReason), "§5 / §6"],
			],
		),
	);
	L.push("");

	L.push("## 2. ESM 可行性（B1）");
	L.push("");
	L.push(
		table(
			["探针", "结果", "细节"],
			[
				[
					"`await import(\"@earendil-works/pi-coding-agent\")`",
					esm.dynamicImport.ok ? "✅ 成功" : "❌ 失败",
					esm.dynamicImport.ok
						? `${esm.dynamicImport.ms} ms；模块导出的 \`VERSION\` = \`${esm.runtimeBrand}\``
						: `\`${esm.dynamicImport.errorCode ?? "无 error.code"}\` ${esm.dynamicImport.errorMessage}`,
				],
				["解析到的文件（脱敏）", "—", `\`${esm.resolvedUrl}\``],
				[
					"`require(\"@earendil-works/pi-coding-agent\")`",
					esm.requireAttempt.ok ? "⚠️ **成功**（不是预期失败）" : "✅ 如预期失败",
					esm.requireAttempt.ok
						? esm.requireAttempt.note
						: `\`${esm.requireAttempt.errorCode ?? "无 error.code"}\` ${esm.requireAttempt.errorMessage}`,
				],
				["包 `type`", "—", `\`${esm.packageType}\``],
				["`exports[\".\"]` 有 `import` 条件", esm.hasImportCondition ? "✅" : "❌", "—"],
				["`exports[\".\"]` 有 `require` 条件", esm.hasRequireCondition ? "❗**有**" : "✅ 没有", "—"],
				["Node engines 是否满足", env.nodeEngineOk === true ? "✅ 满足" : env.nodeEngineOk === false ? "❌ 不满足" : "🤔 无法判断", env.nodeEngineReason ?? "—"],
				["Electron 主进程 ESM", "🤔 本套件不判", "纯 Node 环境下无法验证；该约束由 `spike/electron-window`（已交付 `main.mjs`）覆盖；本套件只确认「Node 侧 import 通」"],
			],
		),
	);
	L.push("");
	L.push(`\`exports\` 原文（读自安装到的 package.json）：`);
	L.push("");
	L.push("```json");
	L.push(JSON.stringify(esm.exportsMap, null, 2));
	L.push("```");
	L.push("");

	L.push("## 3. 导出面核对（B2）");
	L.push("");
	L.push(`安装目录：\`${exports_.installedPackageDir}\`　package.json 可读：${exports_.installedPackageJsonPresent ? "是" : "否"}`);
	L.push("");
	L.push("### 3.1 运行时导出（逐个 `import` 后验证）");
	L.push("");
	L.push(
		table(
			["导出名", "拿到没有", "运行时类型", "vendor src 位置（供对照）"],
			exports_.runtimeRows.map((r) => [r.name, r.present ? "✅ 有" : "❌ 没有", r.type ?? "—", `\`${r.srcHint}\``]),
		),
	);
	L.push("");
	L.push("### 3.2 纯类型导出（运行时不体现，查 `dist/index.d.ts`）");
	L.push("");
	L.push(
		table(
			["类型名", "在安装到的 .d.ts 里", "首个命中行", "运行时命名空间里有（应为 false）", "vendor src 位置"],
			exports_.typeRows.map((r) => [
				r.name,
				r.inInstalledDts ? "✅" : "❌",
				r.dtsLine ?? "—",
				r.inRuntimeNamespace === null ? "—" : r.inRuntimeNamespace ? "⚠️ true" : "false",
				`\`${r.srcHint}\``,
			]),
		),
	);
	L.push("");
	if ((exports_.notes ?? []).length > 0) {
		L.push("**对「没拿到」的名字的定性（区分「不存在」与「未再导出」）**：");
		L.push("");
		L.push(bulletList(exports_.notes));
		L.push("");
	}

	L.push("## 4. 静态核对（B3，源码 文件:行号）");
	L.push("");
	L.push(`命中口径：探针**逐字正则**匹配源码行；若失败才用「缩进放宽」重试，并单独标注。行号漂移（与文档引用不一致）也单独标出。`);
	L.push("");
	L.push(
		table(
			["事实", "问题", "判定", "探针命中", "结论", "证据（文件:行号）"],
			statics.facts.map((f) => [
				f.id,
				f.question,
				verdictLabel(f.verdict === "confirmed" ? "pass" : f.verdict === "partial" ? "partial" : "fail"),
				f.matchedProbes,
				f.conclusion,
				f.probes
					.filter((p) => p.matched)
					.slice(0, 4)
					.map((p) => `\`${p.file}:${p.line}\``)
					.join("　"),
			]),
		),
	);
	L.push("");

	for (const f of statics.facts) {
		L.push(`### ${f.id} · ${f.question}`);
		L.push("");
		L.push(`- 文档原话：${f.docClaim}`);
		L.push(`- 判定：${f.verdict === "confirmed" ? "✅ 命中" : f.verdict === "partial" ? "⚠️ 部分命中" : "❌ 未命中"}（探针 ${f.matchedProbes}）`);
		L.push(`- 结论：${f.conclusion}`);
		L.push("");
		L.push(
			table(
				["期望行", "实际行", "匹配方式", "命中的源码行", "文件"],
				f.probes.map((p) => [
					p.expectLine ?? "—",
					p.line ?? "未命中",
					p.matchMode ?? "—",
					p.matchedText ? `\`${clip(p.matchedText, 160)}\`` : "—",
					`\`${p.file}\``,
				]),
			),
		);
		if (f.lineDrift.length > 0) {
			L.push("");
			L.push("**行号漂移**（文档引用的行号与实际不一致，结论不受影响但要改文档）：");
			L.push("");
			L.push(
				table(
					["文件", "源码行", "实际行", "文档写的是", "差值"],
					f.lineDrift.map((d) => [`\`${d.file}\``, `\`${clip(d.matchedText, 100)}\``, d.actualLine, d.docExpectedLine, d.delta]),
				),
			);
		}
		if (f.relaxedIndentOnly.length > 0) {
			L.push("");
			L.push(`**仅「缩进放宽」后命中**（内容对、缩进与预期不同）：` + f.relaxedIndentOnly.map((r) => `\`${r.file}:${r.line}\``).join("、"));
		}
		if (f.negativeRegions.length > 0) {
			L.push("");
			L.push("**负向探针**（期望区间内不出现这些字段）：");
			for (const n of f.negativeRegions) {
				L.push(
					`- \`${n.file}\` 第 ${n.fromLine}–${n.toLine} 行，禁 ${n.note}：${n.violated ? `❗**命中** ${JSON.stringify(n.hits)}` : "✅ 干净"}`,
				);
			}
		}
		L.push("");
	}

	L.push("## 5. 凭证探测（B4）");
	L.push("");
	L.push(`> ${creds.privacyNote}`);
	L.push("");
	L.push(
		table(
			["项", "结果"],
			[
				["`piConfig.configDir` → `CONFIG_DIR_NAME`", `\`${creds.configDirName ?? "—"}\``],
				["解析出的 agent 目录", `\`${creds.agentDir ?? "—"}\`（${creds.agentDirResolvedVia ?? "—"}）`],
				["`auth.json` 是否存在", creds.authJsonExists ? "✅ 存在" : "❌ 不存在"],
				["是否解析为合法 JSON", creds.authJsonParsed === null ? "—" : creds.authJsonParsed ? "✅ 是" : "❌ 否"],
				["provider 数量", String(creds.providerCount)],
				["provider 名称", creds.providers.length > 0 ? creds.providers.map((p) => `\`${p}\``).join("、") : "无"],
				["配置根目录是否存在", creds.configRootExists ? "✅" : "❌"],
				["配置根下的条目名", creds.configRootEntries.map((e) => `\`${e}\``).join("、") || "—"],
				["⇒ `spike:live` 是否可跑", creds.liveRunnable ? "✅ **可跑**（会真实消耗额度）" : "❌ **跑不起来**"],
			],
		),
	);
	L.push("");
	L.push("各 provider 下出现的**字段名**（只有字段名，没有值）：");
	L.push("");
	L.push(
		table(
			["provider", "字段名"],
			Object.entries(creds.providerFieldNames).map(([p, names]) => [`\`${p}\``, names.map((n) => `\`${n}\``).join("、")]),
		),
	);
	L.push("");
	L.push(`**判定**：${creds.liveRunnableReason}`);
	L.push("");

	L.push("## 6. 未验证项与边界（offline 说不清的，都在这里）");
	L.push("");
	L.push(
		bulletList([
			"**Electron 主进程 ESM**：本套件只验 Node 侧 `import`，不启动 Electron。该约束的实测物是 `spike/electron-window/main.mjs`。",
			"**`on(\"tool_call\")` 运行期是否真的返回注销函数**：源码 src 声明返回 `() => void`（F8），但**安装到本机的是旧 dist（声明 `void`）**。运行期行为列入 `spike:live` 的观察项（登记为 F8-live），本报告不给结论。",
			"**`reason` 回灌后模型的行为**：源码已证明 reason 成为一条 `isError: true` 的 tool result（F9），但「模型看到 error 结果会换姿势还是原样重试」属模型行为，必须 live。",
			"**`terminate` 的整批聚合在真实模型下的表现**：源码规则确定（F10），但同批工具是否真的全部带 terminate、以及传播与否的差别，需 live。",
			"**`navigateTree` 忙时的拒绝形态**：源码为 `async` 方法体内 `throw`（F6）⇒ 必然是 rejected Promise；但「是否同步 throw」在源码层面已可否证（async 体内 throw 不会同步抛出），运行期再确认一次。",
			"**闸门对「工具内部再起会话」的覆盖**：官方 subagent 示例是独立进程（F20），属源码级证据；**同进程内嵌套 `createAgentSession`** 的情形需 live 实测（live Q5）。",
			"**模型/网络类风险**：本套件不测真实模型输出质量、不测 token 成本、不测网络中断重试。",
		]),
	);
	L.push("");

	if (errors.length > 0) {
		L.push("## 7. 运行期异常（本次跑出来的）");
		L.push("");
		L.push(bulletList(errors.map((e) => `\`${e}\``)));
		L.push("");
	}

	return L.join("\n");
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
	ensureDir(OUT_DIR);

	log("== minipi · Pi SDK spike（offline）==");
	const env = envSection();
	log(`Node ${env.node}（engines ${env.nodeEngineRequirement}，满足：${env.nodeEngineOk}）`);
	log(`安装到的 SDK 版本：${env.installedPackageVersion ?? "未安装"}`);

	const { section: esm, mod } = await esmSection();
	log(`[A] import: ${esm.dynamicImport.ok ? "成功" : "失败"}　require: ${esm.requireAttempt.ok ? "成功（意外）" : `失败 ${esm.requireAttempt.errorCode}`}`);

	const exports_ = exportSection(mod);
	log(`[B] 运行时导出缺失 ${exports_.runtimeMissing.length} 个`);

	log("[C] 静态核对…");
	const statics = runStaticScan();
	log(`    命中 ${statics.summary.confirmed}/${statics.summary.total}；部分 ${statics.summary.partial}；未命中 ${statics.summary.notFound}`);

	const creds = credentialSection(mod);
	log(`[D] auth.json ${creds.authJsonExists ? "存在" : "不存在"}；provider ${creds.providerCount} 个：${creds.providers.join("、") || "无"}`);
	log(`    ⇒ spike:live ${creds.liveRunnable ? "可跑" : "跑不起来"}`);

	const report = {
		kind: "pi-sdk-offline",
		generatedAt: env.time,
		env,
		esm,
		exports: exports_,
		staticScan: statics,
		credentials: creds,
		errors,
		liveRunnable: creds.liveRunnable,
	};

	const md = buildMarkdown({ env, esm, exports_, statics, creds });
	const { jsonPath, mdPath } = writeReports("pi-sdk-offline", report, md);

	log("");
	log("== 结论 ==");
	log(`B1 ESM：${esm.conclusion}`);
	log(`B2 导出面：${exports_.conclusion}`);
	log(`B3 静态核对：${statics.summary.confirmed}/${statics.summary.total} 完全命中，${statics.summary.partial} 部分命中，${statics.summary.notFound} 未命中`);
	log(`B4 凭证：${creds.liveRunnableReason}`);
	log("");
	log(`报告：\n  ${redact(mdPath)}\n  ${redact(jsonPath)}`);

	if (errors.length > 0) {
		log("");
		log(`⚠️ 运行期异常 ${errors.length} 条：`);
		for (const e of errors) log(`  - ${e}`);
	}

	process.exitCode = 0;
}

main().catch((err) => {
	process.stderr.write(`offline spike 崩了：${err?.stack ?? err}\n`);
	process.exitCode = 1;
});
