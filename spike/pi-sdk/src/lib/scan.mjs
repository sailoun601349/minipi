/**
 * 静态核对执行器：把 STATIC_FACTS 里的探针在 vendor/pi 源码上跑一遍。
 *
 * 诚实性设计：探针先按「原样正则」匹配；若失败，再用「缩进放宽」的等价正则重试，
 * 并在结果里标出匹配模式（exact / relaxedIndent）。绝不用放宽后的结果冒充逐字命中。
 */

import { STATIC_FACTS } from "./static-facts.mjs";
import { readTextSafe, relFromRepo } from "./util.mjs";

/** 把正则里的 \t 统统放宽成 \s*，用于「只关心行内容、不关心缩进」的兜底匹配。 */
function relaxIndent(regex) {
	const src = regex.source.replace(/\\t/g, "\\s*");
	const flags = regex.flags.replace(/[gy]/g, "");
	return new RegExp(src, flags);
}

function probeFile(file, regex, expectLine) {
	const text = readTextSafe(file);
	if (text === null) {
		return { file, fileExists: false, matched: false, mode: null, line: null, expectLine, lineDelta: null, text: null };
	}
	const lines = text.split(/\r?\n/);

	// 第一轮：原样
	for (let i = 0; i < lines.length; i++) {
		const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ""));
		if (re.test(lines[i])) {
			return {
				file,
				fileExists: true,
				matched: true,
				mode: "exact",
				line: i + 1,
				expectLine: expectLine ?? null,
				lineDelta: expectLine ? i + 1 - expectLine : null,
				text: lines[i].trim(),
			};
		}
	}

	// 第二轮：放宽缩进
	const relaxed = relaxIndent(regex);
	for (let i = 0; i < lines.length; i++) {
		if (relaxed.test(lines[i])) {
			return {
				file,
				fileExists: true,
				matched: true,
				mode: "relaxedIndent",
				line: i + 1,
				expectLine: expectLine ?? null,
				lineDelta: expectLine ? i + 1 - expectLine : null,
				text: lines[i].trim(),
			};
		}
	}

	return { file, fileExists: true, matched: false, mode: null, line: null, expectLine: expectLine ?? null, lineDelta: null, text: null };
}

function checkNegativeRegion(region) {
	const text = readTextSafe(region.file);
	if (text === null) {
		return { ...region, fileExists: false, violated: false, hits: [] };
	}
	const lines = text.split(/\r?\n/);
	const hits = [];
	for (let i = region.fromLine - 1; i < Math.min(region.toLine, lines.length); i++) {
		const re = new RegExp(region.regex.source, region.regex.flags.replace(/[gy]/g, ""));
		if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
	}
	return { ...region, fileExists: true, violated: hits.length > 0, hits };
}

/**
 * 运行全部静态核对。
 * @returns {{ facts: Array, summary: object }}
 */
export function runStaticScan() {
	const facts = [];

	for (const fact of STATIC_FACTS) {
		const probes = fact.probes.map((p) => {
			const r = probeFile(p.file, p.regex, p.expectLine);
			return {
				file: relFromRepo(p.file),
				matched: r.matched,
				matchMode: r.mode,
				line: r.line,
				expectLine: r.expectLine,
				lineDelta: r.lineDelta,
				matchedText: r.text,
				optional: Boolean(p.optional),
			};
		});

		const required = probes.filter((p) => !p.optional);
		const matchedRequired = required.filter((p) => p.matched);
		const missing = required.filter((p) => !p.matched);

		let verdict = "not_found";
		if (missing.length === 0) verdict = "confirmed";
		else if (matchedRequired.length > 0) verdict = "partial";

		const drifted = probes.filter((p) => p.matched && p.expectLine && p.line !== p.expectLine);
		const relaxedOnly = probes.filter((p) => p.matched && p.matchMode === "relaxedIndent");

		const negatives = (fact.negativeRegions ?? []).map((region) => {
			const r = checkNegativeRegion(region);
			return {
				file: relFromRepo(region.file),
				fromLine: region.fromLine,
				toLine: region.toLine,
				note: region.note,
				violated: r.violated,
				hits: r.hits,
			};
		});

		facts.push({
			id: fact.id,
			question: fact.question,
			docClaim: fact.docClaim,
			verdict,
			conclusion: fact.conclusion,
			probes,
			missingProbes: missing.length,
			matchedProbes: `${matchedRequired.length}/${required.length}`,
			lineDrift: drifted.map((p) => ({
				file: p.file,
				matchedText: p.matchedText,
				actualLine: p.line,
				docExpectedLine: p.expectLine,
				delta: p.lineDelta,
			})),
			relaxedIndentOnly: relaxedOnly.map((p) => ({ file: p.file, line: p.line, matchedText: p.matchedText })),
			negativeRegions: negatives,
		});
	}

	const summary = {
		total: facts.length,
		confirmed: facts.filter((f) => f.verdict === "confirmed").length,
		partial: facts.filter((f) => f.verdict === "partial").length,
		notFound: facts.filter((f) => f.verdict === "not_found").length,
		withLineDrift: facts.filter((f) => f.lineDrift.length > 0).length,
		withRelaxedOnly: facts.filter((f) => f.relaxedIndentOnly.length > 0).length,
		negativeViolations: facts.filter((f) => f.negativeRegions.some((n) => n.violated)).length,
	};

	return { facts, summary };
}
