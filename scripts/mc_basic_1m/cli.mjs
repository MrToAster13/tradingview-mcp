/**
 * The one entry point that connects the commands to the live chart (api_v1, "Dependency injection
 * for commands"). It builds the real deps from cdp.mjs, stdout and stderr, calls the chosen
 * command's main with the flags after the command name, sets the exit code, and closes every
 * chart client on the way out.
 * Usage: node scripts/mc_basic_1m/cli.mjs <command> [flags]
 * Commands: draw, snapshot (also snapshot --forward), recorder, resolve, clear, broker-reset.
 * The report needs no chart and keeps its own entry point in report.mjs.
 * Tests never import this file; lint.test.mjs checks that.
 */
import { run } from './cdp.mjs';
import { main as drawMain } from './draw.mjs';
import { main as snapshotMain } from './snapshot.mjs';
import { main as recorderMain } from './recorder.mjs';
import { main as resolveMain } from './resolve.mjs';
import { main as clearMain } from './clear.mjs';
import { main as brokerResetMain } from './broker.mjs';

const COMMANDS = Object.freeze({
  draw: drawMain,
  snapshot: snapshotMain,
  recorder: recorderMain,
  resolve: resolveMain,
  clear: clearMain,
  'broker-reset': brokerResetMain,
});

const USAGE = `usage: node scripts/mc_basic_1m/cli.mjs <${Object.keys(COMMANDS).join('|')}> [flags]`;

const deps = Object.freeze({
  run,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  out: (line) => { process.stdout.write(`${line}\n`); },
  err: (line) => { process.stderr.write(`${line}\n`); },
});

async function start() {
  const name = process.argv[2];
  if (typeof name !== 'string' || !Object.hasOwn(COMMANDS, name)) {
    deps.err(name === undefined ? 'no command given' : `unknown command ${name}`);
    deps.err(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const code = await COMMANDS[name](process.argv.slice(3), deps);
    process.exitCode = Number.isInteger(code) ? code : 1;
  } catch (e) {
    deps.err(`${e && e.code ? e.code : 'E_FAILED'}: ${e && e.message ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    try {
      await run("close", {}, "all");
    } catch (e) {
      deps.err(`closing the chart clients failed: ${e && e.message ? e.message : String(e)}`);
      if (process.exitCode === 0) process.exitCode = 1;
    }
  }
}

await start();
