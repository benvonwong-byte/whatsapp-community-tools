# signal-mcp

An MCP server that lets Claude read, search, and send your Signal messages, and keeps a catalog of every link and file shared in your chats and groups. It is the Signal counterpart to the [WhatsApp MCP server](https://github.com/lharries/whatsapp-mcp): same tool names, same output style, so prompts that work for WhatsApp work here too.

```
Signal on your phone ⇄ signal-cli (a linked device on your Mac) ⇄ signal-mcp (SQLite + MCP tools) ⇄ Claude
```

[signal-cli](https://github.com/AsamK/signal-cli) links to your Signal account as a secondary device, like Signal Desktop. signal-mcp follows its event stream, saves every message to a local SQLite database, and exposes that database to Claude as MCP tools. Everything stays on your machine.

> **Signal keeps no message history on its servers.** signal-cli only sees messages that arrive after you link it, so the database starts empty and fills up from then on.

## Tools

| Tool | What it does |
| --- | --- |
| `search_contacts` | Find contacts by name, phone number, or username |
| `list_chats` | List 1:1 chats and groups, most recent first |
| `get_chat` | Metadata and last message for a chat |
| `get_direct_chat_by_contact` | The 1:1 chat for a phone number / UUID / username |
| `get_contact_chats` | A contact's 1:1 chat plus the groups they share with you |
| `get_last_interaction` | Most recent message involving a contact |
| `list_messages` | Search messages by text, sender, chat, and date range, with surrounding context |
| `get_message_context` | Messages before and after a given message |
| `send_message` | Send a message to a person, group, or Note to Self, optionally as a quote-reply |
| `send_file` | Send an image, video, audio file, or document |
| `send_reaction` | React to a message with an emoji (or remove a reaction) |
| `download_attachment` | Save a received attachment to disk and return its path |
| `list_links` | Every link shared in your chats: where, by whom, when, how often, and its preview title |
| `list_files` | Images, videos, audio, and documents shared in your chats |
| `export_links` | Save the link catalog as CSV (for Sheets, Notion, Airtable) or Markdown (organized by chat) |
| `get_status` | Check the signal-cli connection and how much is stored |

Chats are identified by `chat_id`: the contact's Signal UUID for 1:1 chats, `group:<id>` for groups, and `self` for Note to Self. Messages have an integer `message_id`. Edits, deletions, reactions, quotes, and @mentions are tracked.

## Link catalog

Every message is scanned for links, both in the text and in Signal's link previews. Each link is recorded with the chat, the sender, the time, and the preview's title and description. Tracking parameters (`utm_*`, `fbclid`, and similar) are stripped. Variants of the same URL (with or without `www.`, `http` vs `https`, a trailing slash, a `#fragment`) are recognized as one link. So when an article goes round several groups, `list_links` shows it once, with how many times and where it was shared.

Things to ask Claude:

- "What links were shared in Book Club this month?"
- "Which articles have been shared in more than one of my groups?"
- "Find the YouTube links Alice sent me."
- "Export all links from my climate groups as a CSV."

Exports go to `~/.signal-mcp/exports/`. CSV has one row per link, with columns for the chats and people that shared it. Markdown has one section per chat.

Like messages, links are only catalogued from the point signal-mcp starts capturing.

## Setup (macOS)

You need Node.js 20 or newer and Homebrew.

### 1. Install signal-cli and link it to your phone

```sh
brew install signal-cli qrencode
signal-cli link -n "Claude" | tee >(xargs -L 1 qrencode -t utf8)
```

On your phone, open Signal → Settings → Linked devices → Link new device, and scan the QR code. Then check it worked:

```sh
signal-cli listAccounts
```

(Homebrew's signal-cli brings its own Java. A manual install of signal-cli 0.14 or newer needs Java 25, or use the native build from the signal-cli releases page.)

### 2. Run the signal-cli daemon

```sh
signal-cli -a +15551234567 daemon --http=127.0.0.1:8080 --receive-mode=on-connection --no-receive-stdout
```

`--receive-mode=on-connection` makes signal-cli fetch messages only while signal-mcp is connected. While nothing is connected, messages wait on Signal's servers and arrive the next time Claude starts, so they are not lost. `--no-receive-stdout` keeps message contents out of the daemon's log.

To keep the daemon running in the background, use the LaunchAgent template in [`launchd/org.asamk.signal-cli.plist`](launchd/org.asamk.signal-cli.plist). Put your number in it, then:

```sh
cp launchd/org.asamk.signal-cli.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.asamk.signal-cli.plist
```

### 3. Build signal-mcp

```sh
cd signal-mcp
npm install
npm run build
```

### 4. Connect it to Claude

**Claude Desktop:** add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "signal": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/whatsapp-community-tools/signal-mcp/dist/index.js"],
      "env": { "SIGNAL_ACCOUNT": "+15551234567" }
    }
  }
}
```

Use the full path that `which node` prints. Claude Desktop doesn't use your shell's `PATH`, and the native SQLite module only works with the Node version you ran `npm install` with.

**Claude Code:**

```sh
claude mcp add signal -e SIGNAL_ACCOUNT=+15551234567 -- "$(which node)" "$PWD/dist/index.js"
```

Ask Claude "what's my Signal status?" to check that everything is connected.

### 5. Optional: capture messages around the clock

The MCP server captures messages while Claude is running. To keep the database current even while Claude is closed, run the bridge as a background service using [`launchd/com.signal-mcp.bridge.plist`](launchd/com.signal-mcp.bridge.plist):

```sh
cp launchd/com.signal-mcp.bridge.plist ~/Library/LaunchAgents/   # after editing the paths and number
launchctl load ~/Library/LaunchAgents/com.signal-mcp.bridge.plist
```

The always-on bridge also keeps the linked device active. Signal unlinks devices that haven't connected for about 30 days.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNAL_ACCOUNT` | none | Your Signal number (`+15551234567`). Required if the daemon serves several accounts. |
| `SIGNAL_CLI_URL` | `http://127.0.0.1:8080` | Address of the signal-cli HTTP daemon |
| `SIGNAL_MCP_DB` | `~/.signal-mcp/messages.db` | SQLite database |
| `SIGNAL_MCP_DOWNLOAD_DIR` | `~/.signal-mcp/downloads` | Where `download_attachment` saves files |
| `SIGNAL_CLI_ATTACHMENTS_DIR` | `~/.local/share/signal-cli/attachments` | Where signal-cli stores received attachments (a fast path; otherwise they're fetched over RPC) |
| `SIGNAL_MCP_INGEST` | `1` | Set to `0` if only the bridge should write to the database |
| `SIGNAL_MCP_EXPORT_DIR` | `~/.signal-mcp/exports` | Where `export_links` writes files |
| `SIGNAL_MCP_ARCHIVE_DISAPPEARING` | `0` | Set to `1` to also archive disappearing messages (see below) |

signal-cli can also run in Docker or on another machine. Point `SIGNAL_CLI_URL` at it. Files are sent as data URIs and attachments are fetched over RPC, so no shared filesystem is needed.

## Privacy and safety

- `~/.signal-mcp/messages.db` stores your messages unencrypted, and `~/.local/share/signal-cli` holds your Signal keys. Treat both like your Signal Desktop data.
- The send tools act as you. They are marked as non-read-only, so Claude asks for approval before using them (unless you've allowed them).
- The signal-cli HTTP daemon has no authentication. Keep it bound to `127.0.0.1`.
- Disappearing messages are not archived by default, because the chat chose not to keep them. `get_status` shows how many were skipped. Set `SIGNAL_MCP_ARCHIVE_DISAPPEARING=1` to keep them anyway.
- When someone deletes a message for everyone, its text, attachments, and links are removed from the archive too.

## Development

```sh
npm test        # end-to-end tests against a mock signal-cli daemon
npm run dev     # run from source with tsx
```

The tests start the real MCP server over stdio and drive it with the MCP client SDK. A fake `signal-cli daemon --http` sends events shaped like signal-cli's JSON output.
