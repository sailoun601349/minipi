#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
const checks = [];
function check(label, ok) { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${label}`); }
check("mini 产出按钮存在", /id="btnOutcome"/.test(html));
check("full 产出按钮存在", /id="btnOutcomeFull"/.test(html));
check("产出编辑面板存在", /id="outcomeComposer"/.test(html));
check("intent 输入限制 2000 字", /id="outcomeIntent"[^>]*maxlength="2000"/.test(html));
check("支持 docx 与 md", /data-outcome-format="docx"/.test(html) && /data-outcome-format="md"/.test(html));
check("调用 generateOutcome", /host\.generateOutcome\(\{ sessionId: store\.session\.sessionId, intent, format \}\)/.test(html));
check("流式期间禁用产出", /store\.streaming/.test(html) && /正在回答，请等本轮结束/.test(html));
check("最近用户问题预填", /function latestUserText\(\)/.test(html));
check("真实成功路径关闭面板", /await host\.generateOutcome[\s\S]{0,300}closeOutcomeComposer\(\)/.test(html));
console.log(`qa:outcome-entry: ${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
