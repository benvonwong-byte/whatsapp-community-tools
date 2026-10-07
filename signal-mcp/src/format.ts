import { Attachment, ChatRow, MessageRow, Quote } from "./store";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time as "YYYY-MM-DD HH:MM:SS", matching the WhatsApp MCP's output. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function formatSize(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function messageContent(m: MessageRow, reactions?: Array<{ emoji: string; reactor: string }>): string {
  if (m.deleted) return "[message deleted]";
  const parts: string[] = [];

  const quote = parseJson<Quote>(m.quote);
  if (quote) parts.push(`(replying to "${truncate(quote.text || "attachment", 60)}")`);

  if (m.body) parts.push(m.body);

  const attachments = parseJson<Attachment[]>(m.attachments) ?? [];
  attachments.forEach((a, i) => {
    const kind = a.isVoiceNote ? "voice note" : a.contentType || "file";
    const details = [a.filename ? `"${a.filename}"` : null, formatSize(a.size) || null].filter(Boolean).join(", ");
    const caption = a.caption ? ` caption: ${a.caption}` : "";
    parts.push(`[attachment ${i}: ${kind}${details ? ` ${details}` : ""}${caption}]`);
  });

  if (m.edited_at) parts.push("(edited)");
  if (reactions?.length) parts.push(`[reactions: ${reactions.map((r) => `${r.emoji} ${r.reactor}`).join(", ")}]`);
  return parts.join(" ");
}

export function formatMessage(
  m: MessageRow,
  opts: { showChat?: boolean; reactions?: Array<{ emoji: string; reactor: string }> } = {}
): string {
  const chat = opts.showChat ? `Chat: ${m.chat_name} (chat_id: ${m.chat_id}) ` : "";
  return `[${formatTime(m.timestamp)}] ${chat}From: ${m.sender_name}: ${messageContent(m, opts.reactions)} [message_id: ${m.id}]`;
}

export function chatSummary(chat: ChatRow, lastMessage?: MessageRow) {
  return {
    chat_id: chat.id,
    name: chat.name,
    type: chat.type,
    ...(chat.number ? { phone_number: chat.number } : {}),
    last_message_time: chat.last_message_at ? formatTime(chat.last_message_at) : null,
    ...(lastMessage
      ? {
          last_message: `${lastMessage.sender_name}: ${truncate(messageContent(lastMessage), 200)}`,
          last_message_id: lastMessage.id,
        }
      : {}),
  };
}
