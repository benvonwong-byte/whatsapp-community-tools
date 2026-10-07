import { config } from "./config";
import { Identity } from "./identity";
import { extractLinks } from "./links";
import { log } from "./log";
import { EventSubscription, SignalCliClient } from "./signal-cli";
import { Attachment, SELF, SignalStore, UUID_RE, groupChatId } from "./store";
import { joinNames, replaceMentions } from "./text";

const LAST_EVENT_KEY = "sse_last_event_id";

/** Split signal-cli's deprecated combined identifier (number or ACI) into the modern fields. */
function address(uuid?: string | null, number?: string | null, legacy?: string | null) {
  if (legacy && !uuid && UUID_RE.test(legacy)) uuid = legacy;
  if (legacy && !number && legacy.startsWith("+")) number = legacy;
  return { uuid: uuid || null, number: number || null };
}

/**
 * Turns signal-cli receive events into rows in the local store, and keeps contact and
 * group names in sync. Signal has no server-side history, so anything not captured here
 * (while the MCP server or bridge is running) is not searchable later.
 */
export class Ingestor {
  private subscription: EventSubscription | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private groupRefreshTimer: NodeJS.Timeout | null = null;

  constructor(private store: SignalStore, private client: SignalCliClient, private identity: Identity) {}

  start() {
    this.subscription = this.client.subscribe({
      lastEventId: this.store.getMeta(LAST_EVENT_KEY),
      onEvent: (payload, eventId) => {
        this.store.db.transaction(() => {
          this.handlePayload(payload);
          if (eventId) this.store.setMeta(LAST_EVENT_KEY, eventId);
        })();
      },
      onConnect: () => void this.refresh(),
    });
    this.refreshTimer = setInterval(() => void this.refresh(), config.refreshIntervalMs);
    this.refreshTimer.unref();
  }

  stop() {
    this.subscription?.close();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.groupRefreshTimer) clearTimeout(this.groupRefreshTimer);
  }

  // ── Event handling ──

  handlePayload(payload: any) {
    if (typeof payload?.account === "string") this.identity.learnAccount(payload.account);
    const env = payload?.envelope;
    if (env) this.handleEnvelope(env);
  }

  private handleEnvelope(env: any) {
    if (env.syncMessage) {
      // Sync messages only ever come from our own linked devices.
      this.identity.learn(env.sourceUuid, env.sourceNumber);
      const sent = env.syncMessage.sentMessage;
      if (!sent) return;
      const groupInfo = sent.groupInfo ?? sent.editMessage?.dataMessage?.groupInfo;
      const chatId = groupInfo?.groupId
        ? this.groupChat(groupInfo)
        : this.directChat(address(sent.destinationUuid, sent.destinationNumber, sent.destination));
      if (!chatId) return;
      if (sent.editMessage) this.applyEdit(chatId, SELF, sent.editMessage);
      else this.handleData(chatId, SELF, sent);
      return;
    }

    const source = address(env.sourceUuid, env.sourceNumber, env.source);
    const senderId = this.identity.idFor(source.uuid, source.number);
    if (!senderId) return;
    if (senderId !== SELF) this.store.upsertContact({ ...source, name: env.sourceName });

    if (env.editMessage) {
      const groupInfo = env.editMessage.dataMessage?.groupInfo;
      const chatId = groupInfo?.groupId ? this.groupChat(groupInfo) : senderId;
      this.applyEdit(chatId, senderId, env.editMessage);
    } else if (env.dataMessage) {
      const groupInfo = env.dataMessage.groupInfo;
      const chatId = groupInfo?.groupId ? this.groupChat(groupInfo) : senderId;
      this.handleData(chatId, senderId, env.dataMessage);
    }
  }

  private handleData(chatId: string, senderId: string, dm: any) {
    const timestamp = Number(dm.timestamp);
    if (!timestamp) return;

    if (dm.reaction) {
      const r = dm.reaction;
      const author = address(r.targetAuthorUuid, r.targetAuthorNumber, r.targetAuthor);
      const target = this.identity.idFor(author.uuid, author.number);
      if (!target) return;
      if (r.isRemove) this.store.removeReaction(chatId, target, Number(r.targetSentTimestamp), senderId);
      else this.store.setReaction(chatId, target, Number(r.targetSentTimestamp), senderId, r.emoji, timestamp);
      return;
    }

    if (dm.remoteDelete) {
      const target = Number(dm.remoteDelete.targetTimestamp || dm.remoteDelete.timestamp);
      if (target) this.store.markDeleted(chatId, senderId, target);
      return;
    }

    if (Number(dm.expiresInSeconds) > 0 && !config.archiveDisappearing) {
      const skipped = Number(this.store.getMeta("skipped_disappearing") ?? 0) + 1;
      this.store.setMeta("skipped_disappearing", String(skipped));
      return;
    }

    const body = this.describe(dm);
    const attachments: Attachment[] = (dm.attachments ?? []).map((a: any) => ({
      id: a.id ?? null,
      contentType: a.contentType ?? null,
      filename: a.filename ?? null,
      size: a.size ?? null,
      caption: a.caption ?? null,
      isVoiceNote: Boolean(a.isVoiceNote),
    }));
    if (!body && attachments.length === 0) return; // receipts-like noise: expiry timers, profile keys, calls

    let quote = null;
    if (dm.quote) {
      const author = address(dm.quote.authorUuid, dm.quote.authorNumber, dm.quote.author);
      quote = { timestamp: Number(dm.quote.id), authorId: this.identity.idFor(author.uuid, author.number), text: dm.quote.text ?? null };
    }

    // Direct chats are created lazily so receipts-like noise doesn't add empty chats.
    if (!chatId.startsWith("group:")) this.store.ensureDirectChat(chatId);
    const id = this.store.insertMessage({
      chatId,
      senderId,
      timestamp,
      isFromMe: senderId === SELF,
      body,
      attachments,
      quote,
    });
    if (id) this.store.setLinks(id, extractLinks(body, dm.previews));
  }

  private applyEdit(chatId: string, senderId: string, edit: any) {
    const target = Number(edit.targetSentTimestamp);
    const dm = edit.dataMessage;
    if (!target || !dm) return;
    const body = this.describe(dm);
    const id = this.store.applyEdit(chatId, senderId, target, body, Number(dm.timestamp) || Date.now());
    if (id) this.store.setLinks(id, extractLinks(body, dm.previews));
  }

  /** Text for a data message, with mentions resolved and non-text content summarised. */
  private describe(dm: any): string | null {
    const parts: string[] = [];
    const text = this.applyMentions(dm.message, dm.mentions);
    if (text) parts.push(text);
    if (dm.sticker) parts.push("[Sticker]");
    if (dm.pollCreate) {
      const options = (dm.pollCreate.options ?? []).join(" / ");
      parts.push(`[Poll] ${dm.pollCreate.question ?? ""}${options ? ` — ${options}` : ""}`);
    }
    for (const c of dm.contacts ?? []) {
      const name = joinNames(c.name?.given, c.name?.family) || c.name?.nickname || "contact";
      const phone = c.phone?.[0]?.value;
      parts.push(`[Shared contact: ${name}${phone ? ` ${phone}` : ""}]`);
    }
    if (dm.payment) parts.push("[Payment]");
    return parts.length ? parts.join("\n") : null;
  }

  /** Signal puts U+FFFC placeholders where mentions go; swap them for @Name. */
  private applyMentions(text: string | null | undefined, mentions: any[] | undefined): string | null {
    if (!text) return null;
    if (!mentions?.length) return text;
    return replaceMentions(
      text,
      mentions.map((m) => {
        const id = this.identity.idFor(m.uuid, m.number);
        const c = id && id !== SELF ? this.store.getContact(id) : undefined;
        const name = id === SELF ? "Me" : c?.name || c?.profile_name || m.name || m.number || "unknown";
        return { start: m.start, length: m.length, name };
      })
    );
  }

  private directChat(addr: { uuid: string | null; number: string | null }): string | null {
    const id = this.identity.idFor(addr.uuid, addr.number);
    if (id && id !== SELF) this.store.upsertContact(addr);
    return id;
  }

  private groupChat(groupInfo: any): string {
    const isNew = this.store.ensureGroupChat(groupInfo.groupId, groupInfo.groupName);
    if (isNew && !groupInfo.groupName) this.scheduleGroupRefresh();
    return groupChatId(groupInfo.groupId);
  }

  private scheduleGroupRefresh() {
    if (this.groupRefreshTimer) return;
    this.groupRefreshTimer = setTimeout(() => {
      this.groupRefreshTimer = null;
      this.refreshGroups().catch((err) => log("Group refresh failed:", err?.message || err));
    }, 2000);
  }

  // ── Contact & group sync ──

  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        await this.discoverSelf().catch(() => {});
        await this.refreshContacts().catch((err) => log("Contact refresh failed:", err?.message || err));
        await this.refreshGroups().catch((err) => log("Group refresh failed:", err?.message || err));
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async discoverSelf() {
    if (this.identity.uuid && this.identity.number) return;
    try {
      // Only available when the daemon serves multiple accounts.
      const accounts = await this.client.rpc<Array<{ number?: string; aci?: string }>>("listAccounts", {}, { withAccount: false });
      const mine =
        accounts.find((a) => a.number === config.account || a.aci === config.account) ??
        (accounts.length === 1 ? accounts[0] : undefined);
      if (mine) this.identity.learn(mine.aci, mine.number);
    } catch {}
    if (!this.identity.uuid && this.identity.number) {
      try {
        const statuses = await this.client.rpc<Array<{ uuid?: string }>>("getUserStatus", {
          recipient: [this.identity.number],
        });
        this.identity.learn(statuses?.[0]?.uuid, undefined);
      } catch {}
    }
  }

  async refreshContacts() {
    const contacts = await this.client.rpc<any[]>("listContacts", { allRecipients: true });
    this.store.db.transaction(() => {
      for (const c of contacts ?? []) {
        if (this.identity.isSelf(c.uuid, c.number)) continue;
        this.store.upsertContact(
          {
            uuid: c.uuid,
            number: c.number,
            username: c.username,
            name: c.nickName || c.name || joinNames(c.givenName, c.familyName),
            profileName: joinNames(c.profile?.givenName, c.profile?.familyName),
            isBlocked: c.isBlocked,
          },
          true
        );
      }
    })();
  }

  async refreshGroups() {
    const groups = await this.client.rpc<any[]>("listGroups");
    this.store.db.transaction(() => {
      for (const g of groups ?? []) {
        if (!g.id) continue;
        if (!g.isMember && !this.store.getChat(groupChatId(g.id))) continue;
        this.store.ensureGroupChat(g.id, g.name);
        const memberIds: string[] = [];
        for (const m of g.members ?? []) {
          // Older signal-cli versions list members as plain strings.
          const uuid = typeof m === "string" ? (UUID_RE.test(m) ? m : null) : m.uuid;
          const number = typeof m === "string" ? (UUID_RE.test(m) ? null : m) : m.number;
          const id = this.identity.idFor(uuid, number);
          if (!id) continue;
          if (id !== SELF) this.store.upsertContact({ uuid, number });
          memberIds.push(id);
        }
        this.store.setGroupMembers(g.id, memberIds);
      }
    })();
  }
}
