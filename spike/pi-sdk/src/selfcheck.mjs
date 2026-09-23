/**
 * 套件自检（不依赖 Pi SDK，不需要安装依赖）。
 *
 * 检查两件事：
 *   ① 工程约定：package.json 的 type/engines/pin、两个入口、.gitignore；
 *   ② 这套件自己是否守规矩：ESM 纯度、**不掺隐私**、live 默认不执行、offline 不可能调模型。
 *
 * 用法：npm run selfcheck
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(KIT_ROOT, "src");

const results = [];
function check(id, ok, detail) {
	results.push({ id, ok: ok === true ? "pass" : ok === "warn" ? "warn" : "fail", detail });
}

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "out") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

const kitFiles = walk(KIT_ROOT).filter((f) => !f.endsWith("package-lock.json"));
const mjsFiles = kitFiles.filter((f) => f.endsWith(".mjs"));

// --- ① 工程约定 -----------------------------------------------------------
{
	const pkg = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8"));
	check("pkg.type=module", pkg.type === "module", `type = ${pkg.type}`);
	check("pkg.engines.node>=22.19.0", pkg.engines?.node === ">=22.19.0", `engines.node = ${pkg.engines?.node}`);
	const dep = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
	check("SDK 精确 pin 到 0.87.0", dep === "0.87.0", `dependency = ${dep}`);
	check("有 spike:offline 入口", typeof pkg.scripts?.["spike:offline"] === "string", `= ${pkg.scripts?.["spike:offline"]}`);
	check("有 spike:live 入口", typeof pkg.scripts?.["spike:live"] === "string", `= ${pkg.scripts?.["spike:live"]}`);

	const gi = fs.existsSync(path.join(KIT_ROOT, ".gitignore")) ? fs.readFileSync(path.join(KIT_ROOT, ".gitignore"), "utf8") : "";
	check(".gitignore 忽略 out/", /^out\/$/m.test(gi), gi.trim().split(/\r?\n/).join(" / ") || "(空)");
	check(".gitignore 忽略 node_modules/", /^node_modules\/$/m.test(gi));
}

// --- ② ESM 纯度 + 语法 ----------------------------------------------------
for (const f of mjsFiles) {
	const rel = path.relative(KIT_ROOT, f);
	const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
	check(`语法：${rel}`, r.status === 0, r.status === 0 ? "node --check 通过" : (r.stderr || r.stdout || "").trim().slice(0, 200));
}

{
	const bad = [];
	for (const f of mjsFiles) {
		const rel = path.relative(KIT_ROOT, f);
		// 自检脚本自己含这些模式的字面量（它就是在检查它们），跳过自身，避免自指误报
		if (rel.endsWith("selfcheck.mjs")) continue;
		const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			const trimmed = l.trim();
			const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
			// 粗粒度剥掉字符串字面量与行尾注释（不追求完美解析，只为了避免「字符串里提到 require()」被误报）
			const codeOnly = l
				.replace(/`(?:[^`\\]|\\.)*`/g, "``")
				.replace(/"(?:[^"\\]|\\.)*"/g, '""')
				.replace(/'(?:[^'\\]|\\.)*'/g, "''")
				.replace(/(^|[^:])\/\/.*$/, "$1");
			if (/\bmodule\.exports\b/.test(codeOnly)) bad.push(`${rel}:${i + 1} module.exports`);
			if (/\b__dirname\b|\b__filename\b/.test(codeOnly)) bad.push(`${rel}:${i + 1} __dirname/__filename`);
			// require( 只允许两种情形：注释里提到它（本套件就是在验 require(esm) 行为），
			// 或与 createRequire 同一行（这是获取 require 的合法方式）
			if (/\brequire\s*\(/.test(codeOnly) && !isComment && !/createRequire/.test(codeOnly)) {
				bad.push(`${rel}:${i + 1} 裸 require(`);
			}
		}
	}
	check("ESM 纯度（无 module.exports / __dirname / 裸 require）", bad.length === 0, bad.join("；") || "干净");
}

// --- ② 隐私：套件自己的文件里不得有真实路径/凭证 ----------------------------
{
	const home = os.homedir();
	const repo = path.resolve(KIT_ROOT, "..", "..");
	const offenders = [];
	const secretRe = /(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
	for (const f of kitFiles) {
		if (f.endsWith(".json") && f.includes("out")) continue;
		const t = fs.readFileSync(f, "utf8");
		const rel = path.relative(KIT_ROOT, f);
		const homeEsc = home.replace(/\\/g, "\\\\");
		if (t.includes(home) || t.includes(homeEsc)) offenders.push(`${rel}: 出现用户主目录绝对路径`);
		if (t.includes(repo.replace(/\\/g, "\\\\")) && !rel.endsWith("selfcheck.mjs")) offenders.push(`${rel}: 出现仓库绝对路径`);
		if (secretRe.test(t)) offenders.push(`${rel}: 疑似凭证串`);
		if (/[\w.+-]+@(?!example\.invalid|example\.com)[\w-]+\.[A-Za-z]{2,}/.test(t) === true && /邮箱|email/i.test(t)) {
			// 只在明确谈邮箱的地方才报，避免误伤
			const m = t.match(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g) ?? [];
			for (const a of m) if (!/example\.(invalid|com)/.test(a)) offenders.push(`${rel}: 疑似真实邮箱 ${a}`);
		}
	}
	check("无本机绝对路径 / 无凭证 / 无真实邮箱", offenders.length === 0, offenders.join("；") || "干净");
}

// --- ② live 默认不执行 + offline 不可能调模型 -----------------------------
{
	const live = fs.readFileSync(path.join(SRC_DIR, "live.mjs"), "utf8");
	check("live.mjs 有 --run 门禁", /if \(!args\.run\) \{[\s\S]{0,200}?printPlan/.test(live), "不带 --run 时只打印计划");
	check("live.mjs 有环境变量二次确认", live.includes("MINIPI_SPIKE_LIVE_CONFIRM"), "需 MINIPI_SPIKE_LIVE_CONFIRM=1");
	check("live.mjs 有模型调用计数上限", /maxModelCalls/.test(live) && /countModelCall/.test(live), "--max-model-calls（默认 10）");

	const offline = fs.readFileSync(path.join(SRC_DIR, "offline.mjs"), "utf8");
	const forbidden = [
		["ModelRuntime.create(", /ModelRuntime\.create\(/],
		["session.prompt(", /\.prompt\(/],
		["createAgentSession(", /createAgentSession\(/],
		["fetch(", /\bfetch\(/],
	];
	const hits = forbidden.filter(([, re]) => re.test(offline)).map(([n]) => n);
	check("offline.mjs 不可能调模型（无 ModelRuntime.create / prompt / createAgentSession / fetch）", hits.length === 0, hits.join("；") || "干净");
}

// --- 输出 -----------------------------------------------------------------
const failed = results.filter((r) => r.ok === "fail");
const warned = results.filter((r) => r.ok === "warn");
process.stdout.write(`minipi · pi-sdk spike 自检：${results.length} 项，失败 ${failed.length}，警告 ${warned.length}\n`);
for (const r of results) {
	const icon = r.ok === "pass" ? "✓" : r.ok === "warn" ? "!" : "✗";
	process.stdout.write(`  ${icon} ${r.id}${r.detail ? ` — ${r.detail}` : ""}\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
