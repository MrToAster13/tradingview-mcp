/*
 * In-memory chart session for tests. fakeChart() returns a deps object for the command mains:
 * run, now, sleep, out and err, plus the records a test inspects (calls, sleeps, stdout, stderr
 * and clock).
 *
 * Its run takes the same three arguments as cdp.mjs (template name, args, tab) and makes the
 * same front-door checks before any reply. close takes tab "all" and empty args. An unknown
 * name or non-object args is E_ARGS. The write template runs on tab1 only. discover takes a
 * chart path other than tab 1. Every template then goes through prepareValues with the tab's
 * guard path and resolution, and fillTemplate, as cdp.mjs does, so bad args fail here too.
 * Nothing is evaluated. The reply comes from the test.
 *
 * Replies are keyed "name tab" (for example "read_history tab2") or by name alone. A reply is a
 * constant or a function of (args, tab, n), where n counts the earlier calls with that name and
 * tab. A reply that is an Error is thrown. Results are deep copies, so a command never changes
 * a fixture. An "E_GUARD" refusal comes back as { value, identity }, as cdp.mjs returns it.
 */
import { TEMPLATES, PLACEHOLDERS, prepareValues, fillTemplate } from './templates.mjs';

const TAB1_PATH = '/chart/HCCCDVCt/';
const PATH_RE = /^\/chart\/[A-Za-z0-9]+\/$/;
const READS = Object.freeze(['identity', 'discover', 'read_history', 'read_shapes']);

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGuardRefusal(value) {
  return value === 'E_GUARD' || (Array.isArray(value) && value[0] === 'E_GUARD');
}

/** Replies that walk a list: the n-th call gets items[n], and the last item repeats. */
export function sequence(...items) {
  return (args, tab, n) => items[Math.min(n, items.length - 1)];
}

/** A coded Error, the shape cdp.mjs throws (E_CDP_LOST, E_TAB2_NONE and the rest). */
export function chartError(code, message = code) {
  return coded(code, message);
}

/**
 * options.replies: the reply table described above.
 * options.now: the starting clock in ms. options.advanceClock: sleep adds its ms to the clock
 * (default true). options.afterSleep(fake): runs after each sleep.
 * options.tab2Path: the chart path tab 2 is pinned to (default /chart/FAKETAB2/).
 */
export function fakeChart({ replies = {}, now = 0, advanceClock = true, afterSleep = null, tab2Path = '/chart/FAKETAB2/' } = {}) {
  if (!PATH_RE.test(tab2Path) || tab2Path === TAB1_PATH) throw coded('E_ARGS', 'tab2Path must be a chart path other than tab 1');
  const counts = new Map();
  const fake = {
    replies,
    calls: [],
    sleeps: [],
    stdout: [],
    stderr: [],
    clock: { t: now },
  };

  function contextFor(name, tab) {
    if (name === 'discover') {
      if (typeof tab !== 'string' || tab === TAB1_PATH || !PATH_RE.test(tab)) {
        throw coded('E_ARGS', 'discover takes a listed chart path other than tab 1');
      }
      return { guardPath: tab, expectedRes: '15' };
    }
    if (!READS.includes(name) && tab !== 'tab1') throw coded('E_ARGS', `${name} runs on tab1 only`);
    if (tab === 'tab1') return { guardPath: TAB1_PATH, expectedRes: '1' };
    if (tab === 'tab2') return { guardPath: tab2Path, expectedRes: '15' };
    throw coded('E_ARGS', 'tab must be tab1 or tab2');
  }

  function reply(name, args, tab) {
    const key = `${name} ${tab}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    let r;
    if (Object.hasOwn(replies, key)) r = replies[key];
    else if (Object.hasOwn(replies, name)) r = replies[name];
    else throw new Error(`fake chart has no reply for ${name} on ${tab}`);
    const value = typeof r === 'function' ? r(args, tab, n) : r;
    if (value instanceof Error) throw value;
    return value === undefined ? undefined : structuredClone(value);
  }

  async function run(name, args, tab) {
    fake.calls.push({ name, args: isPlainObject(args) ? structuredClone(args) : args, tab });
    if (name === 'close') {
      if (tab !== 'all' || !isPlainObject(args) || Object.keys(args).length !== 0) {
        throw coded('E_ARGS', 'close takes tab "all" and empty args');
      }
      return true;
    }
    if (typeof name !== 'string' || !Object.hasOwn(TEMPLATES, name)) throw coded('E_ARGS', 'unknown template name');
    if (!isPlainObject(args)) throw coded('E_ARGS', 'args must be a plain object');
    const ctx = contextFor(name, tab);
    fillTemplate(TEMPLATES[name], PLACEHOLDERS[name], prepareValues(name, args, ctx));
    const value = reply(name, args, tab);
    if (!isGuardRefusal(value)) return value;
    const identity = Object.hasOwn(replies, `identity ${tab}`) || Object.hasOwn(replies, 'identity')
      ? reply('identity', {}, tab)
      : true;
    return { value, identity };
  }

  fake.run = run;
  fake.now = () => fake.clock.t;
  fake.sleep = async (ms) => {
    fake.sleeps.push(ms);
    if (advanceClock) fake.clock.t += ms;
    if (afterSleep) afterSleep(fake);
  };
  fake.out = (line) => { fake.stdout.push(line); };
  fake.err = (line) => { fake.stderr.push(line); };
  return fake;
}
