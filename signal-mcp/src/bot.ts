import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { config, ensurePrivateDir, expandHome, restrictFile } from "./config";
import { log } from "./log";
import { SignalCliClient } from "./signal-cli";

/**
 * `signal-mcp bot`: talk to Claude Code from Signal's Note to Self.
 *
 * signal-cli runs as one of your linked devices. When you write a Note to Self that starts
 * with the trigger ("c " or "claude "), the bot runs `claude -p` on this computer with your
 * Claude Code login, continues the same conversation each time, and sends the answer back
 * to Note to Self. Only sync messages from your own devices are accepted: Signal never
 * delivers another person's message as a sync message, so nobody else can reach it.
 */

export const REPLY_MARK = "🤖";
const MAX_CHUNK = 1900;
const SEEN_LIMIT = 500;

export interface BotSettings {
  account: string;
  /** The account's own Signal UUID (ACI), accepted as the sender when a message carries no number. */
  selfUuid?: string;
  signalCliUrl: string;
  claudeBin: string;
  cwd: string;
  permissionMode: string;
  model?: string;
  trigger: RegExp;
  timeoutMs: number;
  /** Reply "Got it, working on it." as soon as a request arrives. */
  ack?: boolean;
  statePath: string;
  attachmentsDir: string;
}

export type BotCommand =
  | { kind: "prompt"; text: string; fresh: boolean }
  | { kind: "new" }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "help" };

export interface NoteToSelf {
  timestamp: number;
  author: string;
  command: BotCommand;
  attachments: string[];
}

export function triggerPattern(words: string): RegExp {
  // "*" means every Note to Self goes to Claude, with or without a leading "c ".
  if (words.trim() === "*") return /^\s*(?:(?:c|claude)(?=$|[\s:,])[\s:,]*)?/i;
  const alts = words
    .split(/[,|]/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^\\s*(?:${alts.join("|")})(?=$|[\\s:,])[\\s:,]*`, "i");
}

/**
 * Turn a signal-cli receive event into a bot command, or null when it isn't one:
 * it must be a Note to Self, written on one of the account's own devices, starting with the trigger.
 */
export function parseNoteToSelf(
  payload: any,
  account: string,
  trigger: RegExp,
  attachmentsDir = config.attachmentsDir,
  selfUuid?: string
): NoteToSelf | null {
  const env = payload?.envelope;
  const sent = env?.syncMessage?.sentMessage;
  if (!sent || sent.groupInfo || sent.editMessage) return null;
  // Signal only syncs messages between the account's own devices; check the sender anyway.
  if (env.sourceNumber !== account && !(selfUuid && env.sourceUuid === selfUuid)) return null;
  const selfIds = [account, env.sourceUuid].filter(Boolean);
  const dest = [sent.destinationNumber, sent.destinationUuid, sent.destination].filter(Boolean);
  if (dest.length === 0 || !dest.every((d: string) => selfIds.includes(d))) return null;

  const raw: string = typeof sent.message === "string" ? sent.message : "";
  if (raw.trimStart().startsWith(REPLY_MARK)) return null;
  const match = raw.match(trigger);
  if (!match) return null;

  const rest = raw.slice(match[0].length).trim();
  const attachments: string[] = (sent.attachments ?? [])
    .map((a: any) => (typeof a?.id === "string" && a.id ? path.join(attachmentsDir, path.basename(a.id)) : null))
    .filter(Boolean);
  const timestamp = Number(sent.timestamp ?? env.timestamp);
  const author = env.sourceNumber || env.sourceUuid || account;

  const word = rest.toLowerCase();
  let command: BotCommand;
  if (word === "stop" || word === "cancel") command = { kind: "stop" };
  else if (word === "status") command = { kind: "status" };
  else if (word === "help" || (word === "" && attachments.length === 0)) command = { kind: "help" };
  else if (word === "new" || word === "reset") command = { kind: "new" };
  else if (/^(new|reset)\b/.test(word)) command = { kind: "prompt", text: rest.replace(/^\S+\s*/, ""), fresh: true };
  else command = { kind: "prompt", text: rest, fresh: false };

  return { timestamp, author, command, attachments };
}

/** Split a reply into Signal-sized messages, preferring paragraph and line breaks. */
export function chunkReply(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["(no reply)"];
}

const SYSTEM_PROMPT = `You are being messaged through Signal: the user writes in Note to Self on their phone, and a bridge on their Mac relays it to you and sends your final reply back to Note to Self as a plain Signal message.
- Write for a phone screen: short, plain text. No markdown tables, headings or horizontal rules. Use a code block only when the user needs to copy a command.
- The user can't see your tool calls or approve permission prompts. When a step needs their yes, stop and ask in your reply; their next message continues this conversation.
- Files they attach are given to you as local paths; read them with your tools.`;

interface BotState {
  sessionId: string | null;
  lastEventId?: string;
  seen: number[];
}

function loadState(file: string): BotState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return { sessionId: s.sessionId ?? null, lastEventId: s.lastEventId, seen: Array.isArray(s.seen) ? s.seen : [] };
  } catch {
    return { sessionId: null, seen: [] };
  }
}

export function settingsFromEnv(env = process.env): BotSettings {
  const account = env.SIGNAL_ACCOUNT?.trim();
  if (!account) throw new Error("Set SIGNAL_ACCOUNT to the Signal number signal-cli is linked to (e.g. +15551234567).");
  return {
    account,
    selfUuid: env.SIGNAL_BOT_SELF_UUID?.trim() || undefined,
    signalCliUrl: config.signalCliUrl,
    claudeBin: env.SIGNAL_BOT_CLAUDE || "claude",
    cwd: expandHome(env.SIGNAL_BOT_CWD || os.homedir()),
    permissionMode: env.SIGNAL_BOT_PERMISSION_MODE || "auto",
    model: env.SIGNAL_BOT_MODEL || undefined,
    trigger: triggerPattern(env.SIGNAL_BOT_TRIGGER || "c,claude"),
    ack: env.SIGNAL_BOT_ACK !== "0",
    timeoutMs: Math.max(1, Number(env.SIGNAL_BOT_TIMEOUT_MINUTES) || 30) * 60 * 1000,
    statePath: expandHome(env.SIGNAL_BOT_STATE || path.join(path.dirname(config.dbPath), "bot-state.json")),
    attachmentsDir: config.attachmentsDir,
  };
}

interface RunResult {
  text: string;
  sessionId: string | null;
  ok: boolean;
}

export class SignalBot {
  private client: SignalCliClient;
  private state: BotState;
  private queue: NoteToSelf[] = [];
  private running: { child: ChildProcess; note: NoteToSelf; startedAt: number } | null = null;
  private stopped = false;
  private stopText: string | null = null;
  private subscription: { close(): void } | null = null;

  constructor(private s: BotSettings) {
    this.client = new SignalCliClient(s.signalCliUrl, s.account);
    this.state = loadState(s.statePath);
  }

  start() {
    if (this.s.permissionMode === "bypassPermissions") {
      log("Warning: SIGNAL_BOT_PERMISSION_MODE=bypassPermissions lets anyone holding one of your linked devices run anything on this computer.");
    }
    log(`Signal bot listening for Note to Self messages on ${this.s.account} via ${this.s.signalCliUrl}; Claude runs in ${this.s.cwd} (${this.s.permissionMode} mode)`);
    this.subscription = this.client.subscribe({
      lastEventId: this.state.lastEventId,
      onEvent: (payload, eventId) => {
        if (eventId) this.state.lastEventId = eventId;
        this.handle(payload);
        this.save();
      },
    });
  }

  stop() {
    this.subscription?.close();
    this.running?.child.kill("SIGTERM");
    this.save();
  }

  private save() {
    try {
      ensurePrivateDir(path.dirname(this.s.statePath));
      fs.writeFileSync(this.s.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      restrictFile(this.s.statePath);
    } catch (err) {
      log("Couldn't save bot state:", err);
    }
  }

  handle(payload: any) {
    const note = parseNoteToSelf(payload, this.s.account, this.s.trigger, this.s.attachmentsDir, this.s.selfUuid);
    if (!note) return;
    if (this.state.seen.includes(note.timestamp)) return;
    this.state.seen = [...this.state.seen, note.timestamp].slice(-SEEN_LIMIT);

    const c = note.command;
    log(`Note to Self command: ${c.kind}`);
    if (c.kind === "stop") {
      const dropped = this.queue.length;
      this.queue = [];
      const droppedText = dropped ? ` Dropped ${dropped} queued message${dropped > 1 ? "s" : ""}.` : "";
      if (this.running) {
        // The run's own reply reports the stop.
        this.stopText = `Stopped.${droppedText}`;
        this.running.child.kill("SIGTERM");
      } else void this.reply(droppedText.trim() || "Nothing is running.");
      return;
    }
    if (c.kind === "status") return void this.reply(this.statusText());
    if (c.kind === "help") return void this.reply(this.helpText());
    if (c.kind === "new") {
      this.state.sessionId = null;
      this.save();
      return void this.reply(this.running ? "The next message starts a new conversation." : "New conversation started.");
    }
    this.queue.push(note);
    if (this.running) {
      void this.react(note, "⏳");
      if (this.s.ack) void this.reply("Got it. I'll start on this when the current request finishes.");
    }
    void this.drain();
  }

  private statusText() {
    const lines = [
      this.running
        ? `Working for ${Math.round((Date.now() - this.running.startedAt) / 1000)}s.`
        : "Idle.",
      `${this.queue.length} queued.`,
      this.state.sessionId ? `Conversation ${this.state.sessionId.slice(0, 8)}.` : "No conversation yet.",
      `Folder: ${this.s.cwd}`,
      `Mode: ${this.s.permissionMode}`,
    ];
    return lines.join("\n");
  }

  private helpText() {
    return [
      "Start a Note to Self with \"c \" to message Claude, e.g. \"c what's on my calendar?\"",
      "c new: start a fresh conversation (or \"c new <message>\")",
      "c stop: cancel what's running",
      "c status: what it's doing",
      "Photos and files you attach are passed along.",
    ].join("\n");
  }

  private async drain() {
    if (this.running || this.stopped) return;
    const note = this.queue.shift();
    if (!note || note.command.kind !== "prompt") return;
    if (note.command.fresh) this.state.sessionId = null;
    void this.react(note, "👀");
    if (this.s.ack) await this.reply("Got it, working on it.");

    let prompt = note.command.text || "Look at the attached file.";
    if (note.attachments.length) prompt += `\n\nAttached files:\n${note.attachments.join("\n")}`;

    let result = await this.runClaude(note, prompt, this.state.sessionId);
    if (!result.ok && this.state.sessionId && /no conversation found|session.*not found/i.test(result.text)) {
      log("Saved conversation is gone; starting a new one");
      result = await this.runClaude(note, prompt, null);
    }
    if (result.sessionId) this.state.sessionId = result.sessionId;
    this.save();

    await this.reply(result.text);
    await this.react(note, result.ok ? "✅" : "❌");
    void this.drain();
  }

  private runClaude(note: NoteToSelf, prompt: string, sessionId: string | null): Promise<RunResult> {
    const args = ["-p", "--output-format", "json", "--permission-mode", this.s.permissionMode, "--append-system-prompt", SYSTEM_PROMPT];
    if (this.s.model) args.push("--model", this.s.model);
    if (sessionId) args.push("--resume", sessionId);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Don't inherit a parent Claude Code session's markers (matters only when started from one).
    for (const k of Object.keys(env)) {
      if (k === "CLAUDECODE" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) delete env[k];
    }
    // The signal MCP server Claude starts should use this signal-cli and skip the Signal
    // Desktop import, which would raise a Keychain prompt on the Mac for every message.
    Object.assign(env, { SIGNAL_DESKTOP: "0", SIGNAL_CLI_URL: this.s.signalCliUrl, SIGNAL_ACCOUNT: this.s.account, SIGNAL_MCP_INGEST: "0" });

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.s.claudeBin, args, { cwd: this.s.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err: any) {
        return resolve({ text: `Couldn't start Claude Code: ${err.message}`, sessionId, ok: false });
      }
      this.running = { child, note, startedAt: Date.now() };
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (err += d));
      child.stdin!.end(prompt);
      const timer = setTimeout(() => child.kill("SIGTERM"), this.s.timeoutMs);

      child.on("error", (e) => {
        clearTimeout(timer);
        this.running = null;
        resolve({ text: `Couldn't start Claude Code (${this.s.claudeBin}): ${e.message}`, sessionId, ok: false });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.running = null;
        let parsed: any = null;
        try {
          parsed = JSON.parse(out.trim().split("\n").pop() || "");
        } catch {}
        if (parsed && typeof parsed === "object") {
          const ok = parsed.subtype === "success" && !parsed.is_error;
          const text = typeof parsed.result === "string" && parsed.result.trim() ? parsed.result : `Claude stopped (${parsed.subtype ?? "error"}).`;
          return resolve({ text, sessionId: parsed.session_id ?? sessionId, ok });
        }
        const stopText = this.stopText;
        this.stopText = null;
        if (stopText) return resolve({ text: stopText, sessionId, ok: false });
        if (signal) return resolve({ text: `Stopped after ${Math.round(this.s.timeoutMs / 60000)} minutes (${signal}).`, sessionId, ok: false });
        const detail = (err || out).trim().split("\n").slice(-3).join("\n");
        log(`claude exited ${code}: ${detail}`);
        resolve({ text: `Claude Code failed (exit ${code}).\n${detail}`.trim(), sessionId, ok: false });
      });
    });
  }

  private async reply(text: string) {
    const chunks = chunkReply(text);
    for (let i = 0; i < chunks.length; i++) {
      const body = i === 0 ? `${REPLY_MARK} ${chunks[i]}` : chunks[i];
      try {
        await this.client.rpc("send", { noteToSelf: true, message: body });
      } catch (err) {
        log("Couldn't send reply:", err);
        return;
      }
    }
  }

  private async react(note: NoteToSelf, emoji: string) {
    try {
      await this.client.rpc("sendReaction", { noteToSelf: true, emoji, targetAuthor: note.author, targetTimestamp: note.timestamp });
    } catch (err) {
      log("Couldn't react:", err);
    }
  }

  get idle() {
    return !this.running && this.queue.length === 0;
  }
}

export function runBot() {
  const bot = new SignalBot(settingsFromEnv());
  const shutdown = () => {
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  bot.start();
}
