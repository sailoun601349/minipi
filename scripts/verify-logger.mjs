#!/usr/bin/env node
/**
 * 主进程日志（`src/main/logger.js`）门禁 —— 纯 Node，不需要 Electron / Chrome。
 *
 * ## 守的是什么（这是发布阻断级缺陷的回归门）
 *
 * 打包后的客户版**曾经完全没有日志**：`index.js` 用 `console`，开发期靠
 * `scripts/launch.mjs` 接走 stdout；打包后没有启动器、Windows GUI 程序没有控制台，
 * 输出被系统丢弃。客户报「双击没反应」时我们手上零信息。
 * 所以这个门禁守的第一件事不是"格式好看"，而是 **日志真的落到盘上**。
 *
 * ## 为什么所有写入都放到**子进程**里跑
 *
 * 读实现时发现两个硬耦合（不是猜的，是探测确认的）：
 *
 *   1. `rotateIfNeeded()` 判断/操作的对象是**模块级 `MAIN_LOG_FILE`**
 *      （`path.join(os.homedir(), ".minipi", "logs", "main.log")`），
 *      **不是** `createLogger({ file })` 传进来的那个路径。
 *      也就是说：哪怕你只想往 `%TEMP%/x.log` 写一行，它也会先去 stat 用户的
 *      真实 `~/.minipi/logs/main.log`，一旦那个文件超过 1MB 就**真的把它改名**。
 *      ⇒ 在本进程里做测试，等于拿用户的真实日志目录当试验台。
 *   2. `rotated` 是**模块级**变量，每进程只轮转一次。同进程内测第二次轮转必然失败，
 *      而且失败的原因是"实现如此"，不是"实现错了"——这种假红最浪费人时间。
 *
 * 两个问题一起解决：每个场景起一个**独立子进程**，`USERPROFILE` / `HOME` 指向
 * 一次性临时目录 ⇒ `os.homedir()` 变了 ⇒ `MAIN_LOG_FILE` 落在临时目录里 ⇒
 * 用户真实目录**一次都不被写、也不被 stat 到轮转**；同时每个场景天然拿到干净的
 * `rotated = false`。主进程只做两件事：**只读快照**真实日志目录、编排子进程、汇总断言。
 *
 * ## 纪律
 *
 *   1. 每条断言独立：一条红了后面的照跑（不是 `&&` 串起来的那种）。
 *   2. 没测到记 `null`（SKIP），不记 true。
 *   3. 只写测试，不改 `src/**`。`logger.js` 只读。
 *
 * 用法：`node scripts/verify-logger.mjs`（退出码 0 = 全绿；`KEEP_TMP=1` 保留临时目录）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGGER_SRC = path.join(ROOT, "src", "main", "logger.js");
const LOGGER_URL = pathToFileURL(LOGGER_SRC).href;
const KEEP_TMP = process.env.KEEP_TMP === "1";

/** 真实用户日志目录 —— **只读**，任何测试都不许往里写。 */
const REAL_LOG_DIR = path.join(os.homedir(), ".minipi", "logs");

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skipped = [];

/**
 * 单条断言。`cond` 允许 `undefined`/`null` 表示"没测到"⇒ 记 SKIP。
 *
 * `detail` 一律截断到 160 字：轮转组的 detail 里可能带着 1MB 的旧内容，
 * 整段打出来会把终端和 CI 日志刷爆（第一版就踩了 —— M6 变异时吐了 1MB）。
 * @param {string} label
 * @param {boolean|null|undefined} cond
 * @param {string} [detail]
 */
function chk(label, cond, detail) {
  const d = typeof detail === "string" && detail.length > 160 ? `${detail.slice(0, 160)}…（共 ${detail.length} 字，已截断）` : detail;
  if (cond === null || cond === undefined) {
    skip += 1;
    skipped.push(label);
    console.log(`  SKIP  ${label}${d === undefined ? "" : `  · ${d}`}  [null]`);
    return;
  }
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${d === undefined ? "" : `  · ${d}`}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${d === undefined ? "" : `  · ${d}`}`);
  }
}

console.log("=".repeat(78));
console.log(" 主进程日志门禁：落盘 / 级别 / 时间戳 / 轮转 / 不抛错 / 镜像 / tag");
console.log("=".repeat(78));

/* ---------------------------------------------------------------- 真实目录只读快照 */
function realSnapshot() {
  try {
    if (!fs.existsSync(REAL_LOG_DIR)) return { exists: false, names: [] };
    return {
      exists: true,
      names: fs
        .readdirSync(REAL_LOG_DIR)
        .sort()
        .map((n) => {
          const st = fs.statSync(path.join(REAL_LOG_DIR, n));
          return `${n}:${st.size}`;
        }),
    };
  } catch {
    return { exists: null, names: [] };
  }
}
const realBefore = realSnapshot();

/* ---------------------------------------------------------------- 子进程 runner */
/**
 * Runner 源码。写成文件再跑（比 `-e` 好调试，也不受引号层数限制）。
 *
 * 为什么结果写**文件**而不是 stdout：`mirrorToConsole` 那组断言要看 stdout 是否被污染，
 * 如果结果也走 stdout，就分不清"日志镜像写出来的"和"runner 自己吐出来的"。
 * stdout 全部留给被测代码，结果另走 `OUT` 文件。
 */
const RUNNER_SRC = `
import fs from "node:fs";
import path from "node:path";

const { createLogger, MAIN_LOG_FILE } = await import(process.env.LOGGER_URL);

const scene = process.env.SCENE;
const out = process.env.OUT;
const work = process.env.WORK;
const result = { scene, ok: true, data: {}, error: null };
const rec = (k, v) => { result.data[k] = v; };

/* 每个场景都记下 MAIN_LOG_FILE 的解析结果 —— 主进程据此断言"沙箱真的隔离了"。
   没有这一条，隔离失败（USERPROFILE 没生效）时测试会静默地拿用户真实日志当试验台。 */
rec("mainLogFile", MAIN_LOG_FILE);
rec("home", process.env.USERPROFILE);

try {
  switch (scene) {
    /* ---- 落盘 / 四级别 / 时间戳 / 多参数 / Error ---- */
    case "basic": {
      const file = path.join(work, "basic.log");
      const log = createLogger({ file, mirrorToConsole: false });
      log.info("hello", 1, { x: 1 });
      log.warn("warnline");
      log.error(new Error("boom"));
      log.debug("dbgline");
      const text = fs.readFileSync(file, "utf8");
      const allLines = text.split("\\n").filter((l) => l.length > 0);
      /* "以时间戳开头的行"= 一条日志的**逻辑首行**。Error 的 stack 会展开成多行物理行，
         所以不能直接拿 allLines 当"条数"。 */
      const LOG_LINE = /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} /;
      const entryStarts = allLines.filter((l) => LOG_LINE.test(l));
      rec("text", text);
      rec("allLines", allLines);
      rec("entryStarts", entryStarts);
      rec("logFileField", log.file);
      rec("sentFile", file);
      rec("keys", Object.keys(log).sort());
      const now = new Date();
      rec("localHour", now.getHours());
      rec("utcHour", now.getUTCHours());
      rec("offsetMin", now.getTimezoneOffset());
      break;
    }

    /* ---- tag 默认空 / 显式 tag ---- */
    case "tag": {
      const def = path.join(work, "tag-default.log");
      const tagged = path.join(work, "tag-x.log");
      createLogger({ file: def, mirrorToConsole: false }).info("[minipi] 启动中");
      createLogger({ file: tagged, mirrorToConsole: false, tag: "x" }).info("hi");
      rec("defText", fs.readFileSync(def, "utf8"));
      rec("taggedText", fs.readFileSync(tagged, "utf8"));
      break;
    }

    /* ---- 轮转：预置 >1MB，再写一条 ---- */
    case "rotate": {
      const BIG = 1024 * 1024 + 100; // 1MB + 100 字节，刚过阈值
      fs.mkdirSync(path.dirname(MAIN_LOG_FILE), { recursive: true });
      fs.writeFileSync(MAIN_LOG_FILE, "x".repeat(BIG));
      const log = createLogger({ mirrorToConsole: false }); // 默认 file = MAIN_LOG_FILE
      log.info("after-rotate");
      const oldPath = MAIN_LOG_FILE + ".old";
      rec("mainLogFile", MAIN_LOG_FILE);
      rec("big", BIG);
      rec("oldExists", fs.existsSync(oldPath));
      rec("oldSize", fs.existsSync(oldPath) ? fs.statSync(oldPath).size : -1);
      rec("newSize", fs.existsSync(MAIN_LOG_FILE) ? fs.statSync(MAIN_LOG_FILE).size : -1);
      rec("newText", fs.existsSync(MAIN_LOG_FILE) ? fs.readFileSync(MAIN_LOG_FILE, "utf8") : "");
      break;
    }

    /* ---- ★ 回归：自定义 file 不得误伤默认路径（2026-10-23 队长修的真 bug） ----
     * 背景：第一版 rotateIfNeeded() 判的是模块级 MAIN_LOG_FILE，不看 opts.file。
     * 于是「传自定义 file」的调用会去轮转**默认的** main.log ——
     * 测试里以为写临时文件，实际把真实用户日志挤成 .old。修法：rotatedFiles Set +
     * path.resolve 归一。
     *
     * 这个场景精确复刻当时的事故形态：在**沙箱的默认路径**预置 >1MB，
     * 然后用自定义 file 写一条。断言默认路径**一根汗毛都不能动**。 */
    case "cross-file": {
      const BIG = 1024 * 1024 + 100;
      const DEFAULT = MAIN_LOG_FILE; // 沙箱里的默认路径（不是真实用户目录）
      const CUSTOM = path.join(work, "custom-target.log");
      fs.mkdirSync(path.dirname(DEFAULT), { recursive: true });
      const defaultBody = "x".repeat(BIG);
      fs.writeFileSync(DEFAULT, defaultBody);
      const defaultBefore = fs.statSync(DEFAULT).size;

      const log = createLogger({ file: CUSTOM, mirrorToConsole: false });
      log.info("写进自定义文件");

      rec("defaultPath", DEFAULT);
      rec("customPath", CUSTOM);
      rec("big", BIG);
      rec("defaultBefore", defaultBefore);
      /* 三条硬事实：默认路径没被改名、内容一字不差、自定义文件收到了日志 */
      rec("defaultOldExists", fs.existsSync(DEFAULT + ".old"));
      rec("defaultStillThere", fs.existsSync(DEFAULT));
      rec(
        "defaultUnchanged",
        fs.existsSync(DEFAULT) ? fs.readFileSync(DEFAULT, "utf8") === defaultBody : false,
      );
      rec("defaultSizeAfter", fs.existsSync(DEFAULT) ? fs.statSync(DEFAULT).size : -1);
      rec("customExists", fs.existsSync(CUSTOM));
      rec("customText", fs.existsSync(CUSTOM) ? fs.readFileSync(CUSTOM, "utf8") : "");
      break;
    }

    /* ---- 同一进程两个不同 file 各自都能轮转（证明 Set 的语义是「每文件一次」，不是「每进程一次」） ---- */
    case "two-files": {
      const BIG = 1024 * 1024 + 100;
      const A = path.join(work, "a.log");
      const B = path.join(work, "b.log");
      fs.writeFileSync(A, "a".repeat(BIG));
      fs.writeFileSync(B, "b".repeat(BIG));
      /* 两个 logger 各自写一条：A 先触发轮转，B 也必须能触发 ——
         若实现退回「布尔 + 只认默认路径」，B 就不会轮转。 */
      createLogger({ file: A, mirrorToConsole: false }).info("to-A");
      createLogger({ file: B, mirrorToConsole: false }).info("to-B");
      rec("big", BIG);
      rec("aOldExists", fs.existsSync(A + ".old"));
      rec("bOldExists", fs.existsSync(B + ".old"));
      rec("aOldSize", fs.existsSync(A + ".old") ? fs.statSync(A + ".old").size : -1);
      rec("bOldSize", fs.existsSync(B + ".old") ? fs.statSync(B + ".old").size : -1);
      rec("aText", fs.existsSync(A) ? fs.readFileSync(A, "utf8") : "");
      rec("bText", fs.existsSync(B) ? fs.readFileSync(B, "utf8") : "");
      break;
    }

    /* ---- 路径归一同一个文件：相对写法与绝对路径不应算两个（否则会重复轮转） ---- */
    case "same-file-normalized": {
      const BIG = 1024 * 1024 + 100;
      const ABS = path.join(work, "norm.log");
      fs.writeFileSync(ABS, "n".repeat(BIG));
      /* 第一次用绝对路径写 → 触发轮转 */
      createLogger({ file: ABS, mirrorToConsole: false }).info("first-abs");
      const afterFirst = fs.existsSync(ABS + ".old") ? fs.statSync(ABS + ".old").size : -1;
      /* 第二次用**纯文件名**指向同一个文件 → 归一后应命中 Set，不再轮转。
         ⚠ 必须 chdir 到 work 再给 "norm.log"：
            第一版我用 path.relative(process.cwd(), ABS)，但 Windows 上**跨盘符**
            （D: 仓库 / C: 临时目录）时 path.relative 直接返回绝对路径，
            于是两次传的是同一个字符串 —— 这条断言就成了"自己跟自己比"，
            M8 变异（去掉 path.resolve）根本咬不中。这是变异验证帮我抓到的假绿。 */
      process.chdir(work);
      const REL = "norm.log";
      const resolveMatches = path.resolve(REL) === ABS;
      fs.appendFileSync(ABS, "m".repeat(BIG)); // 又撑大，制造可轮转状态
      const sizeBeforeSecond = fs.statSync(ABS).size;
      createLogger({ file: REL, mirrorToConsole: false }).info("second-rel");
      rec("big", BIG);
      rec("absPath", ABS);
      rec("relPath", REL);
      rec("resolveMatches", resolveMatches);
      rec("afterOldSize", afterFirst);
      rec("secondOldSize", fs.existsSync(ABS + ".old") ? fs.statSync(ABS + ".old").size : -1);
      rec("sizeBeforeSecond", sizeBeforeSecond);
      rec("finalSize", fs.existsSync(ABS) ? fs.statSync(ABS).size : -1);
      break;
    }

    /* ---- 每文件只轮转一次（钉 rotatedFiles 的「每文件」语义） ---- */
    case "rotate-twice": {
      const BIG = 1024 * 1024 + 100;
      fs.mkdirSync(path.dirname(MAIN_LOG_FILE), { recursive: true });
      fs.writeFileSync(MAIN_LOG_FILE, "x".repeat(BIG));
      const log = createLogger({ mirrorToConsole: false });
      log.info("first");
      const oldPath = MAIN_LOG_FILE + ".old";
      const oldSizeAfterFirst = fs.existsSync(oldPath) ? fs.statSync(oldPath).size : -1;
      /* 再把 main.log 弄回"超大"，模拟"很久之后同一个进程又写了很多" */
      fs.appendFileSync(MAIN_LOG_FILE, "y".repeat(BIG));
      const sizeBeforeSecond = fs.statSync(MAIN_LOG_FILE).size;
      log.info("second");
      rec("big", BIG);
      rec("oldSizeAfterFirst", oldSizeAfterFirst);
      rec("oldSizeAfterSecond", fs.existsSync(oldPath) ? fs.statSync(oldPath).size : -1);
      rec("sizeBeforeSecond", sizeBeforeSecond);
      rec("oldCount", fs.readdirSync(path.dirname(MAIN_LOG_FILE)).filter((n) => n === "main.log.old").length);
      rec("newText", fs.readFileSync(MAIN_LOG_FILE, "utf8"));
      break;
    }

    /* ---- ★ 绝不抛错：路径不可能写入 ---- */
    case "unwritable": {
      const blocker = path.join(work, "blocker.txt");
      fs.writeFileSync(blocker, "我是一个普通文件，不能当目录用");
      /* dirname 是这个普通文件 ⇒ mkdirSync/appendFileSync 必然 ENOTDIR */
      const badFile = path.join(blocker, "nested.log");
      const log = createLogger({ file: badFile, mirrorToConsole: false });
      const thrown = [];
      for (const lvl of ["info", "warn", "error", "debug"]) {
        try {
          log[lvl]("这一行写不进去 " + lvl);
        } catch (err) {
          thrown.push(lvl + " => " + (err && (err.code || err.message)));
        }
      }
      rec("thrown", thrown);
      rec("badFile", badFile);
      rec("badFileCreated", fs.existsSync(badFile));
      /* 写不进去之后，logger 仍要能返回可用对象（调用方不该被迫判空） */
      rec("stillCallable", typeof log.info === "function");
      break;
    }

    /* ---- 镜像开关：stdout 全部留给 logger，结果另走文件 ---- */
    case "mirror-off": {
      const file = path.join(work, "mirror-off.log");
      createLogger({ file, mirrorToConsole: false }).info("MIRROR_OFF_MARKER");
      rec("fileText", fs.readFileSync(file, "utf8"));
      break;
    }
    case "mirror-on": {
      const file = path.join(work, "mirror-on.log");
      createLogger({ file, mirrorToConsole: true }).info("MIRROR_ON_MARKER");
      rec("fileText", fs.readFileSync(file, "utf8"));
      break;
    }

    /* ---- 目录自动创建（默认路径首次使用时 logs/ 可能不存在） ---- */
    case "mkdir": {
      const deep = path.join(work, "a", "b", "c", "deep.log");
      createLogger({ file: deep, mirrorToConsole: false }).info("deep");
      rec("exists", fs.existsSync(deep));
      rec("text", fs.existsSync(deep) ? fs.readFileSync(deep, "utf8") : "");
      break;
    }

    default:
      throw new Error("未知场景：" + scene);
  }
} catch (err) {
  result.ok = false;
  result.error = String((err && err.stack) || err);
}

fs.writeFileSync(out, JSON.stringify(result), "utf8");
`;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "minipi-logger-gate-"));
const RUNNER_PATH = path.join(TMP_ROOT, "runner.mjs");
fs.writeFileSync(RUNNER_PATH, RUNNER_SRC, "utf8");

/**
 * 跑一个场景。每个场景独立：独立临时 home（决定 `MAIN_LOG_FILE`）+ 独立工作目录。
 * @returns {{data:object, ok:boolean, error:string|null, stdout:string, stderr:string, code:number|null, home:string, work:string}}
 */
function runScene(scene) {
  const sandbox = fs.mkdtempSync(path.join(TMP_ROOT, `${scene}-`));
  const home = path.join(sandbox, "home");
  const work = path.join(sandbox, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const outFile = path.join(sandbox, "result.json");

  const res = spawnSync(process.execPath, [RUNNER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      /* 让 os.homedir() 指向一次性目录 ⇒ MAIN_LOG_FILE 不再指向真实用户目录 */
      USERPROFILE: home,
      HOME: home,
      SCENE: scene,
      OUT: outFile,
      WORK: work,
      LOGGER_URL,
    },
  });

  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(outFile, "utf8"));
  } catch {
    payload = null;
  }
  return {
    data: payload?.data ?? {},
    ok: payload?.ok === true,
    error: payload?.error ?? null,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    code: res.status,
    home,
    work,
  };
}

/* ================================================================ A 落盘 */
console.log("\n[A] 落盘：日志真的写到文件里（本缺陷的核心）");
{
  const r = runScene("basic");
  const d = r.data;
  chk("子进程正常结束（场景本身没崩）", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk("★ 写 info 之后文件真的存在（打包版曾经零日志的根因）", typeof d.text === "string" && d.text.length > 0, `bytes=${(d.text || "").length}`);
  chk("文件内容含传入的文本", (d.text || "").includes("hello"));
  chk("createLogger 返回的 file 字段 = 传入的路径（调用方据此提示「日志在哪」）", d.logFileField === d.sentFile, String(d.logFileField));
  chk("返回对象有 info/warn/error/debug/log 五个方法", Array.isArray(d.keys) && ["debug", "error", "info", "log", "warn"].every((k) => d.keys.includes(k)), JSON.stringify(d.keys));
}

/* ================================================================ B 四个级别 */
console.log("\n[B] 四个级别：INFO / WARN / ERROR / DEBUG 各自标记正确");
{
  const r = runScene("basic");
  const starts = r.data.entryStarts || [];
  const has = (lvl) => starts.length > 0 && starts.some((l) => new RegExp(`\\s${lvl}\\s`).test(l));
  chk("INFO 行带 INFO 标记", has("INFO"), JSON.stringify(starts.slice(0, 1)));
  chk("WARN 行带 WARN 标记", has("WARN"), JSON.stringify(starts.filter((l) => l.includes("WARN"))));
  chk("ERROR 行带 ERROR 标记", has("ERROR"), JSON.stringify(starts.filter((l) => l.includes("ERROR")).slice(0, 1)));
  chk("DEBUG 行带 DEBUG 标记", has("DEBUG"), JSON.stringify(starts.filter((l) => l.includes("DEBUG"))));
  chk("★ 四条日志 = 四条逻辑记录（不能把 warn 写成 info 混进去）", starts.length === 4, `逻辑行数=${starts.length}`);
  /* ⚠ `[].every()` 恒真 —— 空数组上这条会假绿。所以必须显式带 `starts.length > 0`。
     这是 2026-10-23 变异 M2 抓出来的自身缺陷：时间戳一坏，entryStarts 变空，
     下面这类 every() 断言会集体"通过"，正好是最需要它们报警的时候。 */
  chk(
    "★ 级别字段宽度统一（padEnd(5)：便于纵向对齐与 grep）",
    starts.length > 0 && starts.every((l) => /^\S+ \S+ (INFO |WARN |ERROR|DEBUG) /.test(l)),
    JSON.stringify(starts.map((l) => l.slice(24, 31))),
  );
}

/* ================================================================ C 时间戳 */
console.log("\n[C] 时间戳格式（用正则卡死，不是「有数字就算」）");
{
  const r = runScene("basic");
  const starts = r.data.entryStarts || [];
  /* 精确到毫秒的本地时间格式。ISO/UTC 变体会在这里红。 */
  const RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /;
  chk("★ 每条逻辑记录都以 YYYY-MM-DD HH:MM:SS.mmm 开头", starts.length > 0 && starts.every((l) => RE.test(l)), JSON.stringify((starts[0] || "").slice(0, 26)));
  chk("★ 毫秒必须是 3 位（padStart(3,'0')，不能是 2 位或 4 位）", starts.length > 0 && starts.every((l) => /\.\d{3} /.test(l)), JSON.stringify((starts[0] || "").slice(19, 27)));
  /* 本地 vs UTC：本机是 UTC+8，两者小时不同 ⇒ 这条能真分辨"用了 UTC"。
     offset=0 的机器上两者相同，这条就分辨不了 ⇒ 记 null，不假装通过。 */
  const { localHour, utcHour, offsetMin } = r.data;
  if (offsetMin === 0) {
    chk("时间戳用的是本地时间（本机 UTC±0，无法分辨）", null, "本机 offset=0，本地与 UTC 同值，这条测不出来");
  } else {
    chk(
      "★ 时间戳用**本地时间**（客户说「下午三点」要对得上，UTC 只增加对表成本）",
      localHour !== utcHour && new RegExp(`^\\d{4}-\\d{2}-\\d{2} ${String(localHour).padStart(2, "0")}:`).test(starts[0] || ""),
      `本地 ${localHour} 时 / UTC ${utcHour} 时 / offset ${offsetMin} 分`,
    );
  }
}

/* ================================================================ D 多参数拼接 */
console.log("\n[D] 多参数：三个参数在同一行，对象要序列化");
{
  const r = runScene("basic");
  const first = (r.data.entryStarts || [])[0] || "";
  chk("★ 三个参数都在同一行（不能只取第一个）", first.includes("hello") && /\b1\b/.test(first) && first.includes("x"), first.slice(24));
  chk("★ 对象被 JSON 序列化（不出现 [object Object]）", first.includes('{"x":1}') && !first.includes("[object Object]"), first.slice(24));
  chk("参数之间用空格分隔（不是直接粘在一起）", /\bhello 1 \{/.test(first), first.slice(24));
}

/* ================================================================ E Error 对象 */
console.log("\n[E] Error 对象：要能看出是哪个错");
{
  const r = runScene("basic");
  const text = r.data.text || "";
  chk("★ Error 的 message 出现在日志里（不能写成 [object Error]）", text.includes("boom"));
  chk("Error 的 stack 被保留（排障要看调用栈，不能被截成一行）", /at\s|file:\/\//.test(text), `含 at 行=${/at\s|file:\/\//.test(text)}`);
  chk(
    "★ stack 多行时，后续物理行**不带**新时间戳（否则一条错误看起来像 N 条）",
    (r.data.entryStarts || []).filter((l) => l.includes("ERROR")).length === 1,
    `ERROR 逻辑行=${(r.data.entryStarts || []).filter((l) => l.includes("ERROR")).length}`,
  );}

/* ================================================================ F 轮转 */
console.log("\n[F] 轮转：>1MB 时 main.log → main.log.old，新文件只留新写的那条");
{
  const r = runScene("rotate");
  const d = r.data;
  chk("子进程正常结束（场景本身没崩）", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk("★ 旧文件被改名成 main.log.old", d.oldExists === true, `oldExists=${d.oldExists}`);
  chk("★ .old 里是**旧的**内容（大小 = 预置的 1MB+100）", d.oldSize === d.big, `oldSize=${d.oldSize} 期望=${d.big}`);
  chk("★ 新的 main.log 只剩新写的那条（不是继续追加在 1MB 后面）", typeof d.newText === "string" && d.newText.includes("after-rotate") && d.newText.length < 500, `newSize=${d.newSize}`);
  /* ⚠ 这条只该验「轮转后新写的那条格式仍然完整」，**不该**顺便验 tag ——
     否则 M4（tag 默认值）变异会让轮转组跟着红，掩盖真正的轮转问题。
     所以 tag 段用 `.*` 放过，只卡死「时间戳 + 级别 + 文本」三段。 */
  chk(
    "新文件里的那条仍是完整格式（时间戳 + 级别 + 文本，tag 段在此不判）",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO .*after-rotate\n$/.test(d.newText || ""),
    JSON.stringify(d.newText),
  );
  chk("只留一代（不产生 .old.1 / .old.2 这类堆积）", d.oldExists === true && (d.newText || "").length < 500);
}

/* ================================================================ G 每进程只轮转一次 */
console.log("\n[G] 轮转只做一次（钉实现里的模块级 rotated —— 这是**既定行为**，不是缺陷）");
{
  const r = runScene("rotate-twice");
  const d = r.data;
  chk("子进程正常结束", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk("第一次写入触发了轮转（.old 大小 = 1MB+100）", d.oldSizeAfterFirst === d.big, `oldSize=${d.oldSizeAfterFirst}`);
  chk(
    "★ 第二次写入**不再轮转**（rotated 每进程只置一次）—— 钉住真实行为，别让后人误以为漏了",
    d.oldSizeAfterSecond === d.oldSizeAfterFirst,
    `第二次后 .old=${d.oldSizeAfterSecond}（若变成 ${d.big} 说明每进程轮转了两次）`,
  );
  chk("第二次的内容仍被追加进 main.log（不轮转 ≠ 不写）", (d.newText || "").includes("second"));
  chk("始终只有一代 .old", d.oldCount === 1, `main.log.old 个数=${d.oldCount}`);
}

/* ================================================ G' ★ 自定义 file 不误伤默认路径 */
/**
 * 这一组是 **2026-10-23 队长修的真 bug 的回归守护**。
 *
 * 缺陷形态：第一版 `rotateIfNeeded()` 判的是模块级 `MAIN_LOG_FILE`，不看 `opts.file`。
 * 于是「传自定义 file」的调用会去轮转**默认的** `main.log` ——
 * 测试里以为写临时文件，实际把真实用户日志挤成 `.old`（就是我自己踩的那次）。
 *
 * ⚠ 这组断言的价值不在"现在是对的"，而在**它曾经错过**：
 *   任何把 `rotateIfNeeded(file)` 改回读模块常量、或把 `rotatedFiles` Set 退回布尔的人，
 *   都会在这里立刻撞红。光修不测，等于随时能回去。
 */
console.log("\n[G'] ★ 自定义 file 不误伤默认路径（2026-10-23 真 bug 的回归守护）");
{
  const r = runScene("cross-file");
  const d = r.data;
  chk("子进程正常结束（场景本身没崩）", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk(
    "★ 默认路径**没有**被改名成 .old（自定义 file 的写入不该触发它轮转）",
    d.defaultOldExists === false,
    `defaultPath=${d.defaultPath} · .old 存在=${d.defaultOldExists}`,
  );
  chk("默认路径的文件还在", d.defaultStillThere === true, `exists=${d.defaultStillThere}`);
  chk(
    "★ 默认路径内容**一字未改**（不是「只差几字节」，是逐字比对）",
    d.defaultUnchanged === true,
    `size=${d.defaultSizeAfter} 期望=${d.defaultBefore}`,
  );
  chk("自定义文件确实收到了那条日志（证明这次写入真的发生了，不是空跑）", (d.customText || "").includes("写进自定义文件"), JSON.stringify((d.customText || "").slice(24, 80)));
}

/* ================================================ G'' 两个不同 file 各自都能轮转 */
console.log("\n[G''] 同一进程两个不同 file 各自都能轮转（Set 的语义是「每文件一次」，不是「每进程一次」）");
{
  const r = runScene("two-files");
  const d = r.data;
  chk("子进程正常结束", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk("★ 第一个 file 触发了轮转", d.aOldExists === true && d.aOldSize === d.big, `a.old=${d.aOldSize} 期望=${d.big}`);
  chk(
    "★ 第二个 file **也**触发了轮转（若退回布尔+默认路径，这里必红）",
    d.bOldExists === true && d.bOldSize === d.big,
    `b.old=${d.bOldSize} 期望=${d.big}`,
  );
  chk("两个文件都只剩新写的那条", (d.aText || "").includes("to-A") && (d.aText || "").length < 500 && (d.bText || "").includes("to-B") && (d.bText || "").length < 500);
}

/* ================================================ G''' 路径归一：相对路径与绝对路径算同一个 */
console.log("\n[G'''] 路径归一：`path.resolve` 归一生效（相对/绝对指向同一文件时不该重复轮转）");
{
  const r = runScene("same-file-normalized");
  const d = r.data;
  chk("子进程正常结束", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk(
    "场景前提：`\"norm.log\"` 解析后确实指向同一个绝对路径（否则这条断言是自欺欺人）",
    d.resolveMatches === true,
    `resolve("${d.relPath}") == ${d.absPath} ? ${d.resolveMatches}`,
  );
  chk("第一次（绝对路径）触发了轮转", d.afterOldSize === d.big, `afterOld=${d.afterOldSize} 期望=${d.big}`);
  chk(
    "★ 第二次（纯文件名指向同一文件）**不再轮转** —— 证明 key 做了路径归一，不是按字符串比对",
    d.secondOldSize === d.afterOldSize,
    `第二次后 .old=${d.secondOldSize}（若 > ${d.big} 说明把同一文件当成了两个）`,
  );
  chk("第二次的内容仍被追加（不轮转 ≠ 不写）", d.finalSize > d.sizeBeforeSecond, `final=${d.finalSize} > before=${d.sizeBeforeSecond}`);
}

/* ================================================================ H ★ 绝不抛错 */
console.log("\n[H] ★ 绝不抛错：路径写不进去也必须继续跑（写日志把 App 搞崩是最蠢的故障）");
{
  const r = runScene("unwritable");
  const d = r.data;
  chk("子进程正常结束（不是靠崩溃「通过」的）", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk("★ 四个级别各写一条，**一条都没抛**", Array.isArray(d.thrown) && d.thrown.length === 0, `抛了=${JSON.stringify(d.thrown)}`);
  chk("确实没写出来（证明路径真的不可写，不是「恰好能写」）", d.badFileCreated === false, `badFileCreated=${d.badFileCreated}`);
  chk("写失败后 logger 仍返回可用对象（调用方不必判空）", d.stillCallable === true);
}

/* ================================================================ I 镜像开关 */
console.log("\n[I] 镜像开关：mirrorToConsole 真的能关掉 stdout 污染");
{
  /* 断言看的是**子进程 stdout**：结果走 JSON 文件，所以 stdout 里出现的任何字
     都只可能来自被镜像的日志 —— 这是唯一能真咬人的做法（在主进程里 monkey-patch
     console 只能证明「我们没调 console」，证明不了「stdout 干净」）。 */
  const off = runScene("mirror-off");
  const on = runScene("mirror-on");
  chk("mirrorToConsole:false ⇒ stdout 里没有日志文本", !off.stdout.includes("MIRROR_OFF_MARKER"), `stdout=${JSON.stringify(off.stdout.slice(0, 120))}`);
  chk("mirrorToConsole:false 时**仍然落盘**（关镜像不等于关日志）", (off.data.fileText || "").includes("MIRROR_OFF_MARKER"));
  chk("对照组：mirrorToConsole:true ⇒ stdout 里能看到（证明上面那条不是「永远看不到」）", on.stdout.includes("MIRROR_ON_MARKER"), `stdout=${JSON.stringify(on.stdout.slice(0, 120))}`);
  chk("两组都落盘（镜像只是附加，不是替代）", (on.data.fileText || "").includes("MIRROR_ON_MARKER") && (off.data.fileText || "").includes("MIRROR_OFF_MARKER"));
}

/* ================================================================ J tag 默认空 */
console.log("\n[J] tag：默认不加前缀（避免 [minipi] [minipi] 双前缀），显式传才加");
{
  const r = runScene("tag");
  const d = r.data;
  chk("子进程正常结束", r.ok, r.error ? String(r.error).slice(0, 200) : `exit=${r.code}`);
  chk(
    "★ 默认 tag 空 ⇒ 不出现双前缀 [minipi] [minipi]",
    !(d.defText || "").includes("[minipi] [minipi]"),
    JSON.stringify((d.defText || "").slice(24, 90)),
  );
  chk("默认 tag 空 ⇒ 调用点自带的 [minipi] 原样保留（只出现一次）", ((d.defText || "").match(/\[minipi\]/g) || []).length === 1, `出现次数=${((d.defText || "").match(/\[minipi\]/g) || []).length}`);
  chk("显式 tag:'x' ⇒ 行里出现 [x] 前缀", (d.taggedText || "").includes("[x] hi"), JSON.stringify((d.taggedText || "").slice(24, 90)));
}

/* ================================================================ K 目录自动创建 */
console.log("\n[K] 默认路径首次使用：logs/ 目录不存在时自己建（不能因目录缺失就丢日志）");
{
  const r = runScene("mkdir");
  chk("多层不存在的目录被自动创建并写入", r.data.exists === true && (r.data.text || "").includes("deep"), `exists=${r.data.exists}`);
}

/* ================================================================ L 安全网 */
console.log("\n[L] 安全网：测试没有碰真实用户日志目录");
{
  /* ★ 这两条是**隔离机制本身**的断言，比"前后快照一致"更早、更直接。
     血泪教训（2026-10-23 我本人踩的）：写这个脚本之前我手工探测时，
     用 `createLogger({file: tmp})` 以为写的是临时文件 —— 但 `rotateIfNeeded()`
     判的是模块级 `MAIN_LOG_FILE`，于是它把我**真实**的 `~/.minipi/logs/main.log`
     当成轮转对象：我预置的 1MB 填充数据被真 App 的启动轮转成了 `main.log.old`，
     把用户真实日志挤进了 `.old`。**测试脚本必须先证明自己的沙箱是真的。**
     所以这里不看快照，直接断言每个子进程解析出的 MAIN_LOG_FILE 都落在自己的沙箱里。
     ⚠ 顺序有意为之：先跑这几轮，**再**拍 after 快照 —— 这样它们造成的任何污染
     都会被下面的快照比对抓出来（若反过来，这几轮就在比对之后、无人看守）。 */
  const HOMES = ["basic", "rotate", "rotate-twice", "unwritable", "tag"].map((s) => ({ s, r: runScene(s) }));
  const escaped = HOMES.filter(({ r }) => {
    const p = String(r.data.mainLogFile || "");
    /* 必须包含沙箱 home 的前缀，且**不能**落在真实 home 下 */
    return !p || !p.startsWith(r.home) || p.startsWith(path.join(os.homedir(), ".minipi"));
  });
  chk(
    "★ 每个沙箱子进程的 MAIN_LOG_FILE 都落在自己的临时 home 里（隔离机制本身成立）",
    escaped.length === 0,
    escaped.length === 0
      ? `5 个场景全部隔离 · 例：${String(HOMES[0].r.data.mainLogFile)}`
      : `逃逸场景：${escaped.map(({ s, r }) => `${s}=${r.data.mainLogFile}`).join(" | ")}`,
  );
  chk(
    "★ 沙箱 home 与真实 home 不同（USERPROFILE 覆盖真的生效了）",
    HOMES.every(({ r }) => path.resolve(r.home) !== path.resolve(os.homedir())),
    `真实 home=${os.homedir()}`,
  );

  /* 快照必须在上面这几轮**之后**拍（见上面关于顺序的说明）。 */
  const realAfter = realSnapshot();
  if (realBefore.exists === null || realAfter.exists === null) {
    chk("真实 ~/.minipi/logs 在测试前后一致", null, "读不到真实目录（权限或平台限制）");
  } else {
    chk(
      "★ 真实 ~/.minipi/logs 在测试前后完全一致（文件名 + 大小逐个比对，只读快照）",
      JSON.stringify(realBefore) === JSON.stringify(realAfter),
      `before=${JSON.stringify(realBefore.names)} after=${JSON.stringify(realAfter.names)}`,
    );
  }
}

/* ---------------------------------------------------------------- 收尾 */
if (!KEEP_TMP) {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* 删不掉不影响结论 */
  }
} else {
  console.log(`\n 临时目录保留：${TMP_ROOT}`);
}

console.log("\n" + "=".repeat(78));
console.log(` 通过 ${pass} 项 · 失败 ${fail} 项 · 未测到 ${skip} 项`);
if (fail > 0) console.log(` 失败项：\n   ✗ ${failures.join("\n   ✗ ")}`);
if (skip > 0) console.log(` 未测到：\n   · ${skipped.join("\n   · ")}`);
console.log("=".repeat(78));
process.exit(fail === 0 ? 0 : 1);
