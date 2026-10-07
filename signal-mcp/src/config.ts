import os from "os";
import path from "path";

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");

function defaultDesktopDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/Signal");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "Signal");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Signal");
}
const stateDir = expandHome(process.env.SIGNAL_MCP_DIR || "~/.signal-mcp");

export const config = {
  // signal-cli daemon started with `--http` (JSON-RPC at /api/v1/rpc, SSE at /api/v1/events)
  signalCliUrl: (process.env.SIGNAL_CLI_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""),
  // Phone number (+15551234567) or ACI of the linked account. Required when the daemon
  // serves multiple accounts; optional (but recommended) in single-account mode.
  account: process.env.SIGNAL_ACCOUNT?.trim() || undefined,
  dbPath: expandHome(process.env.SIGNAL_MCP_DB || path.join(stateDir, "messages.db")),
  downloadDir: expandHome(process.env.SIGNAL_MCP_DOWNLOAD_DIR || path.join(stateDir, "downloads")),
  // Where signal-cli saves received attachments. Used as a fast path before falling back
  // to the getAttachment RPC (which also works when the daemon runs in Docker).
  attachmentsDir: expandHome(
    process.env.SIGNAL_CLI_ATTACHMENTS_DIR || path.join(dataHome, "signal-cli/attachments")
  ),
  // The MCP server also listens for new messages while it runs. Set to 0 if a separate
  // `signal-mcp bridge` process is the only thing that should write to the database.
  ingest: process.env.SIGNAL_MCP_INGEST !== "0",
  // Disappearing messages are skipped by default, honouring the chat's choice not to keep them.
  archiveDisappearing: process.env.SIGNAL_MCP_ARCHIVE_DISAPPEARING === "1",
  exportDir: expandHome(process.env.SIGNAL_MCP_EXPORT_DIR || path.join(stateDir, "exports")),
  // signal-cli is used when SIGNAL_CLI_URL is set, or when there is no Signal Desktop to read.
  signalCliConfigured: Boolean(process.env.SIGNAL_CLI_URL),
  desktop: {
    enabled: process.env.SIGNAL_DESKTOP !== "0",
    dir: expandHome(process.env.SIGNAL_DESKTOP_DIR || defaultDesktopDir()),
    // Comma-separated chat names (or chat_ids) to import; empty imports every chat.
    chats: (process.env.SIGNAL_DESKTOP_CHATS || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    syncIntervalMs: Math.max(1, Number(process.env.SIGNAL_DESKTOP_SYNC_MINUTES) || 5) * 60 * 1000,
  },
  refreshIntervalMs: 30 * 60 * 1000,
};

export type Config = typeof config;
