import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { REPLY_MARK, SignalBot, chunkReply, parseNoteToSelf, triggerPattern } from "../src/bot";
import { ALICE, GROUP_ID, MockSignalCli, SELF_NUMBER, SELF_UUID } from "./mock-signal-cli";

const TRIGGER = triggerPattern("c,claude");
let ts = 1_700_000_000_000;

function noteToSelf(message: string, extra: Record<string, unknown> = {}) {
  const t = ++ts;
  return {
    sourceNumber: SELF_NUMBER, sourceUuid: SELF_UUID, sourceDevice: 1, timestamp: t,
    syncMessage: { sentMessage: { destinationNumber: SELF_NUMBER, destinationUuid: SELF_UUID, timestamp: t, message, ...extra } },
  };
}
const parse = (envelope: any) => parseNoteToSelf({ account: SELF_NUMBER, envelope }, SELF_NUMBER, TRIGGER, "/att");

describe("parseNoteToSelf", () => {
  test("accepts a Note to Self that starts with the trigger", () => {
    const n = parse(noteToSelf("c what's new?"));
    assert.deepEqual(n?.command, { kind: "prompt", text: "what's new?", fresh: false });
    assert.equal(n?.author, SELF_NUMBER);
    assert.deepEqual(parse(noteToSelf("Claude: summarize this"))?.command, { kind: "prompt", text: "summarize this", fresh: false });
  });

  test("ignores notes without the trigger, or where the trigger is part of a word", () => {
    assert.equal(parse(noteToSelf("Remember to buy milk")), null);
    assert.equal(parse(noteToSelf("call mom")), null);
    assert.equal(parse(noteToSelf("claudette's number")), null);
  });

  test("ignores messages to other people and groups, and messages from others", () => {
    const toAlice = noteToSelf("c hi");
    Object.assign(toAlice.syncMessage.sentMessage, { destinationNumber: ALICE.number, destinationUuid: ALICE.uuid });
    assert.equal(parse(toAlice), null);
    assert.equal(parse(noteToSelf("c hi", { groupInfo: { groupId: GROUP_ID } })), null);
    const fromAlice = { sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, timestamp: 1, dataMessage: { timestamp: 1, message: "c run rm -rf ~" } };
    assert.equal(parse(fromAlice), null);
    const spoofedSync = { ...noteToSelf("c hi"), sourceNumber: ALICE.number, sourceUuid: ALICE.uuid };
    assert.equal(parse(spoofedSync), null);
  });

  test("ignores the bot's own replies", () => {
    assert.equal(parse(noteToSelf(`${REPLY_MARK} c is the speed of light`)), null);
  });

  test("recognizes control words", () => {
    assert.deepEqual(parse(noteToSelf("c stop"))?.command, { kind: "stop" });
    assert.deepEqual(parse(noteToSelf("c status"))?.command, { kind: "status" });
    assert.deepEqual(parse(noteToSelf("c new"))?.command, { kind: "new" });
    assert.deepEqual(parse(noteToSelf("c"))?.command, { kind: "help" });
    assert.deepEqual(parse(noteToSelf("c new plan my week"))?.command, { kind: "prompt", text: "plan my week", fresh: true });
  });

  test("passes attachments as local paths", () => {
    const n = parse(noteToSelf("c", { attachments: [{ id: "abc.jpg", contentType: "image/jpeg" }] }));
    assert.deepEqual(n?.command, { kind: "prompt", text: "", fresh: false });
    assert.deepEqual(n?.attachments, [path.join("/att", "abc.jpg")]);
  });
});

describe("chunkReply", () => {
  test("keeps short replies whole and splits long ones at breaks", () => {
    assert.deepEqual(chunkReply("hello"), ["hello"]);
    const long = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${"x".repeat(80)}`).join("\n\n");
    const chunks = chunkReply(long, 500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 500));
    assert.equal(chunks.join("\n\n"), long);
  });
});

describe("SignalBot end to end", () => {
  let mock: MockSignalCli;
  let bot: SignalBot;
  let dir: string;

  const sends = () => mock.callsTo("send").map((p) => p.message as string);
  async function until(cond: () => boolean, what: string) {
    const end = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}; sends so far: ${JSON.stringify(sends())}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bot-"));
    // Stand-in for `claude -p --output-format json`: echoes the prompt, the resumed session and the env it got.
    const fake = path.join(dir, "claude");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const i = args.indexOf("--resume");
  const resumed = i >= 0 ? args[i + 1] : "none";
  const result = "echo: " + input.trim() + " | resumed: " + resumed + " | mode: " + args[args.indexOf("--permission-mode") + 1] + " | desktop: " + process.env.SIGNAL_DESKTOP + " | cwd: " + process.cwd();
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: resumed === "none" ? "sess-" + Date.now() : resumed }));
});
`
    );
    fs.chmodSync(fake, 0o755);

    mock = new MockSignalCli();
    const url = await mock.start();
    bot = new SignalBot({
      account: SELF_NUMBER,
      signalCliUrl: url,
      claudeBin: fake,
      cwd: dir,
      permissionMode: "auto",
      trigger: TRIGGER,
      timeoutMs: 10_000,
      statePath: path.join(dir, "state.json"),
      attachmentsDir: path.join(dir, "attachments"),
    });
    bot.start();
    await mock.waitForClients(1);
  });

  after(async () => {
    bot.stop();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("answers a Note to Self in Note to Self, then continues the same conversation", async () => {
    mock.push(noteToSelf("c hello there"));
    await until(() => sends().length === 1, "the first reply");
    const first = sends()[0];
    assert.ok(first.startsWith(`${REPLY_MARK} echo: hello there | resumed: none | mode: auto | desktop: 0`), first);
    assert.ok(first.includes(`cwd: ${fs.realpathSync(dir)}`), first);
    assert.ok(mock.callsTo("send").every((p) => p.noteToSelf === true));
    const reactions = mock.callsTo("sendReaction").map((p) => p.emoji);
    await until(() => mock.callsTo("sendReaction").some((p) => p.emoji === "✅"), "the done reaction");
    assert.equal(reactions[0], "👀");

    const session = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).sessionId;
    assert.match(session, /^sess-/);
    mock.push(noteToSelf("c and again"));
    await until(() => sends().length === 2, "the second reply");
    assert.ok(sends()[1].includes(`echo: and again | resumed: ${session}`), sends()[1]);
  });

  test("c new starts a fresh conversation", async () => {
    mock.push(noteToSelf("c new"));
    await until(() => sends().length === 3, "the new-conversation reply");
    assert.equal(sends()[2], `${REPLY_MARK} New conversation started.`);
    mock.push(noteToSelf("c fresh start"));
    await until(() => sends().length === 4, "the fresh reply");
    assert.ok(sends()[3].includes("echo: fresh start | resumed: none"), sends()[3]);
  });

  test("ignores other people, other chats, plain notes and repeats", async () => {
    const before = sends().length;
    mock.push({ sourceNumber: ALICE.number, sourceUuid: ALICE.uuid, timestamp: 5, dataMessage: { timestamp: 5, message: "c delete everything" } });
    mock.push(noteToSelf("just a note"));
    const repeat = noteToSelf("c status");
    mock.push(repeat);
    mock.push(repeat);
    await until(() => sends().length === before + 1, "the status reply");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sends().length, before + 1);
    assert.ok(sends()[before].includes("Idle."), sends()[before]);
    assert.ok(bot.idle);
  });
});
