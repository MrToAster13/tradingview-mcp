import { register } from '../router.js';
import * as core from '../../core/health.js';
import { update } from '../../core/update.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    kill: { type: 'boolean', description: 'Kill running TradingView instances first (off by default)' },
    'no-kill': { type: 'boolean', description: 'Do not kill running instances (the default; kept for old scripts)' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: Boolean(opts.kill) && !opts['no-kill'],
  }),
});

register('update', {
  description: 'Update to the latest version (git fast-forward + npm ci if deps changed)',
  handler: () => update({}),
});
