import { register } from '../router.js';
import * as core from '../../core/health.js';
import { update } from '../../core/update.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

/**
 * Maps parsed `tv launch` flags to launch() options. The router parses with
 * strict: false, so `--kill=false` arrives as the string "false". Only
 * `--kill`, `--kill=true` or `--kill=1` turn killing on (TVMCP-R6).
 */
export function launchOptions(opts = {}) {
  const kill = opts.kill === true || (typeof opts.kill === 'string' && /^(?:true|1)$/i.test(opts.kill.trim()));
  return {
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: kill && !opts['no-kill'],
  };
}

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    kill: { type: 'boolean', description: 'Kill running TradingView instances first (off by default)' },
    'no-kill': { type: 'boolean', description: 'Do not kill running instances (the default; kept for old scripts)' },
  },
  handler: (opts) => core.launch(launchOptions(opts)),
});

register('update', {
  description: 'Update to the latest version (git fast-forward + npm ci if deps changed)',
  handler: () => update({}),
});
