'use strict';
/* ============================================================================
   spike 静态校验（不启动 Electron）
   ----------------------------------------------------------------------------
   做 8 件事，任一项失败即以非 0 退出：
     1. package.json：type=module / engines.node>=22.19 / electron 精确 pin 到 44.x / main 存在
     2. 所有 .mjs / .js 过一遍 node --check（语法）
     3. .mjs 里不允许出现 require( —— 这是「ESM 主进程」这条硬约束的自证
     4. main.mjs 的 import 说明符全部可解析（node:* 内建 / 相对路径存在 / electron 交给运行时）
     5. main.mjs 里用到的 renderer/*.html 全部存在
     6. renderer/*.html 自包含（无 http(s) 外链、无 CDN）
     7. scripts 完整性（start / spike / check）
     8. --online：向 npm registry 确认 pinned 的 electron 版本真的存在
   用法：node scripts/selfcheck.mjs [--online]
   ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmpVersion } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ONLINE = process.argv.includes('--online');

const results = [];
let failed = 0;
function ok(name, extra = '') { results.push({ pass: true, name, extra }); }
function bad(name, extra = '') { results.push({ pass: false, name, extra }); failed++; }

/* ---- 1. package.json ---- */
const pkgPath = path.join(ROOT, 'package.json');
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  ok('package.json 可解析');
} catch (e) {
  bad('package.json 可解析', String(e.message));
}

if (pkg) {
  pkg.type === 'module' ? ok('package.json type=module') : bad('package.json type=module', String(pkg.type));

  const need = (pkg.engines && pkg.engines.node) || '';
  const m = /\>=\s*(\d+\.\d+(\.\d+)?)/.exec(need);
  if (m && cmpVersion(m[1], '22.19.0') >= 0) ok('engines.node >= 22.19.0', need);
  else bad('engines.node >= 22.19.0', need || '(缺失)');

  const ev = (pkg.devDependencies && pkg.devDependencies.electron) ||
    (pkg.dependencies && pkg.dependencies.electron) || '';
  const pinnedExact = /^\d+\.\d+\.\d+$/.test(ev);
  const is44 = /^44\./.test(ev);
  pinnedExact && is44
    ? ok('electron 精确 pin 到 44.x', ev)
    : bad('electron 精确 pin 到 44.x', ev || '(缺失)');

  const mainFile = pkg.main || 'index.js';
  fs.existsSync(path.join(ROOT, mainFile))
    ? ok('package.json main 指向的文件存在', mainFile)
    : bad('package.json main 指向的文件存在', mainFile);

  for (const s of ['start', 'spike', 'check']) {
    (pkg.scripts && pkg.scripts[s]) ? ok('scripts.' + s, pkg.scripts[s]) : bad('scripts.' + s, '(缺失)');
  }
  if (pkg.scripts && pkg.scripts.start) {
    /electron\s/.test(pkg.scripts.start)
      ? ok('scripts.start 走 electron')
      : bad('scripts.start 走 electron', pkg.scripts.start);
  }

  /* 本机 Node 也顺带核一下 */
  cmpVersion(process.versions.node, '22.19.0') >= 0
    ? ok('本机 Node 满足 engines', process.version)
    : bad('本机 Node 满足 engines', process.version);
}

/* ---- 收集源文件 ---- */
const skipDirs = new Set(['node_modules', 'out', '.git']);
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (skipDirs.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const moduleFiles = files.filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
const htmlFiles = files.filter(f => f.endsWith('.html'));

/* ---- 2 & 3. 语法 + ESM 纯度 ---- */
for (const f of moduleFiles) {
  const rel = path.relative(ROOT, f);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  r.status === 0 ? ok('node --check ' + rel) : bad('node --check ' + rel, (r.stderr || '').trim().split('\n')[0]);
}
for (const f of moduleFiles.filter(x => x.endsWith('.mjs'))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  /* 只看真正的调用，跳过注释里的示例 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /\brequire\s*\(/.test(code)
    ? bad('ESM 纯度（无 require）：' + rel)
    : ok('ESM 纯度（无 require）：' + rel);
}

/* ---- 4. import 说明符可解析 ---- */
const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const f of moduleFiles.filter(x => x.endsWith('.mjs'))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  const specs = new Set();
  for (const re of [importRe, dynamicRe]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  for (const s of specs) {
    if (s === 'electron') { ok('import 说明符（运行时提供）: ' + rel + ' -> electron'); continue; }
    if (s.startsWith('node:')) { ok('import 说明符（Node 内建）: ' + rel + ' -> ' + s); continue; }
    if (s.startsWith('.')) {
      const target = path.resolve(path.dirname(f), s);
      fs.existsSync(target)
        ? ok('import 说明符（相对路径存在）: ' + rel + ' -> ' + s)
        : bad('import 说明符（相对路径存在）: ' + rel + ' -> ' + s);
      continue;
    }
    bad('import 说明符（未知裸包，未列入依赖）: ' + rel + ' -> ' + s);
  }
}

/* ---- 5. renderer 资源存在性 ---- */
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.mjs'), 'utf8');
const refNames = new Set();
{
  const re = /'([A-Za-z0-9_.-]+\.html)'/g;
  let m;
  while ((m = re.exec(mainSrc))) refNames.add(m[1]);
}
for (const n of refNames) {
  const p = path.join(ROOT, 'renderer', n);
  fs.existsSync(p) ? ok('renderer 资源存在: ' + n) : bad('renderer 资源存在: ' + n);
}
if (refNames.size === 0) bad('main.mjs 引用了至少一个 renderer 页面');
for (const h of htmlFiles) {
  ok('renderer 目录内页面: ' + path.relative(ROOT, h));
}

/* ---- 6. HTML 自包含 ---- */
for (const f of htmlFiles) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  const ext = [];
  if (/<script[^>]+src\s*=/i.test(src)) ext.push('script[src]');
  if (/<link[^>]+href\s*=\s*["']https?:/i.test(src)) ext.push('link[href=http]');
  if (/(src|href)\s*=\s*["']\/\//.test(src)) ext.push('protocol-relative');
  if (/https?:\/\/(?!www\.w3\.org)/.test(src)) ext.push('absolute http(s) url');
  ext.length === 0 ? ok('HTML 自包含: ' + rel) : bad('HTML 自包含: ' + rel, ext.join(', '));
}

/* ---- 8. online 版本核对 ---- */
if (ONLINE && pkg) {
  const ev = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  try {
    const r = await fetch('https://registry.npmjs.org/-/package/electron/dist-tags');
    const j = await r.json();
    const latest = j.latest;
    const lineOk = j['44-x-y'];
    (lineOk === ev) ? ok('npm 上 44.x 线当前版本 == pin 值', ev) :
      bad('npm 上 44.x 线当前版本 == pin 值', 'pin=' + ev + ' / 44-x-y=' + lineOk + ' / latest=' + latest);
  } catch (e) {
    bad('npm registry 可达', String(e.message));
  }
}

/* ---- 输出 ---- */
const line = '-'.repeat(72);
console.log('');
console.log(line);
console.log(' minipi spike 套件 · 静态校验（未启动 Electron）');
console.log(line);
for (const r of results) {
  console.log(' ' + (r.pass ? '[ok]  ' : '[FAIL]') + ' ' + r.name + (r.extra ? '   ' + r.extra : ''));
}
console.log(line);
console.log(' 共 ' + results.length + ' 项，失败 ' + failed + ' 项' + (ONLINE ? '（含 --online）' : '（未联网；加 --online 可核对 electron 版本）'));
console.log(line);
console.log('');

process.exit(failed ? 1 : 0);
