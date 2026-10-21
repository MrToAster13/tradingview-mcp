import { register } from '../router.js';
import * as core from '../../core/drawing.js';

register('trades', {
  description: 'Paper-trading exports (import)',
  subcommands: new Map([
    ['import', {
      description: 'Draw long/short positions from the newest paper-trading CSV export in ~/Downloads',
      options: {
        export: { type: 'string', description: 'Export id YYYY-MM-DDTHH_MM_SS (default: newest)' },
        'dry-run': { type: 'boolean', description: 'Show the planned positions without touching the chart' },
      },
      handler: (opts) => core.drawTradesFromCsv({ export_timestamp: opts.export, dry_run: !!opts['dry-run'] }),
    }],
  ]),
});
