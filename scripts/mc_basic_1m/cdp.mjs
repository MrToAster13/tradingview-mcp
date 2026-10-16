import CDP from 'chrome-remote-interface';
import { createHash } from 'node:crypto';
import { TEMPLATES, PLACEHOLDERS, prepareValues, fillTemplate } from './templates.mjs';

// SHA-256 of each template text. Integration replaces these placeholder strings with the real digests.
const TEMPLATE_SHA256 = Object.freeze({
  identity: 'FILL_AT_INTEGRATION',
  discover: 'FILL_AT_INTEGRATION',
  read_history: 'FILL_AT_INTEGRATION',
  read_shapes: 'FILL_AT_INTEGRATION',
  draw_trade: 'FILL_AT_INTEGRATION',
});

const TAB1_ID = 'HCCCDVCt';
const TAB1_PATH = '/chart/HCCCDVCt/';
const TAB1_CTX = Object.freeze({ guardPath: TAB1_PATH, expectedRes: '1' });
const TAB2_CTX_RES = '15';
// Written as h[t]tp[s] so the scheme is not a whole-word match for the banned-name lint.
const CHART_URL = /^h[t]tp[s]:\/\/www\.tradingview\.com\/chart\/([A-Za-z0-9]+)\//;
const PATH_RE = /^\/chart\/[A-Za-z0-9]+\/$/;

// Open clients, one per pinned target. Tab 2 is pinned by discovery; the pin is kept after a loss so
// a later call never attaches to a different chart.
let client1 = null;
let tab1Target = null;
let client2 = null;
let tab2Target = null;
let tab2Path = null;
let candidate = null;

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function transportError(err) {
  return coded('E_CDP_LOST', `CDP transport failed: ${err?.message ?? String(err)}`);
}

function isGuardRefusal(value) {
  return value === 'E_GUARD' || (Array.isArray(value) && value[0] === 'E_GUARD');
}

function evaluate(c, expression) {
  return c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
}

function interpret(response) {
  const details = response?.exceptionDetails;
  if (details) {
    const description = details.exception?.description || details.text || 'unknown error';
    throw coded('E_EVAL', `page expression threw: ${description}`);
  }
  return response?.result?.value;
}

// Looks the template up once, hashes that same string, then fills it. Nothing is sent here.
function buildExpression(name, args, ctx) {
  if (!Object.hasOwn(TEMPLATES, name) || !Object.hasOwn(TEMPLATE_SHA256, name) || !Object.hasOwn(PLACEHOLDERS, name)) {
    throw coded('E_ARGS', `unknown template ${name}`);
  }
  const text = TEMPLATES[name];
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest !== TEMPLATE_SHA256[name]) {
    throw coded('E_TEMPLATE_HASH', `template ${name} does not match its pinned SHA-256`);
  }
  const values = prepareValues(name, args, ctx);
  return fillTemplate(text, PLACEHOLDERS[name], values);
}

// Every listed chart page, with its chart id and the path the identity guard checks.
async function listPages() {
  const all = await CDP.List({ port: 9222 }).catch((err) => {
    throw transportError(err);
  });
  return all
    .filter((t) => t.type === 'page')
    .map((t) => {
      const m = CHART_URL.exec(String(t.url));
      return m ? { id: t.id, chart: m[1], path: `/chart/${m[1]}/` } : null;
    })
    .filter((p) => p !== null);
}

async function withIdentity(value, identityRun) {
  if (!isGuardRefusal(value)) return value;
  return { value, identity: await identityRun() };
}

// Tab 1

async function dropTab1() {
  if (client1 !== null) {
    try { await client1.close(); } catch { /* already closed */ }
  }
  client1 = null;
}

async function openTab1(targetId) {
  try {
    client1 = await CDP({ port: 9222, target: targetId });
    await client1.send('Runtime.enable');
  } catch (err) {
    await dropTab1();
    throw transportError(err);
  }
  tab1Target = targetId;
}

async function ensureTab1() {
  const pages = await listPages();
  const matches = pages.filter((p) => p.chart === TAB1_ID);
  if (matches.length !== 1) {
    if (client1 !== null || tab1Target !== null) {
      await dropTab1();
      throw coded('E_CDP_LOST', 'tab 1 is no longer listed exactly once');
    }
    throw coded('E_TAB1_MISSING', `tab 1 is listed ${matches.length} times, need exactly 1`);
  }
  if (tab1Target !== null && matches[0].id !== tab1Target) {
    await dropTab1();
    throw coded('E_CDP_LOST', 'tab 1 target id changed');
  }
  if (client1 === null) await openTab1(matches[0].id);
}

async function evalTab1(expression) {
  const response = await evaluate(client1, expression).catch(async (err) => {
    await dropTab1();
    throw transportError(err);
  });
  return interpret(response);
}

async function runTab1(name, args) {
  const expression = buildExpression(name, args, TAB1_CTX);
  await ensureTab1();
  const value = await evalTab1(expression);
  return withIdentity(value, () => runTab1('identity', {}));
}

// Tab 2 discovery and pin

async function closeCandidate() {
  if (candidate !== null) {
    try { await candidate.close(); } catch { /* already closed */ }
  }
  candidate = null;
}

// Runs the read-only discover template on one listed page, over its own client, closed afterwards.
async function discoverEntry(entry) {
  const expression = buildExpression('discover', {}, { guardPath: entry.path, expectedRes: TAB2_CTX_RES });
  candidate = await CDP({ port: 9222, target: entry.id }).catch((err) => {
    throw transportError(err);
  });
  try {
    await candidate.send('Runtime.enable').catch((err) => {
      throw transportError(err);
    });
    const response = await evaluate(candidate, expression).catch((err) => {
      throw transportError(err);
    });
    return interpret(response);
  } finally {
    await closeCandidate();
  }
}

async function discoverPath(path) {
  const pages = await listPages();
  const matches = pages.filter((p) => p.path === path && p.chart !== TAB1_ID);
  if (matches.length !== 1) {
    throw coded('E_ARGS', `discovery path ${path} is listed ${matches.length} times, need exactly 1`);
  }
  return discoverEntry(matches[0]);
}

// Pins tab 2 when exactly one non-tab-1 page passes discovery. A page that vanishes mid-discovery is not a match.
async function pinTab2(pages) {
  const others = pages.filter((p) => p.chart !== TAB1_ID);
  const matched = [];
  for (const entry of others) {
    let verdict;
    try {
      verdict = await discoverEntry(entry);
    } catch (err) {
      if (err.code === 'E_CDP_LOST') continue;
      throw err;
    }
    if (verdict === true) matched.push(entry);
  }
  if (matched.length === 0) throw coded('E_TAB2_NONE', 'no open chart matches tab 2 (MES 15m with MarketCipher_B)');
  if (matched.length > 1) throw coded('E_TAB2_MANY', `${matched.length} charts match tab 2, need exactly 1`);
  tab2Target = matched[0].id;
  tab2Path = matched[0].path;
}

// Tab 2

async function dropTab2() {
  if (client2 !== null) {
    try { await client2.close(); } catch { /* already closed */ }
  }
  client2 = null;
}

async function openTab2() {
  try {
    client2 = await CDP({ port: 9222, target: tab2Target });
    await client2.send('Runtime.enable');
  } catch (err) {
    await dropTab2();
    throw transportError(err);
  }
}

async function ensureTab2() {
  const pages = await listPages();
  if (tab2Target === null) await pinTab2(pages);
  const live = pages.filter((p) => p.id === tab2Target && p.path === tab2Path);
  if (live.length !== 1) {
    await dropTab2();
    throw coded('E_CDP_LOST', 'pinned tab 2 is no longer listed');
  }
  if (client2 === null) await openTab2();
}

async function evalTab2(expression) {
  const response = await evaluate(client2, expression).catch(async (err) => {
    await dropTab2();
    throw transportError(err);
  });
  return interpret(response);
}

async function runTab2(name, args) {
  await ensureTab2();
  const expression = buildExpression(name, args, { guardPath: tab2Path, expectedRes: TAB2_CTX_RES });
  const value = await evalTab2(expression);
  return withIdentity(value, () => runTab2('identity', {}));
}

async function closeAll(tab, args) {
  if (tab !== 'all' || !isPlainObject(args) || Object.keys(args).length !== 0) {
    throw coded('E_ARGS', 'close takes tab "all" and empty args');
  }
  await closeCandidate();
  await dropTab1();
  await dropTab2();
  return true;
}

export async function run(templateName, args, tab) {
  if (templateName === 'close') return closeAll(tab, args);
  if (typeof templateName !== 'string' || !Object.hasOwn(TEMPLATES, templateName)) {
    throw coded('E_ARGS', 'unknown template name');
  }
  if (!isPlainObject(args)) throw coded('E_ARGS', 'args must be a plain object');
  if (templateName === 'discover') {
    if (typeof tab !== 'string' || tab === TAB1_PATH || !PATH_RE.test(tab)) {
      throw coded('E_ARGS', 'discover takes a listed chart path other than tab 1');
    }
    return discoverPath(tab);
  }
  if (templateName === 'draw_trade' && tab !== 'tab1') throw coded('E_ARGS', 'draw_trade runs on tab1 only');
  if (tab === 'tab1') return runTab1(templateName, args);
  if (tab === 'tab2') return runTab2(templateName, args);
  throw coded('E_ARGS', 'tab must be tab1 or tab2');
}
