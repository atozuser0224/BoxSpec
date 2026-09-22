import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createBoxSpecMcpServer } from "./server.js";
import type { BridgeCoreUseCases, BridgeOptions } from "./types.js";

/**
 * Start the dual-era official SDK stdio server. The caller owns Core lifetime.
 * This function never writes diagnostics to stdout.
 */
export function serveBoxSpecStdio(
  core: BridgeCoreUseCases,
  options: BridgeOptions
): StdioServerHandle {
  return serveStdio(() => createBoxSpecMcpServer(core, options), {
    onerror(error) {
      process.stderr.write(`[boxspec-mcp] BoxSpec MCP stdio transport error: ${formatError(error)}\n`);
    }
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
