import fs from "fs";
import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config";
import { chatSummary, formatMessage, formatSize, formatTime, parseJson } from "./format";
import { SignalDesktopSource } from "./desktop";
import { Identity } from "./identity";
import { extractLinks } from "./links";
import { extensionForMime, mimeForFile } from "./mime";
import { SendResult, SignalCliClient } from "./signal-cli";
import {
  Attachment,
  ContactRow,
  FileKind,
  LinkFilters,
  LinkRow,
  LinkShareRow,
  MessageRow,
  Quote,
  SELF,
  SignalStore,
  UUID_RE,
  normalizePhone,
} from "./store";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // Signal's attachment limit

interface Deps {
  store: SignalStore;
  client: SignalCliClient;
  identity: Identity;
  /** Signal Desktop reader, when Desktop is installed. */
  desktop: SignalDesktopSource | null;
  /** Whether signal-cli is configured, which sending needs. */
  sending: boolean;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

/** Wraps a handler so thrown errors come back to the model as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<ToolResult> | ToolResult) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  };
}

function contactName(c: ContactRow): string {
  return c.name || c.profile_name || c.number || c.username || c.id;
}

function contactSummary(c: ContactRow) {
  return {
    contact_id: c.id,
    name: contactName(c),
    ...(c.profile_name && c.profile_name !== c.name ? { profile_name: c.profile_name } : {}),
    phone_number: c.number,
    ...(c.username ? { username: c.username } : {}),
    ...(c.is_blocked ? { blocked: true } : {}),
  };
}

function parseDate(value: string | undefined, field: string): number | undefined {
  if (!value) return undefined;
  // JS parses a bare date as UTC midnight; treat it as local midnight like datetimes without a zone.
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00` : value);
  if (Number.isNaN(ms)) throw new Error(`${field} must be an ISO-8601 date, e.g. 2026-01-31 or 2026-01-31T09:00:00`);
  return ms;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function linkSummary(l: LinkRow) {
  return {
    url: l.url,
    ...(l.title ? { title: l.title } : {}),
    domain: l.domain,
    times_shared: l.share_count,
    first_shared: formatTime(l.first_shared),
    last_shared: formatTime(l.last_shared),
    chats: JSON.parse(l.chats) as string[],
    shared_by: JSON.parse(l.shared_by) as string[],
    ...(l.description ? { description: l.description.slice(0, 200) } : {}),
    message_id: l.latest_message_id,
  };
}

function linksCsv(rows: LinkRow[]): string {
  const header = ["url", "title", "domain", "times_shared", "first_shared", "last_shared", "chats", "shared_by", "description"];
  const lines = rows.map((l) =>
    [
      l.url,
      l.title,
      l.domain,
      l.share_count,
      formatTime(l.first_shared),
      formatTime(l.last_shared),
      (JSON.parse(l.chats) as string[]).join("; "),
      (JSON.parse(l.shared_by) as string[]).join("; "),
      l.description,
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

/** Markdown with one section per chat, each distinct link listed once (most recent share). */
function linksMarkdown(shares: LinkShareRow[], description: string): string {
  const byChat = new Map<string, Map<string, LinkShareRow>>();
  for (const share of shares) {
    const chat = byChat.get(share.chat_name) ?? new Map<string, LinkShareRow>();
    if (!chat.has(share.normalized_url)) chat.set(share.normalized_url, share);
    byChat.set(share.chat_name, chat);
  }
  const out = [`# Signal links`, "", `${description} Exported ${formatTime(Date.now())}.`, ""];
  for (const chatName of [...byChat.keys()].sort((a, b) => a.localeCompare(b))) {
    const links = [...byChat.get(chatName)!.values()];
    out.push(`## ${chatName} (${links.length})`, "");
    for (const l of links) {
      const label = (l.title || l.url).replace(/([\[\]])/g, "\\$1");
      out.push(`- [${label}](<${l.url}>) — ${l.domain} · ${l.sender_name}, ${formatTime(l.timestamp).slice(0, 10)}`);
      if (l.description) out.push(`  > ${l.description.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function registerTools(server: McpServer, { store, client, identity, desktop, sending }: Deps) {
  const READ = { readOnlyHint: true, openWorldHint: false } as const;
  const SEND = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  function emptyHint(): string {
    if (store.stats().messages === 0) {
      if (desktop) {
        return desktop.lastSync?.error
          ? `No messages yet: reading Signal Desktop failed (${desktop.lastSync.error}).`
          : "No messages imported yet; the first Signal Desktop import may still be running. Use get_status to check.";
      }
      return (
        "No Signal messages are stored yet. Signal keeps no message history on its servers, so only messages " +
        "received while signal-mcp (or `signal-mcp bridge`) is running are available. Use get_status to check the connection."
      );
    }
    return "No messages match.";
  }

  /** Contact id for a phone number, UUID, username, or "me". */
  function resolveContactId(input: string): string {
    const s = input.trim();
    if (["me", "self", SELF].includes(s.toLowerCase())) return SELF;
    const contact = store.findContact(s);
    if (contact) return contact.id;
    const phone = normalizePhone(s);
    if (phone) return phone;
    if (UUID_RE.test(s)) return s;
    throw new Error(
      `Unknown contact "${s}". Pass a phone number (+15551234567), a Signal UUID, or "u:username" — use search_contacts to find one by name.`
    );
  }

  /** Address signal-cli should use for a sender in quote/reaction/attachment params. */
  function authorAddress(m: MessageRow): string {
    if (m.is_from_me) {
      const self = identity.address();
      if (!self) throw new Error("Own Signal account is unknown; set SIGNAL_ACCOUNT in the MCP server config.");
      return self;
    }
    const c = store.getContact(m.sender_id);
    return c?.uuid || c?.number || m.sender_id;
  }

  interface Target {
    params: Record<string, unknown>;
    chatId: string | null;
    label: string;
  }

  function resolveTarget(input: string): Target {
    const s = input.trim();
    if (["me", "self", "note to self", "note-to-self"].includes(s.toLowerCase())) {
      return { params: { noteToSelf: true }, chatId: SELF, label: "Note to Self" };
    }
    if (s.startsWith("group:")) {
      const chat = store.getChat(s);
      return { params: { groupId: s.slice("group:".length) }, chatId: s, label: chat?.name ?? s };
    }
    const chat = store.getChat(s);
    if (chat?.type === "direct") {
      const c = store.getContact(s);
      return { params: { recipient: [c?.uuid || c?.number || s] }, chatId: s, label: chat.name };
    }
    const phone = normalizePhone(s);
    if (phone) {
      const c = store.findContact(phone);
      return { params: { recipient: [phone] }, chatId: c?.id ?? null, label: c ? contactName(c) : phone };
    }
    if (UUID_RE.test(s)) {
      const c = store.getContact(s);
      return { params: { recipient: [s] }, chatId: s, label: c ? contactName(c) : s };
    }
    if (s.startsWith("u:")) {
      const c = store.findContact(s);
      return { params: { username: [s.slice(2)] }, chatId: c?.id ?? null, label: s };
    }
    throw new Error(
      `Unrecognized recipient "${s}". Use a chat_id from list_chats (a Signal UUID or group:<id>), a phone number ` +
        `in international format (+15551234567), "u:<username>", or "me" for Note to Self. Find people with search_contacts.`
    );
  }

  /** Store a message we just sent, since signal-cli doesn't echo its own sends back as events. */
  function recordOutgoing(
    target: Target,
    result: SendResult,
    body: string | null,
    attachments: Attachment[],
    quote: Quote | null
  ): number | null {
    let chatId = target.chatId;
    if (!chatId) {
      const addr = result.results?.[0]?.recipientAddress;
      chatId = identity.idFor(addr?.uuid, addr?.number);
      if (chatId && chatId !== SELF) {
        store.upsertContact({ uuid: addr?.uuid, number: addr?.number, username: addr?.username });
      }
    }
    if (!chatId || !result.timestamp) return null;
    if (chatId.startsWith("group:")) store.ensureGroupChat(chatId.slice("group:".length));
    else store.ensureDirectChat(chatId);
    const id = store.insertMessage({
      chatId,
      senderId: SELF,
      timestamp: result.timestamp,
      isFromMe: true,
      body,
      attachments,
      quote,
    });
    if (id) store.setLinks(id, extractLinks(body));
    return id;
  }

  /** Shared filter parsing for the link tools. */
  function linkFilters(args: {
    chat_id?: string;
    sender?: string;
    domain?: string;
    query?: string;
    after?: string;
    before?: string;
  }): LinkFilters {
    if (args.chat_id && !store.getChat(args.chat_id)) {
      throw new Error(`No chat with chat_id "${args.chat_id}". Use list_chats to find it.`);
    }
    return {
      chatId: args.chat_id,
      senderId: args.sender ? resolveContactId(args.sender) : undefined,
      domain: args.domain,
      query: args.query,
      after: parseDate(args.after, "after"),
      before: parseDate(args.before, "before"),
    };
  }

  const LINK_FILTER_SCHEMA = {
    chat_id: z.string().optional().describe("Only links shared in this chat (chat_id from list_chats)"),
    sender: z.string().optional().describe('Only links shared by this person: phone number, Signal UUID, or "me"'),
    domain: z.string().optional().describe("Only links to this site, e.g. youtube.com (includes subdomains)"),
    query: z.string().optional().describe("Only links whose URL, preview title/description, or message text contains this"),
    after: z.string().optional().describe("Only links shared after this ISO-8601 date/time"),
    before: z.string().optional().describe("Only links shared before this ISO-8601 date/time"),
  };

  function sendSummary(target: Target, result: SendResult, messageId: number | null): string {
    const failures = (result.results ?? []).filter((r) => r.type && r.type !== "SUCCESS");
    let summary = `Sent to ${target.label}${messageId ? ` (message_id: ${messageId})` : ""}.`;
    if (failures.length) {
      const who = failures
        .map((f) => `${f.recipientAddress?.number || f.recipientAddress?.uuid || "unknown"} (${f.type})`)
        .join(", ");
      summary += ` Delivery failed for ${failures.length} recipient(s): ${who}`;
    }
    return summary;
  }

  // ── Read tools (mirroring the WhatsApp MCP) ──

  server.registerTool(
    "search_contacts",
    {
      description: "Search Signal contacts by name, phone number, or username.",
      inputSchema: { query: z.string().describe("Search term to match against names, phone numbers, or usernames") },
      annotations: READ,
    },
    safe(({ query }) => {
      const results = store.searchContacts(query).map(contactSummary);
      return results.length ? json(results) : text(`No contacts match "${query}".`);
    })
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "Get Signal messages matching the given filters, most recent first (page 0 = newest). " +
        "Each page is printed oldest to newest. Optionally includes surrounding messages for context.",
      inputSchema: {
        after: z.string().optional().describe("Only messages after this ISO-8601 date/time"),
        before: z.string().optional().describe("Only messages before this ISO-8601 date/time"),
        sender: z.string().optional().describe('Only messages from this sender: phone number, Signal UUID, or "me"'),
        chat_id: z.string().optional().describe("Only messages in this chat (chat_id from list_chats)"),
        query: z.string().optional().describe("Only messages whose text or attachment names contain this term"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of messages to return"),
        page: z.number().int().min(0).default(0).describe("Page number for pagination"),
        include_context: z.boolean().default(true).describe("Include messages before and after each match"),
        context_before: z.number().int().min(0).max(20).default(1).describe("Messages to include before each match"),
        context_after: z.number().int().min(0).max(20).default(1).describe("Messages to include after each match"),
      },
      annotations: READ,
    },
    safe((args) => {
      const after = parseDate(args.after, "after");
      const before = parseDate(args.before, "before");
      const senderId = args.sender ? resolveContactId(args.sender) : undefined;
      if (args.chat_id && !store.getChat(args.chat_id)) {
        return fail(`No chat with chat_id "${args.chat_id}". Use list_chats to find it.`);
      }
      const rows = store.listMessages({
        after,
        before,
        senderId,
        chatId: args.chat_id,
        query: args.query,
        limit: args.limit,
        page: args.page,
      });
      if (rows.length === 0) return text(emptyHint());
      rows.reverse();

      const header = `${rows.length} message(s), page ${args.page}${rows.length === args.limit ? " (more may be available on the next page)" : ""}:\n\n`;
      if (!args.include_context || (args.context_before === 0 && args.context_after === 0)) {
        const reactions = store.getReactions(rows);
        return text(header + rows.map((m) => formatMessage(m, { showChat: true, reactions: reactions.get(m.id) })).join("\n"));
      }
      const blocks = rows.map((m) => {
        const ctx = store.getContext(m, args.context_before, args.context_after);
        const all = [...ctx.before, m, ...ctx.after];
        const reactions = store.getReactions(all);
        const lines = all.map((x) => `${x.id === m.id ? ">" : " "} ${formatMessage(x, { reactions: reactions.get(x.id) })}`);
        return `=== ${m.chat_name} (chat_id: ${m.chat_id}) ===\n${lines.join("\n")}`;
      });
      return text(header + blocks.join("\n\n"));
    })
  );

  server.registerTool(
    "list_chats",
    {
      description: "List Signal chats (1:1 conversations and groups), optionally filtered by name.",
      inputSchema: {
        query: z.string().optional().describe("Search term to filter chats by name, phone number, or chat_id"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of chats to return"),
        page: z.number().int().min(0).default(0).describe("Page number for pagination"),
        include_last_message: z.boolean().default(true).describe("Include the last message in each chat"),
        sort_by: z.enum(["last_active", "name"]).default("last_active").describe("Sort order"),
      },
      annotations: READ,
    },
    safe((args) => {
      const chats = store.listChats({ query: args.query, limit: args.limit, page: args.page, sortBy: args.sort_by });
      if (chats.length === 0) return text(args.query ? `No chats match "${args.query}".` : emptyHint());
      return json(chats.map((c) => chatSummary(c, args.include_last_message ? store.getLastMessage(c.id) : undefined)));
    })
  );

  server.registerTool(
    "get_chat",
    {
      description: "Get Signal chat metadata by chat_id.",
      inputSchema: {
        chat_id: z.string().describe("The chat_id (Signal UUID for 1:1 chats, group:<id> for groups, self for Note to Self)"),
        include_last_message: z.boolean().default(true).describe("Include the last message"),
      },
      annotations: READ,
    },
    safe(({ chat_id, include_last_message }) => {
      const chat = store.getChat(chat_id);
      if (!chat) return fail(`No chat with chat_id "${chat_id}".`);
      return json(chatSummary(chat, include_last_message ? store.getLastMessage(chat.id) : undefined));
    })
  );

  server.registerTool(
    "get_direct_chat_by_contact",
    {
      description: "Get the 1:1 Signal chat with a contact, by phone number, Signal UUID, or username.",
      inputSchema: { contact: z.string().describe("Phone number (+15551234567), Signal UUID, or u:username") },
      annotations: READ,
    },
    safe(({ contact }) => {
      const id = resolveContactId(contact);
      const chat = store.getChat(id);
      if (chat) return json(chatSummary(chat, store.getLastMessage(chat.id)));
      const c = store.getContact(id);
      if (c) {
        return json({
          ...contactSummary(c),
          chat_id: c.id,
          note: "No messages with this contact yet. You can still send to them using this chat_id.",
        });
      }
      return text(`No chat or contact found for "${contact}". You can still send to a phone number directly with send_message.`);
    })
  );

  server.registerTool(
    "get_contact_chats",
    {
      description: "Get all Signal chats involving a contact: their 1:1 chat plus groups they are in or have posted to.",
      inputSchema: {
        contact: z.string().describe("Phone number, Signal UUID, or u:username"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of chats to return"),
        page: z.number().int().min(0).default(0).describe("Page number for pagination"),
      },
      annotations: READ,
    },
    safe(({ contact, limit, page }) => {
      const chats = store.getContactChats(resolveContactId(contact), limit, page);
      return chats.length ? json(chats.map((c) => chatSummary(c))) : text(`No chats found for "${contact}".`);
    })
  );

  server.registerTool(
    "get_last_interaction",
    {
      description: "Get the most recent Signal message involving a contact (sent by them, or in your 1:1 chat).",
      inputSchema: { contact: z.string().describe("Phone number, Signal UUID, or u:username") },
      annotations: READ,
    },
    safe(({ contact }) => {
      const m = store.getLastInteraction(resolveContactId(contact));
      if (!m) return text(`No messages found involving "${contact}".`);
      return text(formatMessage(m, { showChat: true, reactions: store.getReactions([m]).get(m.id) }));
    })
  );

  server.registerTool(
    "get_message_context",
    {
      description: "Get the messages around a specific Signal message.",
      inputSchema: {
        message_id: z.number().int().describe("The message_id to get context for"),
        before: z.number().int().min(0).max(100).default(5).describe("Messages to include before the target"),
        after: z.number().int().min(0).max(100).default(5).describe("Messages to include after the target"),
      },
      annotations: READ,
    },
    safe(({ message_id, before, after }) => {
      const target = store.getMessage(message_id);
      if (!target) return fail(`No message with message_id ${message_id}.`);
      const ctx = store.getContext(target, before, after);
      const all = [...ctx.before, target, ...ctx.after];
      const reactions = store.getReactions(all);
      const lines = all.map((x) => `${x.id === target.id ? ">" : " "} ${formatMessage(x, { reactions: reactions.get(x.id) })}`);
      return text(`=== ${target.chat_name} (chat_id: ${target.chat_id}) ===\n${lines.join("\n")}`);
    })
  );

  // ── Link and file catalog ──

  server.registerTool(
    "list_links",
    {
      description:
        "List links shared in Signal chats, with preview titles, where and by whom they were shared. " +
        "By default each distinct link appears once with how many times it was shared; set group_by_url=false to list every share.",
      inputSchema: {
        ...LINK_FILTER_SCHEMA,
        group_by_url: z.boolean().default(true).describe("Combine repeat shares of the same link into one entry"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of results"),
        page: z.number().int().min(0).default(0).describe("Page number for pagination"),
      },
      annotations: READ,
    },
    safe((args) => {
      const filters = linkFilters(args);
      const offset = args.page * args.limit;
      const results = args.group_by_url
        ? store.listLinks(filters, args.limit, offset).map(linkSummary)
        : store.listLinkShares(filters, args.limit, offset).map((l) => ({
            shared_at: formatTime(l.timestamp),
            chat: l.chat_name,
            chat_id: l.chat_id,
            shared_by: l.sender_name,
            url: l.url,
            ...(l.title ? { title: l.title } : {}),
            message_id: l.message_id,
          }));
      if (results.length === 0) return text(store.stats().links === 0 ? emptyHint() : "No links match.");
      const more = results.length === args.limit ? ` More on page ${args.page + 1}.` : "";
      return text(`${results.length} result(s), page ${args.page}.${more}\n${JSON.stringify(results, null, 2)}`);
    })
  );

  server.registerTool(
    "list_files",
    {
      description: "List files (images, videos, audio, documents) shared in Signal chats. Use download_attachment to save one.",
      inputSchema: {
        chat_id: z.string().optional().describe("Only files shared in this chat"),
        sender: z.string().optional().describe('Only files shared by this person: phone number, Signal UUID, or "me"'),
        query: z.string().optional().describe("Only files whose name, caption, or message text contains this"),
        kind: z.enum(["image", "video", "audio", "document"]).optional().describe("Only this kind of file"),
        after: z.string().optional().describe("Only files shared after this ISO-8601 date/time"),
        before: z.string().optional().describe("Only files shared before this ISO-8601 date/time"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of results"),
        page: z.number().int().min(0).default(0).describe("Page number for pagination"),
      },
      annotations: READ,
    },
    safe((args) => {
      if (args.chat_id && !store.getChat(args.chat_id)) return fail(`No chat with chat_id "${args.chat_id}".`);
      const files = store.listFiles(
        {
          chatId: args.chat_id,
          senderId: args.sender ? resolveContactId(args.sender) : undefined,
          query: args.query,
          kind: args.kind as FileKind | undefined,
          after: parseDate(args.after, "after"),
          before: parseDate(args.before, "before"),
        },
        args.limit,
        args.page * args.limit
      );
      if (files.length === 0) return text(store.stats().messages === 0 ? emptyHint() : "No files match.");
      return json(
        files.map((f) => ({
          message_id: f.message_id,
          attachment_index: f.attachment_index,
          filename: f.filename,
          type: f.content_type,
          ...(f.size ? { size: formatSize(f.size) } : {}),
          ...(f.caption ? { caption: f.caption } : {}),
          chat: f.chat_name,
          shared_by: f.sender_name,
          shared_at: formatTime(f.timestamp),
        }))
      );
    })
  );

  server.registerTool(
    "export_links",
    {
      description:
        "Export the link catalog to a file: CSV (one row per distinct link, for spreadsheets/Notion/Airtable) " +
        "or Markdown (organised by chat). Returns the file path.",
      inputSchema: {
        ...LINK_FILTER_SCHEMA,
        format: z.enum(["csv", "markdown"]).default("markdown").describe("File format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe((args) => {
      const filters = linkFilters(args);
      const all = 100_000;
      fs.mkdirSync(config.exportDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
      let file: string;
      let count: number;
      if (args.format === "csv") {
        const rows = store.listLinks(filters, all, 0);
        count = rows.length;
        file = path.join(config.exportDir, `signal-links-${stamp}.csv`);
        fs.writeFileSync(file, linksCsv(rows));
      } else {
        const shares = store.listLinkShares(filters, all, 0);
        count = new Set(shares.map((s) => s.normalized_url)).size;
        const scope = args.chat_id ? `Links shared in ${store.getChat(args.chat_id)?.name}.` : "Links shared in your Signal chats.";
        file = path.join(config.exportDir, `signal-links-${stamp}.md`);
        fs.writeFileSync(file, linksMarkdown(shares, scope));
      }
      if (count === 0) return text("No links match, so nothing was exported.");
      return json({ file_path: file, links: count, format: args.format });
    })
  );

  // ── Send tools (need signal-cli) ──

  if (sending) {
    server.registerTool(
      "send_message",
      {
        description:
          "Send a Signal message to a person, group, or Note to Self. Optionally reply to (quote) an earlier message. " +
          "Find recipients with search_contacts or list_chats first.",
        inputSchema: {
          recipient: z
            .string()
            .optional()
            .describe(
              'chat_id from list_chats (Signal UUID or group:<id>), phone number with country code (+15551234567), "u:<username>", or "me". ' +
                "Optional when reply_to_message_id is given (defaults to that message's chat)."
            ),
          message: z.string().min(1).describe("The message text to send"),
          reply_to_message_id: z.number().int().optional().describe("message_id to quote-reply to"),
        },
        annotations: SEND,
      },
      safe(async ({ recipient, message, reply_to_message_id }) => {
        const replyTo = reply_to_message_id !== undefined ? store.getMessage(reply_to_message_id) : undefined;
        if (reply_to_message_id !== undefined && !replyTo) return fail(`No message with message_id ${reply_to_message_id}.`);
        const to = recipient ?? replyTo?.chat_id;
        if (!to) return fail("recipient is required.");

        const target = resolveTarget(to);
        const params: Record<string, unknown> = { ...target.params, message };
        let quote: Quote | null = null;
        if (replyTo) {
          params.quoteTimestamp = replyTo.timestamp;
          params.quoteAuthor = authorAddress(replyTo);
          params.quoteMessage = replyTo.body ?? "";
          quote = { timestamp: replyTo.timestamp, authorId: replyTo.sender_id, text: replyTo.body };
        }
        const result = await client.rpc<SendResult>("send", params);
        const id = recordOutgoing(target, result, message, [], quote);
        return text(sendSummary(target, result, id));
      })
    );

    server.registerTool(
      "send_file",
      {
        description: "Send a file (image, video, audio, document) via Signal, with an optional caption.",
        inputSchema: {
          recipient: z
            .string()
            .describe('chat_id from list_chats (Signal UUID or group:<id>), phone number (+15551234567), "u:<username>", or "me"'),
          file_path: z.string().describe("Absolute path to the file to send"),
          caption: z.string().optional().describe("Optional message text to send with the file"),
        },
        annotations: SEND,
      },
      safe(async ({ recipient, file_path, caption }) => {
        const resolved = path.resolve(file_path);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(resolved);
        } catch {
          return fail(`File not found: ${resolved}`);
        }
        if (!stat.isFile()) return fail(`Not a file: ${resolved}`);
        if (stat.size > MAX_ATTACHMENT_BYTES) return fail("File is larger than Signal's 100 MB attachment limit.");

        const target = resolveTarget(recipient);
        const filename = path.basename(resolved);
        const contentType = mimeForFile(resolved);
        // A data URI works even when signal-cli runs in a container that can't see this path.
        const dataUri = `data:${contentType};filename=${encodeURIComponent(filename)};base64,${fs
          .readFileSync(resolved)
          .toString("base64")}`;
        const params: Record<string, unknown> = { ...target.params, attachments: [dataUri] };
        if (caption) params.message = caption;

        const result = await client.rpc<SendResult>("send", params);
        const id = recordOutgoing(target, result, caption ?? null, [{ contentType, filename, size: stat.size }], null);
        return text(sendSummary(target, result, id));
      })
    );

    server.registerTool(
      "send_reaction",
      {
        description: "React to a Signal message with an emoji, or remove your reaction.",
        inputSchema: {
          message_id: z.number().int().describe("The message_id to react to"),
          emoji: z.string().min(1).describe("A single emoji, e.g. 👍"),
          remove: z.boolean().default(false).describe("Remove this reaction instead of adding it"),
        },
        annotations: SEND,
      },
      safe(async ({ message_id, emoji, remove }) => {
        const m = store.getMessage(message_id);
        if (!m) return fail(`No message with message_id ${message_id}.`);
        const target = resolveTarget(m.chat_id);
        await client.rpc<SendResult>("sendReaction", {
          ...target.params,
          emoji,
          targetAuthor: authorAddress(m),
          targetTimestamp: m.timestamp,
          remove,
        });
        if (remove) store.removeReaction(m.chat_id, m.sender_id, m.timestamp, SELF);
        else store.setReaction(m.chat_id, m.sender_id, m.timestamp, SELF, emoji, Date.now());
        return text(`${remove ? "Removed" : "Reacted with"} ${emoji} ${remove ? "from" : "to"} message ${message_id} in ${target.label}.`);
      })
    );
  }

  server.registerTool(
    "download_attachment",
    {
      description: "Save an attachment from a Signal message to a local file and return its path.",
      inputSchema: {
        message_id: z.number().int().describe("The message_id containing the attachment"),
        attachment_index: z.number().int().min(0).default(0).describe("Which attachment, if the message has several"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ message_id, attachment_index }) => {
      const m = store.getMessage(message_id);
      if (!m) return fail(`No message with message_id ${message_id}.`);
      const attachments = parseJson<Attachment[]>(m.attachments) ?? [];
      const a = attachments[attachment_index];
      if (!a) return fail(`Message ${message_id} has ${attachments.length} attachment(s); index ${attachment_index} doesn't exist.`);
      const fromDesktop = Boolean(a.desktopPath && desktop);
      if (!fromDesktop && (!a.id || path.basename(a.id) !== a.id)) {
        return fail("This attachment isn't available to download (it may be one you sent from this server).");
      }

      fs.mkdirSync(config.downloadDir, { recursive: true });
      let name = (a.filename || a.id || "attachment").replace(/[^\w.\-]+/g, "_").slice(-100);
      if (!path.extname(name)) name += extensionForMime(a.contentType);
      const dest = path.join(config.downloadDir, `${m.id}-${attachment_index}-${name}`);

      if (fromDesktop && !fs.existsSync(dest)) {
        fs.writeFileSync(dest, desktop!.readAttachment(a));
      } else if (!fs.existsSync(dest) && a.id) {
        const local = path.join(config.attachmentsDir, a.id);
        if (fs.existsSync(local)) {
          fs.copyFileSync(local, dest);
        } else {
          const where = m.chat_type === "group" ? { groupId: m.chat_id.slice("group:".length) } : { recipient: authorAddress(m) };
          const res = await client.rpc<{ data: string }>("getAttachment", { id: a.id, ...where });
          fs.writeFileSync(dest, Buffer.from(res.data, "base64"));
        }
      }
      return json({ file_path: dest, content_type: a.contentType, filename: a.filename, size: fs.statSync(dest).size });
    })
  );

  if (desktop) {
    server.registerTool(
      "sync_signal_desktop",
      {
        description:
          "Import new messages from Signal Desktop now (this also happens automatically every few minutes). " +
          "Set full=true to re-read all history, e.g. to pick up older edits and deletions.",
        inputSchema: { full: z.boolean().default(false).describe("Re-read every message instead of only new ones") },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      safe(async ({ full }) => {
        const result = await desktop.sync({ full });
        const stats = store.stats();
        return json({
          imported_or_updated: result.imported,
          chats_imported: result.chats,
          total_messages: stats.messages,
          total_links: stats.links,
        });
      })
    );
  }

  server.registerTool(
    "get_status",
    {
      description: "Check where Signal messages come from (Signal Desktop and/or signal-cli) and how much is stored locally.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const stats = store.stats();
      let signalCli: Record<string, unknown> | string = "not used (sending is off; set SIGNAL_CLI_URL to enable it)";
      if (sending) {
        const reachable = await client.isUp();
        const version = reachable ? await client.rpc<{ version: string }>("version", {}, { withAccount: false }).catch(() => null) : null;
        // Only multi-account daemons implement listAccounts.
        const accounts = reachable
          ? await client
              .rpc<Array<{ number: string | null; aci?: string }>>("listAccounts", {}, { withAccount: false })
              .catch(() => null)
          : null;
        signalCli = {
          url: config.signalCliUrl,
          reachable,
          ...(version ? { version: version.version } : {}),
          ...(accounts ? { linked_accounts: accounts.map((a) => a.number ?? a.aci) } : {}),
        };
      }
      const signalDesktop = desktop
        ? {
            folder: desktop.dir,
            last_sync: desktop.lastSync ? formatTime(desktop.lastSync.at) : "in progress",
            ...(desktop.lastSync?.error ? { last_sync_error: desktop.lastSync.error } : {}),
            ...(config.desktop.chats.length ? { only_chats: config.desktop.chats } : {}),
          }
        : "not found";
      return json({
        signal_desktop: signalDesktop,
        signal_cli: signalCli,
        account: identity.number ?? identity.uuid ?? null,
        capturing_new_messages: config.ingest,
        database: config.dbPath,
        messages: stats.messages,
        chats: stats.chats,
        contacts: stats.contacts,
        links: stats.links,
        latest_message_time: stats.lastMessageAt ? formatTime(stats.lastMessageAt) : null,
        ...(config.archiveDisappearing
          ? {}
          : { disappearing_messages_skipped: Number(store.getMeta("skipped_disappearing") ?? 0) }),
      });
    })
  );
}

export function serverInstructions(opts: { sending: boolean; desktop: boolean }): string {
  const lines = [
    opts.sending ? "Read, search, and send the user's Signal messages." : "Read and search the user's Signal messages (read-only: sending is not set up).",
    "",
    '- Chats are identified by chat_id: a Signal UUID for 1:1 chats, "group:<base64 id>" for groups, "self" for Note to Self.',
    `- Messages are identified by an integer message_id (use it with get_message_context, download_attachment${opts.sending ? ", send_reaction, and reply_to_message_id" : ""}).`,
    "- Every link shared in a chat is catalogued: use list_links to browse or search them (grouped by URL across chats) and export_links to save them to a CSV or Markdown file. list_files does the same for shared files.",
  ];
  if (opts.sending) lines.push("- Look people up with search_contacts and chats with list_chats before sending; never guess a recipient.");
  lines.push(
    opts.desktop
      ? "- History is imported from Signal Desktop on this computer and kept in a local archive, which also keeps messages Desktop later removes."
      : "- Signal keeps no history on its servers, so only messages captured since signal-mcp started running are searchable."
  );
  return lines.join("\n");
}

