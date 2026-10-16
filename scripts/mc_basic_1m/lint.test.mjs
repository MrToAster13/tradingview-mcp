/*
 * Text lints for scripts/mc_basic_1m. The suite reads every .mjs file in its own folder and
 * enforces design_v14.md lines 123 to 135 and the "Rules every file follows" section of
 * api_v1.md. A check whose input file is not built yet is skipped with t.skip. Every failure
 * names the file, the line (or template name) and the token.
 *
 * Run from the repo root:
 *   node --test "scripts/mc_basic_1m/lint.test.mjs"
 *
 * This file is linted too. Restricted words are assembled with W() so that none appears whole.
 * templates.mjs is read as text, not imported: a dynamic import is banned by the same lint, and
 * a static import would stop this file from loading while templates.mjs is missing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------- restricted names, assembled so that no whole copy sits in this file ---------- */

const W = (...parts) => parts.join('');
const PROCESS = W('pro', 'cess');
const DYNAMIC_IMPORT = W('imp', 'ort');
const CHROME_LIB = W('chrome-remote-', 'interface');
const RUNTIME = W('Run', 'time');
const SEND_CALL = W('.se', 'nd(');
const DRAW = W('draw', '_trade');
const TEST_SET_DIR = W('__test', 'SetStateDir');
const WAIT_TEXT = 'await new Promise(resolve => setTimeout(resolve, 5000))';
const CHART_DECL = 'const chart = TradingViewApi._activeChartWidgetWV.value();';
const BANNED = [
  W('child', '_process'), W('ht', 'tp'), W('ht', 'tps'), W('n', 'et'), W('t', 'ls'), W('dg', 'ram'),
  W('v', 'm'), W('worker', '_threads'), W('clu', 'ster'), W('mod', 'ule'), W('Web', 'Socket'),
  W('fe', 'tch'), W('req', 'uire'), W('glo', 'bal', 'This'), W('glo', 'bal'), W('getBuiltin', 'Module'),
  W('dl', 'open'), W('e', 'val'), W('Func', 'tion'), W('Refl', 'ect'), W('constr', 'uctor'),
  W('proto', 'type'), W('__pro', 'to__'),
];

/* ---------- template vocabulary (design lines 126 to 132) ---------- */

const TEMPLATE_NAMES = ['identity', 'discover', 'read_history', 'read_shapes', 'draw_trade'];
const GUARD_NAMES = ['WRITE_GUARD', 'READ_GUARD'];
const ERROR_CODES = [
  'E_GUARD', 'E_PATH', 'E_CHARTS', 'E_SYMBOL', 'E_RES', 'E_NOSTUDY', 'E_NOSHAPE',
  'E_SHAPE_MISMATCH', 'E_TEXT_ID', 'E_POS_ID', 'E_POS_THROW',
];
const ALLOWED_LITERALS = [
  'CME_MINI:MES1!', '1', '15', '/chart/HCCCDVCt/', 'MarketCipher_B', 'MarketCipher_SR',
  'long_position', 'short_position', 'text', 'string', ...ERROR_CODES,
].map((s) => `"${s}"`);
const KEYWORDS = [
  'const', 'let', 'return', 'if', 'else', 'for', 'of', 'true', 'false', 'null', 'typeof', 'throw',
  'try', 'catch', 'new', 'Error', 'async', 'await', 'Promise', 'setTimeout',
];
const API_MEMBERS = [
  'Date', 'now', 'TradingViewApi', 'chartsCount', '_activeChartWidgetWV', 'value', '_chartWidget',
  'model', 'dataSources', 'metaInfo', 'data', 'valueAt', 'firstIndex', 'lastIndex', 'mainSeries',
  'bars', 'symbol', 'resolution', 'getAllShapes', 'getShapeById', 'getPoints', 'getProperties',
  'location', 'pathname', 'startsWith', 'id', 'name', 'description', 'time', 'price', 'stopLevel',
  'profitLevel', 'linecolor', 'text', 'shape', 'overrides', 'createShape', 'createMultipointShape',
  'inputs', 'in_2',
];
const HELPERS = [
  'Number', 'isFinite', 'Math', 'min', 'max', 'map', 'filter', 'find', 'some', 'every', 'push',
  'length', 'includes', 'JSON', 'stringify', 'plots', 'type',
];
const LOCAL_NAMES = new Set([
  'chart', 'resolve', 'e', 's', 'x', 'p', 'r', 'i', 'a', 'b', 'ids', 'all', 'rows', 'out', 'pos',
  'txt', 'fresh', 'pts', 'st', 'sid',
]);
const ID_ALLOW = new Set([...KEYWORDS, ...API_MEMBERS, ...HELPERS, ...LOCAL_NAMES]);
const FORBIDDEN_TEMPLATE = new Set([
  ...BANNED, 'window', 'removeEntity', 'removeAllShapes', 'clearAll', 'draw_clear', 'atob',
  'fromCharCode', 'function', 'delete', 'in',
]);
const LITERAL_BEFORE_ARRAY = new Set(['return', 'typeof', 'await', 'of', 'new', 'else', 'throw']);
const OPERATOR_RE = /===|!==|==|!=|<=|>=|=>|\*\*=|>>>=|<<=|>>=|&&=|\|\|=|\?\?=|\+=|-=|\*=|%=|&=|\|=|\^=|\+\+|--|\?\.|=/g;
const OPERATOR_OK = new Set(['===', '!==', '<=', '>=', '=>']);

/* ---------- files ---------- */

const FOLDER = dirname(fileURLToPath(import.meta.url));
const NAMES = readdirSync(FOLDER).filter((n) => n.endsWith('.mjs')).sort();
const SOURCE = new Map(NAMES.map((n) => [n, readFileSync(join(FOLDER, n), 'utf8')]));
const hasFile = (n) => SOURCE.has(n);
const isTest = (n) => n.endsWith('.test.mjs');

/* ---------- scanners ---------- */

const IDENT = /[A-Za-z0-9_$]/;
const IMPORT_FROM_RE = /(?<![A-Za-z0-9_$.])(?:import|export)(?![A-Za-z0-9_$])\s*([^;'"]*?)\s*from\s*(['"])([^'"\n]+)\2/g;
const IMPORT_SIDE_RE = new RegExp('(?<![A-Za-z0-9_$.])' + DYNAMIC_IMPORT + '(?![A-Za-z0-9_$])\\s*([\'"])([^\'"\\n]+)\\1', 'g');
const DYNAMIC_RE = /(?<![A-Za-z0-9_$])import\s*\(/g;
const PROCESS_OK = /^(?:\.(?:argv|exitCode|pid)(?![A-Za-z0-9_$])|\.(?:stdout|stderr)\.write\()/;

/** Indexes where word occurs as a whole word (neither neighbour is in [A-Za-z0-9_$]). */
function wordHits(text, word) {
  const hits = [];
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = at + word.length < text.length ? text[at + word.length] : '';
    if (!IDENT.test(before) && !IDENT.test(after)) hits.push(at);
  }
  return hits;
}

function regexHits(text, re) {
  return [...text.matchAll(re)].map((m) => m.index);
}

/** The token PROCESS, unless it is followed by an allowed member (argv, exitCode, pid, stdout.write(, stderr.write(). */
function processHits(text) {
  return wordHits(text, PROCESS).filter((at) => !PROCESS_OK.test(text.slice(at + PROCESS.length)));
}

function parseImports(text) {
  const out = [];
  for (const m of text.matchAll(IMPORT_FROM_RE)) {
    out.push({ clause: m[1].trim(), spec: m[3], at: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(IMPORT_SIDE_RE)) {
    out.push({ clause: '', spec: m[2], at: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Text with every allowed literal (quotes included) replaced by a space, and @@NAME@@ placeholders replaced too. */
function reduceLiterals(stripped) {
  let rem = stripped;
  for (const lit of ALLOWED_LITERALS) rem = rem.split(lit).join(' ');
  return rem;
}
const stripPlaceholders = (raw) => raw.replace(/@@[A-Z_]+@@/g, ' ');

function literalHits(rem) {
  return [...rem.matchAll(/[\/\\`'"@]/g)].map((m) => ({ token: m[0], index: m.index }));
}

function identHits(rem) {
  return [...rem.matchAll(/\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .filter((m) => !/^\d/.test(m[0]) && !ID_ALLOW.has(m[0]))
    .map((m) => ({ token: m[0], index: m.index }));
}

function forbiddenHits(rem) {
  return [...rem.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)]
    .filter((m) => FORBIDDEN_TEMPLATE.has(m[0]))
    .map((m) => ({ token: m[0], index: m.index, why: 'forbidden in templates (design 131)' }));
}

/** Every standalone = must be the third token of const or let; compound assignments, ==, !=, ++, --, ?. are reported. */
function operatorHits(rem) {
  const out = [];
  for (const m of rem.matchAll(OPERATOR_RE)) {
    const tok = m[0];
    if (OPERATOR_OK.has(tok)) continue;
    if (tok === '=' && /(?<![A-Za-z0-9_$])(?:const|let)\s+[A-Za-z_$][\w$]*\s*$/.test(rem.slice(Math.max(0, m.index - 60), m.index))) continue;
    out.push({ token: tok, index: m.index, why: 'assignment or operator not allowed (design 131)' });
  }
  return out;
}

/** Computed member access other than [<digits>]. Array literals (after a keyword, an operator or a bracket opener) are not member access. */
function memberHits(rem) {
  const out = [];
  for (const m of rem.matchAll(/\[/g)) {
    const prev = rem.slice(Math.max(0, m.index - 40), m.index).match(/([A-Za-z_$][\w$]*|[)\]])\s*$/);
    if (!prev || LITERAL_BEFORE_ARRAY.has(prev[1])) continue;
    const close = rem.indexOf(']', m.index);
    const inside = close === -1 ? '' : rem.slice(m.index + 1, close).trim();
    if (!/^\d+$/.test(inside)) out.push({ token: `[${inside}]`, index: m.index, why: 'computed member access (design 131)' });
  }
  return out;
}

function forHits(rem) {
  return [...rem.matchAll(/(?<![A-Za-z0-9_$])for(?![A-Za-z0-9_$])/g)]
    .filter((m) => !/^for\s*\(\s*const\s+[A-Za-z_$][\w$]*\s+of\s/.test(rem.slice(m.index)))
    .map((m) => ({ token: 'for', index: m.index, why: 'loop head must be for ( const <local> of (design 131)' }));
}

/** Every name bound by const, let, catch, an arrow parameter. */
function bindingHits(rem) {
  const out = [];
  const add = (name, at) => out.push({ token: name, index: at });
  for (const m of rem.matchAll(/(?<![A-Za-z0-9_$])(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) add(m[1], m.index);
  for (const m of rem.matchAll(/(?<![A-Za-z0-9_$])catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) add(m[1], m.index);
  for (const m of rem.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) if (p.trim()) add(p.trim(), m.index);
  }
  for (const m of rem.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1], m.index);
  return out;
}

/** Write members: only in draw_trade, only as chart.<member>( . */
function writeHits(name, rem) {
  const out = [];
  for (const m of rem.matchAll(/(?<![A-Za-z0-9_$])(createShape|createMultipointShape)(?![A-Za-z0-9_$])/g)) {
    if (name !== 'draw_trade') {
      out.push({ token: m[0], index: m.index, why: 'write member outside draw_trade (design 128)' });
      continue;
    }
    const ok = rem.slice(Math.max(0, m.index - 6), m.index) === 'chart.' && rem[m.index + m[0].length] === '(';
    if (!ok) out.push({ token: m[0], index: m.index, why: 'write member must be chart.<member>( (design 128)' });
  }
  return out;
}

/** Each write call in draw_trade follows the exact WRITE_GUARD statement, and no await sits between them. */
function guardHits(raw, guardRaw) {
  const out = [];
  const stmt = `if (!(${guardRaw})) { return "E_GUARD"; }`;
  const calls = [...raw.matchAll(/chart\.(createShape|createMultipointShape)\(/g)];
  if (calls.length !== 2) {
    out.push({ file: 'templates.mjs', where: 'draw_trade', token: 'chart.createShape( and chart.createMultipointShape(', why: `expected one of each, found ${calls.length} calls (design 134)` });
  }
  for (const call of calls) {
    const head = raw.slice(0, call.index).replace(/const\s+[A-Za-z_$][\w$]*\s*=\s*$/, '').replace(/\s+$/, '');
    if (!head.endsWith(stmt)) {
      out.push({ file: 'templates.mjs', where: 'draw_trade', token: call[0], why: 'exact WRITE_GUARD statement not directly before the write (design 134)' });
      continue;
    }
    const start = head.length - stmt.length;
    let depth = 0;
    let j = call.index + call[0].length - 1;
    for (; j < raw.length; j++) {
      if (raw[j] === '(') depth++;
      else if (raw[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const semi = raw.indexOf(';', j);
    const seg = raw.slice(start, semi === -1 ? raw.length : semi);
    if (/(?<![A-Za-z0-9_$])await(?![A-Za-z0-9_$])/.test(seg)) {
      out.push({ file: 'templates.mjs', where: 'draw_trade', token: 'await', why: 'await between the guard and the end of the write statement (design 134)' });
    }
  }
  return out;
}

/* ---------- report helpers ---------- */

const fileViol = (file, text, at, token, why) => ({ file, line: text.slice(0, at).split('\n').length, token, why });
const tplViol = (where, token, why) => ({ file: 'templates.mjs', where, token, why });

function fmt(v) {
  const place = v.where ? ` [${v.where}]` : '';
  const line = v.line ? ` line ${v.line}` : '';
  return `${v.file}${place}${line}: ${v.token}${v.why ? ` (${v.why})` : ''}`;
}

function report(list) {
  if (list.length > 0) assert.fail(`${list.length} violation(s):\n${list.map(fmt).join('\n')}`);
}

/* ---------- templates.mjs read as text ---------- */

function loadTemplates() {
  if (!hasFile('templates.mjs')) return null;
  const text = SOURCE.get('templates.mjs');
  const raw = new Map();
  for (const m of text.matchAll(/([A-Za-z_]\w*)\s*[:=]\s*`([^`]*)`/g)) {
    if (!raw.has(m[1])) raw.set(m[1], m[2]);
  }
  return { text, raw };
}
const TPL = loadTemplates();

/** Runs fn(name, raw) for each of the five templates that templates.mjs defines. */
function eachTemplate(fn) {
  const out = [];
  if (!TPL) return out;
  for (const name of TEMPLATE_NAMES) {
    if (TPL.raw.has(name)) out.push(...fn(name, TPL.raw.get(name)));
  }
  return out;
}

/* ---------- file-level lint bodies ---------- */

function bannedViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    for (const word of BANNED) {
      for (const at of wordHits(text, word)) out.push(fileViol(file, text, at, word, 'banned whole word (design 123)'));
    }
  }
  return out;
}

function processViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    for (const at of processHits(text)) {
      out.push(fileViol(file, text, at, text.slice(at, at + 40).split('\n')[0], 'only argv, exitCode, pid, stdout.write and stderr.write (design 123)'));
    }
  }
  return out;
}

function dynamicViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    for (const at of regexHits(text, DYNAMIC_RE)) out.push(fileViol(file, text, at, `${DYNAMIC_IMPORT}(`, 'dynamic import call (design 123)'));
  }
  return out;
}

function importAllowed(file, imp) {
  const { spec, clause } = imp;
  if (file === 'cdp.mjs') {
    return (spec === CHROME_LIB && clause === 'CDP') || spec === 'node:crypto' || spec === './templates.mjs';
  }
  if (spec === CHROME_LIB) return false;
  if (spec.startsWith('node:')) {
    const mod = spec.slice(5);
    if (['path', 'crypto', 'url'].includes(mod)) return true;
    if (mod === 'fs') return file === 'store.mjs' || isTest(file);
    if (['test', 'assert', 'assert/strict'].includes(mod)) return isTest(file);
    if (mod === 'os') return isTest(file) && (clause === 'os' || /^\{\s*tmpdir\s*\}$/.test(clause));
    return false;
  }
  return /^\.\/[A-Za-z0-9_.-]+\.mjs$/.test(spec);
}

function importViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    for (const imp of parseImports(text)) {
      if (!importAllowed(file, imp)) out.push(fileViol(file, text, imp.at, imp.spec, `import not allowed in ${file} (design 133, api_v1 rules)`));
    }
  }
  return out;
}

function ownerViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    if (file !== 'cdp.mjs' && text.includes(CHROME_LIB)) {
      out.push(fileViol(file, text, text.indexOf(CHROME_LIB), CHROME_LIB, 'only cdp.mjs may name the client library (design 133)'));
    }
    if (file !== 'cdp.mjs' && file !== 'templates.mjs') {
      for (const word of [RUNTIME, SEND_CALL]) {
        const at = text.indexOf(word);
        if (at !== -1) out.push(fileViol(file, text, at, word, 'only cdp.mjs and templates.mjs may use this (design 133)'));
      }
    }
  }
  return out;
}

/** Every run( call in every file: the first argument must be a string literal. draw_trade only in draw.mjs. */
function runCalls(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$])run\s*\(/g)) {
    if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    const lit = text.slice(m.index + m[0].length).match(/^\s*(['"`])([^'"`\n]*)\1/);
    out.push({ index: m.index, lit: lit ? lit[2] : null });
  }
  return out;
}

function drawViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    if (!['templates.mjs', 'cdp.mjs', 'draw.mjs'].includes(file) && !isTest(file)) {
      const at = text.indexOf(DRAW);
      if (at !== -1) out.push(fileViol(file, text, at, DRAW, 'draw_trade text allowed only in templates.mjs, cdp.mjs, draw.mjs and tests (design 133)'));
    }
    for (const call of runCalls(text)) {
      if (call.lit === null) out.push(fileViol(file, text, call.index, 'run(', 'first argument of run( must be a string literal (design 133)'));
      else if (call.lit === DRAW && file !== 'draw.mjs') out.push(fileViol(file, text, call.index, `run("${DRAW}"`, 'run of draw_trade only in draw.mjs (design 133)'));
    }
  }
  return out;
}

function testDirViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    if (file === 'store.mjs' || isTest(file)) continue;
    const at = text.indexOf(TEST_SET_DIR);
    if (at !== -1) out.push(fileViol(file, text, at, TEST_SET_DIR, 'only store.mjs and *.test.mjs (api_v1 store section)'));
  }
  return out;
}

function siblingsOf(name) {
  return parseImports(SOURCE.get(name)).filter((i) => i.spec.startsWith('./')).map((i) => i.spec.slice(2));
}

function closureViolations() {
  const out = [];
  for (const name of NAMES.filter(isTest)) {
    const seen = new Set();
    const queue = siblingsOf(name);
    while (queue.length > 0) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      if (hasFile(next)) queue.push(...siblingsOf(next));
    }
    for (const reached of ['cdp.mjs', 'cli.mjs']) {
      if (seen.has(reached)) out.push({ file: name, token: reached, why: 'test files may not reach cdp.mjs or cli.mjs through imports (design 133, api_v1)' });
    }
  }
  return out;
}

/* ---------- cdp.mjs lint bodies ---------- */

/** Same-length copy of the file with comments, string literals and regex literals blanked, so indexes still match the raw text. */
const blank = (s) => s.replace(/[^\n]/g, ' ');
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, blank)
    .replace(/(?<=[=(,:[!&|?{};]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

function osUsageViolations() {
  const out = [];
  for (const [file, text] of SOURCE) {
    if (!isTest(file) || !parseImports(text).some((i) => i.spec === 'node:os')) continue;
    for (const m of text.matchAll(/(?<![A-Za-z0-9_$.])os\.([A-Za-z_$][\w$]*)/g)) {
      if (m[1] !== 'tmpdir') out.push(fileViol(file, text, m.index, m[0], 'node:os may be used only for tmpdir (design 133)'));
    }
  }
  return out;
}

function cdpImportViolations() {
  const text = SOURCE.get('cdp.mjs');
  const imports = parseImports(text);
  const out = [];
  if (imports.length !== 3) {
    out.push({ file: 'cdp.mjs', token: `${imports.length} imports`, why: 'exactly three imports required (design 123)' });
  }
  const want = ['./templates.mjs', CHROME_LIB, 'node:crypto'].sort();
  const got = imports.map((i) => i.spec).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    out.push({ file: 'cdp.mjs', token: got.join(', '), why: 'imports must be the default of the client library as CDP, node:crypto and ./templates.mjs (design 123)' });
  }
  const cri = imports.find((i) => i.spec === CHROME_LIB);
  if (cri && cri.clause !== 'CDP') {
    out.push({ file: 'cdp.mjs', token: cri.clause, why: 'the client library must be imported as the default export named CDP (design 123)' });
  }
  return out;
}

function inImportRanges(text, at) {
  return parseImports(text).some((i) => at >= i.at && at < i.end);
}

function cdpUsageViolations() {
  const text = SOURCE.get('cdp.mjs');
  const code = codeOnly(text);
  const out = [];
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$])CDP(?=\s*[(.])/g)) {
    if (inImportRanges(text, m.index)) continue;
    const rest = code.slice(m.index);
    const okCall = /^CDP\(\{\s*port:\s*9222,\s*target\s*\}\)/.test(rest) || /^CDP\.List\(\{\s*port:\s*9222\s*\}\)/.test(rest);
    if (!okCall) out.push(fileViol('cdp.mjs', text, m.index, rest.split('\n')[0].slice(0, 40), 'CDP only as CDP({ port: 9222, target }) or CDP.List({ port: 9222 }) (design 123)'));
  }
  return out;
}

function cdpSendViolations() {
  const text = SOURCE.get('cdp.mjs');
  const out = [];
  for (const m of text.matchAll(/\.send\(/g)) {
    if (!new RegExp('^\\s*([\'"])' + RUNTIME + '\\.(?:evaluate|enable)\\1').test(text.slice(m.index + 6))) {
      out.push(fileViol('cdp.mjs', text, m.index, text.slice(m.index, m.index + 40).split('\n')[0], 'first argument of ' + SEND_CALL + ' must be the allowed method literal (design 135)'));
    }
  }
  const evaluateCount = (text.match(new RegExp('\\.send\\(\\s*([\'"])' + RUNTIME + '\\.evaluate\\1', 'g')) || []).length;
  if (evaluateCount !== 1) out.push({ file: 'cdp.mjs', token: RUNTIME + '.evaluate', why: 'exactly one ' + SEND_CALL + ' call with that literal required, found ' + evaluateCount + ' (design 135)' });
  for (const m of text.matchAll(new RegExp(RUNTIME + '\\.(\\w+)', 'g'))) {
    if (!['evaluate', 'enable'].includes(m[1])) out.push(fileViol('cdp.mjs', text, m.index, m[0], 'only the evaluate and enable methods (design 135)'));
  }
  return out;
}

function cdpClientViolations() {
  const text = SOURCE.get('cdp.mjs');
  const out = [];
  const code = codeOnly(text);
  for (const m of code.matchAll(/(?<![A-Za-z0-9_$.])(client1|client2|candidate|c)(?![A-Za-z0-9_$])/g)) {
    if (inImportRanges(text, m.index)) continue;
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 8);
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    const okSend = /^\.send\(/.test(after);
    const okClose = m[1] !== 'c' && /^\.close\(/.test(after);
    const okEvaluate = /evaluate\(\s*$/.test(before);
    if (!okSend && !okClose && !okEvaluate) {
      out.push(fileViol('cdp.mjs', text, m.index, m[1], 'client identifiers only before .send(, .close( or as the first argument of evaluate( (design 135)'));
    }
  }
  return out;
}

function cdpMemberViolations() {
  const text = SOURCE.get('cdp.mjs');
  const code = codeOnly(text);
  const out = [];
  const lookups = [];
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\[([^\]\n]*)\]/g)) {
    if (LITERAL_BEFORE_ARRAY.has(m[1]) || m[1] === 'const' || m[1] === 'let') continue;
    lookups.push({ obj: m[1], key: m[2].trim(), index: m.index });
  }
  for (const l of lookups) {
    const label = `${l.obj}[${l.key}]`;
    if (lookups.length > 2) out.push(fileViol('cdp.mjs', text, l.index, label, 'more than two computed lookups; only the template and hash lookups are allowed (design 123, 125)'));
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const guarded = plain.test(l.key) && plain.test(l.obj)
      && new RegExp(`Object\\.hasOwn\\(\\s*${l.obj}\\s*,\\s*${l.key}\\s*\\)`).test(code.slice(0, l.index));
    if (!guarded) out.push(fileViol('cdp.mjs', text, l.index, label, 'computed lookup not preceded by Object.hasOwn of the same name (design 125)'));
  }
  const exportCount = (text.match(/(?<![A-Za-z0-9_$])export(?![A-Za-z0-9_$])/g) || []).length;
  const runExport = (text.match(/export\s+async\s+function\s+run\s*\(/g) || []).length;
  if (exportCount !== 1 || runExport !== 1) {
    out.push({ file: 'cdp.mjs', token: 'export', why: 'cdp.mjs exports only async function run (api_v1 cdp section)' });
  }
  return out;
}

/* ---------- templates.mjs lint bodies ---------- */

function checkEachTemplate(fn) {
  return eachTemplate((name, raw) => fn(name, raw, reduceLiterals(stripPlaceholders(raw))));
}

function templateIdentityArray(name, raw, rem) {
  return identHits(rem).map((h) => tplViol(name, h.token, 'identifier not in the allowlist (design 127)'));
}

/* ---------- self-tests of the scanners (design 123, 127, 130, 131) ---------- */

describe('scanner self-tests', () => {
  test('a banned word inside a comment is caught', () => {
    const sample = `// ${W('req', 'uire')}('x');`;
    assert.equal(wordHits(sample, W('req', 'uire')).length, 1);
  });

  test('a longer word that starts with the restricted name is not caught; exit is caught; argv is allowed', () => {
    assert.deepEqual(processHits('const processor = 1;'), []);
    assert.equal(processHits(`${PROCESS}.exit(1);`).length, 1);
    assert.deepEqual(processHits(`${PROCESS}.argv`), []);
    assert.deepEqual(processHits(`${PROCESS}.stdout.write('x');`), []);
  });

  test('a whole-word banned name needs non-identifier neighbours', () => {
    assert.equal(wordHits(`x.${W('ht', 'tp')}`, W('ht', 'tp')).length, 1);
    assert.equal(wordHits(`my${W('__pro', 'to__')}`, W('__pro', 'to__')).length, 0);
  });

  test('dynamic import is detected and a property named like it is not', () => {
    assert.equal(regexHits(`${DYNAMIC_IMPORT}('x');`, DYNAMIC_RE).length, 1);
    assert.equal(regexHits(`${DYNAMIC_IMPORT}.meta.url`, DYNAMIC_RE).length, 0);
  });

  test('import parser reads from, side-effect and multi-line forms', () => {
    const src = `${DYNAMIC_IMPORT} { a,\n  b } from 'node:fs';\n${DYNAMIC_IMPORT} 'node:os';\n`;
    assert.deepEqual(parseImports(src).map((i) => i.spec), ['node:fs', 'node:os']);
    assert.deepEqual(parseImports(`${DYNAMIC_IMPORT}('x');`), []);
  });

  test('template identifier scanner: allowed names pass, other names are reported', () => {
    assert.deepEqual(identHits('const a = Math.max(1, 2); return a;'), []);
    assert.deepEqual(identHits('return foo(1);').map((h) => h.token), ['foo']);
  });

  test('template literal scanner: allowed literals pass; other strings, slashes and quotes fail', () => {
    assert.deepEqual(literalHits(reduceLiterals('return "E_GUARD";')), []);
    assert.deepEqual(literalHits(reduceLiterals("return 'x';")).map((h) => h.token), ["'", "'"]);
    assert.deepEqual(literalHits(reduceLiterals('return "E_OTHER";')).map((h) => h.token), ['"', '"']);
    assert.equal(literalHits(reduceLiterals('a = /x/;')).length, 2);
  });

  test('operator scanner: = only in const or let declarations; += and == are reported', () => {
    assert.deepEqual(operatorHits('const b = 1; let c2 = b;'), []);
    assert.deepEqual(operatorHits('a += 1;').map((h) => h.token), ['+=']);
    assert.deepEqual(operatorHits('x = 2;').map((h) => h.token), ['=']);
    assert.deepEqual(operatorHits('if (a == b) {}').map((h) => h.token), ['==']);
  });

  test('loop head and binding scanners', () => {
    assert.deepEqual(forHits('for (const p of xs) {}'), []);
    assert.equal(forHits('for (let i = 0; i < 3; i++) {}').length, 1);
    assert.deepEqual(bindingHits('const chart = 1; const p = (q) => q;').map((h) => h.token), ['chart', 'p', 'q']);
  });
});

/* ---------- file lints: every .mjs in the folder ---------- */

describe('file lints (every .mjs in the folder)', () => {
  test('banned whole-word tokens never appear (design 123, api_v1 rules)', () => report(bannedViolations()));
  test('the restricted name only as argv, exitCode, pid, stdout.write, stderr.write (design 123)', () => report(processViolations()));
  test('no dynamic import call (design 123)', () => report(dynamicViolations()));
  test('import allowlists per file (design 133, api_v1 rules)', () => report(importViolations()));
  test('client library and CDP method calls stay in their owner files (design 133, 135)', () => report(ownerViolations()));
  test('draw_trade text and run( first argument (design 133)', () => report(drawViolations()));
  test('__testSetStateDir only in store.mjs and tests (api_v1 store section)', () => report(testDirViolations()));
  test('test files do not reach cdp.mjs or cli.mjs through imports (design 133)', () => report(closureViolations()));
  test('node:os is used only for tmpdir in test files (design 133)', () => report(osUsageViolations()));
});

/* ---------- cdp.mjs lints ---------- */

describe('cdp.mjs lints (design 123, 135)', () => {
  test('cdp.mjs has exactly three imports (design 123)', (t) => {
    if (!hasFile('cdp.mjs')) return t.skip('cdp.mjs is not built yet');
    report(cdpImportViolations());
  });
  test('CDP is called only as CDP({ port: 9222, target }) and CDP.List({ port: 9222 }) (design 123)', (t) => {
    if (!hasFile('cdp.mjs')) return t.skip('cdp.mjs is not built yet');
    report(cdpUsageViolations());
  });
  test('the send call takes only the allowed method literals, and evaluate appears once (design 135)', (t) => {
    if (!hasFile('cdp.mjs')) return t.skip('cdp.mjs is not built yet');
    report(cdpSendViolations());
  });
  test('client1, client2, candidate and c are used only as design 135 allows', (t) => {
    if (!hasFile('cdp.mjs')) return t.skip('cdp.mjs is not built yet');
    report(cdpClientViolations());
  });
  test('computed member access limited to two lookups; exports only run (design 123, 125, api_v1)', (t) => {
    if (!hasFile('cdp.mjs')) return t.skip('cdp.mjs is not built yet');
    report(cdpMemberViolations());
  });
});

/* ---------- templates.mjs lints ---------- */

describe('templates.mjs lints (design 125, 127 to 134)', () => {
  test('templates.mjs defines the five templates and both guard texts (design 125, 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report([...TEMPLATE_NAMES, ...GUARD_NAMES]
      .filter((n) => !TPL.raw.has(n))
      .map((n) => tplViol(n, n, 'not found as a backtick string in templates.mjs')));
  });

  test('each template is (async () => { ... })() (design 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(eachTemplate((name, raw) => {
      const body = raw.trim();
      return body.startsWith('(async () => {') && body.endsWith('})()') ? [] : [tplViol(name, name, 'wrapper must be (async () => { ... })() (design 134)')];
    }));
  });

  test('literal-free check: after allowed literals, no quote, slash, backslash, backtick or @ (design 130)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => literalHits(rem).map((h) => tplViol(name, h.token, 'literal or regex or comment not allowed (design 130)'))));
  });

  test('every identifier is on the allowlist (design 127)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => templateIdentityArray(name, raw, rem)));
  });

  test('forbidden names and tokens (design 131)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => {
      const hits = [...forbiddenHits(rem), ...rem.matchAll(/\?\./g)].map((h) => ({ token: h[0] ?? h.token, index: h.index, why: 'forbidden in templates (design 131)' }));
      return hits.map((h) => tplViol(name, h.token, h.why));
    }));
  });

  test('assignment and operator rules (design 131)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => operatorHits(rem).map((h) => tplViol(name, h.token, h.why))));
  });

  test('computed member access only [<digits>] (design 131)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => memberHits(rem).map((h) => tplViol(name, h.token, h.why))));
  });

  test('every for is for ( const <local name> of (design 131)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => forHits(rem).map((h) => tplViol(name, h.token, h.why))));
  });

  test('every binding is a local name and chart is declared once with the exact text (design 131, 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => {
      const out = [];
      const bindings = bindingHits(rem);
      for (const b of bindings) {
        if (!LOCAL_NAMES.has(b.token)) out.push(tplViol(name, b.token, 'binding must use a local name (design 131)'));
      }
      const chartBindings = bindings.filter((b) => b.token === 'chart').length;
      if (chartBindings !== 1) out.push(tplViol(name, 'chart', `chart bound ${chartBindings} times, must be once (design 134)`));
      if (raw.split(CHART_DECL).length - 1 !== 1) out.push(tplViol(name, CHART_DECL, 'exact chart declaration missing or repeated (design 134)'));
      return out;
    }));
  });

  test('write members only in draw_trade, only as chart.<member>( (design 128)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => writeHits(name, rem).map((h) => tplViol(name, h.token, h.why))));
  });

  test('draw_trade: one createShape and one createMultipointShape, each after the exact WRITE_GUARD statement with no await (design 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    const raw = TPL.raw.get('draw_trade');
    const guard = TPL.raw.get('WRITE_GUARD');
    if (raw === undefined || guard === undefined) return t.skip('draw_trade or WRITE_GUARD not found; see the presence test');
    report(guardHits(raw, guard));
  });

  test('draw_trade: one step-8 wait inside catch; arrows only in wrapper and wait; setTimeout and Promise only there (design 127, 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report(checkEachTemplate((name, raw, rem) => {
      const out = [];
      const want = name === 'draw_trade' ? 1 : 0;
      for (const word of ['setTimeout', 'Promise']) {
        const count = wordHits(rem, word).length;
        if (count !== want) out.push(tplViol(name, word, `${word} appears ${count} times, expected ${want} (design 127)`));
      }
      if (name === 'draw_trade') {
        const waits = raw.split(WAIT_TEXT).length - 1;
        if (waits !== 1) out.push(tplViol(name, WAIT_TEXT, `step-8 wait appears ${waits} times, expected 1 (design 134)`));
        const arrows = (rem.match(/=>/g) || []).length;
        if (arrows !== 2) out.push(tplViol(name, '=>', `${arrows} arrows, expected 2: the wrapper and the step-8 wait (design 134)`));
        const at = raw.indexOf(WAIT_TEXT);
        if (at !== -1 && !/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{[\s\S]*$/.test(raw.slice(0, at))) {
          out.push(tplViol(name, WAIT_TEXT, 'step-8 wait must sit inside a catch branch (design 134)'));
        }
      }
      return out;
    }));
  });

  test('read templates use READ_GUARD; WRITE_GUARD checks the deadline (design 134)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    const out = [];
    const write = TPL.raw.get('WRITE_GUARD');
    const read = TPL.raw.get('READ_GUARD');
    if (write !== undefined && !write.includes('Date.now() < @@DEADLINE@@')) {
      out.push(tplViol('WRITE_GUARD', 'Date.now() < @@DEADLINE@@', 'missing deadline check (design 134)'));
    }
    if (read !== undefined) {
      for (const n of ['identity', 'read_history', 'read_shapes']) {
        if (TPL.raw.has(n) && !TPL.raw.get(n).includes(read)) out.push(tplViol(n, 'READ_GUARD', 'read template must contain READ_GUARD text (design 134)'));
      }
    }
    report(out);
  });

  test('placeholders are @@UPPER_CASE@@ only, and nothing else in templates uses @ (design 125)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    report([...TEMPLATE_NAMES, ...GUARD_NAMES]
      .filter((n) => TPL.raw.has(n))
      .filter((n) => TPL.raw.get(n).replace(/@@[A-Z_]+@@/g, '').includes('@'))
      .map((n) => tplViol(n, '@', 'placeholder must be @@UPPER_CASE@@ (design 125)')));
  });

  test('templates.mjs freezes its exports and has no get, set, Proxy or Map (design 125)', (t) => {
    if (!TPL) return t.skip('templates.mjs is not built yet');
    const out = [];
    if (!TPL.text.includes('Object.freeze(')) out.push({ file: 'templates.mjs', token: 'Object.freeze(', why: 'exports must be frozen (design 125)' });
    for (const word of ['get', 'set', 'Proxy', 'Map']) {
      for (const at of wordHits(TPL.text, word)) out.push(fileViol('templates.mjs', TPL.text, at, word, 'not allowed in templates.mjs (design 125)'));
    }
    report(out);
  });
});
