import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create_server.js';

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');

if (process.argv.slice(2).includes('--http')) {
  // Streamable HTTP mode on 127.0.0.1 (see src/http.js). Exits 1 on bad config.
  const { main } = await import('./http.js');
  await main();
} else {
  // Start stdio transport
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
