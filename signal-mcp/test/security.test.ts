import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { parseNoteToSelf, triggerPattern } from "../src/bot";
import { SignalStore } from "../src/store";
import { csvCell } from "../src/tools";
import { ALICE, SELF_NUMBER, SELF_UUID } from "./mock-signal-cli";

const TRIGGER = triggerPattern("c,claude");
const note = (envelope: Record<string, unknown>, message = "c hello", extra: Record<string, unknown> = {}) => ({
  account: SELF_NUMBER,
  envelope: {
    timestamp: 1, ...envelope,
    syncMessage: { sentMessage: { destinationNumber: SELF_NUMBER, destinationUuid: SELF_UUID, timestamp: 1, message, ...extra } },
  },
});

describe("security", () => {
  test("the archive and its folder are readable by this user only", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signal-sec-")), "state");
    const db = path.join(dir, "messages.db");
    const store = new SignalStore(db);
    try {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(db).mode & 0o777, 0o600);
    } finally {
      store.close();
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  test("an existing world-readable archive is tightened on open", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-sec-"));
    const db = path.join(dir, "messages.db");
    new SignalStore(db).close();
    fs.chmodSync(db, 0o644);
    const store = new SignalStore(db);
    try {
      assert.equal(fs.statSync(db).mode & 0o777, 0o600);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CSV cells can't become spreadsheet formulas", () => {
    assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
    assert.equal(csvCell("+1 555"), "'+1 555");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell("-2"), "'-2");
    assert.equal(csvCell("A normal title"), "A normal title");
  });

  test("the bot needs the account's own number, or its configured UUID, as the sender", () => {
    assert.ok(parseNoteToSelf(note({ sourceNumber: SELF_NUMBER, sourceUuid: SELF_UUID }), SELF_NUMBER, TRIGGER, "/att"));
    assert.equal(parseNoteToSelf(note({ sourceUuid: SELF_UUID }), SELF_NUMBER, TRIGGER, "/att"), null);
    assert.ok(parseNoteToSelf(note({ sourceUuid: SELF_UUID }), SELF_NUMBER, TRIGGER, "/att", SELF_UUID));
    assert.equal(parseNoteToSelf(note({ sourceUuid: ALICE.uuid }), SELF_NUMBER, TRIGGER, "/att", SELF_UUID), null);
  });

  test("attachment ids can't point outside the attachments folder", () => {
    const n = parseNoteToSelf(note({ sourceNumber: SELF_NUMBER, sourceUuid: SELF_UUID }, "c look", { attachments: [{ id: "../../.ssh/id_rsa" }] }), SELF_NUMBER, TRIGGER, "/att");
    assert.deepEqual(n?.attachments, [path.join("/att", "id_rsa")]);
  });
});
