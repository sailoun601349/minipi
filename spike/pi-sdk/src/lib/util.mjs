/**
 * 共用工具：脱敏、落盘、行扫描。
 *
 * 隐私硬约束（见 README §6）：
 * 本套件写出的任何报告都不得包含本机绝对路径、真实用户名、邮箱、凭证。
 * 所有字符串在写盘前一律过 `redact()`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本套件根目录（spike/pi-sdk），已是绝对路径，仅内部使用。 */
export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 仓库根（minipi/），仅内部用于脱敏。 */
export const REPO_ROOT = path.resolve(KIT_ROOT, "..", "..");

/** 输出目录与临时工作目录（都在 out/ 下，已被 .gitignore 忽略）。 */
export const OUT_DIR = path.join(KIT_ROOT, "out");
export const SCRATCH_DIR = path.join(OUT_DIR, "scratch");

/** 依赖包里我们真正要核对的那份源码（只读参考，绝不修改）。 */
export const VENDOR_AGENT_DIR = path.join(REPO_ROOT, "vendor", "pi", "packages", "coding-agent");
export const VENDOR_SRC_DIR = path.join(VENDOR_AGENT_DIR, "src");
export const VENDOR_DIST_DIR = path.join(VENDOR_AGENT_DIR, "dist");
export const VENDOR_AGENT_CORE_SRC = path.join(REPO_ROOT, "vendor", "pi", "packages", "agent", "src");

/** 与 vendor/pi 一致的 pin 版本。 */
export const PI_PINNED_VERSION = "0.87.0";

const HOME = os.homedir();

/**
 * 脱敏。顺序很重要：先长后短，避免 Home 是 Repo 前缀时被截断。
 * 例：C:\Users\<user>\... -> ~\...
 */
export function redact(value) {
	if (typeof value !== "string") return value;
	let out = value;
	const pairs = [
		[HOME, "~"],
		[REPO_ROOT, "<repo>"],
		[KIT_ROOT, "<kit>"],
		[HOME.replace(/\\/g, "/"), "~"],
		[REPO_ROOT.replace(/\\/g, "/"), "<repo>"],
		[KIT_ROOT.replace(/\\/g, "/"), "<kit>"],
	];
	for (const [from, to] of pairs) {
		if (!from) continue;
		out = out.split(from).join(to);
	}
	return out;
}

/** 深拷贝 + 递归脱敏，用于写盘前的最后一道闸。 */
export function redactDeep(value) {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
		return out;
	}
	return value;
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 读文本文件，失败返回 null（不抛）。 */
export function readTextSafe(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

export function readJsonSafe(file) {
	const text = readTextSafe(file);
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return undefined; // 存在但解析失败
	}
}

/** 按行扫描一个文件，返回命中行（1 基行号）。 */
export function scanFileLines(file, regex) {
	const text = readTextSafe(file);
	if (text === null) return { exists: false, hits: [] };
	const lines = text.split(/\r?\n/);
	const hits = [];
	for (let i = 0; i < lines.length; i++) {
		regex.lastIndex = 0;
		if (regex.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
	}
	return { exists: true, hits };
}

/** 把命中行整理成 "文件相对路径:行号" 形式（相对仓库根，便于写进文档）。 */
export function relFromRepo(absPath) {
	return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立；超时返回 false。 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await sleep(intervalMs);
	}
	return false;
}

/** 截断长文本，避免报告膨胀。 */
export function clip(value, max = 400) {
	if (typeof value !== "string") return value;
	return value.length <= max ? value : `${value.slice(0, max)}…<截断 ${value.length - max} 字符>`;
}

/** ISO 时间戳，报告里只用这个，不含时区隐私问题。 */
export function nowIso() {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 报告落盘
// ---------------------------------------------------------------------------

function writeJson(file, obj) {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(redactDeep(obj), null, 2)}\n`, "utf8");
}

function writeText(file, text) {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, redact(text), "utf8");
}

/**
 * 同时落一份机器可读 JSON 与一份人读 Markdown。
 * `slug` 例如 "pi-sdk-offline"。
 */
export function writeReports(slug, report, markdown) {
	const jsonPath = path.join(OUT_DIR, `${slug}-report.json`);
	const mdPath = path.join(OUT_DIR, `${slug}-report.md`);
	writeJson(jsonPath, report);
	writeText(mdPath, markdown);
	return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Markdown 拼装小工具
// ---------------------------------------------------------------------------

const VERDICT_ICON = {
	pass: "✅ 通过",
	fail: "❌ 不通过",
	partial: "⚠️ 部分符合",
	undecidable: "🤔 不可判定",
	notrun: "⏸️ 未执行",
	info: "ℹ️ 信息",
};

export function verdictLabel(verdict) {
	return VERDICT_ICON[verdict] ?? verdict;
}

/** 把单元格里的换行/竖线弄干净，避免破坏 Markdown 表格。 */
export function cell(value) {
	if (value === null || value === undefined) return "—";
	return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function table(headers, rows) {
	const head = `| ${headers.join(" | ")} |`;
	const sep = `|${headers.map(() => "---").join("|")}|`;
	const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
	return `${head}\n${sep}\n${body}`;
}

export function bulletList(items) {
	return items.map((i) => `- ${i}`).join("\n");
}
