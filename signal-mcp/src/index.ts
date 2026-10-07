#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config";
import { Ingestor } from "./ingest";
import { log } from "./log";
import { SignalCliClient } from "./signal-cli";
import { SignalStore } from "./store";
import { SERVER_INSTRUCTIONS, registerTools } from "./tools";

const USAGE = `signal-mcp — MCP server for Signal (via signal-cli)

Usage:
  signal-mcp           Run the MCP server on stdio (what Claude launches)
  signal-mcp bridge    Only capture incoming messages into the database; run this
                       always-on so nothing is missed while Claude is closed

Environment:
  SIGNAL_CLI_URL       signal-cli HTTP daemon (default http://127.0.0.1:8080)
  SIGNAL_ACCOUNT       Your Signal number, e.g. +15551234567
  SIGNAL_MCP_DB        SQLite database (default ~/.signal-mcp/messages.db)
  SIGNAL_MCP_INGEST    Set to 0 to stop the MCP server capturing messages itself`;

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h" || command === "help") {
    console.error(USAGE);
    return;
  }
  if (command && command !== "bridge" && command !== "serve") {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(1);
  }

  const store = new SignalStore(config.dbPath);
  const client = new SignalCliClient(config.signalCliUrl, config.account);
  const ingestor = new Ingestor(store, client);

  const shutdown = () => {
    ingestor.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (command === "bridge") {
    log(`Bridge capturing Signal messages from ${config.signalCliUrl} into ${config.dbPath}`);
    ingestor.start();
    return;
  }

  const server = new McpServer({ name: "signal", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, { store, client, ingestor });
  if (config.ingest) ingestor.start();

  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  // The SDK transport doesn't watch for EOF, and the event stream would otherwise keep us alive.
  process.stdin.on("end", shutdown);
  await server.connect(transport);
  log(`MCP server ready (signal-cli: ${config.signalCliUrl}, db: ${config.dbPath})`);
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
