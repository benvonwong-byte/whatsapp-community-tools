import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decryptAttachment, readDesktopKey } from "../src/desktop";
import { DesktopFixture, KEYCHAIN_PASSWORD, encryptAttachment } from "./desktop-fixture";
import { ALICE, BOB, GROUP2_ID, GROUP_ID, SELF_NUMBER, SELF_UUID } from "./mock-signal-cli";

const ROOT = path.resolve(__dirname, "..");
const T0 = Date.parse("2026-09-01T18:00:00Z");
const DANA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MENU_PDF = Buffer.from("%PDF-1.4 fake menu for friday");
const POSTER = Buffer.from("fake jpeg poster bytes");
const LONG_TEXT = `Long post: ${"lorem ipsum ".repeat(200)}full report at https://example.org/full-report`;

function buildProfile(dir: string): DesktopFixture {
  const f = new DesktopFixture(dir, { aci: SELF_UUID, number: SELF_NUMBER });
  f.addConversation({ id: "conv-self", type: "private", serviceId: SELF_UUID, e164: SELF_NUMBER, profileName: "Ben" });
  f.addConversation({ id: "conv-alice", type: "private", serviceId: ALICE.uuid, e164: ALICE.number, name: "Alice Smith", profileName: "Ali" });
  f.addConversation({ id: "conv-bob", type: "private", serviceId: BOB.uuid, e164: BOB.number, profileName: "Bob", profileFamilyName: "Jones" });
  f.addConversation({ id: "conv-dana", type: "private", serviceId: DANA, nicknameGivenName: "Dee", profileName: "Dana" });
  f.addConversation({ id: "conv-book", type: "group", groupId: GROUP_ID, name: "Book Club", membersV2: [{ aci: ALICE.uuid }, { aci: BOB.uuid }, { aci: SELF_UUID }] });
  f.addConversation({ id: "conv-crew", type: "group", groupId: GROUP2_ID, name: "Climate Crew", membersV2: [{ aci: BOB.uuid }, { aci: SELF_UUID }] });

  const alice = { sourceServiceId: ALICE.uuid, source: ALICE.number };
  const bob = { sourceServiceId: BOB.uuid, source: BOB.number };
  f.addMessage({
    id: "m1", conversationId: "conv-alice", type: "incoming", sent_at: T0, ...alice,
    body: "Have you seen https://www.nytimes.com/2026/10/01/climate.html?utm_source=signal",
    json: { preview: [{ url: "https://www.nytimes.com/2026/10/01/climate.html", title: "The Climate Report", description: "What the numbers mean." }] },
  });
  f.addMessage({
    id: "m2", conversationId: "conv-alice", type: "outgoing", sent_at: T0 + 60_000, source: SELF_NUMBER, sourceServiceId: SELF_UUID,
    body: "Yes! Sharing it with Book Club",
    json: { reactions: [{ emoji: "❤️", fromId: "conv-alice", targetTimestamp: T0 + 60_000, timestamp: T0 + 70_000 }] },
  });
  f.addMessage({
    id: "m3", conversationId: "conv-book", type: "incoming", sent_at: T0 + 120_000, ...bob,
    body: "￼ have you read https://nytimes.com/2026/10/01/climate.html/",
    json: { bodyRanges: [{ start: 0, length: 1, mentionAci: ALICE.uuid }] },
  });
  f.addMessage({ id: "m4", conversationId: "conv-book", type: "incoming", sent_at: T0 + 180_000, ...bob, body: "Menu for Friday" });
  f.addAttachment({ messageId: "m4", conversationId: "conv-book", sentAt: T0 + 180_000, contentType: "application/pdf", fileName: "menu.pdf", data: MENU_PDF });
  f.addMessage({
    id: "m5", conversationId: "conv-book", type: "incoming", sent_at: T0 + 240_000, ...alice,
    body: "Meeting moved to Saturday https://lu.ma/book-club",
    json: { editHistory: [{ body: "Meeting moved to Saturday https://lu.ma/book-club" }, { body: "Meeting on Friday" }], editMessageTimestamp: T0 + 250_000 },
  });
  f.addMessage({ id: "m6", conversationId: "conv-book", type: "incoming", sent_at: T0 + 300_000, ...bob, body: "", json: { deletedForEveryone: true } });
  f.addMessage({ id: "m7", conversationId: "conv-book", type: "incoming", sent_at: T0 + 310_000, ...bob, body: "secret https://secret.example.org/plan", expireTimer: 3600 });
  f.addMessage({ id: "m8", conversationId: "conv-book", type: "group-v2-change", sent_at: T0 + 320_000, json: { groupV2Change: { details: [] } } });
  f.addMessage({
    id: "m9", conversationId: "conv-alice", type: "incoming", sent_at: T0 + 400_000, ...alice, body: "Agreed",
    json: { quote: { id: T0 + 60_000, authorAci: SELF_UUID, text: "Yes! Sharing it with Book Club", attachments: [] } },
  });
  f.addMessage({
    id: "m10", conversationId: "conv-crew", type: "incoming", sent_at: T0 + 500_000, ...bob, body: "Poster for the march",
    json: { attachments: [{ contentType: "image/jpeg", fileName: "poster.jpg", size: POSTER.length, path: f.writePlainFile(POSTER) }] },
  });
  f.addMessage({ id: "m11", conversationId: "conv-crew", type: "incoming", sent_at: T0 + 600_000, ...bob, body: LONG_TEXT.slice(0, 120) });
  f.addAttachment({ messageId: "m11", conversationId: "conv-crew", sentAt: T0 + 600_000, attachmentType: "long-message", contentType: "text/x-signal-plain", data: Buffer.from(LONG_TEXT) });
  f.addMessage({ id: "m12", conversationId: "conv-alice", type: "incoming", sent_at: T0 + 610_000, ...alice, body: "nice story!", storyId: "story-1" });
  f.addMessage({ id: "m13", conversationId: "conv-alice", type: "incoming", sent_at: T0 + 620_000, ...alice });
  f.addAttachment({ messageId: "m13", conversationId: "conv-alice", sentAt: T0 + 620_000, contentType: "audio/aac", data: Buffer.from("aac"), flags: 1 });
  f.addMessage({ id: "m14", conversationId: "conv-dana", type: "incoming", sent_at: T0 + 630_000, sourceServiceId: DANA, body: "hi from dana" });
  return f;
}

async function startServer(env: Record<string, string>) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(ROOT, "src/index.ts")],
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "ignore",
    })
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { text: res.content.map((c: any) => c.text).join("\n") as string, isError: Boolean(res.isError) };
  };
  return { client, call };
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const body = (text: string) => JSON.parse(text.slice(text.indexOf("\n") + 1));

describe("Signal Desktop import", () => {
  let dir: string;
  let fixture: DesktopFixture;
  let server: Awaited<ReturnType<typeof startServer>>;
  const call = (name: string, args?: Record<string, unknown>) => server.call(name, args);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-desktop-"));
    fixture = buildProfile(path.join(dir, "Signal"));
    // The fixture keeps its connection open, like a running Signal Desktop.
    server = await startServer({
      HOME: dir,
      SIGNAL_DESKTOP_DIR: path.join(dir, "Signal"),
      SIGNAL_DESKTOP_KEYCHAIN_PASSWORD: KEYCHAIN_PASSWORD,
      SIGNAL_MCP_DB: path.join(dir, "archive.db"),
      SIGNAL_MCP_DOWNLOAD_DIR: path.join(dir, "downloads"),
    });
    await until(async () => JSON.parse((await call("get_status")).text).messages >= 11, "the first import");
  });

  after(async () => {
    await server?.client.close();
    fixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("runs read-only without signal-cli", async () => {
    const { tools } = await server.client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("sync_signal_desktop") && names.includes("list_links"));
    for (const sendTool of ["send_message", "send_file", "send_reaction"]) assert.ok(!names.includes(sendTool));
    const status = JSON.parse((await call("get_status")).text);
    assert.equal(status.signal_desktop.folder, path.join(dir, "Signal"));
    assert.match(status.signal_cli, /not used/);
    assert.equal(status.messages, 11);
    assert.equal(status.disappearing_messages_skipped, 1);
  });

  test("imports chats with Desktop's display names, most recent first", async () => {
    const chats = JSON.parse((await call("list_chats")).text);
    assert.deepEqual(chats.slice(0, 4).map((c: any) => c.name), ["Dee", "Alice Smith", "Climate Crew", "Book Club"]);
    assert.equal(chats.find((c: any) => c.name === "Book Club").chat_id, `group:${GROUP_ID}`);
    assert.equal(chats.find((c: any) => c.name === "Alice Smith").chat_id, ALICE.uuid);
    assert.match((await call("search_contacts", { query: "jones" })).text, /Bob Jones/);
  });

  test("imports group messages with mentions, attachments, edits and deletions", async () => {
    const { text } = await call("list_messages", { chat_id: `group:${GROUP_ID}`, include_context: false });
    assert.match(text, /From: Bob Jones: @Alice Smith have you read https:\/\/nytimes\.com/);
    assert.match(text, /From: Bob Jones: Menu for Friday \[attachment 0: application\/pdf "menu\.pdf"/);
    assert.match(text, /From: Alice Smith: Meeting moved to Saturday https:\/\/lu\.ma\/book-club \(edited\)/);
    assert.match(text, /From: Bob Jones: \[message deleted\]/);
    assert.doesNotMatch(text, /secret/, "disappearing messages are skipped");
    assert.equal(text.match(/\[message_id:/g)?.length, 4, "system notices are skipped");
  });

  test("imports reactions, quotes and voice notes, and skips story replies", async () => {
    const { text } = await call("list_messages", { chat_id: ALICE.uuid, include_context: false });
    assert.match(text, /From: Me: Yes! Sharing it with Book Club \[reactions: ❤️ Alice Smith\]/);
    assert.match(text, /From: Alice Smith: \(replying to "Yes! Sharing it with Book Club"\) Agreed/);
    assert.match(text, /\[attachment 0: voice note/);
    assert.doesNotMatch(text, /nice story/);
  });

  test("catalogs links across Desktop chats, including long messages", async () => {
    const links = body((await call("list_links")).text);
    const nyt = links.find((l: any) => l.domain === "nytimes.com");
    assert.equal(nyt.times_shared, 2);
    assert.equal(nyt.title, "The Climate Report");
    assert.deepEqual([...nyt.chats].sort(), ["Alice Smith", "Book Club"]);
    assert.ok(links.some((l: any) => l.url === "https://lu.ma/book-club"));
    assert.ok(links.some((l: any) => l.url === "https://example.org/full-report"), "full text of long messages");
    assert.ok(!JSON.stringify(links).includes("secret.example.org"));
  });

  test("download_attachment decrypts Desktop's encrypted files and copies legacy ones", async () => {
    const pdfId = Number((await call("list_files", { query: "menu" })).text.match(/"message_id": (\d+)/)![1]);
    const pdf = JSON.parse((await call("download_attachment", { message_id: pdfId })).text);
    assert.deepEqual(fs.readFileSync(pdf.file_path), MENU_PDF);
    assert.match(pdf.file_path, /menu\.pdf$/);

    const posterId = Number((await call("list_files", { kind: "image" })).text.match(/"message_id": (\d+)/)![1]);
    const poster = JSON.parse((await call("download_attachment", { message_id: posterId })).text);
    assert.deepEqual(fs.readFileSync(poster.file_path), POSTER);
  });

  test("picks up new messages, edits and deletions while Desktop keeps running", async () => {
    fixture.addMessage({
      id: "m15", conversationId: "conv-crew", type: "incoming", sent_at: T0 + 700_000,
      sourceServiceId: BOB.uuid, source: BOB.number, body: "Join us https://lu.ma/climate-march",
    });
    fixture.updateMessage("m1", "", { deletedForEveryone: true, preview: [] });
    const result = JSON.parse((await call("sync_signal_desktop")).text);
    assert.ok(result.imported_or_updated >= 2);

    const links = body((await call("list_links")).text);
    assert.ok(links.some((l: any) => l.url === "https://lu.ma/climate-march"));
    assert.equal(links.find((l: any) => l.domain === "nytimes.com").times_shared, 1, "deleted share removed");
    assert.match((await call("list_messages", { chat_id: ALICE.uuid, include_context: false })).text, /From: Alice Smith: \[message deleted\]/);
  });

  test("keeps messages in the archive after Desktop removes them", async () => {
    fixture.db.prepare("DELETE FROM messages WHERE id = ?").run(["m14"]);
    await call("sync_signal_desktop", { full: true });
    assert.match((await call("list_messages", { chat_id: DANA, include_context: false })).text, /hi from dana/);
  });
});

describe("Signal Desktop import options", () => {
  test("SIGNAL_DESKTOP_CHATS limits the import to the named chats", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-desktop-filter-"));
    const fixture = buildProfile(path.join(dir, "Signal"));
    const server = await startServer({
      HOME: dir,
      SIGNAL_DESKTOP_DIR: path.join(dir, "Signal"),
      SIGNAL_DESKTOP_KEYCHAIN_PASSWORD: KEYCHAIN_PASSWORD,
      SIGNAL_DESKTOP_CHATS: "book club",
      SIGNAL_MCP_DB: path.join(dir, "archive.db"),
    });
    try {
      await until(async () => JSON.parse((await server.call("get_status")).text).messages > 0, "the filtered import");
      await new Promise((r) => setTimeout(r, 300));
      const chats = JSON.parse((await server.call("list_chats")).text);
      assert.deepEqual(chats.map((c: any) => c.name), ["Book Club"]);
      assert.equal(JSON.parse((await server.call("get_status")).text).messages, 4);
    } finally {
      await server.client.close();
      fixture.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a wrong Keychain password instead of importing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-desktop-badkey-"));
    const fixture = buildProfile(path.join(dir, "Signal"));
    const server = await startServer({
      HOME: dir,
      SIGNAL_DESKTOP_DIR: path.join(dir, "Signal"),
      SIGNAL_DESKTOP_KEYCHAIN_PASSWORD: "not-the-password",
      SIGNAL_MCP_DB: path.join(dir, "archive.db"),
    });
    try {
      let status: any;
      await until(async () => {
        status = JSON.parse((await server.call("get_status")).text);
        return Boolean(status.signal_desktop.last_sync_error);
      }, "the sync error");
      assert.match(status.signal_desktop.last_sync_error, /wrong Keychain password.*paused/);
      // Background syncs stop retrying; a manual sync tries again and reports the error.
      const manual = await server.call("sync_signal_desktop");
      assert.equal(manual.isError, true);
      assert.match(manual.text, /wrong Keychain password/);
      assert.match((await server.call("list_chats")).text, /reading Signal Desktop failed/);
    } finally {
      await server.client.close();
      fixture.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Signal Desktop crypto", () => {
  test("reads both Keychain-encrypted and legacy plaintext keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-keys-"));
    try {
      const legacy = new DesktopFixture(path.join(dir, "legacy"), { aci: SELF_UUID, number: SELF_NUMBER }, { legacyPlaintextKey: true });
      legacy.close();
      assert.match(await readDesktopKey(path.join(dir, "legacy")), /^[0-9a-f]{64}$/);

      const modern = new DesktopFixture(path.join(dir, "modern"), { aci: SELF_UUID, number: SELF_NUMBER });
      modern.close();
      process.env.SIGNAL_DESKTOP_KEYCHAIN_PASSWORD = KEYCHAIN_PASSWORD;
      assert.match(await readDesktopKey(path.join(dir, "modern")), /^[0-9a-f]{64}$/);
      process.env.SIGNAL_DESKTOP_KEYCHAIN_PASSWORD = "wrong";
      await assert.rejects(readDesktopKey(path.join(dir, "modern")), /wrong Keychain password/);
    } finally {
      delete process.env.SIGNAL_DESKTOP_KEYCHAIN_PASSWORD;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("decryptAttachment trims padding and rejects tampered files", () => {
    const keys = Buffer.alloc(64, 7);
    const encrypted = encryptAttachment(Buffer.from("hello attachment"), keys);
    assert.equal(decryptAttachment(encrypted, keys.toString("base64"), 16).toString(), "hello attachment");
    encrypted[20] ^= 1;
    assert.throws(() => decryptAttachment(encrypted, keys.toString("base64"), 16), /integrity/);
  });
});
