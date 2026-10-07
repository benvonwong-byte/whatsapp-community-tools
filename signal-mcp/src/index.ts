#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config";
import { SignalDesktopSource } from "./desktop";
import { Identity } from "./identity";
import { Ingestor } from "./ingest";
import { log } from "./log";
import { SignalCliClient } from "./signal-cli";
import { SignalStore } from "./store";
import { registerTools, serverInstructions } from "./tools";

const USAGE = `signal-mcp — MCP server for Signal (reads Signal Desktop; signal-cli for sending)

Usage:
  signal-mcp           Run the MCP server on stdio (what Claude launches)
  signal-mcp bridge    Only keep the archive up to date (no MCP); run this always-on
                       so the archive stays current while Claude is closed

Environment:
  SIGNAL_DESKTOP_DIR   Signal Desktop's data folder (default: its standard location)
  SIGNAL_DESKTOP_CHATS Comma-separated chat names to import from Signal Desktop
  SIGNAL_CLI_URL       signal-cli HTTP daemon, needed for sending (default http://127.0.0.1:8080)
  SIGNAL_ACCOUNT       Your Signal number for signal-cli, e.g. +15551234567
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
  const identity = new Identity(store);
  const desktop =
    config.desktop.enabled && SignalDesktopSource.isInstalled() ? new SignalDesktopSource(store, identity) : null;
  // signal-cli is optional when Signal Desktop provides the history; it's what sending needs.
  const useSignalCli = config.signalCliConfigured || !desktop;
  const client = new SignalCliClient(config.signalCliUrl, config.account);
  const ingestor = new Ingestor(store, client, identity);

  const startSources = () => {
    desktop?.start();
    if (useSignalCli) ingestor.start();
  };
  const shutdown = () => {
    desktop?.stop();
    ingestor.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const sources = [desktop && `Signal Desktop (${desktop.dir})`, useSignalCli && `signal-cli (${config.signalCliUrl})`];
  if (command === "bridge") {
    log(`Bridge archiving Signal messages from ${sources.filter(Boolean).join(" and ")} into ${config.dbPath}`);
    startSources();
    return;
  }

  const server = new McpServer(
    { name: "signal", version: "0.1.0" },
    { instructions: serverInstructions({ sending: useSignalCli, desktop: Boolean(desktop) }) }
  );
  registerTools(server, { store, client, identity, desktop, sending: useSignalCli });

  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  // The SDK transport doesn't watch for EOF, and the event stream would otherwise keep us alive.
  process.stdin.on("end", shutdown);
  await server.connect(transport);
  if (config.ingest) startSources();
  log(`MCP server ready (sources: ${sources.filter(Boolean).join(", ")}; db: ${config.dbPath})`);
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
