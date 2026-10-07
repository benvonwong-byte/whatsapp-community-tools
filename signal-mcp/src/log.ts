// stdout carries the MCP protocol, so all diagnostics go to stderr.
export function log(...args: unknown[]) {
  console.error(`[signal-mcp ${new Date().toISOString()}]`, ...args);
}
