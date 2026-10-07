import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ALICE, BOB, CAROL, GROUP2_ID, GROUP_ID, MockSignalCli, SELF_NUMBER, SELF_UUID } from "./mock-signal-cli";

const ROOT = path.resolve(__dirname, "..");
const T0 = Date.parse("2026-10-01T18:00:00Z");

function envFor(url: string, dir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    SIGNAL_CLI_URL: url,
    SIGNAL_ACCOUNT: SELF_NUMBER,
    SIGNAL_MCP_DB: path.join(dir, "messages.db"),
    SIGNAL_MCP_DOWNLOAD_DIR: path.join(dir, "downloads"),
    SIGNAL_CLI_ATTACHMENTS_DIR: path.join(dir, "no-local-attachments"),
  };
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const envelopes = {
  aliceAsks: {
    sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, sourceName: "Alice Smith", sourceDevice: 1,
    timestamp: T0, dataMessage: { timestamp: T0, message: "Hey, are we still on for dinner Friday?", expiresInSeconds: 0 },
  },
  iReply: {
    sourceNumber: SELF_NUMBER, sourceUuid: SELF_UUID, sourceName: "Me", sourceDevice: 1, timestamp: T0 + 60_000,
    syncMessage: {
      sentMessage: {
        destination: ALICE.number, destinationNumber: ALICE.number, destinationUuid: ALICE.uuid,
        timestamp: T0 + 60_000, message: "Yes! 7pm at Lucia's", expiresInSeconds: 0,
      },
    },
  },
  aliceHearts: {
    sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, sourceName: "Alice Smith", timestamp: T0 + 90_000,
    dataMessage: {
      timestamp: T0 + 90_000,
      reaction: { emoji: "❤️", targetAuthor: SELF_NUMBER, targetAuthorNumber: SELF_NUMBER, targetAuthorUuid: SELF_UUID, targetSentTimestamp: T0 + 60_000, isRemove: false },
    },
  },
  aliceEdits: {
    sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, sourceName: "Alice Smith", timestamp: T0 + 120_000,
    editMessage: { targetSentTimestamp: T0, dataMessage: { timestamp: T0 + 120_000, message: "Hey, are we still on for dinner Saturday?" } },
  },
  bobMentions: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, sourceName: "Bob Jones", timestamp: T0 + 180_000,
    dataMessage: {
      timestamp: T0 + 180_000, message: "￼ can you bring the wine?",
      mentions: [{ name: ALICE.number, number: ALICE.number, uuid: ALICE.uuid, start: 0, length: 1 }],
      groupInfo: { groupId: GROUP_ID, groupName: null, revision: 3, type: "DELIVER" },
    },
  },
  bobOops: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, timestamp: T0 + 200_000,
    dataMessage: { timestamp: T0 + 200_000, message: "wrong chat, sorry https://private.example.com/doc", groupInfo: { groupId: GROUP_ID, type: "DELIVER" } },
  },
  bobCrewLinks: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, sourceName: "Bob Jones", timestamp: T0 + 50_000,
    dataMessage: {
      timestamp: T0 + 50_000, message: "Also relevant https://nytimes.com/2026/10/01/climate.html/ and this talk https://youtu.be/abc123?si=TRACKING",
      groupInfo: { groupId: GROUP2_ID, groupName: null, revision: 1, type: "DELIVER" },
    },
  },
  bobBookClubLink: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, sourceName: "Bob Jones", timestamp: T0 + 100_000,
    dataMessage: {
      timestamp: T0 + 100_000, message: "Great read: https://www.nytimes.com/2026/10/01/climate.html?utm_source=signal&utm_medium=share.",
      previews: [{ url: "https://www.nytimes.com/2026/10/01/climate.html", title: "The Climate Report", description: "What the new numbers mean.", image: null }],
      groupInfo: { groupId: GROUP_ID, groupName: null, revision: 3, type: "DELIVER" },
    },
  },
  aliceCheck: {
    sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, sourceName: "Alice Smith", timestamp: T0 + 150_000,
    dataMessage: { timestamp: T0 + 150_000, message: "check this out" },
  },
  aliceAddsLinks: {
    sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, sourceName: "Alice Smith", timestamp: T0 + 160_000,
    editMessage: {
      targetSentTimestamp: T0 + 150_000,
      dataMessage: { timestamp: T0 + 160_000, message: "check https://en.wikipedia.org/wiki/Foo_(bar) (and https://www.nytimes.com/2026/10/01/climate.html)" },
    },
  },
  disappearing: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, timestamp: T0 + 20_000,
    dataMessage: { timestamp: T0 + 20_000, message: "secret plan https://secret.example.org/plan", expiresInSeconds: 604800, groupInfo: { groupId: GROUP_ID, type: "DELIVER" } },
  },
  bobDeletes: {
    sourceNumber: BOB.number, sourceUuid: BOB.uuid, timestamp: T0 + 210_000,
    dataMessage: { timestamp: T0 + 210_000, remoteDelete: { targetTimestamp: T0 + 200_000, timestamp: T0 + 200_000 }, groupInfo: { groupId: GROUP_ID, type: "DELIVER" } },
  },
  carolPhoto: {
    sourceNumber: null, sourceUuid: CAROL.uuid, sourceName: "Carol", timestamp: T0 + 240_000,
    dataMessage: { timestamp: T0 + 240_000, message: null, attachments: [{ contentType: "image/jpeg", filename: "menu.jpg", id: "Xyz123.jpg", size: 2048, isVoiceNote: false }] },
  },
  typing: { sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, timestamp: T0 + 250_000, typingMessage: { action: "STARTED", timestamp: T0 + 250_000 } },
  daveProfileKey: {
    sourceNumber: "+15554444444", sourceUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sourceName: "Dave", timestamp: T0 + 260_000,
    dataMessage: { timestamp: T0 + 260_000, message: null, isProfileKeyUpdate: true, hasProfileKey: true },
  },
  noteToSelf: {
    sourceNumber: SELF_NUMBER, sourceUuid: SELF_UUID, timestamp: T0 + 300_000,
    syncMessage: { sentMessage: { destinationNumber: SELF_NUMBER, destinationUuid: SELF_UUID, timestamp: T0 + 300_000, message: "Remember to buy milk" } },
  },
};

describe("signal-mcp", () => {
  let mock: MockSignalCli;
  let client: Client;
  let dir: string;

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    return { text: res.content.map((c: any) => c.text).join("\n") as string, isError: Boolean(res.isError) };
  }

  async function messageCount() {
    return JSON.parse((await call("get_status")).text).messages as number;
  }

  /** message_id of the first line in a list_messages result containing `needle`. */
  async function idOf(needle: string): Promise<number> {
    const { text } = await call("list_messages", { query: needle, include_context: false });
    const match = text.match(/\[message_id: (\d+)\]/);
    assert.ok(match, `no message matching "${needle}" in:\n${text}`);
    return Number(match[1]);
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-test-"));
    mock = new MockSignalCli();
    mock.attachments["Xyz123.jpg"] = Buffer.from("fake jpeg bytes");
    const url = await mock.start();

    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", path.join(ROOT, "src/index.ts")],
        cwd: ROOT,
        env: envFor(url, dir),
        stderr: "ignore",
      })
    );
    await mock.waitForClients(1);
    await until(() => mock.callsTo("listGroups").length > 0, "initial contact/group refresh");
    for (const env of Object.values(envelopes)) mock.push(env);
    await until(async () => (await messageCount()) >= 6, "events to be stored");
  });

  after(async () => {
    await client?.close();
    await mock?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("exposes the WhatsApp-MCP-style tool set", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      "search_contacts", "list_messages", "list_chats", "get_chat", "get_direct_chat_by_contact",
      "get_contact_chats", "get_last_interaction", "get_message_context", "send_message", "send_file",
      "download_attachment",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  test("search_contacts finds people by name, phone, and username, and hides self", async () => {
    assert.match((await call("search_contacts", { query: "alice" })).text, /Alice Smith/);
    assert.match((await call("search_contacts", { query: "555-222" })).text, /Bob Jones/);
    assert.match((await call("search_contacts", { query: "bob.42" })).text, /bb{7}-/);
    assert.match((await call("search_contacts", { query: "Me myself" })).text, /^No contacts match/);
  });

  test("list_chats shows named groups, contacts and Note to Self, most recent first", async () => {
    const chats = JSON.parse((await call("list_chats")).text);
    const names = chats.map((c: any) => c.name);
    assert.deepEqual(names.slice(0, 4), ["Note to Self", "Carol", "Book Club", "Alice Smith"]);
    assert.ok(!names.includes("Dave"), "events without content must not create chats");
    const group = chats.find((c: any) => c.name === "Book Club");
    assert.equal(group.chat_id, `group:${GROUP_ID}`);
    assert.match(group.last_message, /\[message deleted\]/);
    const alice = chats.find((c: any) => c.name === "Alice Smith");
    assert.equal(alice.chat_id, ALICE.uuid);
    assert.equal(alice.phone_number, ALICE.number);
  });

  test("list_messages applies edits, reactions, mentions, and context", async () => {
    const { text } = await call("list_messages", { query: "dinner" });
    assert.match(text, /=== Alice Smith \(chat_id: aaaaaaaa/);
    assert.match(text, /> \[.*\] From: Alice Smith: Hey, are we still on for dinner Saturday\? \(edited\)/);
    assert.match(text, /From: Me: Yes! 7pm at Lucia's \[reactions: ❤️ Alice Smith\]/);
    assert.doesNotMatch(text, /Friday/);

    const group = await call("list_messages", { chat_id: `group:${GROUP_ID}`, include_context: false });
    assert.match(group.text, /From: Bob Jones: @Alice Smith can you bring the wine\?/);
    assert.match(group.text, /From: Bob Jones: \[message deleted\]/);
    assert.doesNotMatch(group.text, /wrong chat/);

    const fromMe = await call("list_messages", { sender: "me", include_context: false });
    assert.match(fromMe.text, /Lucia's/);
    assert.match(fromMe.text, /Remember to buy milk/);
    assert.doesNotMatch(fromMe.text, /wine/);

    const windowed = await call("list_messages", { after: new Date(T0 + 170_000).toISOString(), before: new Date(T0 + 250_000).toISOString(), include_context: false });
    assert.match(windowed.text, /wine/);
    assert.match(windowed.text, /menu\.jpg/);
    assert.doesNotMatch(windowed.text, /dinner|milk/);

    assert.equal((await call("list_messages", { after: "not a date" })).isError, true);
  });

  test("contact lookups resolve phone formats and group membership", async () => {
    const direct = JSON.parse((await call("get_direct_chat_by_contact", { contact: "+1 (555) 111-1111" })).text);
    assert.equal(direct.chat_id, ALICE.uuid);

    const chats = JSON.parse((await call("get_contact_chats", { contact: ALICE.number })).text);
    assert.deepEqual(chats.map((c: any) => c.name).sort(), ["Alice Smith", "Book Club"]);

    const last = await call("get_last_interaction", { contact: ALICE.uuid });
    assert.match(last.text, /Chat: Alice Smith .* From: Alice Smith: check https:\/\/en\.wikipedia/);

    const noChat = JSON.parse((await call("get_direct_chat_by_contact", { contact: "u:bob.42" })).text);
    assert.equal(noChat.chat_id, BOB.uuid);
    assert.match(noChat.note, /No messages/);
  });

  test("get_message_context centres on the target message", async () => {
    const id = await idOf("wine");
    const { text } = await call("get_message_context", { message_id: id, before: 5, after: 5 });
    assert.match(text, /^=== Book Club/);
    assert.match(text, /> \[.*wine/);
  });

  test("send_message sends to phone numbers, chats, groups and records the message", async () => {
    let res = await call("send_message", { recipient: "+1 555 111 1111", message: "See you then" });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Sent to Alice Smith \(message_id: \d+\)/);
    assert.deepEqual(mock.callsTo("send").at(-1), { account: SELF_NUMBER, recipient: ["+15551111111"], message: "See you then" });

    res = await call("send_message", { recipient: `group:${GROUP_ID}`, message: "I'll bring cheese" });
    assert.match(res.text, /Sent to Book Club/);
    assert.equal(mock.callsTo("send").at(-1).groupId, GROUP_ID);

    res = await call("send_message", { recipient: "me", message: "note" });
    assert.equal(mock.callsTo("send").at(-1).noteToSelf, true);

    const thread = await call("list_messages", { chat_id: ALICE.uuid, include_context: false });
    assert.match(thread.text, /From: Me: See you then/);
  });

  test("send_message to an unknown number creates the chat from signal-cli's reply", async () => {
    const res = await call("send_message", { recipient: "+15559999999", message: "Hi, it's Ben" });
    assert.equal(res.isError, false, res.text);
    const chat = JSON.parse((await call("get_chat", { chat_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })).text);
    assert.equal(chat.phone_number, "+15559999999");
  });

  test("send_message can quote-reply without repeating the recipient", async () => {
    const id = await idOf("Saturday");
    const res = await call("send_message", { reply_to_message_id: id, message: "Saturday works" });
    assert.equal(res.isError, false, res.text);
    const sent = mock.callsTo("send").at(-1);
    assert.deepEqual(sent.recipient, [ALICE.uuid]);
    assert.equal(sent.quoteTimestamp, T0);
    assert.equal(sent.quoteAuthor, ALICE.uuid);
    assert.match((await call("list_messages", { query: "Saturday works", include_context: false })).text, /replying to "Hey, are we still on for dinner Saturday\?"/);
  });

  test("send_message refuses ambiguous recipients", async () => {
    const res = await call("send_message", { recipient: "Alice", message: "hi" });
    assert.equal(res.isError, true);
    assert.match(res.text, /Unrecognized recipient/);
  });

  test("send_file sends a data URI that works even if signal-cli is in a container", async () => {
    const file = path.join(dir, "trip notes.txt");
    fs.writeFileSync(file, "hello");
    const res = await call("send_file", { recipient: ALICE.uuid, file_path: file, caption: "notes" });
    assert.equal(res.isError, false, res.text);
    const sent = mock.callsTo("send").at(-1);
    assert.equal(sent.attachments[0], `data:text/plain;filename=trip%20notes.txt;base64,${Buffer.from("hello").toString("base64")}`);
    assert.equal(sent.message, "notes");
    assert.equal((await call("send_file", { recipient: ALICE.uuid, file_path: path.join(dir, "missing") })).isError, true);
  });

  test("send_reaction targets the right author and timestamp", async () => {
    const wine = await idOf("wine");
    await call("send_reaction", { message_id: wine, emoji: "👍" });
    assert.deepEqual(mock.callsTo("sendReaction").at(-1), {
      account: SELF_NUMBER, groupId: GROUP_ID, emoji: "👍", targetAuthor: BOB.uuid, targetTimestamp: T0 + 180_000, remove: false,
    });
    assert.match((await call("get_message_context", { message_id: wine, before: 0, after: 0 })).text, /\[reactions: 👍 Me\]/);

    const mine = await idOf("Lucia");
    await call("send_reaction", { message_id: mine, emoji: "🎉" });
    assert.equal(mock.callsTo("sendReaction").at(-1).targetAuthor, SELF_UUID);
  });

  test("download_attachment fetches via getAttachment and saves a file", async () => {
    const id = await idOf("menu.jpg");
    const res = await call("download_attachment", { message_id: id });
    assert.equal(res.isError, false, res.text);
    const info = JSON.parse(res.text);
    assert.equal(fs.readFileSync(info.file_path, "utf8"), "fake jpeg bytes");
    assert.deepEqual(mock.callsTo("getAttachment").at(-1), { account: SELF_NUMBER, id: "Xyz123.jpg", recipient: CAROL.uuid });
  });

  test("list_links groups the same link across chats, with preview titles", async () => {
    const { text } = await call("list_links");
    const links = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const nyt = links.find((l: any) => l.domain === "nytimes.com");
    assert.equal(nyt.url, "https://www.nytimes.com/2026/10/01/climate.html", "latest share, minus tracking params");
    assert.equal(nyt.title, "The Climate Report");
    assert.equal(nyt.times_shared, 3);
    assert.deepEqual([...nyt.chats].sort(), ["Alice Smith", "Book Club", "Climate Crew"]);
    assert.deepEqual([...nyt.shared_by].sort(), ["Alice Smith", "Bob Jones"]);
    assert.ok(links.some((l: any) => l.url === "https://youtu.be/abc123"), "tracking `si` param stripped");
    assert.ok(links.some((l: any) => l.url === "https://en.wikipedia.org/wiki/Foo_(bar)"), "links added by an edit are catalogued");
    assert.ok(!text.includes("private.example.com"), "links in deleted messages are dropped");
    assert.ok(!text.includes("secret.example.org"), "disappearing messages are not archived");
  });

  test("list_links filters by chat, domain, sender and lists individual shares", async () => {
    const crew = JSON.parse((await call("list_links", { chat_id: `group:${GROUP2_ID}` })).text.replace(/^.*\n/, ""));
    assert.deepEqual(crew.map((l: any) => l.domain).sort(), ["nytimes.com", "youtu.be"]);

    const wiki = JSON.parse((await call("list_links", { domain: "wikipedia.org" })).text.replace(/^.*\n/, ""));
    assert.equal(wiki.length, 1);

    const byAlice = JSON.parse((await call("list_links", { sender: ALICE.number })).text.replace(/^.*\n/, ""));
    assert.deepEqual(byAlice.map((l: any) => l.domain).sort(), ["en.wikipedia.org", "nytimes.com"]);

    const shares = JSON.parse((await call("list_links", { domain: "nytimes.com", group_by_url: false })).text.replace(/^.*\n/, ""));
    assert.equal(shares.length, 3);
    assert.deepEqual(shares.map((s: any) => s.chat), ["Alice Smith", "Book Club", "Climate Crew"]);

    assert.match((await call("list_links", { query: "nothing-like-this" })).text, /No links match/);
  });

  test("export_links writes CSV and Markdown catalogs", async () => {
    const csv = JSON.parse((await call("export_links", { format: "csv" })).text);
    const csvText = fs.readFileSync(csv.file_path, "utf8");
    assert.match(csvText, /^url,title,domain,times_shared,first_shared,last_shared,chats,shared_by,description\n/);
    assert.match(csvText, /https:\/\/www\.nytimes\.com\/2026\/10\/01\/climate\.html,The Climate Report,nytimes\.com,3,/);

    const md = JSON.parse((await call("export_links", { format: "markdown" })).text);
    const mdText = fs.readFileSync(md.file_path, "utf8");
    assert.match(mdText, /^# Signal links/);
    assert.match(mdText, /## Book Club \(1\)\n\n- \[The Climate Report\]\(<https:\/\/www\.nytimes\.com\/.*>\) — nytimes\.com · Bob Jones, /);
    assert.match(mdText, /## Climate Crew \(2\)\n\n(- .*\n)*- \[The Climate Report\]\(<https:\/\/nytimes\.com\/2026\/10\/01\/climate\.html>\)/);
    assert.match(mdText, /\[https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)\]/);
  });

  test("list_files catalogs shared files", async () => {
    const files = JSON.parse((await call("list_files", { kind: "image" })).text);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "menu.jpg");
    assert.equal(files[0].chat, "Carol");
    assert.equal(files[0].size, "2 KB");
    assert.match((await call("list_files", { kind: "document", query: "menu" })).text, /No files match/);
  });

  test("get_status reports links and skipped disappearing messages", async () => {
    const status = JSON.parse((await call("get_status")).text);
    assert.equal(status.links, 3);
    assert.equal(status.disappearing_messages_skipped, 1);
  });

  test("links in messages sent through the server are catalogued", async () => {
    await call("send_message", { recipient: ALICE.uuid, message: "Here's the plan https://docs.example.com/plan" });
    const mine = JSON.parse((await call("list_links", { sender: "me" })).text.replace(/^.*\n/, ""));
    assert.ok(mine.some((l: any) => l.url === "https://docs.example.com/plan" && l.shared_by[0] === "Me"));
  });

  test("reconnects with Last-Event-ID and ignores replayed events", async () => {
    const before = await messageCount();
    mock.dropClients();
    await mock.waitForClients(1);
    assert.match(mock.lastEventIdHeaders.at(-1) ?? "", /^1700000000000-\d+$/);
    for (const env of Object.values(envelopes)) mock.push(env);
    mock.push({
      sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, timestamp: T0 + 400_000,
      dataMessage: { timestamp: T0 + 400_000, message: "after reconnect" },
    });
    await until(async () => (await messageCount()) > before, "new message after reconnect");
    assert.equal(await messageCount(), before + 1);
  });
});

describe("signal-mcp lifecycle", () => {
  test("exits when the client closes stdin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-exit-"));
    const mock = new MockSignalCli();
    const url = await mock.start();
    const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/index.ts")], {
      cwd: ROOT,
      env: envFor(url, dir),
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      await mock.waitForClients(1);
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.stdin!.end();
      const timeout = new Promise((resolve) => setTimeout(() => resolve("still running after 5s"), 5000).unref());
      assert.equal(await Promise.race([exited, timeout]), 0);
    } finally {
      child.kill();
      await mock.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("signal-mcp bridge", () => {
  test("captures messages into the database without an MCP client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-bridge-"));
    const mock = new MockSignalCli();
    const url = await mock.start();
    const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/index.ts"), "bridge"], {
      cwd: ROOT,
      env: envFor(url, dir),
      stdio: "ignore",
    });
    try {
      await mock.waitForClients(1);
      mock.push(envelopes.aliceAsks);
      const dbPath = path.join(dir, "messages.db");
      await until(() => {
        if (!fs.existsSync(dbPath)) return false;
        const db = new Database(dbPath, { readonly: true });
        try {
          return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n === 1;
        } finally {
          db.close();
        }
      }, "bridge to store the message");
    } finally {
      child.kill();
      await mock.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
