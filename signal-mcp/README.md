# signal-mcp

An MCP server that lets Claude search your Signal history and keeps a catalog of every link and file shared in your chats and groups. It is the Signal counterpart to the [WhatsApp MCP server](https://github.com/lharries/whatsapp-mcp): same tool names, same output style, so prompts that work for WhatsApp work here too.

It reads messages from two possible sources, into one local archive:

```
Signal Desktop on this Mac (its local database)  ─┐
                                                   ├─▶ signal-mcp archive (SQLite) ⇄ Claude
signal-cli, optional (live capture + sending)    ─┘
```

- **Signal Desktop** (recommended): if Signal Desktop is set up on the Mac, signal-mcp imports everything it has, read-only, and checks for new messages every few minutes. Nothing else needs to be installed.
- **[signal-cli](https://github.com/AsamK/signal-cli)** (optional): a separate linked device that lets Claude *send* messages, files, and reactions, and captures messages as they arrive. Without Signal Desktop it's the only source, and history starts when you link it, since Signal keeps no message history on its servers.

The archive keeps messages even after they're removed from Signal Desktop. Everything stays on your machine.

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
| `list_links` | Every link shared in your chats: where, by whom, when, how often, and its preview title |
| `list_files` | Images, videos, audio, and documents shared in your chats |
| `export_links` | Save the link catalog as CSV (for Sheets, Notion, Airtable) or Markdown (organized by chat) |
| `download_attachment` | Save an attachment to disk (decrypting Signal Desktop's copy) and return its path |
| `sync_signal_desktop` | Import from Signal Desktop now, or re-read all of it |
| `get_status` | Where messages come from and how much is archived |
| `send_message` | *With signal-cli:* send to a person, group, or Note to Self, optionally as a quote-reply |
| `send_file` | *With signal-cli:* send an image, video, audio file, or document |
| `send_reaction` | *With signal-cli:* react to a message with an emoji |

Chats are identified by `chat_id`: the contact's Signal UUID for 1:1 chats, `group:<id>` for groups, and `self` for Note to Self. Messages have an integer `message_id`. Edits, deletions, reactions, quotes, and @mentions are tracked.

## Link catalog

Every message is scanned for links, both in the text and in Signal's link previews. Each link is recorded with the chat, the sender, the time, and the preview's title and description. Tracking parameters (`utm_*`, `fbclid`, and similar) are stripped. Variants of the same URL (with or without `www.`, `http` vs `https`, a trailing slash, a `#fragment`) are recognized as one link. So when an article goes round several groups, `list_links` shows it once, with how many times and where it was shared.

Things to ask Claude:

- "What links were shared in Book Club this month?"
- "Which articles have been shared in more than one of my groups?"
- "Find the YouTube links Alice sent me."
- "Export all links from my climate groups as a CSV."

Exports go to `~/.signal-mcp/exports/`. CSV has one row per link, with columns for the chats and people that shared it. Markdown has one section per chat.

## Setup (macOS, with Signal Desktop)

You need Node.js 20 or newer, and Signal Desktop set up and linked on the Mac.

### 1. Build signal-mcp

```sh
cd signal-mcp
npm install
npm run build
```

### 2. Connect it to Claude

**Claude Desktop:** add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "signal": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/whatsapp-community-tools/signal-mcp/dist/index.js"]
    }
  }
}
```

Use the full path that `which node` prints. Claude Desktop doesn't use your shell's `PATH`, and the native SQLite module only works with the Node version you ran `npm install` with.

**Claude Code:**

```sh
claude mcp add signal -- "$(which node)" "$PWD/dist/index.js"
```

### 3. Allow Keychain access

Signal Desktop encrypts its database with a key it keeps in the macOS Keychain. The first time signal-mcp starts, macOS asks whether `security` may use the "Signal Safe Storage" item.

- **Allow**: macOS asks again each time signal-mcp starts.
- **Always Allow**: no more prompts, but any program that uses macOS's `security` tool could then read the key without asking.

If you click Deny, automatic imports pause until you ask Claude to run `sync_signal_desktop`.

The first import runs in the background and can take a minute on a large history. Ask Claude "what's my Signal status?" to see progress.

### 4. Optional: keep the archive current while Claude is closed

The MCP server imports while Claude is running. To keep importing around the clock, for example to capture messages before Signal Desktop deletes them, run the bridge as a background service using [`launchd/com.signal-mcp.bridge.plist`](launchd/com.signal-mcp.bridge.plist). Edit the paths in it first, then:

```sh
cp launchd/com.signal-mcp.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.signal-mcp.bridge.plist
```

## Optional: sending with signal-cli

To let Claude send messages, add signal-cli as a second linked device:

```sh
brew install signal-cli qrencode
signal-cli link -n "Claude" | tee >(xargs -L 1 qrencode -t utf8)
```

On your phone, open Signal → Settings → Linked devices → Link new device, and scan the QR code. Check it worked with `signal-cli listAccounts`. (Homebrew's signal-cli brings its own Java. A manual install of 0.14 or newer needs Java 25.)

Run the daemon, and keep it running with [`launchd/org.asamk.signal-cli.plist`](launchd/org.asamk.signal-cli.plist):

```sh
signal-cli -a +15551234567 daemon --http=127.0.0.1:8080 --receive-mode=on-connection --no-receive-stdout
```

Then add `"env": { "SIGNAL_CLI_URL": "http://127.0.0.1:8080", "SIGNAL_ACCOUNT": "+15551234567" }` to the Claude config above. The send tools appear once `SIGNAL_CLI_URL` is set.

`--receive-mode=on-connection` makes signal-cli fetch messages only while signal-mcp is connected; otherwise they wait on Signal's servers. Signal unlinks devices that haven't connected for about 30 days, so if you rarely open Claude, run the bridge too.

Without Signal Desktop on the machine, signal-cli is used automatically and is the only source of messages.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNAL_DESKTOP_DIR` | `~/Library/Application Support/Signal` | Signal Desktop's data folder |
| `SIGNAL_DESKTOP_CHATS` | all chats | Comma-separated chat names to import from Signal Desktop, e.g. `Book Club,Climate Crew` |
| `SIGNAL_DESKTOP_SYNC_MINUTES` | `5` | How often to check Signal Desktop for new messages |
| `SIGNAL_DESKTOP` | `1` | Set to `0` to ignore Signal Desktop |
| `SIGNAL_CLI_URL` | none | signal-cli HTTP daemon; setting it enables sending (default `http://127.0.0.1:8080` when there's no Signal Desktop) |
| `SIGNAL_ACCOUNT` | none | Your Signal number for signal-cli (`+15551234567`) |
| `SIGNAL_MCP_DB` | `~/.signal-mcp/messages.db` | The archive |
| `SIGNAL_MCP_DOWNLOAD_DIR` | `~/.signal-mcp/downloads` | Where `download_attachment` saves files |
| `SIGNAL_MCP_EXPORT_DIR` | `~/.signal-mcp/exports` | Where `export_links` writes files |
| `SIGNAL_MCP_ARCHIVE_DISAPPEARING` | `0` | Set to `1` to also archive disappearing messages (see below) |
| `SIGNAL_MCP_INGEST` | `1` | Set to `0` if only the bridge should write to the archive |

`SIGNAL_DESKTOP_CHATS` matches chat names case-insensitively, so `book` matches "Book Club". Changing it re-reads Signal Desktop's history for the chats you add.

## Privacy and safety

- signal-mcp only reads Signal Desktop's data. It never writes to it.
- The archive at `~/.signal-mcp/messages.db` stores messages unencrypted, unlike Signal Desktop's own database. Treat it like your Signal data. The Keychain-derived key is held only in memory.
- Disappearing messages are not archived by default, because the chat chose not to keep them. `get_status` shows how many were skipped. Set `SIGNAL_MCP_ARCHIVE_DISAPPEARING=1` to keep them anyway.
- When someone deletes a message for everyone, its text, attachments, and links are removed from the archive too.
- The send tools act as you. They are marked as non-read-only, so Claude asks for approval before using them (unless you've allowed them).
- The signal-cli HTTP daemon has no authentication. Keep it bound to `127.0.0.1`.

## Development

```sh
npm test        # unit and end-to-end tests
npm run dev     # run from source with tsx
```

The end-to-end tests start the real MCP server over stdio and drive it with the MCP client SDK, against:

- a fake `signal-cli daemon --http` that sends events shaped like signal-cli's JSON output;
- a fake Signal Desktop profile, encrypted with Signal Desktop's own SQLCipher library and its key and attachment encryption.
