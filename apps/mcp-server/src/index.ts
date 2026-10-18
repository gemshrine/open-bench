#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './bridge-client.js';
import { createServer } from './server.js';

/**
 * OpenBench MCP server (stdio). It holds no circuit state of its own: every tool call is
 * forwarded over the loopback bridge to the running OpenBench window.
 * Logs go to stderr — stdout is reserved for the MCP protocol.
 */
async function main(): Promise<void> {
  const bridge = new BridgeClient();
  const server = createServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('openbench-mcp: ready (stdio)\n');
  const shutdown = () => {
    bridge.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`openbench-mcp: fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
